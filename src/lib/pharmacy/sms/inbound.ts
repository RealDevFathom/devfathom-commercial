import 'server-only';

import { withTenantDb } from '@/lib/tenancy/scoped-db';

import { lockCustomerConsent } from '../consent-writer';
import { claimMessageLogInTransaction, sendAndLog } from '../whatsapp/message-log';
import { consentKeyword, normalizeWhatsAppNumber, phoneLast4 } from '../whatsapp/messages';
import type { SmsConfig, SmsInboundMessage, SmsProvider } from './provider';
import { SMS_TEMPLATES } from './templates';

export type SmsInboundOutcome =
  | 'DUPLICATE'
  | 'IGNORED'
  | 'UNKNOWN_SENDER'
  | 'STALE_CONSENT'
  | 'OPTED_OUT'
  | 'OPTED_IN';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * #723 — SMS STOP/START. Uses the same keyword list as WhatsApp
 * (`consentKeyword`: STOP / UNSUBSCRIBE / band karo / بند …). STOP sets
 * `smsOptIn = false`, which blocks every SMS fallback until START. The consent
 * change commits with its replay claim; no message text is persisted. SMS is a
 * utility channel only, so any other text is ignored (no order intake by SMS).
 */
export async function handleInboundSms(
  organizationId: string,
  config: SmsConfig,
  provider: SmsProvider,
  message: SmsInboundMessage,
  now = new Date()
): Promise<SmsInboundOutcome> {
  const keyword = consentKeyword(message.text);
  if (!keyword) return 'IGNORED';
  if (!Number.isFinite(message.receivedAt.getTime())) throw new Error('Invalid consent timestamp.');
  // Gateway clock skew must never drop a STOP: a future timestamp is read as now.
  const at = message.receivedAt > now ? now : message.receivedAt;
  const optIn = keyword === 'START';
  const last4 = phoneLast4(message.from);

  const { knownSender, customerId, inboundId, staleConsent } = await withTenantDb(organizationId, async (db) => {
    // A phone controls consent for every active customer using that number.
    // Do not use the order-intake resolver, which rejects ambiguous identities.
    const candidates = await db.pharmacyCustomer.findMany({
      where: { organizationId, active: true, patient: { phone: { endsWith: last4 } } },
      select: { id: true, patientId: true, patient: { select: { phone: true } } },
      orderBy: [{ patientId: 'asc' }, { id: 'asc' }],
    });
    const customers = candidates.filter(
      (candidate) => normalizeWhatsAppNumber(candidate.patient.phone) === message.from
    );
    const customer = customers.length === 1 ? customers[0]! : null;
    const inboundId = await claimMessageLogInTransaction(db, {
      organizationId,
      channel: 'SMS',
      direction: 'INBOUND',
      status: 'RECEIVED',
      kind: optIn ? 'OPT_IN' : 'OPT_OUT',
      dedupeKey: `sms-in:${message.providerMessageId}`,
      customerId: customer?.id ?? null,
      phoneLast4: last4,
      providerMessageId: message.providerMessageId,
    });
    if (inboundId && customers.length === 0)
      await db.pharmacyMessageLog.update({
        where: { id: inboundId },
        data: { status: 'IGNORED', error: 'UNKNOWN_SENDER' },
      });
    let changedCount = 0;
    if (inboundId && customers.length) {
      for (const match of customers) {
        await lockCustomerConsent(db, organizationId, match.id);
        const changed = await db.pharmacyCustomer.updateMany({
          where: {
            organizationId,
            id: match.id,
            OR: [
              { smsOptInChangedAt: null },
              { smsOptInChangedAt: { lt: at } },
              // STOP wins an equal-time race, as on WhatsApp.
              ...(!optIn ? [{ smsOptInChangedAt: at }] : []),
            ],
          },
          data: { smsOptIn: optIn, smsOptInChangedAt: at },
        });
        changedCount += changed.count;
      }
      if (changedCount === 0)
        await db.pharmacyMessageLog.update({
          where: { id: inboundId },
          data: { status: 'IGNORED', error: 'STALE_CONSENT' },
        });
    }
    return {
      knownSender: customers.length > 0,
      customerId: customer?.id ?? null,
      inboundId,
      staleConsent: customers.length > 0 && changedCount === 0,
    };
  });
  if (!inboundId) return 'DUPLICATE';
  if (!knownSender) return 'UNKNOWN_SENDER';
  if (staleConsent) return 'STALE_CONSENT';

  // The acknowledgement answers the customer's own request; only for fresh messages.
  const age = now.getTime() - at.getTime();
  if (age >= 0 && age < DAY_MS) {
    await sendAndLog(
      {
        organizationId,
        channel: 'SMS',
        kind: 'CONSENT_ACK',
        dedupeKey: `sms-out:${message.providerMessageId}`,
        customerId,
        phoneLast4: last4,
      },
      () =>
        provider.sendText({
          to: message.from,
          body: optIn
            ? SMS_TEMPLATES.optedIn(config.language)
            : SMS_TEMPLATES.optedOut(config.language),
        })
    );
  }
  return optIn ? 'OPTED_IN' : 'OPTED_OUT';
}
