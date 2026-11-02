import 'server-only';

import { lockCustomerConsent } from '@/lib/pharmacy/consent-writer';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

import { WhatsAppProviderError, type WhatsAppSendResult } from './provider';

export type MessageLogKind =
  | 'REFILL_REMINDER'
  | 'KHATA_REMINDER'
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
  customerDayKey?: string;
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
    data: [entry],
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
    error?: string;
    customerId?: string;
    orderId?: string;
    branchId?: string;
  }
) {
  await withTenantDb(organizationId, (db) => db.pharmacyMessageLog.update({ where: { id }, data }));
}

/**
 * At-most-once outbound send: the dedupe key is claimed before the provider is
 * called, so a crash between claim and send never produces a duplicate message.
 */
export async function sendAndLog(
  entry: MessageLogEntry,
  send: () => Promise<WhatsAppSendResult>
): Promise<'SENT' | 'PREPARED' | 'UNKNOWN' | 'FAILED' | 'DUPLICATE'> {
  const logId = await claimMessageLog({ ...entry, direction: 'OUTBOUND', status: 'PENDING' });
  if (!logId) return 'DUPLICATE';
  return sendClaimedMessage(entry, logId, send);
}

/** Reservation has already committed with its eligibility checks. */
export async function sendClaimedMessage(
  entry: MessageLogEntry,
  logId: string,
  send: () => Promise<WhatsAppSendResult>
): Promise<'SENT' | 'PREPARED' | 'UNKNOWN' | 'FAILED'> {
  // STOP acknowledgements must still send after the opt-out commits.
  if (
    entry.kind !== 'CONSENT_ACK' &&
    (entry.customerId || entry.kind === 'REFILL_REMINDER' || entry.kind === 'KHATA_REMINDER')
  ) {
    return withTenantDb(entry.organizationId, async (db) => {
      let customer = null;
      if (entry.customerId) {
        // Match STOP's patient-then-customer lock order before reading consent.
        await lockCustomerConsent(db, entry.organizationId, entry.customerId);
        customer = await db.pharmacyCustomer.findFirst({
          where: { organizationId: entry.organizationId, id: entry.customerId },
          select: { active: true, whatsappOptIn: true },
        });
      }
      if (!customer?.active || customer.whatsappOptIn !== true) {
        await db.pharmacyMessageLog.update({
          where: { id: logId },
          data: { status: 'IGNORED', error: 'OPTED_OUT_BEFORE_SEND' },
        });
        return 'PREPARED';
      }
      return sendAndRecord(db, logId, send);
    });
  }

  return sendAndRecord(null, logId, send, entry.organizationId);
}

async function sendAndRecord(
  db: ScopedDb | null,
  logId: string,
  send: () => Promise<WhatsAppSendResult>,
  organizationId?: string
): Promise<'SENT' | 'PREPARED' | 'UNKNOWN' | 'FAILED'> {
  const update = (data: Parameters<typeof updateMessageLog>[2]) =>
    db
      ? db.pharmacyMessageLog.update({ where: { id: logId }, data }).then(() => undefined)
      : updateMessageLog(organizationId!, logId, data);
  let result: WhatsAppSendResult;
  try {
    result = await send();
  } catch (error) {
    const definitive = error instanceof WhatsAppProviderError && error.definitive;
    await update({
      status: definitive ? 'FAILED' : 'PENDING',
      // Never persist arbitrary transport errors: they can contain message/recipient data.
      error: definitive ? error.reason : 'UNKNOWN_PROVIDER_OUTCOME',
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
  await update({
    status: outcome === 'SENT' ? 'SENT' : outcome === 'PREPARED' ? 'IGNORED' : 'PENDING',
    providerMessageId: result.providerMessageId,
    ...(outcome === 'PREPARED'
      ? { error: 'MOCK_PREPARED' }
      : outcome === 'UNKNOWN'
        ? { error: 'UNKNOWN_PROVIDER_OUTCOME' }
        : {}),
  });
  return outcome;
}
