import 'server-only';

import { z } from 'zod';

import {
  Prisma,
  type RestaurantWebhookInbox,
  type RestaurantWebhookVerificationStatus,
} from '@/generated/prisma/client';
import type { RestaurantJobHandler } from '@/lib/restaurant/job-handlers-core';
import { enqueue } from '@/lib/restaurant/scheduler';
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
 * Conservative M7 defaults (recorded in BUILD-ASSUMPTIONS):
 *   - Signature verification is STUBBED. No provider secret is configured in M7,
 *     so {@link verifyWebhookSignatureStub} records a status from the presence of a
 *     signature header — never a real HMAC/asymmetric check. It is the seam a
 *     provider adapter replaces; `FAILED` is reserved for that real verifier.
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
  /** The raw signature header value, if the caller presented one (STUB input). */
  signature?: string | null;
  verificationStatus?: RestaurantWebhookVerificationStatus;
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
 * STUB (D21) signature verification. No provider secret is configured in M7, so
 * this performs NO cryptographic check: it records `VERIFIED` when the caller
 * presented a non-empty signature and `PENDING` otherwise (awaiting a real
 * verifier). This is the extension point a provider adapter replaces to return the
 * real `VERIFIED`/`FAILED` — the receiver claims no more than it does.
 */
export function verifyWebhookSignatureStub(input: {
  source: string;
  signature: string | null;
}): RestaurantWebhookVerificationStatus {
  return input.signature != null && input.signature.trim().length > 0 ? 'VERIFIED' : 'PENDING';
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
 * stores a `terminal.*` row only after its HMAC passes; every other row carries
 * either no check or the presence-only stub, so it is unauthenticated.
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
  const verificationStatus =
    input.verificationStatus ??
    verifyWebhookSignatureStub({ source: input.source, signature: input.signature ?? null });
  // Only an explicit verifier result counts; the stub never authenticates.
  const authenticated = isAuthenticatedTerminal(input.eventType, input.verificationStatus);
  // An authenticated event deduplicates only against another authenticated row.
  const isDuplicate = (existing: ExistingInbox) =>
    !authenticated || isAuthenticatedTerminal(existing.eventType, existing.verificationStatus);

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runInboxTransaction(db, async (tx) => {
        const existing = await findExistingInbox(tx, input.source, input.externalEventId);
        if (existing) {
          if (isDuplicate(existing)) return duplicateOf(existing);
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
      if (isUniqueViolation(error)) {
        const existing = await runInboxTransaction(db, (tx) =>
          findExistingInbox(tx, input.source, input.externalEventId)
        );
        if (existing && isDuplicate(existing)) return duplicateOf(existing);
        if (existing && attempt < 2) continue;
      }
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
