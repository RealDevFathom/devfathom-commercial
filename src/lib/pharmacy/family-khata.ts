import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { writePatientConsent } from './consent-writer';
import { linkCustomerToSale } from './customer-loyalty';
import { auditPatientRead } from './patient-prescriptions';
import { normalizeWhatsAppNumber } from './whatsapp/messages';

export type FamilyKhataScope = { organizationId: string; branchId: string; actorId: string };

export class FamilyKhataError extends Error {
  constructor(
    readonly reason:
      | 'MEMBER_NOT_FOUND'
      | 'CROSS_MEMBER_CLINICAL_ACCESS'
      | 'INVALID_AMOUNT'
      | 'PAYMENT_EXCEEDS_BALANCE'
      | 'OWNER_ACTION_REQUIRED'
      | 'OVERRIDE_REASON_REQUIRED'
      | 'CREDIT_LIMIT_EXCEEDED'
      | 'ACCOUNT_NOT_FOUND'
      | 'PATIENT_NOT_FOUND'
      | 'CONSENT_REQUIRED'
      | 'PHONE_REQUIRED'
      | 'PATIENT_AMBIGUOUS'
      | 'SALE_REDEEMED_BY_OTHER_CUSTOMER'
      | 'REFERENCE_REQUIRED'
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

/**
 * DEV-290: a manager's or owner's PIN approval at the cashier's till, already verified by
 * the server's counter-approval path (`authorizeCounterApproval` / `confirmCounterApproval`).
 * Never built from client input.
 */
export type KhataPinApproval = {
  approvedByUserId: string;
  approvalPolicy: string;
  selfApproved: boolean;
  credentialId: string | null;
};

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
  input: { familyAccountId: string; amountMinor: number; occurredAt: Date; note?: string }
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
          note: input.note,
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
    /**
     * DEV-290: the approver's reason for charging past the credit limit. When given
     * (the counter charge override always gives it), it must not be blank.
     */
    overrideReason?: string;
    /**
     * DEV-290: a server-verified PIN approval by a manager or owner at the till. It replaces
     * the signed-in owner's password re-authentication as the approval evidence.
     */
    pinApproval?: KhataPinApproval;
  }
) {
  const authorizedAt = new Date();
  const reauthenticatedAt = input.ownerReauthenticatedAt?.getTime();
  const pin = input.pinApproval;
  const pinAuthorized =
    pin !== undefined &&
    input.ownerAuthorizedByUserId === pin.approvedByUserId &&
    pin.approvedByUserId.length > 0 &&
    // Self-approval by PIN is only the solo rule's fresh re-entry, never a free pass.
    (pin.approvedByUserId !== scope.actorId || pin.selfApproved);
  const passwordAuthorized =
    pin === undefined &&
    input.ownerAuthorizedByUserId === scope.actorId &&
    reauthenticatedAt !== undefined &&
    Number.isFinite(reauthenticatedAt) &&
    reauthenticatedAt <= authorizedAt.getTime() &&
    authorizedAt.getTime() - reauthenticatedAt <= 5 * 60_000;
  if (!input.ownerAuthorized || !(pinAuthorized || passwordAuthorized))
    throw new FamilyKhataError('OWNER_ACTION_REQUIRED');
  const overrideReason = input.overrideReason?.trim();
  if (input.overrideReason !== undefined && !overrideReason)
    throw new FamilyKhataError('OVERRIDE_REASON_REQUIRED');
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
        ...(pin
          ? {
              approvalPolicy: pin.approvalPolicy,
              approvalCredentialId: pin.credentialId,
              selfApproved: pin.selfApproved,
              operatorUserId: scope.actorId,
            }
          : {
              ownerReauthenticatedAt: input.ownerReauthenticatedAt!.toISOString(),
              // DEV-290: a charge override by password is the sole approver's own
              // fresh re-authentication; the router refuses it when anyone else could approve.
              ...(input.overrideReason !== undefined
                ? { approvalPolicy: 'SOLE_APPROVER_PASSWORD_REAUTH', selfApproved: true }
                : {}),
            }),
        ownerAuthorizedAt: authorizedAt.toISOString(),
        ...(overrideReason ? { overrideReason } : {}),
      },
      // The person who authorized the limit: the PIN approver, or the re-authenticated actor.
      ownerActorId: pin ? pin.approvedByUserId : scope.actorId,
    },
  });
  return { account, decision };
}

/** Entire append-only family ledger, never the counter's ten-sale preview. */
export async function readKhataBalance(
  db: ScopedDb,
  scope: FamilyKhataScope,
  familyAccountId: string,
  /** Balance as it stood at this instant; omitted means the whole ledger. */
  asOf?: Date
) {
  const totals = await db.pharmacyKhataEvent.groupBy({
    by: ['kind'],
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      familyAccountId,
      ...(asOf ? { occurredAt: { lte: asOf } } : {}),
    },
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
  owner: { authorized: boolean; passwordAuthenticatedAt?: number; pinApproval?: KhataPinApproval }
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
      ownerAuthorizedByUserId: owner.pinApproval?.approvedByUserId ?? scope.actorId,
      pinApproval: owner.pinApproval,
      ownerReauthenticatedAt:
        owner.passwordAuthenticatedAt === undefined
          ? undefined
          : new Date(owner.passwordAuthenticatedAt),
      overrideLimitMinor: projected,
      // Always present for a charge override, so a blank reason is refused after the
      // approver's authorization is checked.
      overrideReason: input.overrideReason?.trim() ?? '',
    });
  }
  return account;
}

/**
 * One canonical form per number, so the same phone always finds the same patient.
 * Reuses the WhatsApp normalizer (03xx…, 3xx…, 0092…, +92…, Urdu digits → `+92…`);
 * numbers it rejects, such as local landlines, keep their digits, with `00` read as `+`.
 */
export function normalizeKhataPhone(phone: string) {
  const international = normalizeWhatsAppNumber(phone);
  if (international) return `+${international}`;
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  return `${trimmed.startsWith('+') ? '+' : ''}${digits}`;
}

/**
 * DEV-716: inline Khata signup from the counter's Khata tender.
 *
 * Finds (or creates) the patient, records in-person LOYALTY consent, links the
 * customer to the OPEN sale, then creates the family account with the customer
 * as payer and member. The limit is always 0 here: raising it goes through the
 * owner-authorized limit decision, never through signup.
 */
export async function signUpSaleKhata(
  db: ScopedDb,
  scope: FamilyKhataScope,
  input: {
    saleId: string;
    patientId?: string;
    displayName: string;
    phone?: string;
    consentGranted: boolean;
  }
) {
  if (input.consentGranted !== true) throw new FamilyKhataError('CONSENT_REQUIRED');
  const displayName = input.displayName.trim();
  const phone = input.phone ? normalizeKhataPhone(input.phone) : undefined;
  let patient: { id: string; displayName: string; phone: string | null } | null;
  if (input.patientId) {
    patient = await db.pharmacyPatient.findFirst({
      where: { id: input.patientId, organizationId: scope.organizationId },
      select: { id: true, displayName: true, phone: true },
    });
    if (!patient) throw new FamilyKhataError('PATIENT_NOT_FOUND');
  } else {
    if (!phone || phone.replace('+', '').length < 7) throw new FamilyKhataError('PHONE_REQUIRED');
    // Serialize find-or-create per number so two counters cannot both create the patient.
    await db.$queryRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`khata-signup:${scope.organizationId}:${phone}`}, 0))`
    );
    // Same name and phone only: a shared family phone must not merge two people.
    // Stored phones may carry spaces or dashes, so compare normalized numbers.
    const matches = (
      await db.pharmacyPatient.findMany({
        where: {
          organizationId: scope.organizationId,
          displayName: { equals: displayName, mode: 'insensitive' },
          phone: { not: null },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, displayName: true, phone: true },
      })
    ).filter((row) => row.phone !== null && normalizeKhataPhone(row.phone) === phone);
    // Two records with the same name and number: the operator must pick the patient.
    if (matches.length > 1) throw new FamilyKhataError('PATIENT_AMBIGUOUS');
    patient =
      matches[0] ??
      (await db.pharmacyPatient.create({
        data: { organizationId: scope.organizationId, displayName, phone },
        select: { id: true, displayName: true, phone: true },
      }));
  }
  const consent = await db.patientConsent.findFirst({
    where: { organizationId: scope.organizationId, patientId: patient.id, purpose: 'LOYALTY' },
    orderBy: [{ version: 'desc' }, { recordedAt: 'desc' }],
    select: { granted: true, revokedAt: true },
  });
  if (!consent?.granted || consent.revokedAt)
    await writePatientConsent(db, scope.organizationId, scope.actorId, {
      patientId: patient.id,
      purpose: 'LOYALTY',
      channel: 'IN_PERSON',
      granted: true,
      source: 'COUNTER_TABLET',
    });
  // A selected patient keeps their stored phone; a request phone only names a new patient.
  const phoneLast4 = ((input.patientId ? patient.phone : phone) ?? '').replace(/\D/g, '').slice(-4);
  // A redemption belongs to the customer who redeemed: signup must not move it to someone else,
  // or a later refund would restore those points to the new customer.
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_sales WHERE id=${input.saleId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`
  );
  const redemption = await db.pharmacyLoyaltyPointsEntry.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId: input.saleId,
      kind: 'REDEEM',
      customer: { patientId: { not: patient.id } },
    },
    select: { id: true },
  });
  if (redemption) throw new FamilyKhataError('SALE_REDEEMED_BY_OTHER_CUSTOMER');
  const customer = await linkCustomerToSale(db, scope, {
    saleId: input.saleId,
    patientId: patient.id,
    displayName: patient.displayName,
    ...(phoneLast4.length === 4 ? { phoneLast4 } : {}),
  });
  // Serialize account creation per customer and branch so two counters cannot open two ledgers.
  await db.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`khata-account:${scope.organizationId}:${scope.branchId}:${customer.id}`}, 0))`
  );
  const existing = await db.pharmacyFamilyAccount.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      active: true,
      members: { some: { customerId: customer.id } },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  if (existing) return { customerId: customer.id, familyAccountId: existing.id, created: false };
  const account = await db.pharmacyFamilyAccount.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      payerCustomerId: customer.id,
      displayName: patient.displayName,
      creditLimitMinor: 0,
    },
    select: { id: true },
  });
  await db.pharmacyFamilyMember.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      familyAccountId: account.id,
      customerId: customer.id,
    },
  });
  return { customerId: customer.id, familyAccountId: account.id, created: true };
}

const KHATA_REFUND_ID_PREFIX = 'khata-refund:';
export const KHATA_LEDGER_LIST_LIMIT = 500;

export type KhataLedgerRow = {
  id: string;
  displayName: string;
  payerName: string;
  phoneLast4: string | null;
  balanceMinor: number;
  creditLimitMinor: number;
  lastPaymentAt: Date | null;
  oldestOverdueAt: Date | null;
};

/**
 * DEV-730 owner list: every active family account on one branch with its full-ledger
 * balance, limit, last customer payment and oldest overdue charge. Refund reversals are
 * ledger credits but not customer payments, so they never count as "last payment".
 */
export async function listKhataLedger(
  db: ScopedDb,
  scope: FamilyKhataScope,
  now: Date = new Date()
): Promise<{ accounts: KhataLedgerRow[]; truncated: boolean }> {
  const where = { organizationId: scope.organizationId, branchId: scope.branchId };
  const accounts = await db.pharmacyFamilyAccount.findMany({
    where: { ...where, active: true },
    select: {
      id: true,
      displayName: true,
      creditLimitMinor: true,
      payer: { select: { displayName: true, phoneLast4: true } },
    },
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    take: KHATA_LEDGER_LIST_LIMIT + 1,
  });
  const visible = accounts.slice(0, KHATA_LEDGER_LIST_LIMIT);
  const ids = visible.map((account) => account.id);
  if (!ids.length) return { accounts: [], truncated: false };
  const accountWhere = { ...where, familyAccountId: { in: ids } };
  const [totals, payments, events] = await Promise.all([
    db.pharmacyKhataEvent.groupBy({
      by: ['familyAccountId', 'kind'],
      where: accountWhere,
      _sum: { amountMinor: true },
    }),
    db.pharmacyKhataEvent.groupBy({
      by: ['familyAccountId'],
      where: {
        ...accountWhere,
        kind: 'PAYMENT',
        NOT: { id: { startsWith: KHATA_REFUND_ID_PREFIX } },
      },
      _max: { occurredAt: true },
    }),
    db.pharmacyKhataEvent.findMany({
      where: {
        ...accountWhere,
        OR: [{ kind: 'CHARGE' }, { kind: 'PAYMENT' }, { kind: 'DISHONOURED_CHEQUE' }],
      },
      select: {
        id: true,
        familyAccountId: true,
        kind: true,
        amountMinor: true,
        dueAt: true,
        occurredAt: true,
        settlesChargeId: true,
      },
    }),
  ]);
  const balance = new Map<string, number>();
  for (const row of totals)
    balance.set(
      row.familyAccountId,
      (balance.get(row.familyAccountId) ?? 0) +
        (row.kind === 'PAYMENT' ? -1 : 1) * (row._sum.amountMinor ?? 0)
    );
  const lastPayment = new Map(payments.map((row) => [row.familyAccountId, row._max.occurredAt]));
  // A dishonoured cheque re-opens what it bounced: linked to a payment it re-opens that
  // payment's charge, linked to a charge it re-opens that charge; otherwise it is owed now.
  const paymentCharge = new Map<string, string | null>();
  for (const event of events)
    if (event.kind === 'PAYMENT') paymentCharge.set(event.id, event.settlesChargeId);
  const chargeIds = new Set(events.filter((e) => e.kind === 'CHARGE').map((e) => e.id));
  const paid = new Map<string, number>();
  const overdue = new Map<string, Date>();
  const markOverdue = (accountId: string, at: Date) => {
    const current = overdue.get(accountId);
    if (!current || at < current) overdue.set(accountId, at);
  };
  for (const event of events) {
    if (event.kind === 'PAYMENT' && event.settlesChargeId)
      paid.set(event.settlesChargeId, (paid.get(event.settlesChargeId) ?? 0) + event.amountMinor);
    if (event.kind !== 'DISHONOURED_CHEQUE') continue;
    const chargeId =
      (event.settlesChargeId && paymentCharge.get(event.settlesChargeId)) || event.settlesChargeId;
    if (chargeId && chargeIds.has(chargeId))
      paid.set(chargeId, (paid.get(chargeId) ?? 0) - event.amountMinor);
    else markOverdue(event.familyAccountId, event.occurredAt);
  }
  for (const event of events) {
    if (event.kind !== 'CHARGE' || !event.dueAt || event.dueAt > now) continue;
    if (event.amountMinor <= (paid.get(event.id) ?? 0)) continue;
    markOverdue(event.familyAccountId, event.dueAt);
  }
  return {
    truncated: accounts.length > KHATA_LEDGER_LIST_LIMIT,
    accounts: visible
      .map((account) => ({
        id: account.id,
        displayName: account.displayName,
        payerName: account.payer.displayName,
        phoneLast4: account.payer.phoneLast4,
        balanceMinor: balance.get(account.id) ?? 0,
        creditLimitMinor: account.creditLimitMinor,
        lastPaymentAt: lastPayment.get(account.id) ?? null,
        oldestOverdueAt: overdue.get(account.id) ?? null,
      }))
      .sort((a, b) => b.balanceMinor - a.balanceMinor),
  };
}
