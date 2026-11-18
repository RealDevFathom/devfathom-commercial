import 'server-only';

import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

import { lockPatientConsent } from '../consent-writer';
import {
  claimMessageLogWithAliasesInTransaction,
  sendClaimedMessage,
  type MessageLogAliases,
} from '../whatsapp/message-log';
import { normalizeWhatsAppNumber, phoneLast4 } from '../whatsapp/messages';
import { smsLanguage, utilitySmsBody, type UtilitySmsContent } from './messages';
import { smsEnabledFor, type SmsConfig, type SmsProvider } from './provider';

const DAY_MS = 86_400_000;

export type SmsFallbackCounts = {
  sent: number;
  prepared: number;
  unknown: number;
  failed: number;
  duplicate: number;
};

export function emptySmsFallbackCounts(): SmsFallbackCounts {
  return { sent: 0, prepared: 0, unknown: 0, failed: 0, duplicate: 0 };
}

export type UtilitySmsRequest = {
  organizationId: string;
  branchId: string;
  customerId: string;
  /** WhatsApp dedupe key of the same utility message; SMS claims `sms:<key>`. */
  dedupeKey: string;
  /** Other WhatsApp-style key formats of the same message, claimed as `sms:<key>` with it. */
  aliases?: MessageLogAliases | null;
  content: UtilitySmsContent;
  refillCaptureId?: string | null;
  orderId?: string | null;
  dueDate?: string | null;
};

/**
 * True when the customer's latest REMINDERS/SMS consent is an active grant
 * recorded no later than `now`. The caller holds the patient consent lock.
 */
async function hasSmsReminderConsent(
  db: ScopedDb,
  organizationId: string,
  patientId: string,
  now: Date
) {
  const consent = await db.patientConsent.findFirst({
    where: { organizationId, patientId, purpose: 'REMINDERS', channel: 'SMS' },
    orderBy: [{ version: 'desc' }, { id: 'asc' }],
    select: { granted: true, revokedAt: true, recordedAt: true },
  });
  return Boolean(consent?.granted && !consent.revokedAt && consent.recordedAt <= now);
}

/**
 * DEV-87 — sends a refill-due / order-ready / khata-due utility message by SMS.
 * Callers invoke it only when `smsFallbackReason` says WhatsApp is unavailable
 * (no consent) or failed permanently. The SMS consent gate, the claim and the
 * pre-send recheck mirror the WhatsApp path; returns null when not eligible.
 */
export async function sendUtilitySmsFallback(
  request: UtilitySmsRequest,
  config: SmsConfig,
  provider: SmsProvider,
  now: Date
): Promise<'SENT' | 'PREPARED' | 'UNKNOWN' | 'FAILED' | 'DUPLICATE' | null> {
  if (!smsEnabledFor(config, request.organizationId)) return null;
  const dedupeKey = `sms:${request.dedupeKey}`;
  const claim = await withTenantDb(request.organizationId, async (db) => {
    const customer = await db.pharmacyCustomer.findFirst({
      where: { organizationId: request.organizationId, id: request.customerId },
      select: {
        id: true,
        patientId: true,
        active: true,
        preferredLanguage: true,
        patient: { select: { phone: true } },
      },
    });
    if (!customer?.active) return null;
    await lockPatientConsent(db, request.organizationId, customer.patientId);
    const to = normalizeWhatsAppNumber(customer.patient.phone);
    if (!to || !(await hasSmsReminderConsent(db, request.organizationId, customer.patientId, now)))
      return null;
    // Keep the WhatsApp jobs' anti-nag limit: no SMS when this customer already
    // had a reminder of this kind in the last 24 hours on any channel. Only a
    // permanently failed send (the one this fallback replaces) does not count.
    const prior = await db.pharmacyMessageLog.count({
      where: {
        organizationId: request.organizationId,
        customerId: customer.id,
        direction: 'OUTBOUND',
        kind: request.content.kind,
        status: { not: 'FAILED' },
        createdAt: { gte: new Date(now.getTime() - DAY_MS) },
      },
    });
    if (prior) return null;
    const aliases = request.aliases
      ? { ...request.aliases, dedupeKeys: request.aliases.dedupeKeys.map((key) => `sms:${key}`) }
      : null;
    const logId = await claimMessageLogWithAliasesInTransaction(
      db,
      {
        organizationId: request.organizationId,
        channel: 'SMS',
        direction: 'OUTBOUND',
        status: 'PENDING',
        kind: request.content.kind,
        dedupeKey,
        // Atomic one-per-customer-per-day guard across accounts, medicines and branches.
        customerDayKey: `sms:${request.content.kind}:${customer.id}:${now.toISOString().slice(0, 10)}`,
        branchId: request.branchId,
        customerId: customer.id,
        patientId: customer.patientId,
        phoneLast4: phoneLast4(to),
        refillCaptureId: request.refillCaptureId ?? null,
        orderId: request.orderId ?? null,
        dueDate: request.dueDate ?? null,
      },
      aliases
    );
    return {
      logId,
      to,
      patientId: customer.patientId,
      body: utilitySmsBody(request.content, smsLanguage(customer.preferredLanguage)),
    };
  });
  if (!claim) return null;
  if (!claim.logId) return 'DUPLICATE';
  return sendClaimedMessage(
    {
      organizationId: request.organizationId,
      channel: 'SMS',
      kind: request.content.kind,
      dedupeKey,
      branchId: request.branchId,
      customerId: request.customerId,
      patientId: claim.patientId,
      phoneLast4: phoneLast4(claim.to),
      refillCaptureId: request.refillCaptureId ?? null,
      orderId: request.orderId ?? null,
      dueDate: request.dueDate ?? null,
    },
    claim.logId,
    () => provider.send({ to: claim.to, body: claim.body })
  );
}

export function tallySms(
  counts: SmsFallbackCounts,
  outcome: 'SENT' | 'PREPARED' | 'UNKNOWN' | 'FAILED' | 'DUPLICATE'
) {
  if (outcome === 'SENT') counts.sent += 1;
  else if (outcome === 'PREPARED') counts.prepared += 1;
  else if (outcome === 'UNKNOWN') counts.unknown += 1;
  else if (outcome === 'FAILED') counts.failed += 1;
  else counts.duplicate += 1;
}
