import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { isTenantLifecycleAccessible } from '@/lib/tenancy/host';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';

import { formatMinor } from '../counter-receipt';
import { lockPatientConsent } from '../consent-writer';
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
    dueDate: candidate.oldestOverdueAt ? candidate.oldestOverdueAt.toISOString().slice(0, 10) : null,
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
    configured: Boolean(config.templates.khataReminder),
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
  if (!result.configured || config.provider === 'meta' || !organizationId || !config.phoneNumberId)
    return { ...result, configured: false };

  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
  // Platform admin read spans branches to total each account's open charges and
  // find its earliest overdue due date in a single pass.
  const accounts = await withPlatformDb((db) =>
    db.$queryRaw<DueAccount[]>(Prisma.sql`
      WITH paid AS (
        SELECT "organizationId", "branchId", "settlesChargeId" AS charge_id,
               SUM("amountMinor")::bigint AS paid_minor
        FROM "pharmacy_khata_events"
        WHERE "kind" = 'PAYMENT' AND "settlesChargeId" IS NOT NULL
          AND "organizationId" = ${organizationId}
        GROUP BY "organizationId", "branchId", "settlesChargeId"
      ),
      open_charges AS (
        SELECT ev."organizationId", ev."branchId", ev."familyAccountId", ev."id", ev."dueAt",
               ev."amountMinor" - COALESCE(paid.paid_minor, 0) AS remaining_minor
        FROM "pharmacy_khata_events" ev
        LEFT JOIN paid ON paid."organizationId" = ev."organizationId"
                      AND paid."branchId" = ev."branchId"
                      AND paid.charge_id = ev."id"
        WHERE ev."kind" = 'CHARGE' AND ev."organizationId" = ${organizationId}
      )
      SELECT acct."id" AS "familyAccountId", acct."organizationId", acct."branchId",
             acct."displayName", acct."payerCustomerId",
             SUM(oc.remaining_minor)::bigint AS "balanceMinor",
             MIN(oc."dueAt") FILTER (
               WHERE oc."dueAt" IS NOT NULL AND oc."dueAt" <= ${now} AND oc.remaining_minor > 0
             ) AS "oldestOverdueAt"
      FROM "pharmacy_family_accounts" acct
      JOIN open_charges oc ON oc."organizationId" = acct."organizationId"
                          AND oc."branchId" = acct."branchId"
                          AND oc."familyAccountId" = acct."id"
      WHERE acct."active" = true AND acct."organizationId" = ${organizationId}
        AND oc.remaining_minor > 0
      GROUP BY acct."id", acct."organizationId", acct."branchId", acct."displayName",
               acct."payerCustomerId"
      HAVING SUM(oc.remaining_minor) > 0
         AND MIN(oc."dueAt") FILTER (
               WHERE oc."dueAt" IS NOT NULL AND oc."dueAt" <= ${now} AND oc.remaining_minor > 0
             ) IS NOT NULL
      ORDER BY "oldestOverdueAt", acct."id"
      LIMIT ${limit}
    `)
  );

  for (const account of accounts) {
    result.scanned += 1;
    const balanceMinor = Number(account.balanceMinor);
    const plan = planKhataReminder(
      { familyAccountId: account.familyAccountId, balanceMinor, oldestOverdueAt: account.oldestOverdueAt },
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
        select: { vertical: true, status: true, timezone: true },
      });
      const branch = await db.pharmacyBranch.findFirst({
        where: { organizationId: account.organizationId, id: account.branchId, active: true },
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
          await resolveOrganizationEntitlements(account.organizationId, db, now),
          'pharmacy-crm'
        )
      )
        return null;
      const hour = Number(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: organization.timezone,
          hour: '2-digit',
          hourCycle: 'h23',
        }).format(now)
      );
      if (hour >= 22 || hour < 8) return null;
      const customer = await db.pharmacyCustomer.findFirst({
        where: { organizationId: account.organizationId, id: account.payerCustomerId },
        select: {
          id: true,
          patientId: true,
          active: true,
          whatsappOptIn: true,
          patient: { select: { phone: true } },
        },
      });
      if (!customer) return null;
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
      const to = normalizeWhatsAppNumber(customer.patient.phone);
      if (
        !to ||
        !canMessageCustomer(customer) ||
        !consent?.granted ||
        consent.revokedAt ||
        consent.recordedAt > now
      )
        return null;
      const prior = await db.pharmacyMessageLog.count({
        where: {
          organizationId: account.organizationId,
          customerId: customer.id,
          direction: 'OUTBOUND',
          kind: 'KHATA_REMINDER',
          createdAt: { gte: new Date(now.getTime() - DAY_MS) },
        },
      });
      if (prior) return null;
      const logId = await claimMessageLogInTransaction(db, {
        organizationId: account.organizationId,
        direction: 'OUTBOUND',
        status: 'PENDING',
        kind: 'KHATA_REMINDER',
        dedupeKey: plan.dedupeKey,
        branchId: account.branchId,
        customerId: customer.id,
        patientId: customer.patientId,
        phoneLast4: phoneLast4(to),
        templateName: config.templates.khataReminder,
        dueDate: plan.dueDate,
      });
      return { customerId: customer.id, patientId: customer.patientId, to, logId };
    });
    if (!recipient) {
      result.skippedNoConsent += 1;
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
        templateName: config.templates.khataReminder,
        dueDate: plan.dueDate,
      },
      recipient.logId,
      () =>
        provider.sendTemplate({
          to: recipient.to,
          template: 'khataReminder',
          // Utility parameters only: who owes, and how much is outstanding.
          parameters: [account.displayName, formatMinor(balanceMinor)],
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
