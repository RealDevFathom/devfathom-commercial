import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { can, subjectFromSession } from '@/lib/abac';
import { capabilityMatches } from '@/lib/abac/capabilities';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { auditPatientRead } from './patient-prescriptions';

export type FamilyKhataScope = { organizationId: string; branchId: string; actorId: string };

export class FamilyKhataError extends Error {
  constructor(
    readonly reason:
      | 'MEMBER_NOT_FOUND'
      | 'CROSS_MEMBER_CLINICAL_ACCESS'
      | 'INVALID_AMOUNT'
      | 'PAYMENT_EXCEEDS_BALANCE'
      | 'OWNER_ACTION_REQUIRED'
      | 'CREDIT_LIMIT_EXCEEDED'
      | 'ACCOUNT_NOT_FOUND'
  ) {
    super(reason);
  }
}

export type KhataHistoryEntry = {
  kind: 'CHARGE' | 'PAYMENT' | 'DISHONOURED_CHEQUE';
  amountMinor: number;
  occurredAt: Date;
  dueAt?: Date | null;
  settlesChargeId?: string | null;
};

export type KhataHealthSuggestion = {
  score: number;
  method: 'KHATA_HEALTH_V1';
  windowStart: Date;
  windowEnd: Date;
  suggestedLimitMinor: number;
  reasons: string[];
  metrics: {
    chargeCount: number;
    overdueChargeCount: number;
    averageDaysToPay: number | null;
    dishonouredCheques: number;
  };
};

const DAY_MS = 86_400_000;

/** CRM-L04 estimate only. Calling this function cannot change a credit limit. */
export function calculateKhataHealthSuggestion(
  history: readonly (KhataHistoryEntry & { id: string })[],
  currentLimitMinor: number,
  windowStart: Date,
  windowEnd: Date
): KhataHealthSuggestion {
  const entries = history.filter(
    (entry) => entry.occurredAt >= windowStart && entry.occurredAt <= windowEnd
  );
  const charges = entries.filter((entry) => entry.kind === 'CHARGE');
  const payments = entries.filter((entry) => entry.kind === 'PAYMENT');
  const dishonouredCheques = entries.filter((entry) => entry.kind === 'DISHONOURED_CHEQUE').length;
  const paidChargeIds = new Set(payments.map((payment) => payment.settlesChargeId));
  const overdueChargeCount = charges.filter(
    (charge) => charge.dueAt && charge.dueAt < windowEnd && !paidChargeIds.has(charge.id)
  ).length;
  const paymentDays = payments.flatMap((payment) => {
    const charge = charges.find((candidate) => candidate.id === payment.settlesChargeId);
    return charge
      ? [
          Math.max(
            0,
            Math.round((payment.occurredAt.getTime() - charge.occurredAt.getTime()) / DAY_MS)
          ),
        ]
      : [];
  });
  const averageDaysToPay = paymentDays.length
    ? Math.round(paymentDays.reduce((sum, days) => sum + days, 0) / paymentDays.length)
    : null;

  let score = 100;
  score -= overdueChargeCount * 12;
  score -= dishonouredCheques * 20;
  if (averageDaysToPay !== null) score -= Math.max(0, averageDaysToPay - 14);
  if (charges.length === 0) score = Math.min(score, 50);
  score = Math.max(0, Math.min(100, score));

  const reasons = [
    `${charges.length} charge(s) in the stated window`,
    `${overdueChargeCount} overdue unsettled charge(s)`,
    averageDaysToPay === null
      ? 'No settled charges available for days-to-pay'
      : `Average ${averageDaysToPay} day(s) to pay`,
    `${dishonouredCheques} dishonoured cheque(s)`,
  ];
  const observedChargesMinor = charges.reduce((sum, charge) => sum + charge.amountMinor, 0);
  const base = Math.max(currentLimitMinor, observedChargesMinor);
  const suggestedLimitMinor = Math.max(0, Math.floor((base * score) / 100 / 100) * 100);

  return {
    score,
    method: 'KHATA_HEALTH_V1',
    windowStart,
    windowEnd,
    suggestedLimitMinor,
    reasons,
    metrics: {
      chargeCount: charges.length,
      overdueChargeCount,
      averageDaysToPay,
      dishonouredCheques,
    },
  };
}

/** Fail closed before any protected table is queried. */
export function assertSameFamilyMemberPatient(memberPatientId: string, requestedPatientId: string) {
  if (memberPatientId !== requestedPatientId)
    throw new FamilyKhataError('CROSS_MEMBER_CLINICAL_ACCESS');
}

export async function readFamilyMemberDispensing(
  db: ScopedDb,
  scope: FamilyKhataScope,
  input: { familyAccountId: string; memberId: string; patientId: string }
) {
  const member = await db.pharmacyFamilyMember.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      familyAccountId: input.familyAccountId,
      id: input.memberId,
    },
    select: { customer: { select: { patientId: true } } },
  });
  if (!member) throw new FamilyKhataError('MEMBER_NOT_FOUND');
  assertSameFamilyMemberPatient(member.customer.patientId, input.patientId);

  auditPatientRead({
    organizationId: scope.organizationId,
    actorId: scope.actorId,
    patientId: input.patientId,
  });
  return db.prescription.findMany({
    where: { organizationId: scope.organizationId, patientId: input.patientId },
    include: { lines: { include: { fills: true } } },
    orderBy: { capturedAt: 'desc' },
  });
}

export async function settleFamilyKhata(
  db: ScopedDb,
  scope: FamilyKhataScope,
  input: { familyAccountId: string; amountMinor: number; occurredAt: Date }
) {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
    throw new FamilyKhataError('INVALID_AMOUNT');
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_family_accounts WHERE id=${input.familyAccountId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`
  );
  const events = await db.pharmacyKhataEvent.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      familyAccountId: input.familyAccountId,
    },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });
  const paidByCharge = new Map<string, number>();
  for (const event of events)
    if (event.kind === 'PAYMENT' && event.settlesChargeId)
      paidByCharge.set(
        event.settlesChargeId,
        (paidByCharge.get(event.settlesChargeId) ?? 0) + event.amountMinor
      );
  const openCharges = events
    .filter((event) => event.kind === 'CHARGE')
    .map((charge) => ({
      charge,
      remaining: charge.amountMinor - (paidByCharge.get(charge.id) ?? 0),
    }))
    .filter(({ remaining }) => remaining > 0);
  const balanceMinor = openCharges.reduce((sum, item) => sum + item.remaining, 0);
  if (input.amountMinor > balanceMinor) throw new FamilyKhataError('PAYMENT_EXCEEDS_BALANCE');

  let remaining = input.amountMinor;
  const allocations = [];
  for (const item of openCharges) {
    if (!remaining) break;
    const amountMinor = Math.min(remaining, item.remaining);
    allocations.push(
      await db.pharmacyKhataEvent.create({
        data: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          familyAccountId: input.familyAccountId,
          kind: 'PAYMENT',
          amountMinor,
          occurredAt: input.occurredAt,
          settlesChargeId: item.charge.id,
          actorId: scope.actorId,
        },
      })
    );
    remaining -= amountMinor;
  }
  return {
    paidMinor: input.amountMinor,
    remainingBalanceMinor: balanceMinor - input.amountMinor,
    allocations,
  };
}

/** Tenant role keys (system templates only) that may approve an over-limit Khata charge. */
export const KHATA_OVERRIDE_APPROVER_ROLE_KEYS = ['owner', 'owner-operator', 'manager'] as const;

/**
 * True when a member row may approve a Khata limit override at the charge's branch.
 * Tenant ADMINs reach every branch (the same exemption the counter applies to cashiers);
 * an owner/manager system role must also hold an active assignment to that branch.
 */
export function isKhataOverrideApprover(row: {
  status: string | null;
  role?: string | null;
  roleKey?: string | null;
  isSystem?: boolean | null;
  branchAssigned?: boolean | null;
}) {
  if (row.status !== 'ACTIVE') return false;
  if (row.role === 'ADMIN') return true;
  return (
    row.branchAssigned === true &&
    row.isSystem === true &&
    (KHATA_OVERRIDE_APPROVER_ROLE_KEYS as readonly string[]).includes(row.roleKey ?? '')
  );
}

/**
 * Capability gate on top of `isKhataOverrideApprover`, so an explicit DENY (user override
 * or role rule) revokes approval exactly as the ABAC engine decides it. ADMIN keeps the
 * `admin:access` gate; owner and manager templates grant `pharmacy:manage`. The
 * owner-operator template does not, so only a matching unexpired DENY refuses it.
 */
export async function khataApproverCapable(
  db: ScopedDb,
  approver: { id: string; status: string | null; role?: string | null; roleKey?: string | null }
) {
  const subject = subjectFromSession(approver);
  if (approver.role === 'ADMIN')
    return can(subject, 'admin:access', undefined, { db, source: 'TRPC' });
  if (approver.roleKey !== 'owner-operator')
    return can(subject, 'pharmacy:manage', undefined, { db, source: 'TRPC' });
  const now = new Date();
  const user = await db.user.findUnique({
    where: { id: approver.id },
    select: {
      organizationRole: { select: { permissions: { select: { capability: true, effect: true } } } },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  if (!user) return false;
  return ![...user.permissionOverrides, ...(user.organizationRole?.permissions ?? [])].some(
    (rule) =>
      rule.effect === 'DENY' && capabilityMatches(rule.capability, 'pharmacy:manage', 'DENY')
  );
}

type KhataLimitDecisionInput = {
  familyAccountId: string;
  suggestion: KhataHealthSuggestion;
  // Trusted server evidence only: never populate this from a client timestamp.
  ownerAuthorized: boolean;
  ownerAuthorizedByUserId?: string;
  ownerReauthenticatedAt?: Date;
  overrideReason?: string;
  overrideLimitMinor?: number;
};

async function writeKhataLimitDecision(
  db: ScopedDb,
  scope: FamilyKhataScope,
  input: KhataLimitDecisionInput,
  approvalId?: string,
  /** Database clock for DB-stamped evidence, so app/DB clock skew cannot refuse it. */
  dbNow?: Date
) {
  const authorizedAt = dbNow ?? new Date();
  const reauthenticatedAt = input.ownerReauthenticatedAt?.getTime();
  const overrideReason = input.overrideReason?.trim();
  if (
    !input.ownerAuthorized ||
    !input.ownerAuthorizedByUserId ||
    (input.overrideReason !== undefined && !overrideReason) ||
    reauthenticatedAt === undefined ||
    !Number.isFinite(reauthenticatedAt) ||
    reauthenticatedAt > authorizedAt.getTime() ||
    authorizedAt.getTime() - reauthenticatedAt > 5 * 60_000
  )
    throw new FamilyKhataError('OWNER_ACTION_REQUIRED');
  const appliedLimitMinor = input.overrideLimitMinor ?? input.suggestion.suggestedLimitMinor;
  if (!Number.isSafeInteger(appliedLimitMinor) || appliedLimitMinor < 0)
    throw new FamilyKhataError('INVALID_AMOUNT');
  const account = await db.pharmacyFamilyAccount.update({
    where: {
      organizationId_branchId_id: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        id: input.familyAccountId,
      },
    },
    data: { creditLimitMinor: appliedLimitMinor },
  });
  const decision = await db.pharmacyKhataLimitDecision.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      familyAccountId: input.familyAccountId,
      kind: input.overrideLimitMinor === undefined ? 'ACCEPTED' : 'OVERRIDDEN',
      score: input.suggestion.score,
      method: input.suggestion.method,
      windowStart: input.suggestion.windowStart,
      windowEnd: input.suggestion.windowEnd,
      suggestedLimitMinor: input.suggestion.suggestedLimitMinor,
      appliedLimitMinor,
      reasons: {
        reasons: input.suggestion.reasons,
        ownerAuthorizedByUserId: input.ownerAuthorizedByUserId,
        ownerReauthenticatedAt: input.ownerReauthenticatedAt!.toISOString(),
        ownerAuthorizedAt: authorizedAt.toISOString(),
        ...(overrideReason ? { overrideReason } : {}),
        // Links the durable decision to the single-use approval evidence row.
        ...(approvalId ? { approvalId, recordedByUserId: scope.actorId } : {}),
      },
      ownerActorId: input.ownerAuthorizedByUserId,
    },
  });
  return { account, decision };
}

/**
 * Direct owner path: the authorizing owner must be the acting session. A second-person
 * approval only enters through `authorizeKhataCharge`, which verifies stored evidence.
 */
export async function applyKhataLimitDecision(
  db: ScopedDb,
  scope: FamilyKhataScope,
  input: KhataLimitDecisionInput
) {
  if (!input.ownerAuthorized || input.ownerAuthorizedByUserId !== scope.actorId)
    throw new FamilyKhataError('OWNER_ACTION_REQUIRED');
  return writeKhataLimitDecision(db, scope, input);
}

/** Entire append-only family ledger, never the counter's ten-sale preview. */
export async function readKhataBalance(
  db: ScopedDb,
  scope: FamilyKhataScope,
  familyAccountId: string
) {
  const totals = await db.pharmacyKhataEvent.groupBy({
    by: ['kind'],
    where: { organizationId: scope.organizationId, branchId: scope.branchId, familyAccountId },
    _sum: { amountMinor: true },
  });
  return totals.reduce(
    (sum, row) => sum + (row.kind === 'PAYMENT' ? -1 : 1) * (row._sum.amountMinor ?? 0),
    0
  );
}

/** Account membership is checked against the sale's server-read customer. */
export async function readSaleKhataAccounts(db: ScopedDb, scope: FamilyKhataScope, saleId: string) {
  const sale = await db.pharmacySale.findFirst({
    where: { id: saleId, organizationId: scope.organizationId, branchId: scope.branchId },
    select: { customerId: true },
  });
  if (!sale?.customerId) return [];
  const accounts = await db.pharmacyFamilyAccount.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      active: true,
      members: { some: { customerId: sale.customerId } },
    },
    select: {
      id: true,
      displayName: true,
      creditLimitMinor: true,
      members: { where: { customerId: sale.customerId }, select: { id: true } },
    },
    orderBy: { id: 'asc' },
  });
  return Promise.all(
    accounts.map(async (account) => ({
      id: account.id,
      displayName: account.displayName,
      creditLimitMinor: account.creditLimitMinor,
      memberId: account.members[0]!.id,
      balanceMinor: await readKhataBalance(db, scope, account.id),
    }))
  );
}

export async function readSaleKhataStatement(
  db: ScopedDb,
  scope: FamilyKhataScope,
  saleId: string,
  familyAccountId: string
) {
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_family_accounts WHERE id=${familyAccountId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR SHARE`
  );
  const account = (await readSaleKhataAccounts(db, scope, saleId)).find(
    (row) => row.id === familyAccountId
  );
  if (!account) throw new FamilyKhataError('ACCOUNT_NOT_FOUND');
  const rows = await db.pharmacyKhataEvent.findMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, familyAccountId },
    select: { id: true, kind: true, amountMinor: true, occurredAt: true },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: 1001,
  });
  return {
    account,
    generatedAt: new Date(),
    truncated: rows.length > 1000,
    entries: rows.slice(0, 1000),
  };
}

/** Caller holds the sale lock; family lock serializes competing counters. */
export async function authorizeKhataCharge(
  db: ScopedDb,
  scope: FamilyKhataScope,
  input: {
    saleId: string;
    familyAccountId: string;
    amountMinor: number;
    ownerOverride?: boolean;
    overrideReason?: string;
  },
  approval: { approvalId?: string }
) {
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_family_accounts WHERE id=${input.familyAccountId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`
  );
  const account = (await readSaleKhataAccounts(db, scope, input.saleId)).find(
    (row) => row.id === input.familyAccountId
  );
  if (!account) throw new FamilyKhataError('ACCOUNT_NOT_FOUND');
  const projected = account.balanceMinor + input.amountMinor;
  if (
    !Number.isSafeInteger(input.amountMinor) ||
    input.amountMinor <= 0 ||
    !Number.isSafeInteger(projected) ||
    projected > 2147483647
  )
    throw new FamilyKhataError('INVALID_AMOUNT');
  if (projected > account.creditLimitMinor) {
    if (!input.ownerOverride) throw new FamilyKhataError('CREDIT_LIMIT_EXCEEDED');
    const overrideReason = input.overrideReason?.trim();
    const approvals =
      approval.approvalId && overrideReason
        ? await db.$queryRaw<
            Array<{
              id: string;
              approverId: string;
              reason: string;
              createdAt: Date;
              approvedLimitMinor: number;
              dbNow: Date;
            }>
          >(Prisma.sql`
          SELECT id, "approverId", reason, "createdAt", "approvedLimitMinor",
            CURRENT_TIMESTAMP::timestamp(3) AS "dbNow"
          FROM pharmacy_khata_override_approvals
          WHERE id=${approval.approvalId} AND "organizationId"=${scope.organizationId}
            AND "branchId"=${scope.branchId} AND "saleId"=${input.saleId}
            AND "familyAccountId"=${input.familyAccountId} AND "amountMinor"=${input.amountMinor}
            AND btrim(reason)=${overrideReason}
            AND "consumedAt" IS NULL AND "expiresAt" >= NOW() FOR UPDATE`)
        : [];
    const evidence = approvals[0];
    const reason = evidence?.reason.trim();
    if (!evidence || !reason) throw new FamilyKhataError('OWNER_ACTION_REQUIRED');
    // The approver authorized a final limit, not an open-ended amount: a charge that landed
    // after approval must not push the account past the figure they saw.
    if (
      !Number.isSafeInteger(evidence.approvedLimitMinor) ||
      projected > evidence.approvedLimitMinor
    )
      throw new FamilyKhataError('OWNER_ACTION_REQUIRED');
    // Re-check the approver inside the tender transaction: a role change, deactivation or
    // branch unassignment after the approval was issued must still refuse the override.
    const approvers = await db.$queryRaw<
      Array<{
        id: string;
        status: string;
        role: string | null;
        roleKey: string | null;
        isSystem: boolean | null;
        branchAssigned: boolean | null;
      }>
    >(Prisma.sql`
      SELECT u.id, u.status::text AS status, u.role::text AS role, r.key AS "roleKey", r."isSystem",
        EXISTS (
          SELECT 1 FROM pharmacy_branch_assignments a
          JOIN pharmacy_branches b ON b.id = a."branchId" AND b."organizationId" = a."organizationId"
          WHERE a."organizationId" = u."organizationId" AND a."userId" = u.id
            AND a."branchId" = ${scope.branchId} AND a.active AND b.active
        ) AS "branchAssigned"
      FROM users u LEFT JOIN organization_roles r
        ON r.id = u."organizationRoleId" AND r."organizationId" = u."organizationId"
      WHERE u.id=${evidence.approverId} AND u."organizationId"=${scope.organizationId}
      FOR SHARE OF u`);
    const approver = approvers[0];
    if (!approver || !isKhataOverrideApprover(approver))
      throw new FamilyKhataError('OWNER_ACTION_REQUIRED');
    // A DENY added after issuance must still refuse consumption.
    if (!(await khataApproverCapable(db, approver)))
      throw new FamilyKhataError('OWNER_ACTION_REQUIRED');
    const consumed = await db.$executeRaw(Prisma.sql`
      UPDATE pharmacy_khata_override_approvals SET "consumedAt"=NOW()
      WHERE id=${evidence.id} AND "organizationId"=${scope.organizationId}
        AND "branchId"=${scope.branchId} AND "consumedAt" IS NULL`);
    if (consumed !== 1) throw new FamilyKhataError('OWNER_ACTION_REQUIRED');
    const now = new Date();
    const windowStart = new Date(now.getTime() - 180 * DAY_MS);
    // The durable override evidence must describe this account's real ledger. Keep the
    // query aligned with the calculator's stated window rather than supplying an empty
    // placeholder (or unrelated tenant history).
    const history = await db.pharmacyKhataEvent.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        familyAccountId: account.id,
        occurredAt: { gte: windowStart, lte: now },
      },
      select: {
        id: true,
        kind: true,
        amountMinor: true,
        occurredAt: true,
        dueAt: true,
        settlesChargeId: true,
      },
    });
    await writeKhataLimitDecision(
      db,
      scope,
      {
        familyAccountId: account.id,
        suggestion: calculateKhataHealthSuggestion(
          history,
          account.creditLimitMinor,
          windowStart,
          now
        ),
        ownerAuthorized: true,
        ownerAuthorizedByUserId: evidence.approverId,
        overrideReason: reason,
        ownerReauthenticatedAt: evidence.createdAt,
        overrideLimitMinor: projected,
      },
      evidence.id,
      evidence.dbNow instanceof Date ? evidence.dbNow : undefined
    );
  }
  return account;
}
