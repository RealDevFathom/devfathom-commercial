import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { isTenantLifecycleAccessible } from '@/lib/tenancy/host';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';

import { formatMinor } from '../counter-receipt';
import { lockPatientConsent } from '../consent-writer';
import { readTenantMedicineNames } from '../medicine-names';
import { lintWhatsAppMessage } from './compliance-linter';
import { recordWhatsAppComplianceBlock } from './compliance-log';
import { KHATA_REMINDER_DEFAULTS, khataReminderPayTo } from '../khata-reminder-settings';
import { manualPaymentSettingsSchema } from '../manual-payments';
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
import { claimMessageLogInTransaction, sendClaimedMessage } from './message-log';
import { isUtilityReminderQuietHour, reminderLocalHour } from './reminder-quiet-hours';
import { canMessageCustomer, normalizeWhatsAppNumber, phoneLast4 } from './messages';
import {
  createWhatsAppProvider,
  readWhatsAppConfig,
  type KhataTemplateParameter,
  type WhatsAppConfig,
  type WhatsAppProvider,
  type WhatsAppTemplateLanguage,
} from './provider';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;

/** ISO Monday-to-Monday week on the Karachi calendar, including its UTC bounds. */
function karachiReminderWeek(now: Date) {
  const localDay = new Date(Math.floor((now.getTime() + KARACHI_OFFSET_MS) / DAY_MS) * DAY_MS);
  const monday = localDay.getTime() - ((localDay.getUTCDay() + 6) % 7) * DAY_MS;
  const thursday = new Date(monday + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.ceil((thursday.getTime() - Date.UTC(year, 0, 1) + DAY_MS) / WEEK_MS);
  const start = new Date(monday - KARACHI_OFFSET_MS);
  const end = new Date(start.getTime() + WEEK_MS);
  // A Karachi calendar week overlaps two old Thursday-based UTC epoch buckets.
  const legacyPeriods = [
    Math.floor(start.getTime() / WEEK_MS),
    Math.floor((end.getTime() - 1) / WEEK_MS),
  ];
  return { period: `w${year}-${week}`, start, end, legacyPeriods };
}

/** Do not nag over a few paisa: a reminder needs a real outstanding balance. */
const DEFAULT_MIN_BALANCE_MINOR = KHATA_REMINDER_DEFAULTS.minBalanceMinor;
const DEFAULT_CADENCE_DAYS = KHATA_REMINDER_DEFAULTS.cadenceDays;

function cadenceDaysOrDefault(value: number | undefined): number {
  return Number.isSafeInteger(value) && value! >= 1 && value! <= 30 ? value! : DEFAULT_CADENCE_DAYS;
}

export type KhataReminderCandidate = {
  familyAccountId: string;
  balanceMinor: number;
  oldestOverdueAt: Date | null;
};

/**
 * CRM-L06 pure reminder plan for one family khata account. A reminder is due
 * only when the account carries an overdue, unsettled balance at or above the
 * floor. The dedupe key buckets by account x the branch's owner-configured
 * cadence (weekly by default), so the scheduled job nudges an overdue payer at
 * most once per period until the balance clears — never a promotion, only the
 * utility fact that money is owed. Weekly keys follow the Karachi ISO calendar.
 */
export function planKhataReminder(
  candidate: KhataReminderCandidate,
  now: Date,
  minBalanceMinor: number = DEFAULT_MIN_BALANCE_MINOR,
  cadenceDays: number = DEFAULT_CADENCE_DAYS
) {
  const floor = Math.max(1, Number.isSafeInteger(minBalanceMinor) ? minBalanceMinor : 1);
  const due =
    candidate.oldestOverdueAt !== null &&
    candidate.oldestOverdueAt.getTime() <= now.getTime() &&
    Number.isSafeInteger(candidate.balanceMinor) &&
    candidate.balanceMinor >= floor;
  const cadence = cadenceDaysOrDefault(cadenceDays);
  const period =
    cadence === 7
      ? karachiReminderWeek(now).period
      : `c${cadence}:${Math.floor(now.getTime() / (cadence * DAY_MS))}`;
  return {
    due,
    dueDate: candidate.oldestOverdueAt
      ? candidate.oldestOverdueAt.toISOString().slice(0, 10)
      : null,
    dedupeKey: `khata:${candidate.familyAccountId}:${period}`,
  };
}

type DueAccount = {
  familyAccountId: string;
  organizationId: string;
  branchId: string;
  displayName: string;
  payerCustomerId: string;
  balanceMinor: bigint | number;
  oldestOverdueAt: Date;
  /** The branch owner's schedule; absent rows fall back to the defaults. */
  cadenceDays?: number;
  minBalanceMinor?: number;
};

export type KhataReminderRunResult = {
  configured: boolean;
  scanned: number;
  sent: number;
  prepared: number;
  unknown: number;
  failed: number;
  duplicate: number;
  skippedNoConsent: number;
  /** Due but held back: it is outside 9 am to 10 pm in the workspace timezone. */
  skippedQuietHours: number;
  skippedConfiguration: number;
  notDue: number;
  configurationErrors: string[];
  /** DEV-87 SMS fallback outcomes (no WhatsApp consent or permanent failure). */
  sms: SmsFallbackCounts;
};

type KhataPaymentDetails = { dueDate: string; payTo: string | null };

type KhataRecipientResult =
  | { kind: 'configuration'; configurationError: string }
  | { kind: 'quiet-hours' }
  | { kind: 'duplicate' }
  | ({ kind: 'sms'; customerId: string } & KhataPaymentDetails)
  | ({
      kind: 'recipient';
      customerId: string;
      patientId: string;
      to: string;
      logId: string | null;
      language: WhatsAppTemplateLanguage;
      parameters: string[];
    } & KhataPaymentDetails);

function baseConfigurationErrors(config: WhatsAppConfig): string[] {
  const errors: string[] = [];
  if (!config.organizationId) errors.push('ORGANIZATION_NOT_CONFIGURED');
  if (!config.phoneNumberId) errors.push('PHONE_NUMBER_NOT_CONFIGURED');
  if (config.provider === 'meta' && !config.accessToken) errors.push('ACCESS_TOKEN_NOT_CONFIGURED');
  // Live Meta sending requires the explicit owner-approval flag, not just credentials.
  if (config.provider === 'meta' && !config.liveSendApproved) errors.push('LIVE_SEND_NOT_APPROVED');
  const hasUsableKhataTemplate = (['en', 'ur'] as const).some(
    (language) => config.khataTemplates[language] && config.khataParameterOrder[language]
  );
  if (!hasUsableKhataTemplate) {
    errors.push('KHATA_TEMPLATES_NOT_CONFIGURED');
  }
  return errors;
}

export type KhataReminderValues = {
  name: string;
  balance: string;
  dueDate?: string | null;
  payTo?: string | null;
};

/**
 * Template parameters in the approved placeholder order. Returns null when the
 * language has no approved template; throws `KhataParameterUnavailable` when the
 * template asks for a value this branch cannot supply (e.g. no Raast details).
 */
export function khataReminderParameters(
  config: WhatsAppConfig,
  language: WhatsAppTemplateLanguage,
  values: KhataReminderValues
): string[] | null {
  const order = config.khataParameterOrder[language];
  if (!config.khataTemplates[language] || !order) return null;
  return order.map((key) => {
    const value = values[key];
    if (!value) throw new KhataParameterUnavailable(key);
    return value;
  });
}

export class KhataParameterUnavailable extends Error {
  constructor(readonly parameter: KhataTemplateParameter) {
    super(`KHATA_PARAMETER_${parameter.toUpperCase()}_UNAVAILABLE`);
    this.name = 'KhataParameterUnavailable';
  }
}

/** The oldest overdue charge's due date, in the workspace's own calendar. */
export function formatKhataDueDate(dueAt: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(dueAt);
}

/**
 * Scheduled job: sends the approved khata-reminder template to the payer of
 * each family account whose overdue, unsettled balance is still outstanding.
 * Mirrors the refill-reminder gates — WhatsApp opt-in (a STOP reply clears it)
 * AND a granted REMINDERS/WHATSAPP patient consent AND outside the 22:00-09:00
 * local quiet hours — because a balance reminder is a utility message, never a
 * marketing touch. The text carries only the account name, the amount, the due
 * date and the branch's Raast / wallet destination; never a product name.
 */
export async function processDueWhatsAppKhataReminders(
  options: {
    now?: Date;
    limit?: number;
    minBalanceMinor?: number;
    config?: WhatsAppConfig;
    provider?: WhatsAppProvider;
    smsConfig?: SmsConfig;
    smsProvider?: SmsProvider;
    /**
     * DEV-730 owner "Send reminder": restrict the run to one family account. The same
     * overdue, consent, quiet-hour, once-per-week and SMS-fallback gates apply as the
     * scheduled job.
     */
    account?: { organizationId: string; branchId: string; familyAccountId: string };
  } = {}
): Promise<KhataReminderRunResult> {
  const now = options.now ?? new Date();
  const config = options.config ?? readWhatsAppConfig();
  const provider = options.provider ?? createWhatsAppProvider(config);
  const smsConfig = options.smsConfig ?? readSmsConfig();
  const smsProvider = options.smsProvider ?? createSmsProvider(smsConfig);
  const result: KhataReminderRunResult = {
    configured: false,
    scanned: 0,
    sent: 0,
    prepared: 0,
    unknown: 0,
    failed: 0,
    duplicate: 0,
    skippedNoConsent: 0,
    skippedQuietHours: 0,
    skippedConfiguration: 0,
    notDue: 0,
    configurationErrors: baseConfigurationErrors(config),
    sms: emptySmsFallbackCounts(),
  };
  result.configured = result.configurationErrors.length === 0;
  // `configured` reports the WhatsApp channel. A bound SMS sender still runs
  // the job for customers it can reach, without WhatsApp credentials.
  const whatsappReady = result.configured && Boolean(config.organizationId && config.phoneNumberId);
  const smsReady = smsConfig.provider !== 'disabled' && Boolean(smsConfig.organizationId);
  const organizationId = whatsappReady
    ? config.organizationId
    : smsReady
      ? smsConfig.organizationId
      : null;
  if (!organizationId) return result;
  // An owner's single-account send never scans another workspace's accounts.
  if (options.account && options.account.organizationId !== organizationId) {
    result.configured = false;
    result.configurationErrors.push('ORGANIZATION_NOT_CONFIGURED');
    return result;
  }

  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
  // Catalogue names for the send-time variable re-check, read once per run.
  let catalogNames: Set<string> | null = null;
  const accounts = await withPlatformDb((db) =>
    readDueKhataAccounts(db, organizationId, now, limit, options.minBalanceMinor, options.account)
  );

  for (const account of accounts) {
    result.scanned += 1;
    const balanceMinor = Number(account.balanceMinor);
    const plan = planKhataReminder(
      {
        familyAccountId: account.familyAccountId,
        balanceMinor,
        oldestOverdueAt: account.oldestOverdueAt,
      },
      now,
      options.minBalanceMinor ?? account.minBalanceMinor ?? DEFAULT_MIN_BALANCE_MINOR,
      account.cadenceDays
    );
    if (!plan.due) {
      result.notDue += 1;
      continue;
    }

    const recipient = await withTenantDb<KhataRecipientResult | null>(
      account.organizationId,
      async (db) => {
        const whatsappBound = whatsappReady && config.organizationId === account.organizationId;
        if (!whatsappBound && !smsEnabledFor(smsConfig, account.organizationId)) return null;
        const organization = await db.organization.findUnique({
          where: { id: account.organizationId },
          select: { vertical: true, status: true, timezone: true },
        });
        const branch = await db.pharmacyBranch.findFirst({
          where: { organizationId: account.organizationId, id: account.branchId, active: true },
          select: { id: true, khataReminderEnabled: true, manualPaymentSettings: true },
        });
        if (
          !organization ||
          organization.vertical !== 'PHARMACY' ||
          !isTenantLifecycleAccessible(organization.status) ||
          !branch ||
          (branch.khataReminderEnabled === false && !options.account)
        )
          return null;
        if (
          !hasModule(
            await resolveOrganizationEntitlements(account.organizationId, db, now),
            'pharmacy-crm'
          )
        )
          return null;
        // UTC for a stored zone Intl refuses ("PKT", "UTC+5"), as the other readers do.
        const timeZone = workspaceTimezone(organization.timezone);
        if (isUtilityReminderQuietHour(reminderLocalHour(now, timeZone)))
          return { kind: 'quiet-hours' };
        const customer = await db.pharmacyCustomer.findFirst({
          where: { organizationId: account.organizationId, id: account.payerCustomerId },
          select: {
            id: true,
            patientId: true,
            active: true,
            whatsappOptIn: true,
            preferredLanguage: true,
            patient: { select: { phone: true } },
          },
        });
        if (!customer) return null;
        const merchant = manualPaymentSettingsSchema.safeParse(branch.manualPaymentSettings ?? {});
        const details: KhataPaymentDetails = {
          dueDate: formatKhataDueDate(account.oldestOverdueAt, timeZone),
          payTo: merchant.success ? khataReminderPayTo(merchant.data) : null,
        };
        await lockPatientConsent(db, account.organizationId, customer.patientId);
        const consent = await db.patientConsent.findFirst({
          where: {
            organizationId: account.organizationId,
            patientId: customer.patientId,
            purpose: 'REMINDERS',
            channel: 'WHATSAPP',
          },
          orderBy: { version: 'desc' },
          select: { granted: true, revokedAt: true, recordedAt: true },
        });
        if (cadenceDaysOrDefault(account.cadenceDays) === 7) {
          const week = karachiReminderWeek(now);
          // Keep persisted claims effective across the namespace change, on both
          // channels. The consent lock serializes this check with other sends.
          // Include FAILED claims: the old unique key also prevented their replay.
          const legacyClaim = await db.pharmacyMessageLog.findFirst({
            where: {
              organizationId: account.organizationId,
              direction: 'OUTBOUND',
              kind: 'KHATA_REMINDER',
              dedupeKey: {
                in: week.legacyPeriods.flatMap((period) => [
                  `khata:${account.familyAccountId}:w${period}`,
                  `sms:khata:${account.familyAccountId}:w${period}`,
                ]),
              },
              createdAt: { gte: week.start, lt: week.end },
            },
            select: { id: true },
          });
          if (legacyClaim) return { kind: 'duplicate' };
        }
        const to = normalizeWhatsAppNumber(customer.patient.phone);
        if (
          !whatsappBound ||
          !to ||
          !canMessageCustomer(customer) ||
          !consent?.granted ||
          consent.revokedAt ||
          consent.recordedAt > now
        )
          return { kind: 'sms', customerId: customer.id, ...details };
        const language = customer.preferredLanguage;
        if (language !== 'en' && language !== 'ur')
          return { kind: 'configuration', configurationError: 'KHATA_LANGUAGE_UNSUPPORTED' };
        let parameters: string[] | null;
        try {
          parameters = khataReminderParameters(config, language, {
            name: sanitizeReminderDisplayName(account.displayName),
            balance: formatMinor(balanceMinor),
            ...details,
          });
        } catch (error) {
          if (!(error instanceof KhataParameterUnavailable)) throw error;
          return { kind: 'configuration', configurationError: error.message };
        }
        if (!parameters)
          return {
            kind: 'configuration',
            configurationError: `KHATA_TEMPLATE_${language.toUpperCase()}_NOT_CONFIGURED`,
          };
        // DEV-29: re-check the send-time values (a display name can name a medicine).
        catalogNames ??= await readTenantMedicineNames(db);
        const compliance = lintWhatsAppMessage({
          purpose: 'UTILITY',
          variables: parameters,
          catalogNames,
        });
        if (compliance.outcome === 'BLOCK') {
          await recordWhatsAppComplianceBlock(db, {
            organizationId: account.organizationId,
            branchId: account.branchId,
            subject: 'KHATA_REMINDER',
            subjectId: account.familyAccountId,
            result: compliance,
          });
          return { kind: 'configuration', configurationError: 'WHATSAPP_COMPLIANCE_BLOCKED' };
        }
        const day = new Intl.DateTimeFormat('en-CA', {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(now);
        const logId = await claimMessageLogInTransaction(db, {
          organizationId: account.organizationId,
          direction: 'OUTBOUND',
          status: 'PENDING',
          kind: 'KHATA_REMINDER',
          dedupeKey: plan.dedupeKey,
          customerDayKey: `khata:${customer.id}:${day}`,
          branchId: account.branchId,
          customerId: customer.id,
          patientId: customer.patientId,
          phoneLast4: phoneLast4(to),
          templateName: config.khataTemplates[language],
          dueDate: plan.dueDate,
        });
        return {
          kind: 'recipient',
          customerId: customer.id,
          patientId: customer.patientId,
          to,
          logId,
          language,
          parameters,
          ...details,
        };
      }
    );
    if (!recipient) {
      result.skippedNoConsent += 1;
      continue;
    }
    if (recipient.kind === 'quiet-hours') {
      result.skippedQuietHours += 1;
      continue;
    }
    if (recipient.kind === 'duplicate') {
      result.duplicate += 1;
      continue;
    }
    const smsFallback = (customerId: string, details: KhataPaymentDetails) =>
      sendUtilitySmsFallback(
        {
          organizationId: account.organizationId,
          branchId: account.branchId,
          customerId,
          dedupeKey: plan.dedupeKey,
          content: {
            kind: 'KHATA_REMINDER',
            balance: formatMinor(balanceMinor),
            dueDate: details.dueDate,
            payTo: details.payTo,
          },
          dueDate: plan.dueDate,
        },
        smsConfig,
        smsProvider,
        now
      );
    if (recipient.kind === 'sms') {
      // No WhatsApp consent: SMS only with the customer's own SMS reminder consent.
      const sms = await smsFallback(recipient.customerId, recipient);
      if (sms) tallySms(result.sms, sms);
      else result.skippedNoConsent += 1;
      continue;
    }
    if (recipient.kind === 'configuration') {
      result.skippedConfiguration += 1;
      if (!result.configurationErrors.includes(recipient.configurationError))
        result.configurationErrors.push(recipient.configurationError);
      continue;
    }
    if (!recipient.logId) {
      result.duplicate += 1;
      continue;
    }

    const outcome = await sendClaimedMessage(
      {
        organizationId: account.organizationId,
        kind: 'KHATA_REMINDER',
        dedupeKey: plan.dedupeKey,
        branchId: account.branchId,
        customerId: recipient.customerId,
        patientId: recipient.patientId,
        phoneLast4: phoneLast4(recipient.to),
        templateName: config.khataTemplates[recipient.language],
        dueDate: plan.dueDate,
      },
      recipient.logId,
      () =>
        provider.sendTemplate({
          to: recipient.to,
          template: 'khataReminder',
          language: recipient.language,
          // Only the explicitly configured approved-template placeholder order is used.
          parameters: recipient.parameters,
        })
    );
    if (outcome === 'SENT') result.sent += 1;
    else if (outcome === 'PREPARED') result.prepared += 1;
    else if (outcome === 'UNKNOWN') result.unknown += 1;
    else if (outcome === 'FAILED') result.failed += 1;
    else result.duplicate += 1;
    if (smsFallbackReason({ whatsappEligible: true, whatsappOutcome: outcome })) {
      const sms = await smsFallback(recipient.customerId, recipient);
      if (sms) tallySms(result.sms, sms);
    }
  }
  return result;
}

/** Template text must stay a short, single-line name without links. */
export function sanitizeReminderDisplayName(name: string): string {
  return (
    Array.from(
      name
        .replace(
          /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]\S*)?/gi,
          ''
        )
        .replace(/[\r\n\u2028\u2029]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
      .slice(0, 40)
      .join('') || 'Family account'
  );
}

/**
 * One platform scan; ledger credits stay on the account's branch. Each branch's
 * owner schedule applies here, before the limit: a disabled branch, a balance
 * under that branch's floor, or an account already reminded (on any channel)
 * within its cadence never takes a result slot from a payer who is due.
 * `minBalanceMinor` overrides every branch floor (tests and manual runs only).
 */
export async function readDueKhataAccounts(
  db: import('@/lib/tenancy/scoped-db').ScopedDb,
  organizationId: string,
  now: Date,
  limit: number,
  minBalanceMinor?: number,
  only?: { branchId: string; familyAccountId: string }
): Promise<DueAccount[]> {
  const override =
    minBalanceMinor === undefined
      ? null
      : Math.max(1, Number.isSafeInteger(minBalanceMinor) ? minBalanceMinor : 1);
  const floor =
    override === null
      ? Prisma.sql`GREATEST(1, br."khataReminderMinBalanceMinor")`
      : Prisma.sql`${override}`;
  const accountFilter = only
    ? Prisma.sql`AND acct."branchId" = ${only.branchId} AND acct."id" = ${only.familyAccountId}`
    : Prisma.empty;
  // The owner's on/off switch governs the scheduled job; an owner's explicit
  // one-account send (DEV-730) still goes out through every other gate.
  const scheduleSwitch = only ? Prisma.empty : Prisma.sql`AND br."khataReminderEnabled" = true`;
  return db.$queryRaw<DueAccount[]>(Prisma.sql`
    WITH settlements AS (
      -- A dishonoured cheque re-opens what it bounced, as readKhataBalance counts it: linked
      -- to a payment it re-opens that payment's charge, linked to a charge it re-opens that
      -- charge, and otherwise it is owed now with no due date of its own.
      SELECT e."id", e."organizationId", e."branchId", e."familyAccountId", e."kind",
             e."amountMinor"::bigint AS amount,
             COALESCE(bounced."settlesChargeId", e."settlesChargeId") AS "chargeId"
      FROM "pharmacy_khata_events" e
      LEFT JOIN "pharmacy_khata_events" bounced
        ON e."kind" = 'DISHONOURED_CHEQUE' AND bounced."kind" = 'PAYMENT'
       AND bounced."organizationId" = e."organizationId" AND bounced."branchId" = e."branchId"
       AND bounced."id" = e."settlesChargeId"
      WHERE e."organizationId" = ${organizationId}
        AND e."kind" IN ('PAYMENT', 'DISHONOURED_CHEQUE')
    ),
    payments AS (
      SELECT "organizationId", "branchId", "familyAccountId", "chargeId" AS "settlesChargeId",
             SUM(CASE WHEN "kind" = 'PAYMENT' THEN amount ELSE -amount END) AS paid
      FROM settlements
      WHERE "chargeId" IS NOT NULL
      GROUP BY "organizationId", "branchId", "familyAccountId", "chargeId"
    ),
    unlinked AS (
      SELECT s."id" FROM settlements s
      WHERE s."kind" = 'DISHONOURED_CHEQUE'
        AND NOT EXISTS (
          SELECT 1 FROM "pharmacy_khata_events" c
          WHERE c."organizationId" = s."organizationId" AND c."branchId" = s."branchId"
            AND c."id" = s."chargeId" AND c."kind" = 'CHARGE'
        )
    )
    SELECT acct."id" AS "familyAccountId", acct."organizationId", acct."branchId",
           acct."displayName", acct."payerCustomerId",
           br."khataReminderCadenceDays" AS "cadenceDays",
           br."khataReminderMinBalanceMinor" AS "minBalanceMinor",
           SUM(CASE WHEN ev."kind" = 'PAYMENT' THEN -ev."amountMinor"::bigint
                    ELSE ev."amountMinor"::bigint END)::bigint AS "balanceMinor",
           MIN(COALESCE(ev."dueAt", ev."occurredAt")) FILTER (
             WHERE (ev."kind" = 'CHARGE' AND ev."dueAt" <= ${now}
                    AND ev."amountMinor" > COALESCE(payments.paid, 0))
                OR unlinked."id" IS NOT NULL
           ) AS "oldestOverdueAt"
    FROM "pharmacy_family_accounts" acct
    JOIN "pharmacy_branches" br
      ON br."organizationId" = acct."organizationId" AND br."id" = acct."branchId"
     AND br."active" = true ${scheduleSwitch}
    JOIN "pharmacy_khata_events" ev
      ON ev."organizationId" = acct."organizationId"
     AND ev."branchId" = acct."branchId" AND ev."familyAccountId" = acct."id"
    LEFT JOIN payments
      ON payments."organizationId" = ev."organizationId"
     AND payments."branchId" = ev."branchId"
     AND payments."familyAccountId" = ev."familyAccountId"
     AND payments."settlesChargeId" = ev."id"
    LEFT JOIN unlinked ON unlinked."id" = ev."id"
    WHERE acct."organizationId" = ${organizationId} AND acct."active" = true
      ${accountFilter}
      AND NOT EXISTS (
        SELECT 1 FROM "pharmacy_message_logs" ml
        WHERE ml."organizationId" = acct."organizationId"
          AND ml."direction" = 'OUTBOUND' AND ml."kind" = 'KHATA_REMINDER'
          AND ml."status" <> 'FAILED'
          AND (starts_with(ml."dedupeKey", 'khata:' || acct."id" || ':')
            OR starts_with(ml."dedupeKey", 'sms:khata:' || acct."id" || ':'))
          AND ml."createdAt" + make_interval(days => br."khataReminderCadenceDays") > ${now}
      )
    GROUP BY acct."id", acct."organizationId", acct."branchId", acct."displayName", acct."payerCustomerId",
             br."khataReminderCadenceDays", br."khataReminderMinBalanceMinor"
    HAVING SUM(CASE WHEN ev."kind" = 'PAYMENT' THEN -ev."amountMinor"::bigint
                    ELSE ev."amountMinor"::bigint END) >= ${floor}
       AND MIN(COALESCE(ev."dueAt", ev."occurredAt")) FILTER (
         WHERE (ev."kind" = 'CHARGE' AND ev."dueAt" <= ${now}
                AND ev."amountMinor" > COALESCE(payments.paid, 0))
            OR unlinked."id" IS NOT NULL
       ) IS NOT NULL
    ORDER BY "oldestOverdueAt", acct."id"
    LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}
  `);
}
