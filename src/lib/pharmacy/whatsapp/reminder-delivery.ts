import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

// Fail closed: unknown, throttling and transient error codes never enable SMS.
// Meta error reference: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/
const PERMANENT_DELIVERY_ERRORS = new Set([131026, 131031, 132001, 132015, 132016]);

/** Called only after signature, tenant and sender ownership validation. */
export async function recordReminderDelivery(
  db: ScopedDb,
  organizationId: string,
  input: {
    messageId: string;
    state: 'DELIVERED' | 'FAILED' | 'PROVIDER_ACCEPTED';
    occurredAt: Date;
    errorCodes: number[];
  },
  now = new Date()
) {
  if (input.occurredAt > now || input.state === 'PROVIDER_ACCEPTED') return;
  const delivered = input.state === 'DELIVERED';
  if (!delivered && !input.errorCodes.some((code) => PERMANENT_DELIVERY_ERRORS.has(code))) return;
  // Delivery confirmation wins over a later/replayed failure. Only reminder
  // logs qualify; marketing evidence remains in its existing event ledger.
  await db.pharmacyMessageLog.updateMany({
    where: {
      organizationId,
      channel: 'WHATSAPP',
      direction: 'OUTBOUND',
      kind: { in: ['REFILL_REMINDER', 'KHATA_REMINDER'] },
      providerMessageId: input.messageId,
      status: { in: delivered ? ['SENT', 'PENDING', 'FAILED'] : ['SENT', 'PENDING'] },
      // Meta timestamps have second precision; include the whole second in
      // which this claim was created, while rejecting genuinely older evidence.
      createdAt: { lt: new Date(input.occurredAt.getTime() + 1000) },
      OR: [{ error: null }, { error: { not: 'DELIVERY_CONFIRMED' } }],
    },
    data: {
      status: delivered ? 'SENT' : 'FAILED',
      error: delivered ? 'DELIVERY_CONFIRMED' : 'WHATSAPP_DELIVERY_FAILED',
    },
  });
  // The scheduled reminder jobs claim the SMS in local daytime. Keeping the
  // failure on the original log also survives webhook retries and quiet hours.
}
