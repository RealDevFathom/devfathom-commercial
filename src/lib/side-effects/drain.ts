import { createHmac } from 'node:crypto';

import type { Prisma } from '@/generated/prisma/client';
import { sendEmail } from '@/lib/email';
import { deliverWebhookRequest } from '@/lib/webhooks/safe-url';

const BATCH = 25;
/** A claimed row stays locked to this worker until delivery finishes. Five minutes covers a full batch. */
export const STALE_CLAIM_MS = 5 * 60 * 1000;
const WEBHOOK_TIMEOUT_MS = 5_000;
export const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 15 * 60 * 1000;
export const DELIVERED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** One cron call drains at most this many organizations, oldest due work first. */
export const DRAIN_ORG_LIMIT = 50;
/** Stop before the next organization once a call has used about four minutes. */
export const DRAIN_TIME_BUDGET_MS = 240_000;

/**
 * Claim pending rows without blocking on a row another worker already locked.
 * The increment happens in the same statement as the status change.
 */
export const CLAIM_SQL = `WITH picked AS (
  SELECT id FROM "outbound_effects"
  WHERE status = 'PENDING' AND "availableAt" <= NOW()
  ORDER BY "createdAt"
  FOR UPDATE SKIP LOCKED
  LIMIT $1
)
UPDATE "outbound_effects" AS effect
SET status = 'PROCESSING',
    attempts = effect.attempts + 1,
    "updatedAt" = NOW()
FROM picked
WHERE effect.id = picked.id
RETURNING effect.id, effect.kind, effect.payload, effect.attempts`;

/** Organizations with work the per-tenant drain should pick up, including claims older than the stale window. */
export const DUE_ORGANIZATIONS_SQL = `SELECT "organizationId"
FROM "outbound_effects"
WHERE (status = 'PENDING' AND "availableAt" <= NOW())
   OR (status = 'PROCESSING' AND "updatedAt" <= NOW() - ($1::int * INTERVAL '1 millisecond'))
GROUP BY "organizationId"
ORDER BY MIN("createdAt"), "organizationId"
LIMIT $2`;

/** Drop recipient email, name, and HTML from dead-lettered email rows. Other fields stay for diagnosis. */
export const SCRUB_DEAD_EMAIL_SQL = `UPDATE "outbound_effects"
SET payload = CASE
  WHEN jsonb_typeof(payload->'to') = 'object'
    THEN jsonb_set(payload - 'html', '{to}', (payload->'to') - 'email' - 'name', true)
  ELSE payload - 'html'
END
WHERE kind = 'email'
  AND status = 'DEAD'
  AND (
    payload ? 'html'
    OR (
      jsonb_typeof(payload->'to') = 'object'
      AND ((payload->'to') ? 'email' OR (payload->'to') ? 'name')
    )
  )`;

type EffectRow = {
  id: string;
  kind: string;
  payload: Prisma.JsonValue;
  attempts: number;
};

export type WebhookEndpoint = { url: string; secret: string; active: boolean };

export type EffectOutcome = {
  ok: boolean;
  error: string | null;
  delivery?: {
    webhookId: string;
    event: string;
    payload: Prisma.InputJsonValue;
    statusCode: number | null;
    success: boolean;
    error: string | null;
  };
};

type EffectDb = {
  $queryRawUnsafe: <T>(sql: string, ...params: unknown[]) => Promise<T>;
  $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<unknown>;
  outboundEffect: {
    update: (args: {
      where: { id: string };
      data: {
        status: string;
        lastError?: string | null;
        availableAt?: Date;
        payload?: Prisma.InputJsonValue;
      };
    }) => Promise<unknown>;
    updateMany: (args: {
      where: {
        status: string;
        updatedAt?: { lt: Date };
        attempts?: { lt: number } | { gte: number };
      };
      data: { status: string; availableAt?: Date };
    }) => Promise<unknown>;
    deleteMany: (args: { where: { status: string; updatedAt: { lt: Date } } }) => Promise<unknown>;
  };
  webhookDelivery: {
    create: (args: { data: NonNullable<EffectOutcome['delivery']> }) => Promise<unknown>;
  };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Retry with exponential backoff, then leave the row dead-lettered. */
export function failureDisposition(
  attempts: number,
  now = Date.now()
): { status: 'PENDING' | 'DEAD'; availableAt: Date } {
  if (attempts >= MAX_ATTEMPTS) return { status: 'DEAD', availableAt: new Date(now) };
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(attempts - 1, 0), BACKOFF_CAP_MS);
  return { status: 'PENDING', availableAt: new Date(now + delay) };
}

export function deliveredRetentionCutoff(now = Date.now()): Date {
  return new Date(now - DELIVERED_RETENTION_MS);
}

/** Remove the recipient email, name, and HTML from a dead-lettered email payload. */
export function scrubDeadEmailPayload(payload: Prisma.JsonValue): Prisma.InputJsonValue {
  const record = asRecord(payload) ?? {};
  const next: Record<string, unknown> = { ...record };
  delete next.html;
  const to = asRecord(next.to);
  if (to) {
    const rest = { ...to };
    delete rest.email;
    delete rest.name;
    next.to = rest;
  }
  return next as Prisma.InputJsonValue;
}

/**
 * Deliver one committed outbox row. The webhook secret is loaded by the caller
 * at send time. Failures stay generic: tenant-visible errors must not include
 * socket or DNS text.
 */
export async function runEffect(
  row: Pick<EffectRow, 'id' | 'kind' | 'payload'>,
  lookupWebhook: (webhookId: string) => Promise<WebhookEndpoint | null> = async () => null,
  organizationId?: string
): Promise<EffectOutcome> {
  if (row.kind === 'pharmacy-back-in-stock') {
    const payload = asRecord(row.payload);
    if (
      !organizationId ||
      typeof payload?.branchId !== 'string' ||
      typeof payload.notificationId !== 'string'
    )
      return { ok: false, error: 'Delivery failed' };
    const { deliverBackInStockNotification } = await import('@/lib/pharmacy/back-in-stock-worker');
    await deliverBackInStockNotification(
      { organizationId, branchId: payload.branchId },
      payload.notificationId
    );
    // The notification owns its durable delivery claim and audit outcome. An
    // ambiguous send must never be automatically retried by this outer outbox.
    return { ok: true, error: null };
  }
  if (row.kind === 'email') return runEmail(row.payload);
  if (row.kind === 'webhook') return runWebhook(row, lookupWebhook);
  return { ok: false, error: 'Delivery failed' };
}

async function runEmail(payload: Prisma.JsonValue): Promise<EffectOutcome> {
  const record = asRecord(payload);
  const to = asRecord(record?.to);
  if (
    !record ||
    !to ||
    typeof to.email !== 'string' ||
    typeof to.name !== 'string' ||
    typeof record.subject !== 'string' ||
    typeof record.html !== 'string' ||
    typeof record.text !== 'string'
  ) {
    return { ok: false, error: 'Delivery failed' };
  }
  try {
    await sendEmail({
      to: { email: to.email, name: to.name },
      subject: record.subject,
      html: record.html,
      text: record.text,
    });
    return { ok: true, error: null };
  } catch {
    return { ok: false, error: 'Delivery failed' };
  }
}

async function runWebhook(
  row: Pick<EffectRow, 'id' | 'payload'>,
  lookupWebhook: (webhookId: string) => Promise<WebhookEndpoint | null>
): Promise<EffectOutcome> {
  const record = asRecord(row.payload);
  if (
    !record ||
    typeof record.webhookId !== 'string' ||
    typeof record.event !== 'string' ||
    typeof record.body !== 'string'
  ) {
    return { ok: false, error: 'Delivery failed' };
  }
  const endpoint = await lookupWebhook(record.webhookId);
  if (!endpoint?.active || !endpoint.secret || !endpoint.url) {
    return { ok: false, error: 'Delivery failed' };
  }
  const signature = createHmac('sha256', endpoint.secret).update(record.body).digest('hex');
  const result = await deliverWebhookRequest(endpoint.url, {
    headers: {
      'Content-Type': 'application/json',
      'X-DevFathom-Event': record.event,
      'X-DevFathom-Delivery-Id': row.id,
      'X-DevFathom-Signature': `sha256=${signature}`,
    },
    body: record.body,
    timeoutMs: WEBHOOK_TIMEOUT_MS,
  });
  const eventPayload = (record.payload ?? {}) as Prisma.InputJsonValue;
  return {
    ok: result.success,
    error: result.error,
    delivery: {
      webhookId: record.webhookId,
      event: record.event,
      payload: eventPayload,
      statusCode: result.statusCode,
      success: result.success,
      error: result.error,
    },
  };
}

export async function requeueStale(db: EffectDb, now = Date.now()): Promise<void> {
  const staleBefore = new Date(now - STALE_CLAIM_MS);
  await db.outboundEffect.updateMany({
    where: {
      status: 'PROCESSING',
      updatedAt: { lt: staleBefore },
      attempts: { gte: MAX_ATTEMPTS },
    },
    data: { status: 'DEAD' },
  });
  await db.outboundEffect.updateMany({
    where: {
      status: 'PROCESSING',
      updatedAt: { lt: staleBefore },
      attempts: { lt: MAX_ATTEMPTS },
    },
    data: { status: 'PENDING', availableAt: new Date(now) },
  });
  await db.$executeRawUnsafe(SCRUB_DEAD_EMAIL_SQL);
}

export async function retainDelivered(db: EffectDb, now = Date.now()): Promise<void> {
  const cutoff = deliveredRetentionCutoff(now);
  await db.outboundEffect.deleteMany({
    where: { status: 'DONE', updatedAt: { lt: cutoff } },
  });
  await db.outboundEffect.deleteMany({
    where: { status: 'DEAD', updatedAt: { lt: cutoff } },
  });
  await db.outboundEffect.deleteMany({
    where: { status: 'FAILED', updatedAt: { lt: cutoff } },
  });
}

export async function claimEffects(db: EffectDb): Promise<EffectRow[]> {
  const rows = await db.$queryRawUnsafe<EffectRow[]>(CLAIM_SQL, BATCH);
  return rows.map((row) => ({ ...row, attempts: Number(row.attempts) }));
}

export async function recordOutcome(
  db: EffectDb,
  row: Pick<EffectRow, 'id' | 'attempts'> & Partial<Pick<EffectRow, 'kind' | 'payload'>>,
  outcome: EffectOutcome,
  now = Date.now()
): Promise<void> {
  if (outcome.ok) {
    await db.outboundEffect.update({
      where: { id: row.id },
      data: { status: 'DONE', lastError: null },
    });
  } else {
    const next = failureDisposition(row.attempts, now);
    await db.outboundEffect.update({
      where: { id: row.id },
      data: {
        status: next.status,
        lastError: outcome.error,
        availableAt: next.availableAt,
        ...(next.status === 'DEAD' && row.kind === 'email'
          ? { payload: scrubDeadEmailPayload(row.payload ?? null) }
          : {}),
      },
    });
  }
  if (outcome.delivery) await db.webhookDelivery.create({ data: outcome.delivery });
}

export async function listDueOrganizationIds(
  query: (sql: string, staleMs: number, limit: number) => Promise<Array<{ organizationId: string }>>
): Promise<string[]> {
  const rows = await query(DUE_ORGANIZATIONS_SQL, STALE_CLAIM_MS, DRAIN_ORG_LIMIT);
  return rows.map((row) => row.organizationId).filter((id) => id.length > 0);
}

/**
 * Drain organizations with due or stale outbox work so a retry does not wait
 * for that organization's next enqueue. One call takes at most
 * {@link DRAIN_ORG_LIMIT} organizations and stops once {@link DRAIN_TIME_BUDGET_MS}
 * has elapsed. Platform admin lists the ids; each drain runs under that
 * tenant's row level security.
 */
export async function drainDueOrganizations(options?: {
  now?: () => number;
  budgetMs?: number;
}): Promise<{ organizations: number }> {
  const now = options?.now ?? Date.now;
  const budgetMs = options?.budgetMs ?? DRAIN_TIME_BUDGET_MS;
  const started = now();
  const { withPlatformDb } = await import('@/lib/tenancy/scoped-db');
  const organizationIds = await withPlatformDb((db) =>
    listDueOrganizationIds((sql, staleMs, limit) =>
      db.$queryRawUnsafe<Array<{ organizationId: string }>>(sql, staleMs, limit)
    )
  );
  let drained = 0;
  for (const organizationId of organizationIds) {
    if (drained > 0 && now() - started >= budgetMs) break;
    await drainOrganization(organizationId).catch((error) => {
      console.error('[side-effects] drain failed', error instanceof Error ? error.name : 'error');
    });
    drained += 1;
  }
  return { organizations: drained };
}

/**
 * Claim a small batch of this organization's pending effects, deliver them
 * outside the claim transaction, then record the outcome. SKIP LOCKED lets a
 * second worker take the next free rows instead of waiting.
 */
export async function drainOrganization(organizationId: string): Promise<void> {
  const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
  const claimed = await withTenantDb(
    organizationId,
    async (db) => {
      const effectDb = db as unknown as EffectDb;
      await requeueStale(effectDb);
      await retainDelivered(effectDb);
      return claimEffects(effectDb);
    },
    { skipDrain: true, timeout: 15_000 }
  );

  for (const row of claimed) {
    const outcome = await runEffect(
      row,
      (webhookId) =>
        withTenantDb(
          organizationId,
          async (db) =>
            db.webhook.findUnique({
              where: { id: webhookId },
              select: { url: true, secret: true, active: true },
            }),
          { skipDrain: true, timeout: 10_000 }
        ),
      organizationId
    );
    await withTenantDb(
      organizationId,
      async (db) => {
        await recordOutcome(db as unknown as EffectDb, row, outcome);
      },
      { skipDrain: true, timeout: 10_000 }
    ).catch((error) => {
      console.error(
        '[side-effects] status update failed',
        error instanceof Error ? error.name : 'error'
      );
    });
  }
}
