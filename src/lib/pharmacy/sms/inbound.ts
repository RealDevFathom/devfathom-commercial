import 'server-only';

import { withTenantDb } from '@/lib/tenancy/scoped-db';

import { lockCustomerConsent, writePatientConsent } from '../consent-writer';
import { findCustomerByWhatsApp } from '../whatsapp/inbound';
import { claimMessageLogInTransaction, sendAndLog } from '../whatsapp/message-log';
import { consentKeyword, phoneLast4 } from '../whatsapp/messages';
import { SMS_REPLIES } from './messages';
import type { SmsInboundMessage, SmsProvider } from './provider';

/** STOP on SMS withdraws SMS reminders and promotional consent on every channel. */
const STOP_REVOKED: ReadonlyArray<
  readonly [
    'REMINDERS' | 'MARKETING' | 'LOYALTY',
    'WHATSAPP' | 'SMS' | 'EMAIL' | 'PHONE' | 'IN_PERSON',
  ]
> = [
  ['REMINDERS', 'SMS'],
  ...(['MARKETING', 'LOYALTY'] as const).flatMap((purpose) =>
    (['WHATSAPP', 'SMS', 'EMAIL', 'PHONE', 'IN_PERSON'] as const).map(
      (channel) => [purpose, channel] as const
    )
  ),
];

export type SmsInboundOutcome =
  'DUPLICATE' | 'UNKNOWN_SENDER' | 'OPTED_OUT' | 'OPTED_IN' | 'STALE_CONSENT' | 'IGNORED';

/**
 * DEV-87 — handles one inbound SMS. Only STOP/START keywords act; SMS is not an
 * ordering channel, so any other text is logged as ignored. The consent effect
 * commits with its replay claim; the acknowledgement is sent afterwards.
 */
export async function handleInboundSmsMessage(
  organizationId: string,
  provider: SmsProvider,
  message: SmsInboundMessage,
  now = new Date()
): Promise<SmsInboundOutcome> {
  const keyword = consentKeyword(message.text);
  const last4 = phoneLast4(message.from);
  const outcome = await withTenantDb<{ result: SmsInboundOutcome; customerId?: string }>(
    organizationId,
    async (db) => {
      const customer = await findCustomerByWhatsApp(db, organizationId, message.from);
      const inboundId = await claimMessageLogInTransaction(db, {
        organizationId,
        channel: 'SMS',
        direction: 'INBOUND',
        status: 'RECEIVED',
        kind: keyword === 'STOP' ? 'OPT_OUT' : keyword === 'START' ? 'OPT_IN' : 'ORDER_REQUEST',
        dedupeKey: `sms-in:${message.providerMessageId}`,
        phoneLast4: last4,
        providerMessageId: message.providerMessageId,
        customerId: customer?.id ?? null,
      });
      if (!inboundId) return { result: 'DUPLICATE' as const };
      const ignore = async (error: string, result: SmsInboundOutcome) => {
        await db.pharmacyMessageLog.update({
          where: { id: inboundId },
          data: { status: 'IGNORED', error },
        });
        return { result };
      };
      if (!customer) return ignore('UNKNOWN_SENDER', 'UNKNOWN_SENDER');
      if (!keyword) return ignore('SMS_TEXT_NOT_HANDLED', 'IGNORED');
      if (!Number.isFinite(message.receivedAt.getTime()) || message.receivedAt > now)
        throw new Error('Invalid consent timestamp.');
      await lockCustomerConsent(db, organizationId, customer.id);
      const actor = customer.userId ?? `sms:${last4}`;

      if (keyword === 'STOP') {
        for (const [purpose, channel] of STOP_REVOKED) {
          const latest = await db.patientConsent.findFirst({
            where: { organizationId, patientId: customer.patientId, purpose, channel },
            orderBy: [{ version: 'desc' }, { id: 'asc' }],
            select: { granted: true, revokedAt: true, recordedAt: true },
          });
          // A newer purpose-specific event supersedes this delayed reply (STOP
          // wins ties).
          if (latest && latest.recordedAt > message.receivedAt) continue;
          // SMS reminders always record the newest refusal, even when already
          // withdrawn, so a delayed older START cannot override this STOP.
          // Other purposes only need a row when there is a grant to revoke.
          const smsReminders = purpose === 'REMINDERS' && channel === 'SMS';
          if (!smsReminders && (!latest || !latest.granted || latest.revokedAt)) continue;
          await writePatientConsent(
            db,
            organizationId,
            actor,
            { patientId: customer.patientId, purpose, channel, granted: false, source: 'REPLY' },
            message.receivedAt
          );
        }
        return { result: 'OPTED_OUT' as const, customerId: customer.id };
      }

      // START re-enables SMS reminders only; promotional consent needs its own
      // explicit counter/QR grant, exactly as on WhatsApp.
      const latest = await db.patientConsent.findFirst({
        where: {
          organizationId,
          patientId: customer.patientId,
          purpose: 'REMINDERS',
          channel: 'SMS',
        },
        orderBy: [{ version: 'desc' }, { id: 'asc' }],
        select: { granted: true, revokedAt: true, recordedAt: true },
      });
      if (latest && latest.recordedAt >= message.receivedAt)
        return ignore('STALE_CONSENT', 'STALE_CONSENT');
      if (!latest?.granted || latest.revokedAt)
        await writePatientConsent(
          db,
          organizationId,
          actor,
          {
            patientId: customer.patientId,
            purpose: 'REMINDERS',
            channel: 'SMS',
            granted: true,
            source: 'REPLY',
          },
          message.receivedAt
        );
      return { result: 'OPTED_IN' as const, customerId: customer.id };
    }
  );

  if ((outcome.result === 'OPTED_OUT' || outcome.result === 'OPTED_IN') && outcome.customerId) {
    const age = now.getTime() - message.receivedAt.getTime();
    // Acknowledge only recent requests; a replayed old callback stays silent.
    if (age >= 0 && age < 24 * 60 * 60 * 1000)
      await sendAndLog(
        {
          organizationId,
          channel: 'SMS',
          kind: 'CONSENT_ACK',
          dedupeKey: `sms-out:${message.providerMessageId}`,
          customerId: outcome.customerId,
          phoneLast4: last4,
        },
        () =>
          provider.send({
            to: message.from,
            body: outcome.result === 'OPTED_OUT' ? SMS_REPLIES.optedOut : SMS_REPLIES.optedIn,
          })
      );
  }
  return outcome.result;
}
