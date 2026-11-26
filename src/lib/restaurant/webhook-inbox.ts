import 'server-only';

import { z } from 'zod';

import {
  Prisma,
  type RestaurantWebhookInbox,
  type RestaurantWebhookVerificationStatus,
} from '@/generated/prisma/client';
import type { RestaurantJobHandler } from '@/lib/restaurant/job-handlers-core';
import { enqueue, SchedulerError } from '@/lib/restaurant/scheduler';
import { verifyProviderSignature, type SigningConfig } from './terminal-webhook-keys';
import { recordAudit } from '@/server/audit';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { processTerminalEvent, terminalEventSchema } from '@/lib/restaurant/terminal-payments';

/**
 * M7-L2 / D21 — the inbound-webhook inbox seam. External providers POST an
 * envelope to `/api/restaurant/webhooks/[source]`; this module durably records it
 * in `restaurant_webhook_inbox` (deduplicated by `(organization, source,
 * externalEventId)`) and enqueues a `webhook.process` job so the scheduler drains
 * it inside the tenant's RLS context — the receiver never processes provider
 * events on the request path.
 *
 * Public admission authenticates the raw body with the locked provider config
 * and checks job capacity inside the same transaction as the inbox and queue writes.
 *   - Dedup is idempotent at two layers: a check-then-create fast path plus the
 *     `(organization, source, externalEventId)` unique index as the authoritative
 *     guard (a concurrent duplicate loses the race and is returned as
 *     `deduplicated`). The enqueued job is itself deduplicated on the inbox id.
 *   - An unauthenticated envelope never reserves an event id against an
 *     authenticated one. When a terminal event whose HMAC the route verified
 *     arrives for an id already held by an unauthenticated row (any non-terminal
 *     type, or a stub status), that row is replaced and the signed event is
 *     queued. Only an authenticated row deduplicates an authenticated event.
 *   - Only VERIFIED envelopes may be processed. Terminal events apply the
 *     payment integration below; other events receive durable acknowledgement.
 *     Every other verification state is discarded without processing.
 */

/** The scheduler job type L2 owns and registers in `job-handlers.ts`. */
export const WEBHOOK_PROCESS_JOB_TYPE = 'webhook.process';

/** The per-inbox-row idempotency key for the processing job (one job per row). */
export function webhookProcessJobKey(inboxId: string): string {
  return `${WEBHOOK_PROCESS_JOB_TYPE}:${inboxId}`;
}

/**
 * The strict inbound envelope. Unknown top-level keys are REJECTED (house style /
 * M7 global constraint). `payload` is the opaque provider event, stored verbatim
 * as JSON; `externalEventId` is the provider's own event id and the dedup key.
 */
export const webhookEnvelopeSchema = z
  .object({
    externalEventId: z.string().min(1).max(200),
    eventType: z.string().min(1).max(200).optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;

/** The strict `webhook.process` job payload the handler validates at its boundary. */
export const webhookProcessPayloadSchema = z.object({ inboxId: z.string().min(1) }).strict();

export type RecordInboundWebhookInput = {
  /** The `[source]` path segment (provider slug), already validated by the route. */
  source: string;
  externalEventId: string;
  eventType?: string | null;
  payload: Prisma.InputJsonValue;
  verificationStatus: RestaurantWebhookVerificationStatus | 'UNVERIFIED';
  /** The public receiver supplies the original bytes for verification under the provider row lock. */
  providerSignature?: WebhookSignature;
};

export type RecordInboundWebhookResult = {
  inbox: Pick<
    RestaurantWebhookInbox,
    'id' | 'source' | 'externalEventId' | 'status' | 'verificationStatus' | 'receivedAt'
  >;
  /** True iff an envelope with the same `(org, source, externalEventId)` existed. */
  deduplicated: boolean;
  /** The enqueued processing job id, or null when this was a duplicate receipt. */
  enqueuedJobId: string | null;
};

const INBOX_SELECT = {
  id: true,
  source: true,
  externalEventId: true,
  status: true,
  verificationStatus: true,
  receivedAt: true,
} as const;

/**
 * Providers without a cryptographic verifier have no proof of origin.
 * UNVERIFIED is an admission result only and never enters the inbox.
 */
export const verifyWebhookSignatureStub: (input: {
  source: string;
  signature: string | null;
}) => 'UNVERIFIED' = () => 'UNVERIFIED';

export const MAX_PENDING_WEBHOOK_JOBS = 1000;

export class WebhookAdmissionError extends Error {
  constructor(
    readonly status: 401 | 404 | 429,
    message: string
  ) {
    super(message);
  }
}

/** Open one tenant-scoped transaction (same retype as scheduler.ts / dispatcher). */
function runInboxTransaction<T>(db: ScopedDb, work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * True only for a terminal event that a real verifier marked VERIFIED. The route
 * has always required an HMAC for `terminal.*`. Older non-terminal rows can
 * carry a VERIFIED status from the retired presence-only stub.
 */
function isAuthenticatedTerminal(
  eventType: string | null | undefined,
  verificationStatus: RestaurantWebhookVerificationStatus | null | undefined
): boolean {
  return verificationStatus === 'VERIFIED' && (eventType?.startsWith('terminal.') ?? false);
}

type ExistingInbox = RecordInboundWebhookResult['inbox'] & {
  eventType: string | null;
  organizationId: string;
};

async function findExistingInbox(
  tx: ScopedDb,
  source: string,
  externalEventId: string
): Promise<ExistingInbox | null> {
  // RLS scopes the lookup to the current organization, so `(source,
  // externalEventId)` is the effective dedup key without threading the org id.
  return tx.restaurantWebhookInbox.findFirst({
    where: { source, externalEventId },
    select: { ...INBOX_SELECT, eventType: true, organizationId: true },
  });
}

function duplicateOf(existing: ExistingInbox): RecordInboundWebhookResult {
  const { id, source, externalEventId, status, verificationStatus, receivedAt } = existing;
  return {
    inbox: { id, source, externalEventId, status, verificationStatus, receivedAt },
    deduplicated: true,
    enqueuedJobId: null,
  };
}

type WebhookSignature = {
  configId: string | null;
  terminalId: string | null;
  timestamp: string;
  signature: string;
  rawBody: Uint8Array;
};

async function lockAndVerifyProvider(tx: ScopedDb, input: RecordInboundWebhookInput) {
  const signed = input.providerSignature;
  // The tenant id comes only from the host-bound RLS transaction. A terminal
  // payload and an explicit config header must resolve to the same row.
  const rows = await tx.$queryRaw<(SigningConfig & { organizationId: string })[]>`
    SELECT id, "organizationId", "encryptedSigningSecret", "previousEncryptedSigningSecret",
           "previousSigningSecretExpiresAt", "legacySigningCutoff"
    FROM restaurant_terminal_provider_configs
    WHERE "organizationId" = current_setting('app.current_organization_id')
      AND source = ${input.source} AND mode = 'WEBHOOK'
      ${signed?.configId != null ? Prisma.sql`AND id = ${signed.configId}` : Prisma.empty}
      ${signed?.terminalId != null ? Prisma.sql`AND "externalTerminalId" = ${signed.terminalId}` : Prisma.empty}
    LIMIT ${signed ? 2 : 1} FOR SHARE
  `;
  const [config] = rows;
  if (!config) throw new WebhookAdmissionError(404, 'Unknown webhook source.');
  if (!signed) return; // Internal callers supply their previously verified admission result.
  if (rows.length !== 1) throw new WebhookAdmissionError(401, 'Ambiguous webhook configuration.');
  const verification = verifyProviderSignature(
    config,
    input.source,
    signed.rawBody,
    signed.signature,
    signed.timestamp
  );
  if (verification === 'FAILED') throw new WebhookAdmissionError(401, 'Invalid webhook signature.');
  if (verification === 'LEGACY') {
    // Explicit tx means audit failure rolls back admission. Duplicates are acceptances too.
    await recordAudit(
      {
        organizationId: config.organizationId,
        actorType: 'SYSTEM',
        source: 'SYSTEM',
        category: 'TERMINAL',
        operation: 'EXECUTE',
        action: 'restaurant.webhook.legacy_key_accepted',
        targetType: 'RestaurantTerminalProviderConfig',
        targetId: config.id,
        metadata: { source: input.source, externalEventId: input.externalEventId },
      },
      tx
    );
  }
}

/**
 * Record an inbound webhook and enqueue its processing job atomically. `db` must
 * be bound to the target organization's RLS scope (the route resolves the org
 * from the request host and opens the tenant client). A repeat of the same
 * `(source, externalEventId)` returns the existing row (`deduplicated: true`) and
 * enqueues nothing new; a concurrent duplicate that loses the unique-index race is
 * resolved to the same result. The one exception is an authenticated terminal
 * event meeting an unauthenticated row: the signed event replaces it and is queued.
 */
export async function recordInboundWebhook(
  db: ScopedDb,
  input: RecordInboundWebhookInput,
  now: Date = new Date()
): Promise<RecordInboundWebhookResult> {
  const { verificationStatus } = input;
  if (verificationStatus !== 'VERIFIED') {
    throw new WebhookAdmissionError(401, 'Invalid webhook signature.');
  }
  // Preserve promotion of legacy rows when a verified terminal event arrives.
  const authenticated = isAuthenticatedTerminal(input.eventType, verificationStatus);
  // An authenticated event deduplicates only against another authenticated row.
  const isDuplicate = (existing: ExistingInbox) =>
    !authenticated || isAuthenticatedTerminal(existing.eventType, existing.verificationStatus);

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runInboxTransaction(db, async (tx) => {
        await lockAndVerifyProvider(tx, input);
        // Serialize admission across all webhook sources for this tenant.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(
          'restaurant:webhook:' || current_setting('app.current_organization_id'), 0
        ))::text`;
        const existing = await findExistingInbox(tx, input.source, input.externalEventId);
        if (existing && isDuplicate(existing)) return duplicateOf(existing);
        const pending = await tx.restaurantJob.count({
          where: { type: WEBHOOK_PROCESS_JOB_TYPE, status: { in: ['QUEUED', 'RUNNING'] } },
        });
        if (pending >= MAX_PENDING_WEBHOOK_JOBS) {
          throw new WebhookAdmissionError(429, 'Too many pending webhook jobs.');
        }
        if (existing) {
          // Authenticated promotion: drop the unauthenticated row that holds this
          // event id. Its pending job, if any, no-ops once the row is gone.
          await tx.restaurantWebhookInbox.deleteMany({ where: { id: existing.id } });
          // Awaited in this transaction: the deletion and its audit commit together.
          await recordAudit(
            {
              organizationId: existing.organizationId,
              actorType: 'SYSTEM',
              source: 'SYSTEM',
              category: 'TERMINAL',
              operation: 'DELETE',
              action: 'restaurant.webhook.unauthenticated_row_replaced',
              targetType: 'RestaurantWebhookInbox',
              targetId: existing.id,
              metadata: {
                source: input.source,
                externalEventId: input.externalEventId,
                replacedEventType: existing.eventType,
                replacedVerificationStatus: existing.verificationStatus,
                replacedStatus: existing.status,
                replacedByEventType: input.eventType ?? null,
              },
            },
            tx
          );
        }

        const inbox = await tx.restaurantWebhookInbox.create({
          data: {
            source: input.source,
            externalEventId: input.externalEventId,
            eventType: input.eventType ?? null,
            payload: input.payload,
            verificationStatus,
            providerHmacVerified: input.providerSignature !== undefined,
            status: 'PENDING',
          },
          select: INBOX_SELECT,
        });

        // Same transaction as the inbox insert: the row and its processing job
        // commit together, so a received envelope always has a job to drain it.
        const { job } = await enqueue(
          tx,
          {
            type: WEBHOOK_PROCESS_JOB_TYPE,
            payload: { inboxId: inbox.id },
            idempotencyKey: webhookProcessJobKey(inbox.id),
          },
          now
        );

        return { inbox, deduplicated: false, enqueuedJobId: job.id };
      });
    } catch (error) {
      // Lost the create race: another request inserted the same (org, source,
      // externalEventId) first. Re-read and report it as a duplicate receipt,
      // unless an unauthenticated row won against an authenticated event: then
      // retry once so the promotion above replaces it.
      if (error instanceof SchedulerError && error.reason === 'WEBHOOK_CAPACITY') {
        throw new WebhookAdmissionError(429, error.message);
      }
      if (isUniqueViolation(error) && attempt < 2) continue;
      throw error;
    }
  }
}

/**
 * The `webhook.process` handler (registered in `job-handlers.ts`). Idempotent: it
 * re-reads the inbox row, no-ops if the row is gone or already left `PENDING`
 * (a retry after a crash), and otherwise moves it to a terminal state — `DISCARDED`
 * unless signature verification is VERIFIED (never processed), else `PROCESSED`.
 * Terminal events use the payment integration; other verified events receive
 * durable acknowledgement.
 */
export const processInboundWebhookHandler: RestaurantJobHandler = async ({ db, job }) => {
  const { inboxId } = webhookProcessPayloadSchema.parse(job.payload);
  const now = new Date();

  const row = await db.restaurantWebhookInbox.findUnique({
    where: { id: inboxId },
    select: {
      id: true,
      source: true,
      externalEventId: true,
      eventType: true,
      payload: true,
      status: true,
      verificationStatus: true,
    },
  });
  if (!row || row.status !== 'PENDING') return;

  if (row.verificationStatus === 'VERIFIED' && row.eventType?.startsWith('terminal.')) {
    const event = terminalEventSchema.parse(row.payload);
    await processTerminalEvent(db, {
      source: row.source,
      externalEventId: row.externalEventId,
      event,
      requiredMode: 'WEBHOOK',
    });
  }
  await runInboxTransaction(db, async (tx) => {
    const terminalStatus = row.verificationStatus === 'VERIFIED' ? 'PROCESSED' : 'DISCARDED';
    await tx.restaurantWebhookInbox.update({
      where: { id: inboxId },
      data: {
        status: terminalStatus,
        processedAt: now,
        attempts: { increment: 1 },
      },
    });
  });
};
