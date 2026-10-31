import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { deriveRefillSchedule, RefillSupportError } from '@/lib/pharmacy/refill-support';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';

import { claimMessageLogInTransaction, sendClaimedMessage } from './message-log';
import { lockPatientConsent } from '../consent-writer';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { isTenantLifecycleAccessible } from '@/lib/tenancy/host';
import { canMessageCustomer, normalizeWhatsAppNumber, phoneLast4 } from './messages';
import {
  claimSmsFallbackInTransaction,
  countSmsOutcome,
  emptySmsCounters,
  sendSmsFallbackAfterWhatsAppFailure,
  sendSmsFallbackClaim,
  type SmsFallbackCounters,
} from '../sms/fallback';
import {
  createSmsProvider,
  readSmsConfig,
  smsFallbackEnabled,
  type SmsConfig,
  type SmsProvider,
} from '../sms/provider';
import { SMS_TEMPLATES } from '../sms/templates';
import {
  createWhatsAppProvider,
  readWhatsAppConfig,
  type WhatsAppConfig,
  type WhatsAppProvider,
} from './provider';

const DAY_MS = 86_400_000;

export type RefillReminderPlanInput = {
  patientId: string;
  medicineId: string;
  dispensedAt: Date;
  quantityDispensed: number;
  directions: string;
};

/**
 * Pure schedule for one captured refill reminder. The due date is the
 * RX-07 run-out date from `deriveRefillSchedule`; the send window opens
 * `leadDays` before it and closes at run-out. The dedupe key is stable per
 * patient x medicine x due date, so repeated job runs claim it only once.
 */
export function planRefillReminder(input: RefillReminderPlanInput, now: Date, leadDays: number) {
  const schedule = deriveRefillSchedule({
    dispensedAt: input.dispensedAt,
    quantityDispensed: input.quantityDispensed,
    directions: input.directions,
  });
  const dueDate = schedule.expectedExhaustionAt.toISOString().slice(0, 10);
  const sendAt = new Date(schedule.expectedExhaustionAt.getTime() - leadDays * DAY_MS);
  return {
    dueDate,
    sendAt,
    expectedExhaustionAt: schedule.expectedExhaustionAt,
    due: sendAt <= now && now < schedule.expectedExhaustionAt,
    dedupeKey: `refill:${input.patientId}:${input.medicineId}:${dueDate}`,
  };
}

type DueCapture = {
  id: string;
  organizationId: string;
  branchId: string;
  patientId: string;
  medicineId: string;
  medicineName: string;
  channel: 'WHATSAPP' | 'SMS';
  directionsEnglish: string;
  quantityDispensed: number;
  dispensedAt: Date;
};

export type RefillReminderRunResult = {
  configured: boolean;
  scanned: number;
  sent: number;
  prepared: number;
  unknown: number;
  failed: number;
  duplicate: number;
  skippedNoConsent: number;
  notDue: number;
  /** #723: SMS fallback outcomes (no WhatsApp consent, or a permanent WhatsApp failure). */
  sms: SmsFallbackCounters;
};

/**
 * Scheduled job: sends the approved refill-reminder template for WhatsApp
 * and SMS reminder captures (created by `captureRefillReminder`) inside the
 * send window. SMS captures use SMS directly; WhatsApp captures fall back only
 * without WhatsApp consent or after a permanent failure. Each channel requires
 * its own current consent and tenant sender binding.
 */
export async function processDueWhatsAppRefillReminders(
  options: {
    now?: Date;
    limit?: number;
    config?: WhatsAppConfig;
    provider?: WhatsAppProvider;
    smsConfig?: SmsConfig;
    smsProvider?: SmsProvider;
  } = {}
): Promise<RefillReminderRunResult> {
  const now = options.now ?? new Date();
  const config = options.config ?? readWhatsAppConfig();
  const provider = options.provider ?? createWhatsAppProvider(config);
  const smsConfig = options.smsConfig ?? readSmsConfig();
  const smsProvider = options.smsProvider ?? createSmsProvider(smsConfig);
  const whatsappConfigured = Boolean(
    config.templates.refillReminder &&
    config.provider !== 'meta' &&
    config.organizationId &&
    config.phoneNumberId
  );
  const smsConfigured = Boolean(
    smsConfig.organizationId && smsFallbackEnabled(smsConfig, smsConfig.organizationId)
  );
  const result: RefillReminderRunResult = {
    configured: whatsappConfigured || smsConfigured,
    scanned: 0,
    sent: 0,
    prepared: 0,
    unknown: 0,
    failed: 0,
    duplicate: 0,
    skippedNoConsent: 0,
    notDue: 0,
    sms: emptySmsCounters(),
  };
  if (!result.configured) return result;

  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
  const windowEnd = new Date(now.getTime() + config.reminderLeadDays * DAY_MS);
  // Filter channel eligibility before LIMIT so captures awaiting consent cannot
  // starve newer reminders. Consent is still rechecked under the patient lock.
  const captures = await withPlatformDb((db) =>
    db.$queryRaw<DueCapture[]>(Prisma.sql`
      SELECT capture."id", capture."organizationId", capture."branchId", capture."patientId",
             line."medicineId", capture."medicineName", capture."channel", capture."directionsEnglish",
             capture."quantityDispensed", fill."dispensedAt"
      FROM "pharmacy_refill_reminder_captures" capture
      JOIN "pharmacy_prescription_fills" fill
        ON fill."organizationId" = capture."organizationId" AND fill."id" = capture."prescriptionFillId"
      JOIN "pharmacy_prescription_lines" line
        ON line."organizationId" = fill."organizationId" AND line."id" = fill."prescriptionLineId"
      JOIN "pharmacy_customers" customer
        ON customer."organizationId" = capture."organizationId" AND customer."patientId" = capture."patientId"
      LEFT JOIN LATERAL (
        SELECT consent.granted AND consent."revokedAt" IS NULL AND consent."recordedAt" <= ${now} AS allowed
        FROM "pharmacy_patient_consents" consent
        WHERE consent."organizationId" = capture."organizationId" AND consent."patientId" = capture."patientId"
          AND consent.purpose = 'REMINDERS' AND consent.channel = 'WHATSAPP'
        ORDER BY consent.version DESC LIMIT 1
      ) whatsapp_consent ON true
      LEFT JOIN LATERAL (
        SELECT consent.granted AND consent."revokedAt" IS NULL AND consent."recordedAt" <= ${now} AS allowed
        FROM "pharmacy_patient_consents" consent
        WHERE consent."organizationId" = capture."organizationId" AND consent."patientId" = capture."patientId"
          AND consent.purpose = 'REMINDERS' AND consent.channel = 'SMS'
        ORDER BY consent.version DESC LIMIT 1
      ) sms_consent ON true
      CROSS JOIN LATERAL (
        SELECT EXISTS (
          SELECT 1 FROM "pharmacy_message_logs" log
          WHERE log."organizationId" = capture."organizationId" AND log."refillCaptureId" = capture.id
            AND log."channel" = 'WHATSAPP' AND log."status" = 'FAILED'
        ) AS failed
      ) whatsapp_delivery
      WHERE capture."channel" IN ('WHATSAPP', 'SMS')
        AND (capture."organizationId" = ${whatsappConfigured ? config.organizationId : null}
          OR capture."organizationId" = ${smsConfigured ? smsConfig.organizationId : null})
        AND (capture."channel" <> 'SMS'
          OR capture."organizationId" = ${smsConfigured ? smsConfig.organizationId : null})
        AND capture."expectedExhaustionAt" > ${now}
        AND capture."expectedExhaustionAt" <= ${windowEnd}
        AND customer.active = true
        AND (
          (capture."channel" = 'WHATSAPP'
            AND capture."organizationId" = ${whatsappConfigured ? config.organizationId : null}
            AND customer."whatsappOptIn" IS TRUE AND whatsapp_consent.allowed IS TRUE
            AND NOT whatsapp_delivery.failed)
          OR (capture."organizationId" = ${smsConfigured ? smsConfig.organizationId : null}
            AND customer."smsOptIn" IS DISTINCT FROM false AND sms_consent.allowed IS TRUE
            AND (capture."channel" = 'SMS' OR customer."whatsappOptIn" IS NOT TRUE
              OR whatsapp_consent.allowed IS NOT TRUE OR whatsapp_delivery.failed))
        )
        AND NOT EXISTS (
          SELECT 1 FROM "pharmacy_message_logs" log
          WHERE log."organizationId" = capture."organizationId"
            AND log."refillCaptureId" = capture."id"
            AND NOT (log."channel" = 'WHATSAPP' AND log."status" = 'FAILED')
        )
      ORDER BY capture."expectedExhaustionAt", capture."id"
      LIMIT ${limit}
    `)
  );

  for (const capture of captures) {
    result.scanned += 1;
    let plan: ReturnType<typeof planRefillReminder>;
    try {
      plan = planRefillReminder(
        {
          patientId: capture.patientId,
          medicineId: capture.medicineId,
          dispensedAt: capture.dispensedAt,
          quantityDispensed: Number(capture.quantityDispensed),
          directions: capture.directionsEnglish,
        },
        now,
        config.reminderLeadDays
      );
    } catch (error) {
      if (!(error instanceof RefillSupportError)) throw error;
      result.notDue += 1;
      continue;
    }
    if (!plan.due) {
      result.notDue += 1;
      continue;
    }

    const recipient = await withTenantDb(capture.organizationId, async (db) => {
      const canUseWhatsApp = whatsappConfigured && config.organizationId === capture.organizationId;
      if (!canUseWhatsApp && !smsFallbackEnabled(smsConfig, capture.organizationId)) return null;
      const organization = await db.organization.findUnique({
        where: { id: capture.organizationId },
        select: { vertical: true, status: true, timezone: true },
      });
      const branch = await db.pharmacyBranch.findFirst({
        where: { organizationId: capture.organizationId, id: capture.branchId, active: true },
      });
      if (
        !organization ||
        organization.vertical !== 'PHARMACY' ||
        !isTenantLifecycleAccessible(organization.status) ||
        !branch
      )
        return null;
      if (
        !hasModule(
          await resolveOrganizationEntitlements(capture.organizationId, db, now),
          'pharmacy-crm'
        )
      )
        return null;
      const hour = Number(
        // A stored zone Intl refuses reads as UTC rather than failing the run.
        new Intl.DateTimeFormat('en-GB', {
          timeZone: workspaceTimezone(organization.timezone),
          hour: '2-digit',
          hourCycle: 'h23',
        }).format(now)
      );
      if (hour >= 22 || hour < 8) return null;
      // #723: per-customer, per-local-day cap on refill SMS (mirrors khata-sms).
      const day = new Intl.DateTimeFormat('en-CA', {
        timeZone: workspaceTimezone(organization.timezone),
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now);
      await lockPatientConsent(db, capture.organizationId, capture.patientId);
      const [customer, consent] = await Promise.all([
        db.pharmacyCustomer.findFirst({
          where: { organizationId: capture.organizationId, patientId: capture.patientId },
          select: {
            id: true,
            active: true,
            whatsappOptIn: true,
            patient: { select: { phone: true } },
          },
        }),
        db.patientConsent.findFirst({
          where: {
            organizationId: capture.organizationId,
            patientId: capture.patientId,
            purpose: 'REMINDERS',
            channel: 'WHATSAPP',
          },
          orderBy: { version: 'desc' },
          select: { granted: true, revokedAt: true, recordedAt: true },
        }),
      ]);
      const to = normalizeWhatsAppNumber(customer?.patient.phone);
      if (!customer) return null;
      const whatsappAllowed = Boolean(
        to &&
          canMessageCustomer(customer) &&
          consent?.granted &&
          !consent.revokedAt &&
          !(consent.recordedAt > now)
      );
      const previous = await db.pharmacyMessageLog.findFirst({
        where: {
          organizationId: capture.organizationId,
          channel: 'WHATSAPP',
          direction: 'OUTBOUND',
          dedupeKey: plan.dedupeKey,
        },
        select: { status: true },
      });
      const useSms = capture.channel === 'SMS' || !whatsappAllowed || previous?.status === 'FAILED';
      if (useSms ? !smsFallbackEnabled(smsConfig, capture.organizationId) : !canUseWhatsApp)
        return null;
      const prior = await db.pharmacyMessageLog.count({
        where: {
          organizationId: capture.organizationId,
          customerId: customer.id,
          direction: 'OUTBOUND',
          kind: 'REFILL_REMINDER',
          NOT: { channel: 'WHATSAPP', status: 'FAILED' },
          createdAt: { gte: new Date(now.getTime() - DAY_MS) },
        },
      });
      if (prior) return null;
      if (useSms || !to) {
        const sms = await claimSmsFallbackInTransaction(db, smsConfig, {
          organizationId: capture.organizationId,
          customerId: customer.id,
          kind: 'REFILL_REMINDER',
          dedupeKey: `sms:${plan.dedupeKey}`,
          customerDayKey: `refill-sms:${customer.id}:${day}`,
          branchId: capture.branchId,
          refillCaptureId: capture.id,
          dueDate: plan.dueDate,
          now,
        });
        return sms ? { channel: 'SMS' as const, sms } : null;
      }
      const logId = await claimMessageLogInTransaction(db, {
        organizationId: capture.organizationId,
        direction: 'OUTBOUND',
        status: 'PENDING',
        kind: 'REFILL_REMINDER',
        dedupeKey: plan.dedupeKey,
        branchId: capture.branchId,
        customerId: customer.id,
        patientId: capture.patientId,
        phoneLast4: phoneLast4(to),
        templateName: config.templates.refillReminder,
        refillCaptureId: capture.id,
        dueDate: plan.dueDate,
      });
      return { channel: 'WHATSAPP' as const, customerId: customer.id, to, logId, day };
    });
    if (!recipient) {
      result.skippedNoConsent += 1;
      continue;
    }
    const smsBody = SMS_TEMPLATES.refillReminder(smsConfig.language, { dueDate: plan.dueDate });
    if (recipient.channel === 'SMS') {
      const { sms } = recipient;
      countSmsOutcome(
        result.sms,
        sms.logId
          ? await sendSmsFallbackClaim(smsProvider, { ...sms, logId: sms.logId }, smsBody)
          : 'DUPLICATE'
      );
      continue;
    }

    if (!recipient.logId) {
      result.duplicate += 1;
      continue;
    }
    const outcome = await sendClaimedMessage(
      {
        organizationId: capture.organizationId,
        kind: 'REFILL_REMINDER',
        dedupeKey: plan.dedupeKey,
        branchId: capture.branchId,
        customerId: recipient.customerId,
        patientId: capture.patientId,
        phoneLast4: phoneLast4(recipient.to),
        templateName: config.templates.refillReminder,
        refillCaptureId: capture.id,
        dueDate: plan.dueDate,
      },
      recipient.logId,
      () =>
        provider.sendTemplate({
          to: recipient.to,
          template: 'refillReminder',
          parameters: [plan.dueDate],
        })
    );
    if (outcome === 'SENT') result.sent += 1;
    else if (outcome === 'PREPARED') result.prepared += 1;
    else if (outcome === 'UNKNOWN') result.unknown += 1;
    else if (outcome === 'FAILED') result.failed += 1;
    else result.duplicate += 1;
    if (outcome === 'FAILED') {
      // #723: a permanent WhatsApp failure falls back to SMS when SMS consent exists.
      const smsOutcome = await sendSmsFallbackAfterWhatsAppFailure(
        smsConfig,
        smsProvider,
        {
          organizationId: capture.organizationId,
          customerId: recipient.customerId,
          kind: 'REFILL_REMINDER',
          dedupeKey: `sms:${plan.dedupeKey}`,
          customerDayKey: `refill-sms:${recipient.customerId}:${recipient.day}`,
          branchId: capture.branchId,
          refillCaptureId: capture.id,
          dueDate: plan.dueDate,
          now,
        },
        smsBody
      );
      if (smsOutcome) countSmsOutcome(result.sms, smsOutcome);
    }
  }
  return result;
}
