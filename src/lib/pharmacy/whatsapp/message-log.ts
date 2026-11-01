import 'server-only';

import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

import { WhatsAppProviderError, type WhatsAppSendResult } from './provider';

// PENDING alone is ambiguous (including legacy claims and crashed senders).
// Only a fresh, unattempted reservation carries this marker. Consume it in a
// committed compare-and-set BEFORE calling the provider; never expire/reset it.
const SEND_RESERVED = 'SEND_RESERVED';
const UNKNOWN_PROVIDER_OUTCOME = 'UNKNOWN_PROVIDER_OUTCOME';
const DEFINITIVE_FAILURE_REASONS = ['NOT_CONFIGURED', 'TEMPLATE_NOT_CONFIGURED', 'SEND_FAILED'];

type SendOutcome = 'SENT' | 'PREPARED' | 'UNKNOWN' | 'FAILED' | 'DUPLICATE';

export type MessageLogKind =
  | 'REFILL_REMINDER'
  | 'ORDER_REQUEST'
  | 'ORDER_CONFIRMATION'
  | 'ORDER_FALLBACK'
  | 'OPT_OUT'
  | 'OPT_IN'
  | 'CONSENT_ACK';

export type MessageLogEntry = {
  organizationId: string;
  kind: MessageLogKind;
  dedupeKey: string;
  branchId?: string | null;
  customerId?: string | null;
  patientId?: string | null;
  phoneLast4?: string | null;
  templateName?: string | null;
  refillCaptureId?: string | null;
  orderId?: string | null;
  dueDate?: string | null;
};

/**
 * Claims `dedupeKey` for the organization. Returns the new log id, or null when
 * the key was already claimed (a duplicate reminder run or webhook retry).
 */
type MessageLogClaim = MessageLogEntry & {
  direction: 'OUTBOUND' | 'INBOUND';
  status: 'PENDING' | 'RECEIVED';
  providerMessageId?: string;
};

/** Reuse the caller's transaction when a claim must commit with its effect. */
export async function claimMessageLogInTransaction(db: ScopedDb, entry: MessageLogClaim) {
  const created = await db.pharmacyMessageLog.createManyAndReturn({
    data: [entry.direction === 'OUTBOUND' ? { ...entry, error: SEND_RESERVED } : entry],
    skipDuplicates: true,
    select: { id: true },
  });
  return created[0]?.id ?? null;
}

export async function claimMessageLog(entry: MessageLogClaim): Promise<string | null> {
  return withTenantDb(entry.organizationId, (db) => claimMessageLogInTransaction(db, entry));
}

export async function updateMessageLog(
  organizationId: string,
  id: string,
  data: {
    status?: 'PENDING' | 'SENT' | 'FAILED' | 'IGNORED';
    providerMessageId?: string;
    error?: string | null;
    customerId?: string;
    orderId?: string;
    branchId?: string;
  }
) {
  // Do not hydrate unrelated, unmigrated inherited growth/campaign fields.
  await withTenantDb(organizationId, (db) =>
    db.pharmacyMessageLog.update({ where: { id }, data, select: { id: true } })
  );
}

/**
 * Reserve a new outbound key. Retries of existing reservations must use the
 * same sendClaimedMessage authority gate as the original sender.
 */
export async function sendAndLog(
  entry: MessageLogEntry,
  send: () => Promise<WhatsAppSendResult>
): Promise<SendOutcome> {
  const logId = await claimMessageLog({ ...entry, direction: 'OUTBOUND', status: 'PENDING' });
  if (!logId) return 'DUPLICATE';
  return sendClaimedMessage(entry, logId, send);
}

/**
 * Reservation has already committed with its eligibility checks. The atomic
 * transition below is shared by the original sender and every retry, scoped to
 * the exact tenant/outbound/key/id. It commits before any external side effect.
 *
 * A zero-row result is NOT permission to send: SENT, mock preparation, unknown
 * outcomes (even PENDING with no error), and another in-flight sender all fail
 * closed. Only an unattempted reservation or a recorded definitive rejection
 * may acquire authority. No lock is held across a provider call, and a crash or
 * post-acceptance log failure leaves the durable unknown state non-retryable.
 */
export async function sendClaimedMessage(
  entry: MessageLogEntry,
  logId: string,
  send: () => Promise<WhatsAppSendResult>
): Promise<SendOutcome> {
  const authority = await withTenantDb(entry.organizationId, (db) =>
    db.pharmacyMessageLog.updateMany({
      where: {
        id: logId,
        organizationId: entry.organizationId,
        direction: 'OUTBOUND',
        dedupeKey: entry.dedupeKey,
        OR: [
          { status: 'PENDING', error: SEND_RESERVED },
          { status: 'FAILED', error: { in: DEFINITIVE_FAILURE_REASONS } },
        ],
      },
      data: { status: 'PENDING', error: UNKNOWN_PROVIDER_OUTCOME },
    })
  );
  if (authority.count !== 1) return 'DUPLICATE';

  let result: WhatsAppSendResult;
  try {
    result = await send();
  } catch (error) {
    const definitive = error instanceof WhatsAppProviderError && error.definitive;
    await updateMessageLog(entry.organizationId, logId, {
      status: definitive ? 'FAILED' : 'PENDING',
      // Never persist arbitrary transport errors: they can contain message/recipient data.
      error: definitive ? error.reason : UNKNOWN_PROVIDER_OUTCOME,
    });
    return definitive ? 'FAILED' : 'UNKNOWN';
  }
  const outcome =
    result.acceptedByProvider === true
      ? 'SENT'
      : result.acceptedByProvider === false
        ? 'PREPARED'
        : 'UNKNOWN';
  // Keep the provider call outside persistence error handling. A failed log
  // update after provider acceptance must not overwrite the claim as FAILED.
  await updateMessageLog(entry.organizationId, logId, {
    status: outcome === 'SENT' ? 'SENT' : outcome === 'PREPARED' ? 'IGNORED' : 'PENDING',
    providerMessageId: result.providerMessageId,
    ...(outcome === 'PREPARED'
      ? { error: 'MOCK_PREPARED' }
      : outcome === 'UNKNOWN'
        ? { error: UNKNOWN_PROVIDER_OUTCOME }
        : { error: null }),
  });
  return outcome;
}
