import 'server-only';

import { withTenantDb } from '@/lib/tenancy/scoped-db';

import type { WhatsAppSendResult } from './provider';

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
export async function claimMessageLog(
  entry: MessageLogEntry & {
    direction: 'OUTBOUND' | 'INBOUND';
    status: 'PENDING' | 'RECEIVED';
    providerMessageId?: string;
  }
): Promise<string | null> {
  const { organizationId, ...data } = entry;
  return withTenantDb(organizationId, async (db) => {
    const created = await db.pharmacyMessageLog.createManyAndReturn({
      data: [{ organizationId, ...data }],
      skipDuplicates: true,
      select: { id: true },
    });
    return created[0]?.id ?? null;
  });
}

export async function updateMessageLog(
  organizationId: string,
  id: string,
  data: {
    status?: 'SENT' | 'FAILED' | 'IGNORED';
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
): Promise<'SENT' | 'FAILED' | 'DUPLICATE'> {
  const logId = await claimMessageLog({ ...entry, direction: 'OUTBOUND', status: 'PENDING' });
  if (!logId) return 'DUPLICATE';
  try {
    const result = await send();
    await updateMessageLog(entry.organizationId, logId, {
      status: 'SENT',
      providerMessageId: result.providerMessageId,
    });
    return 'SENT';
  } catch (error) {
    await updateMessageLog(entry.organizationId, logId, {
      status: 'FAILED',
      error: (error instanceof Error ? error.message : 'SEND_FAILED').slice(0, 200),
    });
    return 'FAILED';
  }
}
