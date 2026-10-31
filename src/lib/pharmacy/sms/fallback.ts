import 'server-only';

import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

import { lockPatientConsent } from '../consent-writer';
import {
  claimMessageLogInTransaction,
  sendClaimedMessage,
  type MessageLogEntry,
} from '../whatsapp/message-log';
import { canMessageCustomer, normalizeWhatsAppNumber, phoneLast4 } from '../whatsapp/messages';
import { smsFallbackEnabled, type SmsConfig, type SmsProvider } from './provider';

/**
 * #723 — SMS fallback for utility messages (refill-due, order-ready,
 * khata-due). WhatsApp reminders fall back only without WhatsApp consent or
 * after a permanent failure. Refill captures explicitly scheduled on SMS use
 * SMS directly. Every SMS requires a granted REMINDERS/SMS consent and no STOP.
 */

export type SmsFallbackKind = 'REFILL_REMINDER' | 'KHATA_REMINDER' | 'ORDER_READY';

type ConsentRow = { granted: boolean; revokedAt: Date | null; recordedAt: Date } | null;

function consentActive(consent: ConsentRow | undefined, now: Date): boolean {
  // Same comparison the reminder jobs use: a future-dated record is not yet in force.
  return Boolean(consent?.granted && !consent.revokedAt && !(consent.recordedAt > now));
}

/** The exact WhatsApp gate the reminder jobs apply (opt-in flag AND REMINDERS/WHATSAPP). */
export function hasWhatsAppReminderConsent(
  customer: { active: boolean; whatsappOptIn: boolean | null } | null | undefined,
  consent: ConsentRow | undefined,
  now: Date
): boolean {
  return canMessageCustomer(customer) && consentActive(consent, now);
}

/**
 * SMS gate: an active customer with a granted, unrevoked REMINDERS/SMS consent
 * who has not replied STOP by SMS (`smsOptIn === false`). STOP is sticky until
 * the customer replies START.
 */
export function canSmsCustomer(
  customer: { active: boolean; smsOptIn?: boolean | null } | null | undefined,
  consent: ConsentRow | undefined,
  now: Date
): boolean {
  return Boolean(customer?.active && customer.smsOptIn !== false && consentActive(consent, now));
}

export type SmsFallbackClaimInput = {
  organizationId: string;
  customerId: string;
  kind: SmsFallbackKind;
  dedupeKey: string;
  customerDayKey?: string;
  branchId?: string | null;
  refillCaptureId?: string | null;
  orderId?: string | null;
  dueDate?: string | null;
  now: Date;
};

export type SmsFallbackClaim = {
  logId: string | null;
  to: string;
  customerId: string;
  patientId: string;
  entry: MessageLogEntry;
};

/**
 * Runs inside the caller's tenant transaction. Re-reads the SMS consent under
 * the patient consent lock and claims the SMS log row so the eligibility check
 * and the claim commit together. Returns null when SMS is not allowed; a claim
 * with `logId: null` when the dedupe key was already used.
 */
export async function claimSmsFallbackInTransaction(
  db: ScopedDb,
  config: SmsConfig,
  input: SmsFallbackClaimInput
): Promise<SmsFallbackClaim | null> {
  if (!smsFallbackEnabled(config, input.organizationId)) return null;
  const customer = await db.pharmacyCustomer.findFirst({
    where: { organizationId: input.organizationId, id: input.customerId },
    select: {
      id: true,
      patientId: true,
      active: true,
      smsOptIn: true,
      patient: { select: { phone: true } },
    },
  });
  if (!customer) return null;
  await lockPatientConsent(db, input.organizationId, customer.patientId);
  const consent = await db.patientConsent.findFirst({
    where: {
      organizationId: input.organizationId,
      patientId: customer.patientId,
      purpose: 'REMINDERS',
      channel: 'SMS',
    },
    orderBy: { version: 'desc' },
    select: { granted: true, revokedAt: true, recordedAt: true },
  });
  const to = normalizeWhatsAppNumber(customer.patient.phone);
  if (!to || !canSmsCustomer(customer, consent, input.now)) return null;
  const entry: MessageLogEntry = {
    organizationId: input.organizationId,
    channel: 'SMS',
    kind: input.kind,
    dedupeKey: input.dedupeKey,
    ...(input.customerDayKey ? { customerDayKey: input.customerDayKey } : {}),
    branchId: input.branchId ?? null,
    customerId: customer.id,
    patientId: customer.patientId,
    phoneLast4: phoneLast4(to),
    templateName: `sms:${input.kind.toLowerCase()}:${config.language}`,
    refillCaptureId: input.refillCaptureId ?? null,
    orderId: input.orderId ?? null,
    dueDate: input.dueDate ?? null,
  };
  const logId = await claimMessageLogInTransaction(db, {
    ...entry,
    direction: 'OUTBOUND',
    status: 'PENDING',
  });
  return { logId, to, customerId: customer.id, patientId: customer.patientId, entry };
}

export type SmsFallbackOutcome = 'SENT' | 'PREPARED' | 'UNKNOWN' | 'FAILED' | 'DUPLICATE';

/** Sends a committed claim. The provider call runs outside any transaction. */
export async function sendSmsFallbackClaim(
  provider: SmsProvider,
  claim: SmsFallbackClaim & { logId: string },
  body: string
): Promise<Exclude<SmsFallbackOutcome, 'DUPLICATE'>> {
  return sendClaimedMessage(claim.entry, claim.logId, () =>
    provider.sendText({ to: claim.to, body })
  );
}

/**
 * Fallback after a permanent (definitive) WhatsApp failure. Opens its own
 * tenant transaction for the consent check and claim, then sends. Returns null
 * when SMS is not allowed for this customer.
 */
export async function sendSmsFallbackAfterWhatsAppFailure(
  config: SmsConfig,
  provider: SmsProvider,
  input: SmsFallbackClaimInput,
  body: string
): Promise<SmsFallbackOutcome | null> {
  if (!smsFallbackEnabled(config, input.organizationId)) return null;
  const claim = await withTenantDb(input.organizationId, (db) =>
    claimSmsFallbackInTransaction(db, config, input)
  );
  if (!claim) return null;
  if (!claim.logId) return 'DUPLICATE';
  return sendSmsFallbackClaim(provider, { ...claim, logId: claim.logId }, body);
}

export type SmsFallbackCounters = {
  sent: number;
  prepared: number;
  unknown: number;
  failed: number;
  duplicate: number;
};

export function emptySmsCounters(): SmsFallbackCounters {
  return { sent: 0, prepared: 0, unknown: 0, failed: 0, duplicate: 0 };
}

export function countSmsOutcome(counters: SmsFallbackCounters, outcome: SmsFallbackOutcome) {
  if (outcome === 'SENT') counters.sent += 1;
  else if (outcome === 'PREPARED') counters.prepared += 1;
  else if (outcome === 'UNKNOWN') counters.unknown += 1;
  else if (outcome === 'FAILED') counters.failed += 1;
  else counters.duplicate += 1;
}
