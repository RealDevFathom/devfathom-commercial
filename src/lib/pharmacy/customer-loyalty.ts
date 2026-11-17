import 'server-only';

import { assertSaleBatchesSellable } from './sale-batch-safety';
import { completePaidPharmacySale, completionSaleInclude } from './sale-completion';
import { postTenderEntry } from './finance-postings';
import { requestCounterEvidence } from './counter-evidence';
import { lockCustomerConsent } from './consent-writer';
import { assertRxSaleAllowed } from './rx-sale-gate';
import { assertStoredPharmacyMayOperate } from './regulatory';

import { Prisma } from '@/generated/prisma/client';
import {
  earnedPointsFor,
  LOYALTY_POINT_VALUE_MINOR,
  loyaltyExpiresAt,
  loyaltyLiabilityMinor,
  pointsForRedeemedMoney,
  redemptionFor,
} from '@/lib/commerce/loyalty-arithmetic';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { expireStrandedRestoration, pointsPastExpiry } from './loyalty-expiry';
import {
  currentLoyaltyProgram,
  hasLoyaltyEarningConsent,
  lockedLoyaltyProgram,
} from './loyalty-program';
import type { LedgerScope } from './stock-ledger';

/** Tenders that never earn at sale time: points themselves, and khata until it is paid. */
export const SALE_EARN_EXCLUDED_TENDERS: readonly string[] = ['LOYALTY', 'CREDIT'];

/**
 * DEV-764: an EXPIRY entry that closed a lot already spent in full takes no points. It stays in
 * the ledger (it is how the expiry job knows the lot is closed) but is not shown as an event.
 */
const CLOSED_LOT_WITHOUT_POINTS = { kind: 'EXPIRY', points: 0 } as const;

export class PharmacyLoyaltyError extends Error {
  constructor(
    readonly reason:
      | 'LOYALTY_CONSENT_REQUIRED'
      | 'CUSTOMER_NOT_FOUND'
      | 'PRESCRIPTION_PATIENT_MISMATCH'
      | 'SALE_NOT_OPEN'
      | 'SALE_NOT_LINKED'
      | 'INSUFFICIENT_POINTS'
      | 'INVALID_REDEMPTION'
      | 'IDEMPOTENCY_CONFLICT'
      | 'INVALID_ADJUSTMENT'
      | 'ADJUSTMENT_EXCEEDS_BALANCE'
      | 'MANAGER_ADJUSTMENT_LIMIT'
  ) {
    super(reason);
  }
}

export async function linkCustomerToSale(
  db: ScopedDb,
  scope: LedgerScope,
  input: { saleId: string; patientId: string; displayName: string; phoneLast4?: string }
) {
  const consent = await db.patientConsent.findFirst({
    where: { organizationId: scope.organizationId, patientId: input.patientId, purpose: 'LOYALTY' },
    orderBy: [{ version: 'desc' }, { recordedAt: 'desc' }],
    select: { granted: true, revokedAt: true },
  });
  if (!consent?.granted || consent.revokedAt)
    throw new PharmacyLoyaltyError('LOYALTY_CONSENT_REQUIRED');
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_sales WHERE id=${input.saleId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`
  );
  const sale = await db.pharmacySale.findFirst({
    where: {
      id: input.saleId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'OPEN',
    },
  });
  if (!sale) throw new PharmacyLoyaltyError('SALE_NOT_OPEN');
  const referencedLine = await db.pharmacySaleLine.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId: sale.id,
      prescriptionLineId: { not: null },
      prescriptionPatientId: { not: input.patientId },
    },
    select: { id: true },
  });
  if (referencedLine) throw new PharmacyLoyaltyError('PRESCRIPTION_PATIENT_MISMATCH');
  const customer = await db.pharmacyCustomer.upsert({
    where: {
      organizationId_patientId: {
        organizationId: scope.organizationId,
        patientId: input.patientId,
      },
    },
    update: {
      displayName: input.displayName.trim(),
      phoneLast4: input.phoneLast4,
      active: true,
    },
    create: {
      organizationId: scope.organizationId,
      patientId: input.patientId,
      displayName: input.displayName.trim(),
      phoneLast4: input.phoneLast4,
    },
  });
  await db.pharmacySale.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: sale.id } },
    data: { customerId: customer.id },
  });
  return { id: customer.id, displayName: customer.displayName, phoneLast4: customer.phoneLast4 };
}

export async function accrueSalePoints(db: ScopedDb, scope: LedgerScope, saleId: string) {
  const prior = await db.pharmacyLoyaltyPointsEntry.findUnique({
    where: {
      organizationId_idempotencyKey: {
        organizationId: scope.organizationId,
        idempotencyKey: `loyalty:earn:${saleId}`,
      },
    },
  });
  if (prior) return { ...prior, replayed: true };
  const sale = await db.pharmacySale.findFirst({
    where: { id: saleId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: { tenders: true },
  });
  if (!sale?.customerId) return null;
  // DEV-746: points are earned on money received. Points tenders never earn, and a khata
  // (CREDIT) tender earns only when the debt is paid at the counter (earnKhataCollectionPoints).
  const netPaidMinor = sale.tenders
    .filter((tender) => !SALE_EARN_EXCLUDED_TENDERS.includes(tender.type))
    .reduce((sum, tender) => sum + tender.amountMinor, 0);
  if (netPaidMinor === 0) return null;
  // No rate set by the owner means nothing is earned; no default rate is assumed.
  const program = await currentLoyaltyProgram(db, scope.organizationId);
  if (!program) return null;
  const points = earnedPointsFor(netPaidMinor, program);
  if (points === 0) return null;
  if (!(await hasLoyaltyEarningConsent(db, scope.organizationId, sale.customerId))) return null;
  const entry = await db.pharmacyLoyaltyPointsEntry.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      customerId: sale.customerId,
      saleId: sale.id,
      kind: 'EARN',
      points,
      netPaidMinor,
      programVersionId: program.id,
      // DEV-764: the lot lasts as long as the program in force when it was earned says.
      expiresAt: loyaltyExpiresAt(new Date(), program.expiryDays),
      actorId: scope.actorId,
      idempotencyKey: `loyalty:earn:${sale.id}`,
    },
  });
  return { ...entry, replayed: false };
}

export async function redeemSalePoints(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    saleId: string;
    points: number;
    deviceId: string;
    businessDate: Date;
    idempotencyKey: string;
  }
) {
  const key = `loyalty:redeem:${input.idempotencyKey}`;
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_sales WHERE id=${input.saleId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`
  );
  const prior = await db.pharmacyLoyaltyPointsEntry.findUnique({
    where: {
      organizationId_idempotencyKey: { organizationId: scope.organizationId, idempotencyKey: key },
    },
    include: { tender: true },
  });
  if (prior) {
    if (
      prior.branchId !== scope.branchId ||
      prior.saleId !== input.saleId ||
      prior.requestedPoints !== input.points
    )
      throw new PharmacyLoyaltyError('IDEMPOTENCY_CONFLICT');
    return { points: -prior.points, amountMinor: prior.tender!.amountMinor, replayed: true };
  }
  // A points redemption can settle the sale, so it shares the settlement gate.
  await assertStoredPharmacyMayOperate(db, scope.organizationId, scope.branchId, {
    name: 'pharmacy.sale.tender',
  });
  const sale = await db.pharmacySale.findFirst({
    where: {
      id: input.saleId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'OPEN',
    },
    include: completionSaleInclude,
  });
  if (!sale) throw new PharmacyLoyaltyError('SALE_NOT_OPEN');
  if (!sale.customerId) throw new PharmacyLoyaltyError('SALE_NOT_LINKED');
  // DEV-86: a regulated line added inside pharmacist-presence hours cannot be paid for,
  // and the sale completed, after those hours close.
  if (
    sale.lines.some(({ medicine }) => medicine?.rx || medicine?.restricted || medicine?.controlled)
  )
    await assertStoredPharmacyMayOperate(db, scope.organizationId, scope.branchId, {
      name: 'pharmacy.sale.tender_regulated',
      requiresQualifiedPerson: true,
      requiresPharmacistPresence: true,
    });
  // A points redemption is still payment. Apply the same line-aware Rx gate as every
  // other tender, while leaving OTC loyalty redemption available to counter staff.
  await assertRxSaleAllowed(
    db,
    scope,
    sale.lines.map((line) => line.medicine)
  );
  // #659: a points tender is a tender: refuse it while any batch on the bill is unsafe.
  await assertSaleBatchesSellable(db, scope, sale.id);
  // DEV-764: lock order on every path is program, then customer. The redemption value is read
  // under the program lock so an owner save cannot change it under this redemption.
  const program = await lockedLoyaltyProgram(db, scope.organizationId);
  await lockCustomerConsent(db, scope.organizationId, sale.customerId);
  const customer = await db.pharmacyCustomer.findFirst({
    where: { id: sale.customerId, organizationId: scope.organizationId, active: true },
    select: { patientId: true },
  });
  if (!customer?.patientId) throw new PharmacyLoyaltyError('CUSTOMER_NOT_FOUND');
  const consent = await db.patientConsent.findFirst({
    where: {
      organizationId: scope.organizationId,
      patientId: customer.patientId,
      purpose: 'LOYALTY',
    },
    orderBy: [{ version: 'desc' }, { recordedAt: 'desc' }],
    select: { granted: true, revokedAt: true },
  });
  if (!consent?.granted || consent.revokedAt)
    throw new PharmacyLoyaltyError('LOYALTY_CONSENT_REQUIRED');
  const balance = await db.pharmacyLoyaltyPointsEntry.aggregate({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      customerId: sale.customerId,
    },
    _sum: { points: true },
  });
  const totalMinor = sale.lines.reduce(
    (sum, line) => sum + line.grossMinor - line.discountMinor,
    0
  );
  const outstandingMinor =
    totalMinor - sale.tenders.reduce((sum, tender) => sum + tender.amountMinor, 0);
  // DEV-764: points redeem at the owner's current redemption value (PKR 1 before one is set),
  // and points already past their expiry date cannot be spent even before the sweep runs.
  const pastExpiry = await pointsPastExpiry(
    db,
    { organizationId: scope.organizationId, branchId: scope.branchId, customerId: sale.customerId },
    new Date()
  );
  let redemption: { points: number; amountMinor: number };
  try {
    redemption = redemptionFor({
      requestedPoints: input.points,
      availablePoints: Math.max(0, (balance._sum.points ?? 0) - pastExpiry),
      outstandingMinor,
      pointValueMinor: program?.redemptionValueMinor ?? LOYALTY_POINT_VALUE_MINOR,
    });
  } catch (error) {
    throw new PharmacyLoyaltyError(
      error instanceof RangeError && error.message === 'INSUFFICIENT_POINTS'
        ? 'INSUFFICIENT_POINTS'
        : 'INVALID_REDEMPTION'
    );
  }
  const tender = await db.pharmacyTender.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId: sale.id,
      type: 'LOYALTY',
      amountMinor: redemption.amountMinor,
      businessDate: input.businessDate,
      actorId: scope.actorId,
      deviceId: input.deviceId,
    },
  });
  await db.pharmacyLoyaltyPointsEntry.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      customerId: sale.customerId,
      saleId: sale.id,
      tenderId: tender.id,
      kind: 'REDEEM',
      points: -redemption.points,
      requestedPoints: input.points,
      actorId: scope.actorId,
      idempotencyKey: key,
    },
  });
  await postTenderEntry(db, scope, { tenderId: tender.id, at: tender.createdAt });
  const settled = redemption.amountMinor === outstandingMinor;
  let receiptNumber: number | null = null;
  if (settled) {
    receiptNumber = await completePaidPharmacySale(db, scope, sale, input);
    await accrueSalePoints(db, scope, sale.id);
  }
  await requestCounterEvidence(db, scope, { kind: 'TENDER', subjectId: tender.id });
  return { ...redemption, settled, receiptNumber, replayed: false };
}

export async function restoreRefundedLoyaltyPoints(
  db: ScopedDb,
  scope: LedgerScope,
  input: { refundId: string; tenderId: string; saleId: string; customerId: string }
) {
  // DEV-764: the same per-customer lock as redemption, adjustment, void release and the expiry
  // sweep, so restored points cannot land in a lot the sweep is closing at the same moment.
  // The refund flow already holds the sale and tender rows, the same order as redemption.
  await lockCustomerConsent(db, scope.organizationId, input.customerId);
  const key = `loyalty:refund:${input.refundId}`;
  const prior = await db.pharmacyLoyaltyPointsEntry.findUnique({
    where: {
      organizationId_idempotencyKey: { organizationId: scope.organizationId, idempotencyKey: key },
    },
  });
  if (prior) return { ...prior, replayed: true };
  const redemption = await db.pharmacyLoyaltyPointsEntry.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      tenderId: input.tenderId,
      kind: 'REDEEM',
    },
    select: { points: true, tender: { select: { amountMinor: true } } },
  });
  if (!redemption?.tender) return null;
  const [refunds, restored] = await Promise.all([
    db.pharmacyRefund.aggregate({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        originalTenderId: input.tenderId,
      },
      _sum: { amountMinor: true },
    }),
    db.pharmacyLoyaltyPointsEntry.aggregate({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        tenderId: input.tenderId,
        // DEV-764: points a void already released are given back once, never again.
        kind: { in: ['REFUND', 'REDEMPTION_RELEASE'] },
      },
      _sum: { points: true },
    }),
  ]);
  const redeemedPoints = -redemption.points;
  // DEV-764: at the value the points were redeemed at (PKR 1 each before DEV-764), so a later
  // change of redemption value never mints or loses points on a refund.
  const target = pointsForRedeemedMoney({
    releasedMinor: refunds._sum.amountMinor ?? 0,
    tenderMinor: redemption.tender.amountMinor,
    redeemedPoints,
  });
  const points = target - (restored._sum.points ?? 0);
  if (points <= 0) return null;
  const entry = await db.pharmacyLoyaltyPointsEntry.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      customerId: input.customerId,
      saleId: input.saleId,
      tenderId: input.tenderId,
      refundId: input.refundId,
      kind: 'REFUND',
      points,
      actorId: scope.actorId,
      idempotencyKey: key,
    },
  });
  // DEV-764: points restored into a lot that has since expired are expired again at once.
  await expireStrandedRestoration(
    db,
    {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      customerId: input.customerId,
    },
    entry,
    new Date()
  );
  return { ...entry, replayed: false };
}

export async function readCustomerSnapshot(
  db: ScopedDb,
  scope: LedgerScope,
  customerId: string,
  page = 1
) {
  const customer = await db.pharmacyCustomer.findFirst({
    where: { id: customerId, organizationId: scope.organizationId, active: true },
    select: { id: true, displayName: true, phoneLast4: true, creditLimitMinor: true },
  });
  if (!customer) throw new PharmacyLoyaltyError('CUSTOMER_NOT_FOUND');
  const [points, sales, pointsHistory, pointsCount, program] = await Promise.all([
    db.pharmacyLoyaltyPointsEntry.aggregate({
      where: { organizationId: scope.organizationId, branchId: scope.branchId, customerId },
      _sum: { points: true },
    }),
    db.pharmacySale.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        customerId,
        status: 'COMPLETED',
      },
      select: {
        id: true,
        receiptNumber: true,
        completedAt: true,
        lines: { select: { grossMinor: true, discountMinor: true } },
        tenders: {
          select: { type: true, amountMinor: true, refunds: { select: { amountMinor: true } } },
        },
      },
      orderBy: { completedAt: 'desc' },
      take: 10,
    }),
    db.pharmacyLoyaltyPointsEntry.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        customerId,
        NOT: CLOSED_LOT_WITHOUT_POINTS,
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * 25,
      take: 25,
      select: {
        id: true,
        kind: true,
        points: true,
        occurredAt: true,
        saleId: true,
        refundId: true,
        sale: { select: { receiptNumber: true } },
      },
    }),
    db.pharmacyLoyaltyPointsEntry.count({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        customerId,
        NOT: CLOSED_LOT_WITHOUT_POINTS,
      },
    }),
    currentLoyaltyProgram(db, scope.organizationId),
  ]);
  const creditBalanceMinor = sales
    .flatMap((sale) => sale.tenders)
    .filter((tender) => tender.type === 'CREDIT')
    .reduce(
      (sum, tender) =>
        sum +
        tender.amountMinor -
        tender.refunds.reduce((value, row) => value + row.amountMinor, 0),
      0
    );
  return {
    customer,
    pointsBalance: points._sum.points ?? 0,
    // DEV-746: false until the owner sets an earn rate; nothing new is earned until then.
    earnRateSet: Boolean(program),
    // DEV-764: what one point redeems for at the counter now.
    pointValueMinor: program?.redemptionValueMinor ?? LOYALTY_POINT_VALUE_MINOR,
    pointsHistory,
    pointsCount,
    pointsPage: page,
    creditBalanceMinor,
    availableCreditMinor: Math.max(0, customer.creditLimitMinor - creditBalanceMinor),
    history: sales.map((sale) => ({
      saleId: sale.id,
      receiptNumber: sale.receiptNumber,
      completedAt: sale.completedAt,
      totalMinor: sale.lines.reduce((sum, line) => sum + line.grossMinor - line.discountMinor, 0),
    })),
  };
}

// Ordinary history consumers only. Accounting and counter snapshot contracts stay separate.
export const LOYALTY_HISTORY_PAGE_SIZE = 25;
export const LOYALTY_HISTORY_MAX_PAGE = 10_000;

async function assertLoyaltyHistoryBranch(db: ScopedDb, scope: LedgerScope) {
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: scope.branchId, organizationId: scope.organizationId, active: true },
    select: { id: true },
  });
  if (!branch) throw new PharmacyLoyaltyError('CUSTOMER_NOT_FOUND');
}

const LOYALTY_SEARCH_MAX_TERMS = 6;

// DEV-671: the loyalty name is a snapshot taken when the customer was first linked at the
// counter, so matching only that one column missed customers known by their patient name,
// phone number or loyalty number. Every word must match one of those identity fields.
function loyaltyCustomerSearch(query: string): Prisma.PharmacyCustomerWhereInput[] {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, LOYALTY_SEARCH_MAX_TERMS)
    .map((term) => {
      const match: Prisma.PharmacyCustomerWhereInput[] = [
        { displayName: { contains: term, mode: 'insensitive' } },
        { patient: { displayName: { contains: term, mode: 'insensitive' } } },
        { id: term },
      ];
      const digits = term.replace(/\D/g, '');
      if (/^\+?[\d()-]+$/.test(term) && digits.length >= 4) {
        if (digits.length === 4) match.push({ phoneLast4: digits });
        // Stored numbers mix +92 and 0 prefixes; compare the subscriber part.
        const local = digits.length > 4 ? digits.replace(/^(?:92|0)/, '') : digits;
        match.push({ patient: { phone: { contains: local } } });
      }
      return { OR: match };
    });
}

export async function listLoyaltyCustomers(db: ScopedDb, scope: LedgerScope, query = '') {
  if (query.trim().length > 100) throw new RangeError('INVALID_CUSTOMER_QUERY');
  await assertLoyaltyHistoryBranch(db, scope);
  const terms = loyaltyCustomerSearch(query);
  // Retail identities are tenant-wide; balances and entries below are branch-specific.
  const rows = await db.pharmacyCustomer.findMany({
    where: {
      organizationId: scope.organizationId,
      active: true,
      ...(terms.length ? { AND: terms } : {}),
    },
    select: { id: true, displayName: true, phoneLast4: true },
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    take: 51,
  });
  const customers = rows.slice(0, 50);
  const balances = customers.length
    ? await db.pharmacyLoyaltyPointsEntry.groupBy({
        by: ['customerId'],
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          customerId: { in: customers.map((customer) => customer.id) },
        },
        _sum: { points: true },
      })
    : [];
  const pointsBy = new Map(balances.map((row) => [row.customerId, row._sum.points ?? 0]));
  return {
    customers: customers.map((customer) => ({
      ...customer,
      pointsBalance: pointsBy.get(customer.id) ?? 0,
    })),
    hasMore: rows.length > 50,
  };
}

export async function readLoyaltyHistory(
  db: ScopedDb,
  scope: LedgerScope,
  customerId: string,
  page = 1
) {
  if (!Number.isInteger(page) || page < 1 || page > LOYALTY_HISTORY_MAX_PAGE)
    throw new RangeError('INVALID_HISTORY_PAGE');
  await assertLoyaltyHistoryBranch(db, scope);
  const customer = await db.pharmacyCustomer.findFirst({
    where: { id: customerId, organizationId: scope.organizationId, active: true },
    select: { id: true, displayName: true, phoneLast4: true, preferredLanguage: true },
  });
  if (!customer) throw new PharmacyLoyaltyError('CUSTOMER_NOT_FOUND');
  const where = { organizationId: scope.organizationId, branchId: scope.branchId, customerId };
  const listed = { ...where, NOT: CLOSED_LOT_WITHOUT_POINTS };
  const [balance, total] = await Promise.all([
    db.pharmacyLoyaltyPointsEntry.aggregate({ where, _sum: { points: true } }),
    db.pharmacyLoyaltyPointsEntry.count({ where: listed }),
  ]);
  const pageCount = Math.max(1, Math.ceil(total / LOYALTY_HISTORY_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const entries = await db.pharmacyLoyaltyPointsEntry.findMany({
    where: listed,
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    skip: (currentPage - 1) * LOYALTY_HISTORY_PAGE_SIZE,
    take: LOYALTY_HISTORY_PAGE_SIZE,
    select: {
      id: true,
      kind: true,
      points: true,
      occurredAt: true,
      saleId: true,
      tenderId: true,
      refundId: true,
      reason: true,
      expiresAt: true,
      sale: { select: { receiptNumber: true, receiptDeviceId: true } },
    },
  });
  return {
    customer,
    pointsBalance: balance._sum.points ?? 0,
    entries,
    total,
    page: currentPage,
    pageCount,
    hasNext: currentPage < Math.min(pageCount, LOYALTY_HISTORY_MAX_PAGE),
    historyLimitReached:
      pageCount > LOYALTY_HISTORY_MAX_PAGE && currentPage === LOYALTY_HISTORY_MAX_PAGE,
  };
}

/** DEV-764: the most points one manual adjustment may add or remove. */
export const LOYALTY_MAX_ADJUSTMENT_POINTS = 1_000_000;

/**
 * DEV-764: an owner's or manager's correction to a customer's points at one branch, with a
 * written reason. Append-only: it is a new signed entry, never an edit of an earlier one. A
 * removal may not take the balance below zero. The caller has authorized the actor and records
 * the audit; this runs in the caller's tenant transaction.
 */
const PAKISTAN_OFFSET_MS = 5 * 3_600_000;
const DAY_MS = 86_400_000;

/**
 * DEV-881: the Pakistan calendar day (Asia/Karachi, UTC+05:00, no daylight saving) holding
 * `now`, as a half-open UTC range. A manager's adjustment allowance resets at local midnight.
 */
export function loyaltyAdjustmentDay(now: Date): { from: Date; to: Date } {
  const local = new Date(now.getTime() + PAKISTAN_OFFSET_MS);
  const start =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - PAKISTAN_OFFSET_MS;
  return { from: new Date(start), to: new Date(start + DAY_MS) };
}

/**
 * DEV-764: a manual adjustment. DEV-881: with `managerLimit`, the owner's ceiling applies to the
 * total of every adjustment (added and removed points both count) to this customer in the
 * current Pakistan calendar day, across branches, this one included, so a large grant cannot be
 * split into entries that are each under the ceiling. Checked under the customer lock, after an
 * idempotent replay is recognised, so concurrent entries cannot both pass and a retry is never
 * refused.
 */
export async function adjustLoyaltyPoints(
  db: ScopedDb,
  scope: LedgerScope,
  input: { customerId: string; points: number; reason: string; idempotencyKey: string },
  options: { managerLimit?: number; now?: Date } = {}
) {
  const reason = input.reason.trim();
  if (
    !Number.isSafeInteger(input.points) ||
    input.points === 0 ||
    Math.abs(input.points) > LOYALTY_MAX_ADJUSTMENT_POINTS ||
    reason.length < 3 ||
    reason.length > 500
  )
    throw new PharmacyLoyaltyError('INVALID_ADJUSTMENT');
  await assertLoyaltyHistoryBranch(db, scope);
  const customer = await db.pharmacyCustomer.findFirst({
    where: { id: input.customerId, organizationId: scope.organizationId, active: true },
    select: { id: true },
  });
  if (!customer) throw new PharmacyLoyaltyError('CUSTOMER_NOT_FOUND');
  // Same per-customer lock as redemption, so a removal and a redemption cannot both spend
  // the same points.
  await lockCustomerConsent(db, scope.organizationId, customer.id);
  const key = `loyalty:adjust:${input.idempotencyKey}`;
  const prior = await db.pharmacyLoyaltyPointsEntry.findUnique({
    where: {
      organizationId_idempotencyKey: { organizationId: scope.organizationId, idempotencyKey: key },
    },
  });
  if (prior) {
    if (
      prior.kind !== 'ADJUSTMENT' ||
      prior.branchId !== scope.branchId ||
      prior.customerId !== customer.id ||
      prior.points !== input.points ||
      prior.reason !== reason
    )
      throw new PharmacyLoyaltyError('IDEMPOTENCY_CONFLICT');
    return { entry: prior, balanceBefore: null, balanceAfter: null, replayed: true };
  }
  // Taken after the lock, and stored as the entry's occurredAt below, so the cap window and the
  // recorded day always agree even when this transaction waited for the lock across midnight.
  const now = options.now ?? new Date();
  if (options.managerLimit !== undefined) {
    const day = loyaltyAdjustmentDay(now);
    const today = {
      organizationId: scope.organizationId,
      customerId: customer.id,
      kind: 'ADJUSTMENT' as const,
      occurredAt: { gte: day.from, lt: day.to },
    };
    const [added, removed] = await Promise.all([
      db.pharmacyLoyaltyPointsEntry.aggregate({
        where: { ...today, points: { gt: 0 } },
        _sum: { points: true },
      }),
      db.pharmacyLoyaltyPointsEntry.aggregate({
        where: { ...today, points: { lt: 0 } },
        _sum: { points: true },
      }),
    ]);
    const adjustedToday = (added._sum.points ?? 0) - (removed._sum.points ?? 0);
    if (adjustedToday + Math.abs(input.points) > options.managerLimit)
      throw new PharmacyLoyaltyError('MANAGER_ADJUSTMENT_LIMIT');
  }
  const balance = await db.pharmacyLoyaltyPointsEntry.aggregate({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      customerId: customer.id,
    },
    _sum: { points: true },
  });
  const balanceBefore = balance._sum.points ?? 0;
  // A removal may take only points that can still be spent: not those already past expiry.
  if (input.points < 0) {
    const pastExpiry = await pointsPastExpiry(
      db,
      { organizationId: scope.organizationId, branchId: scope.branchId, customerId: customer.id },
      new Date()
    );
    if (balanceBefore - pastExpiry + input.points < 0)
      throw new PharmacyLoyaltyError('ADJUSTMENT_EXCEEDS_BALANCE');
  }
  const entry = await db.pharmacyLoyaltyPointsEntry.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      customerId: customer.id,
      kind: 'ADJUSTMENT',
      points: input.points,
      reason,
      actorId: scope.actorId,
      idempotencyKey: key,
      occurredAt: now,
    },
  });
  return { entry, balanceBefore, balanceAfter: balanceBefore + input.points, replayed: false };
}

/**
 * DEV-764: value of unredeemed points, organization-wide and per branch, at the current
 * redemption value (PKR 1 per point before an owner sets one). Balances are branch-scoped.
 */
export async function readLoyaltyLiability(db: ScopedDb, organizationId: string) {
  const [balances, program] = await Promise.all([
    db.pharmacyLoyaltyPointsEntry.groupBy({
      by: ['branchId', 'customerId'],
      where: { organizationId },
      _sum: { points: true },
    }),
    currentLoyaltyProgram(db, organizationId),
  ]);
  const pointValueMinor = program?.redemptionValueMinor ?? LOYALTY_POINT_VALUE_MINOR;
  // Points already past their expiry date are not owed, even before the sweep closes them.
  const now = new Date();
  const due = await db.pharmacyLoyaltyPointsEntry.findMany({
    where: {
      organizationId,
      kind: { in: ['EARN', 'KHATA_EARN'] },
      expiresAt: { lte: now },
      closedBy: { none: { kind: 'EXPIRY' } },
    },
    distinct: ['branchId', 'customerId'],
    select: { branchId: true, customerId: true },
  });
  const expired = new Map<string, number>();
  for (const row of due)
    expired.set(
      `${row.branchId}:${row.customerId}`,
      await pointsPastExpiry(db, { organizationId, ...row }, now)
    );
  const byBranch = new Map<string, { points: number; customers: number }>();
  for (const row of balances) {
    const points = Math.max(
      0,
      (row._sum.points ?? 0) - (expired.get(`${row.branchId}:${row.customerId}`) ?? 0)
    );
    if (points === 0) continue;
    const branch = byBranch.get(row.branchId) ?? { points: 0, customers: 0 };
    branch.points += points;
    branch.customers += 1;
    byBranch.set(row.branchId, branch);
  }
  const branches = [...byBranch.entries()]
    .map(([branchId, row]) => ({
      branchId,
      points: row.points,
      customers: row.customers,
      liabilityMinor: loyaltyLiabilityMinor(row.points, pointValueMinor),
    }))
    .sort((a, b) => a.branchId.localeCompare(b.branchId));
  const points = branches.reduce((sum, row) => sum + row.points, 0);
  return {
    pointValueMinor,
    points,
    customers: branches.reduce((sum, row) => sum + row.customers, 0),
    liabilityMinor: loyaltyLiabilityMinor(points, pointValueMinor),
    branches,
  };
}

export const LOYALTY_REDEMPTION_PAGE_SIZE = 25;

/**
 * DEV-764: points redemptions at one branch, newest first, with what each was worth and
 * what came back (refund restorations and void releases on the same tender).
 */
export async function listLoyaltyRedemptions(db: ScopedDb, scope: LedgerScope, page = 1) {
  if (!Number.isInteger(page) || page < 1 || page > LOYALTY_HISTORY_MAX_PAGE)
    throw new RangeError('INVALID_HISTORY_PAGE');
  await assertLoyaltyHistoryBranch(db, scope);
  const where = {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    kind: 'REDEEM' as const,
  };
  const total = await db.pharmacyLoyaltyPointsEntry.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / LOYALTY_REDEMPTION_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const rows = await db.pharmacyLoyaltyPointsEntry.findMany({
    where,
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    skip: (currentPage - 1) * LOYALTY_REDEMPTION_PAGE_SIZE,
    take: LOYALTY_REDEMPTION_PAGE_SIZE,
    select: {
      id: true,
      points: true,
      occurredAt: true,
      tenderId: true,
      customer: { select: { id: true, displayName: true } },
      sale: { select: { id: true, receiptNumber: true, status: true } },
      tender: { select: { amountMinor: true } },
    },
  });
  const tenderIds = rows.flatMap((row) => (row.tenderId ? [row.tenderId] : []));
  const returned = tenderIds.length
    ? await db.pharmacyLoyaltyPointsEntry.groupBy({
        by: ['tenderId'],
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          tenderId: { in: tenderIds },
          kind: { in: ['REFUND', 'REDEMPTION_RELEASE'] },
        },
        _sum: { points: true },
      })
    : [];
  const returnedBy = new Map(returned.map((row) => [row.tenderId, row._sum.points ?? 0]));
  return {
    redemptions: rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt,
      customer: row.customer,
      receiptNumber: row.sale?.receiptNumber ?? null,
      saleId: row.sale?.id ?? null,
      saleVoided: row.sale?.status === 'VOID',
      points: -row.points,
      amountMinor: row.tender?.amountMinor ?? 0,
      pointsReturned: (row.tenderId && returnedBy.get(row.tenderId)) || 0,
    })),
    total,
    page: currentPage,
    pageCount,
  };
}
