import { createHmac } from 'node:crypto';

import type { Prisma } from '@/generated/prisma/client';
import { sendEmail } from '@/lib/email';
import { deliverWebhookRequest } from '@/lib/webhooks/safe-url';

const BATCH = 25;
const STALE_MS = 2 * 60 * 1000;
const WEBHOOK_TIMEOUT_MS = 5_000;

type EffectRow = {
  id: string;
  kind: string;
  payload: Prisma.JsonValue;
};

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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Deliver one committed outbox row. Failures stay generic: tenant-visible
 * webhook errors must not include socket or DNS text.
 */
export async function runEffect(row: Pick<EffectRow, 'kind' | 'payload'>): Promise<EffectOutcome> {
  if (row.kind === 'email') return runEmail(row.payload);
  if (row.kind === 'webhook') return runWebhook(row.payload);
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

async function runWebhook(payload: Prisma.JsonValue): Promise<EffectOutcome> {
  const record = asRecord(payload);
  if (
    !record ||
    typeof record.webhookId !== 'string' ||
    typeof record.url !== 'string' ||
    typeof record.secret !== 'string' ||
    typeof record.event !== 'string' ||
    typeof record.body !== 'string'
  ) {
    return { ok: false, error: 'Delivery failed' };
  }
  const signature = createHmac('sha256', record.secret).update(record.body).digest('hex');
  const result = await deliverWebhookRequest(record.url, {
    headers: {
      'Content-Type': 'application/json',
      'X-DevFathom-Event': record.event,
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

/**
 * Claim a small batch of this organization's pending effects, deliver them
 * outside the claim transaction, then record the outcome. A second caller
 * cannot claim a row already moved to PROCESSING.
 */
export async function drainOrganization(organizationId: string): Promise<void> {
  const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
  const claimed = await withTenantDb(
    organizationId,
    async (db) => {
      await db.outboundEffect.updateMany({
        where: { status: 'PROCESSING', updatedAt: { lt: new Date(Date.now() - STALE_MS) } },
        data: { status: 'PENDING' },
      });
      const pending = await db.outboundEffect.findMany({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        take: BATCH,
        select: { id: true, kind: true, payload: true },
      });
      const rows: EffectRow[] = [];
      for (const row of pending) {
        const claim = await db.outboundEffect.updateMany({
          where: { id: row.id, status: 'PENDING' },
          data: { status: 'PROCESSING', attempts: { increment: 1 } },
        });
        if (claim.count === 1) rows.push(row);
      }
      return rows;
    },
    { skipDrain: true, timeout: 15_000 }
  );

  for (const row of claimed) {
    const outcome = await runEffect(row);
    await withTenantDb(
      organizationId,
      async (db) => {
        await db.outboundEffect.update({
          where: { id: row.id },
          data: { status: outcome.ok ? 'DONE' : 'FAILED', lastError: outcome.error },
        });
        if (outcome.delivery) {
          await db.webhookDelivery.create({ data: outcome.delivery });
        }
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
