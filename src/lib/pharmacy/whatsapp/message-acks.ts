import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { markRefillReminderSent } from '@/lib/pharmacy/refill-reminder-sender';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * Provider acknowledgements for outbound WhatsApp messages (the status
 * callbacks on the signed webhook). They advance the message log, never
 * backwards: SENT -> DELIVERED -> READ, and FAILED only from SENT.
 */
export type ProviderAckState = 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

export type ProviderAck = {
  providerMessageId: string;
  state: ProviderAckState;
  occurredAt: Date;
};

export type ProviderAckOutcome =
  | 'APPLIED'
  /** The log is already in this state: a webhook retry. */
  | 'DUPLICATE'
  /** An older state than the log's (out of order); nothing changes. */
  | 'STALE'
  /** No single outbound log the provider accepted carries this message id. */
  | 'UNBOUND'
  /** Unusable timestamp (invalid or in the future). */
  | 'REJECTED';

const STATUS_WORDS = new Map<string, ProviderAckState>([
  ['sent', 'SENT'],
  ['delivered', 'DELIVERED'],
  ['read', 'READ'],
  ['failed', 'FAILED'],
]);

/** Meta status word -> ack state; any other status is not an acknowledgement. */
export function providerAckState(status: string): ProviderAckState | null {
  return STATUS_WORDS.get(status) ?? null;
}

/** States the provider reached after accepting the message, in order. */
const ACCEPTED_RANK = new Map<string, number>([
  ['SENT', 1],
  ['DELIVERED', 2],
  ['READ', 3],
]);

function transition(current: string, next: ProviderAckState): ProviderAckOutcome {
  if (current === 'FAILED') return next === 'FAILED' ? 'DUPLICATE' : 'STALE';
  const rank = ACCEPTED_RANK.get(current);
  // PENDING / IGNORED rows were never accepted by the provider: an ack cannot
  // create that evidence, only follow it.
  if (rank === undefined) return 'UNBOUND';
  if (next === 'FAILED') return current === 'SENT' ? 'APPLIED' : 'STALE';
  const nextRank = ACCEPTED_RANK.get(next)!;
  return nextRank > rank ? 'APPLIED' : nextRank === rank ? 'DUPLICATE' : 'STALE';
}

/**
 * Apply one acknowledgement inside the caller's tenant transaction. The log
 * row is locked first, so concurrent callbacks for one message serialize; a
 * duplicate or stale ack changes nothing. A refill reminder's capture moves
 * QUEUED -> SENT in the same transaction, validated against this log
 * (`markRefillReminderSent`).
 */
export async function applyProviderAck(
  db: ScopedDb,
  organizationId: string,
  ack: ProviderAck,
  now = new Date()
): Promise<ProviderAckOutcome> {
  if (!Number.isFinite(ack.occurredAt.getTime()) || ack.occurredAt > now) return 'REJECTED';
  const logs = await db.$queryRaw<
    Array<{
      id: string;
      branchId: string | null;
      kind: string;
      status: string;
      refillCaptureId: string | null;
    }>
  >(Prisma.sql`
    SELECT "id", "branchId", "kind", "status", "refillCaptureId"
    FROM "pharmacy_message_logs"
    WHERE "organizationId" = ${organizationId} AND "providerMessageId" = ${ack.providerMessageId}
      AND "direction" = 'OUTBOUND'
    FOR UPDATE
  `);
  // Ambiguous evidence fails closed, like a missing log.
  if (logs.length !== 1) return 'UNBOUND';
  const log = logs[0]!;
  const outcome = transition(log.status, ack.state);
  if (outcome !== 'APPLIED') return outcome;

  await db.pharmacyMessageLog.updateMany({
    where: { organizationId, id: log.id, status: log.status },
    data: {
      status: ack.state,
      statusAt: ack.occurredAt,
      ...(ack.state === 'DELIVERED' ? { deliveredAt: ack.occurredAt } : {}),
      ...(ack.state === 'READ' ? { readAt: ack.occurredAt } : {}),
      ...(ack.state === 'FAILED' ? { error: 'PROVIDER_FAILURE' } : {}),
    },
  });
  if (
    ack.state !== 'FAILED' &&
    log.kind === 'REFILL_REMINDER' &&
    log.refillCaptureId &&
    log.branchId
  ) {
    await markRefillReminderSent(db, {
      organizationId,
      branchId: log.branchId,
      captureId: log.refillCaptureId,
      messageLogId: log.id,
      providerMessageId: ack.providerMessageId,
      sentAt: ack.occurredAt,
    });
  }
  return 'APPLIED';
}
