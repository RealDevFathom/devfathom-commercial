import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { deriveRefillSchedule, RefillSupportError } from '@/lib/pharmacy/refill-support';
import {
  refillSubscriptionReminder,
  refillSubscriptionReminderDue,
} from '@/lib/pharmacy/refill-subscription-rules';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';

import { claimMessageLogInTransaction, sendClaimedMessage } from './message-log';
import {
  emptySmsFallbackCounts,
  sendUtilitySmsFallback,
  tallySms,
  type SmsFallbackCounts,
} from '../sms/fallback';
import { smsFallbackReason } from '../sms/messages';
import {
  createSmsProvider,
  readSmsConfig,
  smsEnabledFor,
  type SmsConfig,
  type SmsProvider,
} from '../sms/provider';
import { lockPatientConsent } from '../consent-writer';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { isTenantLifecycleAccessible } from '@/lib/tenancy/host';
import { canMessageCustomer, normalizeWhatsAppNumber, phoneLast4 } from './messages';
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
 * Pure schedule for one captured WhatsApp refill reminder. The due date is the
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
  /** DEV-87 SMS fallback outcomes (no WhatsApp consent or permanent failure). */
  sms: SmsFallbackCounts;
};

/**
 * Scheduled job: sends the approved refill-reminder template for WhatsApp
 * reminder captures (created by `captureRefillReminder`) that fall inside the
 * send window. Only customers who opted in on WhatsApp AND whose latest
 * REMINDERS/WHATSAPP patient consent is granted are messaged.
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
  const result: RefillReminderRunResult = {
    configured: Boolean(config.templates.refillReminder),
    scanned: 0,
    sent: 0,
    prepared: 0,
    unknown: 0,
    failed: 0,
    duplicate: 0,
    skippedNoConsent: 0,
    notDue: 0,
    sms: emptySmsFallbackCounts(),
  };
  // `configured` reports the WhatsApp channel. A bound SMS sender still runs
  // the job for customers it can reach, without WhatsApp credentials.
  const whatsappReady = result.configured && config.provider !== 'meta';
  const smsReady = smsConfig.provider !== 'disabled' && Boolean(smsConfig.organizationId);
  if (!whatsappReady) result.configured = false;
  if (!whatsappReady && !smsReady) return result;

  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
  const windowEnd = new Date(now.getTime() + config.reminderLeadDays * DAY_MS);
  const captures = await withPlatformDb((db) =>
    db.$queryRaw<DueCapture[]>(Prisma.sql`
      SELECT capture."id", capture."organizationId", capture."branchId", capture."patientId",
             line."medicineId", capture."medicineName", capture."directionsEnglish",
             capture."quantityDispensed", fill."dispensedAt"
      FROM "pharmacy_refill_reminder_captures" capture
      JOIN "pharmacy_prescription_fills" fill
        ON fill."organizationId" = capture."organizationId" AND fill."id" = capture."prescriptionFillId"
      JOIN "pharmacy_prescription_lines" line
        ON line."organizationId" = fill."organizationId" AND line."id" = fill."prescriptionLineId"
      WHERE capture."channel" = 'WHATSAPP'
        AND capture."expectedExhaustionAt" > ${now}
        AND capture."expectedExhaustionAt" <= ${windowEnd}
        AND NOT EXISTS (
          SELECT 1 FROM "pharmacy_message_logs" log
          WHERE log."organizationId" = capture."organizationId"
            AND log."refillCaptureId" = capture."id"
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

    await deliverRefillReminder(
      {
        organizationId: capture.organizationId,
        branchId: capture.branchId,
        patientId: capture.patientId,
        dueDate: plan.dueDate,
        dedupeKey: plan.dedupeKey,
        refillCaptureId: capture.id,
      },
      { now, config, provider, smsConfig, smsProvider, whatsappReady },
      result
    );
  }
  return result;
}

type ReminderDelivery = {
  organizationId: string;
  branchId: string;
  patientId: string;
  dueDate: string;
  dedupeKey: string;
  /** RX-07 capture the reminder came from; null for a DEV-73 subscription cycle. */
  refillCaptureId: string | null;
};

type ReminderChannels = {
  now: Date;
  config: WhatsAppConfig;
  provider: WhatsAppProvider;
  smsConfig: SmsConfig;
  smsProvider: SmsProvider;
  whatsappReady: boolean;
};

/**
 * Consent-, quiet-hour- and entitlement-checked delivery of the approved
 * utility refill template. Its only parameter is the due date: no medicine,
 * salt or category is ever sent.
 */
async function deliverRefillReminder(
  item: ReminderDelivery,
  channels: ReminderChannels,
  result: RefillReminderRunResult
) {
  const { now, config, provider, smsConfig, smsProvider, whatsappReady } = channels;
  const recipient = await withTenantDb(item.organizationId, async (db) => {
    const whatsappBound =
      whatsappReady &&
      config.organizationId === item.organizationId &&
      Boolean(config.phoneNumberId);
    if (!whatsappBound && !smsEnabledFor(smsConfig, item.organizationId)) return null;
    const organization = await db.organization.findUnique({
      where: { id: item.organizationId },
      select: { vertical: true, status: true, timezone: true },
    });
    const branch = await db.pharmacyBranch.findFirst({
      where: { organizationId: item.organizationId, id: item.branchId, active: true },
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
        await resolveOrganizationEntitlements(item.organizationId, db, now),
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
    await lockPatientConsent(db, item.organizationId, item.patientId);
    const [customer, consent] = await Promise.all([
      db.pharmacyCustomer.findFirst({
        where: { organizationId: item.organizationId, patientId: item.patientId },
        select: {
          id: true,
          active: true,
          whatsappOptIn: true,
          patient: { select: { phone: true } },
        },
      }),
      db.patientConsent.findFirst({
        where: {
          organizationId: item.organizationId,
          patientId: item.patientId,
          purpose: 'REMINDERS',
          channel: 'WHATSAPP',
        },
        orderBy: { version: 'desc' },
        select: { granted: true, revokedAt: true, recordedAt: true },
      }),
    ]);
    if (!customer) return null;
    const to = normalizeWhatsAppNumber(customer.patient.phone);
    if (
      !whatsappBound ||
      !to ||
      !canMessageCustomer(customer) ||
      !consent?.granted ||
      consent.revokedAt ||
      consent.recordedAt > now
    )
      // No WhatsApp sender or consent: SMS only with the customer's own SMS consent.
      return { kind: 'sms' as const, customerId: customer.id };
    const prior = await db.pharmacyMessageLog.count({
      where: {
        organizationId: item.organizationId,
        customerId: customer.id,
        direction: 'OUTBOUND',
        kind: 'REFILL_REMINDER',
        createdAt: { gte: new Date(now.getTime() - DAY_MS) },
      },
    });
    if (prior) return null;
    const logId = await claimMessageLogInTransaction(db, {
      organizationId: item.organizationId,
      direction: 'OUTBOUND',
      status: 'PENDING',
      kind: 'REFILL_REMINDER',
      dedupeKey: item.dedupeKey,
      branchId: item.branchId,
      customerId: customer.id,
      patientId: item.patientId,
      phoneLast4: phoneLast4(to),
      templateName: config.templates.refillReminder,
      refillCaptureId: item.refillCaptureId,
      dueDate: item.dueDate,
    });
    return { kind: 'whatsapp' as const, customerId: customer.id, to, logId };
  });
  if (!recipient) {
    result.skippedNoConsent += 1;
    return;
  }
  const smsFallback = (customerId: string) =>
    sendUtilitySmsFallback(
      {
        organizationId: item.organizationId,
        branchId: item.branchId,
        customerId,
        dedupeKey: item.dedupeKey,
        content: { kind: 'REFILL_REMINDER', dueDate: item.dueDate },
        refillCaptureId: item.refillCaptureId,
        dueDate: item.dueDate,
      },
      smsConfig,
      smsProvider,
      now
    );
  if (recipient.kind === 'sms') {
    const sms = await smsFallback(recipient.customerId);
    if (sms) tallySms(result.sms, sms);
    else result.skippedNoConsent += 1;
    return;
  }

  if (!recipient.logId) {
    result.duplicate += 1;
    return;
  }
  const outcome = await sendClaimedMessage(
    {
      organizationId: item.organizationId,
      kind: 'REFILL_REMINDER',
      dedupeKey: item.dedupeKey,
      branchId: item.branchId,
      customerId: recipient.customerId,
      patientId: item.patientId,
      phoneLast4: phoneLast4(recipient.to),
      templateName: config.templates.refillReminder,
      refillCaptureId: item.refillCaptureId,
      dueDate: item.dueDate,
    },
    recipient.logId,
    () =>
      provider.sendTemplate({
        to: recipient.to,
        template: 'refillReminder',
        parameters: [item.dueDate],
      })
  );
  if (outcome === 'SENT') result.sent += 1;
  else if (outcome === 'PREPARED') result.prepared += 1;
  else if (outcome === 'UNKNOWN') result.unknown += 1;
  else if (outcome === 'FAILED') result.failed += 1;
  else result.duplicate += 1;
  if (smsFallbackReason({ whatsappEligible: true, whatsappOutcome: outcome })) {
    const sms = await smsFallback(recipient.customerId);
    if (sms) tallySms(result.sms, sms);
  }
}

type DueSubscriptionCycle = {
  id: string;
  organizationId: string;
  branchId: string;
  patientId: string;
  dueAt: Date;
  reminderLeadDays: number;
};

/**
 * DEV-73 scheduled job: one reminder per open refill-subscription cycle, sent
 * inside the subscription's own lead-time window with the same neutral utility
 * template, consent checks and SMS fallback as RX-07 refill reminders.
 */
export async function processDueSubscriptionRefillReminders(
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
  const result: RefillReminderRunResult = {
    configured: Boolean(config.templates.refillReminder),
    scanned: 0,
    sent: 0,
    prepared: 0,
    unknown: 0,
    failed: 0,
    duplicate: 0,
    skippedNoConsent: 0,
    notDue: 0,
    sms: emptySmsFallbackCounts(),
  };
  const whatsappReady = result.configured && config.provider !== 'meta';
  const smsReady = smsConfig.provider !== 'disabled' && Boolean(smsConfig.organizationId);
  if (!whatsappReady) result.configured = false;
  if (!whatsappReady && !smsReady) return result;

  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
  const cycles = await withPlatformDb((db) =>
    db.$queryRaw<DueSubscriptionCycle[]>(Prisma.sql`
      SELECT cycle."id", cycle."organizationId", cycle."branchId", customer."patientId",
             cycle."dueAt", subscription."reminderLeadDays"
      FROM "pharmacy_refill_subscription_cycles" cycle
      JOIN "pharmacy_refill_subscriptions" subscription
        ON subscription."organizationId" = cycle."organizationId"
       AND subscription."id" = cycle."subscriptionId"
      JOIN "pharmacy_customers" customer
        ON customer."organizationId" = subscription."organizationId"
       AND customer."id" = subscription."customerId"
      WHERE cycle."status" IN ('AWAITING_PHARMACIST', 'RESERVED')
        AND subscription."status" = 'ACTIVE'
        AND cycle."dueAt" > ${now}
        AND NOT EXISTS (
          SELECT 1 FROM "pharmacy_message_logs" log
          WHERE log."organizationId" = cycle."organizationId"
            -- SMS fallback claims the same reminder under an 'sms:' prefix.
            AND log."dedupeKey" IN (
              'refill-subscription:' || cycle."id",
              'sms:refill-subscription:' || cycle."id"
            )
        )
      ORDER BY cycle."dueAt", cycle."id"
      LIMIT ${limit}
    `)
  );
  for (const cycle of cycles) {
    result.scanned += 1;
    if (!refillSubscriptionReminderDue(cycle, Number(cycle.reminderLeadDays), now)) {
      result.notDue += 1;
      continue;
    }
    const reminder = refillSubscriptionReminder(cycle);
    await deliverRefillReminder(
      {
        organizationId: cycle.organizationId,
        branchId: cycle.branchId,
        patientId: cycle.patientId,
        dueDate: reminder.dueDate,
        dedupeKey: reminder.dedupeKey,
        refillCaptureId: null,
      },
      { now, config, provider, smsConfig, smsProvider, whatsappReady },
      result
    );
  }
  return result;
}
