import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PharmacyKhataEvent } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { auditPatientRead } from './patient-prescriptions';
import { PharmacySettlementError, recordPharmacyCashMovement } from './settlement';

export type FamilyKhataScope = { organizationId: string; branchId: string; actorId: string };

type FamilyKhataSettlementResult = {
  paidMinor: number;
  remainingBalanceMinor: number;
  allocations: PharmacyKhataEvent[];
};

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
  input: {
    familyAccountId: string;
    amountMinor: number;
    occurredAt: Date;
    drawerSessionId?: string;
    deviceId?: string;
    idempotencyKey?: string;
  }
): Promise<FamilyKhataSettlementResult> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
    throw new FamilyKhataError('INVALID_AMOUNT');
  const accounts = await db.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT id FROM pharmacy_family_accounts WHERE id=${input.familyAccountId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`
  );
  if (!accounts.length) throw new FamilyKhataError('ACCOUNT_NOT_FOUND');

  const cashCollection =
    input.drawerSessionId !== undefined ||
    input.deviceId !== undefined ||
    input.idempotencyKey !== undefined;
  if (
    cashCollection &&
    (!input.drawerSessionId || !input.deviceId || !input.idempotencyKey?.trim())
  )
    throw new FamilyKhataError('INVALID_AMOUNT');

  let drawer: { id: string; deviceId: string; status: string } | null = null;
  let prior: { payloadHash: string; commandType: string; resultPayload: unknown } | null = null;
  if (cashCollection) {
    // Resolve the tenant and branch resources before consulting replay state. This
    // prevents a valid key from one branch revealing its result in another.
    drawer = await db.pharmacyDrawerSession.findFirst({
      where: {
        id: input.drawerSessionId!,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        deviceId: input.deviceId!,
      },
      select: { id: true, deviceId: true, status: true },
    });
    if (!drawer) throw new PharmacySettlementError('DRAWER_NOT_OPEN');

    const payloadHash = createHash('sha256')
      .update(
        JSON.stringify({
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          familyAccountId: input.familyAccountId,
          amountMinor: input.amountMinor,
          occurredAt: input.occurredAt,
          drawerSessionId: input.drawerSessionId,
          deviceId: input.deviceId,
        })
      )
      .digest('hex');
    await db.$executeRaw(Prisma.sql`
      INSERT INTO pharmacy_money_idempotency_keys
        (id, "organizationId", "deviceId", key, "commandType", "payloadHash", "createdAt")
      VALUES (${randomUUID()}, ${scope.organizationId}, ${input.deviceId!}, ${input.idempotencyKey!.trim()}, 'khata_collection', ${payloadHash}, now())
      ON CONFLICT ("organizationId", "deviceId", key) DO NOTHING`);
    prior = await db.pharmacyMoneyIdempotencyKey.findUnique({
      where: {
        organizationId_deviceId_key: {
          organizationId: scope.organizationId,
          deviceId: input.deviceId!,
          key: input.idempotencyKey!.trim(),
        },
      },
      select: { payloadHash: true, commandType: true, resultPayload: true },
    });
    if (!prior || prior.commandType !== 'khata_collection' || prior.payloadHash !== payloadHash)
      throw new PharmacySettlementError('IDEMPOTENCY_CONFLICT');
    if (prior.resultPayload) {
      const result = prior.resultPayload as FamilyKhataSettlementResult;
      // JSON storage loses Date instances; match the original response on retry.
      return {
        ...result,
        allocations: result.allocations.map((allocation) => ({
          ...allocation,
          occurredAt: new Date(allocation.occurredAt),
          dueAt: allocation.dueAt === null ? null : new Date(allocation.dueAt),
        })),
      };
    }
    // A committed collection remains replayable after close. Only new writes
    // require an open drawer; the movement helper rechecks under the day lock.
    if (drawer.status !== 'OPEN') throw new PharmacySettlementError('DRAWER_NOT_OPEN');
  }
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
  if (drawer)
    await recordPharmacyCashMovement(db, scope, {
      drawerSessionId: drawer.id,
      kind: 'PAID_IN',
      amountMinor: input.amountMinor,
      reason: `Khata collection: ${input.familyAccountId}`,
    });
  const result = {
    paidMinor: input.amountMinor,
    remainingBalanceMinor: balanceMinor - input.amountMinor,
    allocations,
  };
  if (prior)
    await db.pharmacyMoneyIdempotencyKey.update({
      where: {
        organizationId_deviceId_key: {
          organizationId: scope.organizationId,
          deviceId: input.deviceId!,
          key: input.idempotencyKey!.trim(),
        },
      },
      data: {
        resultPayload: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
      },
    });
  return result;
}

export async function applyKhataLimitDecision(
  db: ScopedDb,
  scope: FamilyKhataScope,
  input: {
    familyAccountId: string;
    suggestion: KhataHealthSuggestion;
    // Trusted server evidence only: never populate this from a client timestamp.
    ownerAuthorized: boolean;
    ownerAuthorizedByUserId?: string;
    ownerReauthenticatedAt?: Date;
    overrideLimitMinor?: number;
  }
) {
  const authorizedAt = new Date();
  const reauthenticatedAt = input.ownerReauthenticatedAt?.getTime();
  if (
    !input.ownerAuthorized ||
    input.ownerAuthorizedByUserId !== scope.actorId ||
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
      },
      ownerActorId: scope.actorId,
    },
  });
  return { account, decision };
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
  input: { saleId: string; familyAccountId: string; amountMinor: number; ownerOverride?: boolean },
  owner: { authorized: boolean; passwordAuthenticatedAt?: number }
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
    await applyKhataLimitDecision(db, scope, {
      familyAccountId: account.id,
      suggestion: calculateKhataHealthSuggestion(
        history,
        account.creditLimitMinor,
        windowStart,
        now
      ),
      ownerAuthorized: owner.authorized,
      ownerAuthorizedByUserId: scope.actorId,
      ownerReauthenticatedAt:
        owner.passwordAuthenticatedAt === undefined
          ? undefined
          : new Date(owner.passwordAuthenticatedAt),
      overrideLimitMinor: projected,
    });
  }
  return account;
}
