import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { isTenantLifecycleAccessible } from '@/lib/tenancy/host';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';

import { formatMinor } from '../counter-receipt';
import { lockCustomerConsent } from '../consent-writer';
import { claimMessageLogInTransaction, sendClaimedMessage } from './message-log';
import { canMessageCustomer, normalizeWhatsAppNumber, phoneLast4 } from './messages';
import {
  createWhatsAppProvider,
  readWhatsAppConfig,
  type WhatsAppConfig,
  type WhatsAppProvider,
} from './provider';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** Do not nag over a few paisa: a reminder needs a real outstanding balance. */
const DEFAULT_MIN_BALANCE_MINOR = 10_000;

export type KhataReminderCandidate = {
  familyAccountId: string;
  balanceMinor: number;
  oldestOverdueAt: Date | null;
};

/**
 * CRM-L06 pure reminder plan for one family khata account. A reminder is due
 * only when the account carries an overdue, unsettled balance at or above the
 * floor. The dedupe key buckets by account x week, so the scheduled job nudges
 * an overdue payer at most once per week until the balance clears — never a
 * promotion, only the utility fact that money is owed.
 */
export function planKhataReminder(
  candidate: KhataReminderCandidate,
  now: Date,
  minBalanceMinor: number = DEFAULT_MIN_BALANCE_MINOR
) {
  const floor = Math.max(1, Number.isSafeInteger(minBalanceMinor) ? minBalanceMinor : 1);
  const due =
    candidate.oldestOverdueAt !== null &&
    candidate.oldestOverdueAt.getTime() <= now.getTime() &&
    Number.isSafeInteger(candidate.balanceMinor) &&
    candidate.balanceMinor >= floor;
  const week = Math.floor(now.getTime() / WEEK_MS);
  return {
    due,
    dueDate: candidate.oldestOverdueAt
      ? candidate.oldestOverdueAt.toISOString().slice(0, 10)
      : null,
    dedupeKey: `khata:${candidate.familyAccountId}:w${week}`,
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
  notDue: number;
};

/**
 * Scheduled job: sends the approved khata-reminder template to the payer of
 * each family account whose overdue, unsettled balance is still outstanding.
 * Mirrors the refill-reminder gates — WhatsApp opt-in AND a granted
 * REMINDERS/WHATSAPP patient consent AND local daytime hours — because a
 * balance reminder is a utility message, never a marketing touch.
 */
export async function processDueWhatsAppKhataReminders(
  options: {
    now?: Date;
    limit?: number;
    minBalanceMinor?: number;
    config?: WhatsAppConfig;
    provider?: WhatsAppProvider;
  } = {}
): Promise<KhataReminderRunResult> {
  const now = options.now ?? new Date();
  const config = options.config ?? readWhatsAppConfig();
  const provider = options.provider ?? createWhatsAppProvider(config);
  const minBalanceMinor = options.minBalanceMinor ?? DEFAULT_MIN_BALANCE_MINOR;
  const result: KhataReminderRunResult = {
    configured: Boolean(
      (config.templates.khataReminder || config.templates.khataReminderUrdu) &&
      config.organizationId &&
      config.phoneNumberId &&
      // Live reminders require both webhook setup and signed STOP processing.
      (config.provider === 'mock' || (config.accessToken && config.appSecret && config.verifyToken))
    ),
    scanned: 0,
    sent: 0,
    prepared: 0,
    unknown: 0,
    failed: 0,
    duplicate: 0,
    skippedNoConsent: 0,
    notDue: 0,
  };
  const organizationId = config.organizationId;
  if (!result.configured || !organizationId) return { ...result, configured: false };

  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
  const accounts = await withPlatformDb((db) =>
    readDueKhataAccounts(db, organizationId, now, limit, minBalanceMinor)
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
      minBalanceMinor
    );
    if (!plan.due) {
      result.notDue += 1;
      continue;
    }

    const recipient = await withTenantDb(account.organizationId, async (db) => {
      if (config.organizationId !== account.organizationId || !config.phoneNumberId) return null;
      const organization = await db.organization.findUnique({
        where: { id: account.organizationId },
        select: { vertical: true, status: true, timezone: true, isDemo: true },
      });
      const branch = await db.pharmacyBranch.findFirst({
        where: { organizationId: account.organizationId, id: account.branchId, active: true },
      });
      if (
        !organization ||
        organization.isDemo ||
        organization.vertical !== 'PHARMACY' ||
        !isTenantLifecycleAccessible(organization.status) ||
        !branch
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
      const hour = Number(
        new Intl.DateTimeFormat('en-GB', {
          timeZone,
          hour: '2-digit',
          hourCycle: 'h23',
        }).format(now)
      );
      if (hour >= 22 || hour < 8) return null;
      // STOP and consent writers take the same locks. Read eligibility only
      // after acquiring them so a committed opt-out cannot leave a stale snapshot.
      await lockCustomerConsent(db, account.organizationId, account.payerCustomerId);
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
      const to = normalizeWhatsAppNumber(customer.patient.phone);
      if (
        !to ||
        !canMessageCustomer(customer) ||
        !consent?.granted ||
        consent.revokedAt ||
        consent.recordedAt > now
      )
        return null;
      const day = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(now);
      const preferredLanguage =
        customer.preferredLanguage === 'ur' ? ('ur' as const) : ('en' as const);
      const templateName =
        preferredLanguage === 'ur'
          ? config.templates.khataReminderUrdu
          : config.templates.khataReminder;
      if (!templateName) return { missingTemplate: true as const };
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
        templateName,
        dueDate: plan.dueDate,
      });
      return {
        customerId: customer.id,
        patientId: customer.patientId,
        preferredLanguage,
        templateName,
        to,
        logId,
      };
    });
    if (!recipient) {
      result.skippedNoConsent += 1;
      continue;
    }
    if ('missingTemplate' in recipient) {
      result.failed += 1;
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
        templateName: recipient.templateName,
        dueDate: plan.dueDate,
      },
      recipient.logId,
      () =>
        provider.sendTemplate({
          to: recipient.to,
          template: recipient.preferredLanguage === 'ur' ? 'khataReminderUrdu' : 'khataReminder',
          language: recipient.preferredLanguage,
          // Utility parameters only: who owes, and how much is outstanding.
          parameters: [sanitizeReminderDisplayName(account.displayName), formatMinor(balanceMinor)],
        })
    );
    if (outcome === 'SENT') result.sent += 1;
    else if (outcome === 'PREPARED') result.prepared += 1;
    else if (outcome === 'UNKNOWN') result.unknown += 1;
    else if (outcome === 'FAILED') result.failed += 1;
    else result.duplicate += 1;
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

/** One platform scan; ledger credits stay on the account's branch. */
export async function readDueKhataAccounts(
  db: import('@/lib/tenancy/scoped-db').ScopedDb,
  organizationId: string,
  now: Date,
  limit: number,
  minBalanceMinor: number = DEFAULT_MIN_BALANCE_MINOR
): Promise<DueAccount[]> {
  const floor = Math.max(1, Number.isSafeInteger(minBalanceMinor) ? minBalanceMinor : 1);
  return db.$queryRaw<DueAccount[]>(Prisma.sql`
    WITH payments AS (
      SELECT "organizationId", "branchId", "familyAccountId", "settlesChargeId",
             SUM("amountMinor") AS paid
      FROM "pharmacy_khata_events"
      WHERE "organizationId" = ${organizationId} AND "kind" = 'PAYMENT'
      GROUP BY "organizationId", "branchId", "familyAccountId", "settlesChargeId"
    )
    SELECT acct."id" AS "familyAccountId", acct."organizationId", acct."branchId",
           acct."displayName", acct."payerCustomerId",
           SUM(CASE WHEN ev."kind" = 'PAYMENT' THEN -ev."amountMinor"::bigint
                    ELSE ev."amountMinor"::bigint END)::bigint AS "balanceMinor",
           MIN(ev."dueAt") FILTER (
             WHERE ev."kind" = 'CHARGE' AND ev."dueAt" <= ${now}
               AND ev."amountMinor" > COALESCE(payments.paid, 0)
           ) AS "oldestOverdueAt"
    FROM "pharmacy_family_accounts" acct
    JOIN "pharmacy_khata_events" ev
      ON ev."organizationId" = acct."organizationId"
     AND ev."branchId" = acct."branchId" AND ev."familyAccountId" = acct."id"
    LEFT JOIN payments
      ON payments."organizationId" = ev."organizationId"
     AND payments."branchId" = ev."branchId"
     AND payments."familyAccountId" = ev."familyAccountId"
     AND payments."settlesChargeId" = ev."id"
    WHERE acct."organizationId" = ${organizationId} AND acct."active" = true
    GROUP BY acct."id", acct."organizationId", acct."branchId", acct."displayName", acct."payerCustomerId"
    HAVING SUM(CASE WHEN ev."kind" = 'PAYMENT' THEN -ev."amountMinor"::bigint
                    ELSE ev."amountMinor"::bigint END) >= ${floor}
       AND MIN(ev."dueAt") FILTER (
         WHERE ev."kind" = 'CHARGE' AND ev."dueAt" <= ${now}
           AND ev."amountMinor" > COALESCE(payments.paid, 0)
       ) IS NOT NULL
    ORDER BY "oldestOverdueAt", acct."id"
    LIMIT ${Math.max(1, Math.min(500, Math.floor(limit)))}
  `);
}
