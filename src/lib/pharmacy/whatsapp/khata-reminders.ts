import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { isTenantLifecycleAccessible } from '@/lib/tenancy/host';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';

import { formatMinor } from '../counter-receipt';
import { lockPatientConsent } from '../consent-writer';
import { readKhataBalance } from '../family-khata';
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
  const accounts = await withPlatformDb((db) =>
    readDueKhataAccounts(db, organizationId, now, limit)
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
      const day = new Intl.DateTimeFormat('en-CA', {
        timeZone: organization.timezone,
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

/** Platform scan only; balance uses exactly the statement's ledger function.
 * Payments made from another counter are ledger credits on the account's branch.
 */
export async function readDueKhataAccounts(
  db: import('@/lib/tenancy/scoped-db').ScopedDb,
  organizationId: string,
  now: Date,
  limit: number
): Promise<DueAccount[]> {
  const accounts = await db.$queryRaw<Omit<DueAccount, 'balanceMinor'>[]>(Prisma.sql`
    SELECT acct."id" AS "familyAccountId", acct."organizationId", acct."branchId",
           acct."displayName", acct."payerCustomerId", MIN(ev."dueAt") AS "oldestOverdueAt"
    FROM "pharmacy_family_accounts" acct
    JOIN "pharmacy_khata_events" ev
      ON ev."organizationId" = acct."organizationId"
     AND ev."branchId" = acct."branchId" AND ev."familyAccountId" = acct."id"
    WHERE acct."organizationId" = ${organizationId} AND acct."active" = true
      AND ev."kind" = 'CHARGE' AND ev."dueAt" <= ${now}
    GROUP BY acct."id", acct."organizationId", acct."branchId", acct."displayName", acct."payerCustomerId"
    ORDER BY "oldestOverdueAt", acct."id"
    LIMIT ${limit}
  `);
  const result: DueAccount[] = [];
  for (const account of accounts) {
    const balanceMinor = await readKhataBalance(
      db,
      {
        organizationId,
        branchId: account.branchId,
        actorId: 'khata-reminder-job',
      },
      account.familyAccountId
    );
    result.push({ ...account, balanceMinor });
  }
  return result;
}
