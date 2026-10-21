import { createHmac } from 'node:crypto';

import type { Prisma } from '@/generated/prisma/client';
import { sendEmail } from '@/lib/email';
import { deliverWebhookRequest } from '@/lib/webhooks/safe-url';

const BATCH = 25;
const STALE_MS = 2 * 60 * 1000;
const WEBHOOK_TIMEOUT_MS = 5_000;
export const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 15 * 60 * 1000;
export const DELIVERED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
  outboundEffect: {
    update: (args: {
      where: { id: string };
      data: {
        status: string;
        lastError?: string | null;
        availableAt?: Date;
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

/**
 * Deliver one committed outbox row. The webhook secret is loaded by the caller
 * at send time. Failures stay generic: tenant-visible errors must not include
 * socket or DNS text.
 */
export async function runEffect(
  row: Pick<EffectRow, 'id' | 'kind' | 'payload'>,
  lookupWebhook: (webhookId: string) => Promise<WebhookEndpoint | null> = async () => null
): Promise<EffectOutcome> {
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
  const staleBefore = new Date(now - STALE_MS);
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
}

export async function retainDelivered(db: EffectDb, now = Date.now()): Promise<void> {
  await db.outboundEffect.deleteMany({
    where: { status: 'DONE', updatedAt: { lt: deliveredRetentionCutoff(now) } },
  });
}

export async function claimEffects(db: EffectDb): Promise<EffectRow[]> {
  const rows = await db.$queryRawUnsafe<EffectRow[]>(CLAIM_SQL, BATCH);
  return rows.map((row) => ({ ...row, attempts: Number(row.attempts) }));
}

export async function recordOutcome(
  db: EffectDb,
  row: Pick<EffectRow, 'id' | 'attempts'>,
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
      data: { status: next.status, lastError: outcome.error, availableAt: next.availableAt },
    });
  }
  if (outcome.delivery) await db.webhookDelivery.create({ data: outcome.delivery });
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
    const outcome = await runEffect(row, (webhookId) =>
      withTenantDb(
        organizationId,
        async (db) =>
          db.webhook.findUnique({
            where: { id: webhookId },
            select: { url: true, secret: true, active: true },
          }),
        { skipDrain: true, timeout: 10_000 }
      )
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
