import { readKhataBalance } from './family-khata';
import 'server-only';

import { completePaidPharmacySale, completionSaleInclude } from './sale-completion';
import { postTenderEntry } from './finance-postings';
import { requestCounterEvidence } from './counter-evidence';
import { lockCustomerConsent } from './consent-writer';

import { Prisma } from '@/generated/prisma/client';
import { pointsForNetPaid, redemptionFor } from '@/lib/commerce/loyalty-arithmetic';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import type { LedgerScope } from './stock-ledger';

export class PharmacyLoyaltyError extends Error {
  constructor(
    readonly reason:
      | 'CONSENT_REQUIRED'
      | 'CUSTOMER_NOT_FOUND'
      | 'SALE_NOT_OPEN'
      | 'SALE_NOT_LINKED'
      | 'INSUFFICIENT_POINTS'
      | 'INVALID_REDEMPTION'
      | 'IDEMPOTENCY_CONFLICT'
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
  if (!consent?.granted || consent.revokedAt) throw new PharmacyLoyaltyError('CONSENT_REQUIRED');
  const sale = await db.pharmacySale.findFirst({
    where: {
      id: input.saleId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'OPEN',
    },
  });
  if (!sale) throw new PharmacyLoyaltyError('SALE_NOT_OPEN');
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
  const netPaidMinor = sale.tenders
    .filter((tender) => tender.type !== 'LOYALTY')
    .reduce((sum, tender) => sum + tender.amountMinor, 0);
  const points = pointsForNetPaid(netPaidMinor);
  if (points === 0) return null;
  const entry = await db.pharmacyLoyaltyPointsEntry.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      customerId: sale.customerId,
      saleId: sale.id,
      kind: 'EARN',
      points,
      netPaidMinor,
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
  if (!consent?.granted || consent.revokedAt) throw new PharmacyLoyaltyError('CONSENT_REQUIRED');
  const balance = await db.pharmacyLoyaltyPointsEntry.aggregate({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      customerId: sale.customerId,
    },
    _sum: { points: true },
  });
  const totalMinor = sale.lines.reduce(
    (sum, line) => sum + line.quantity * line.unitPriceMinor - line.discountMinor,
    0
  );
  const outstandingMinor =
    totalMinor - sale.tenders.reduce((sum, tender) => sum + tender.amountMinor, 0);
  let redemption: { points: number; amountMinor: number };
  try {
    redemption = redemptionFor({
      requestedPoints: input.points,
      availablePoints: balance._sum.points ?? 0,
      outstandingMinor,
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
    select: { points: true },
  });
  if (!redemption) return null;
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
        kind: 'REFUND',
      },
      _sum: { points: true },
    }),
  ]);
  const redeemedPoints = -redemption.points;
  const target = Math.min(redeemedPoints, pointsForNetPaid(refunds._sum.amountMinor ?? 0));
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
  const [points, sales, pointsHistory, pointsCount] = await Promise.all([
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
        lines: { select: { quantity: true, unitPriceMinor: true, discountMinor: true } },
        tenders: {
          select: { type: true, amountMinor: true, refunds: { select: { amountMinor: true } } },
        },
      },
      orderBy: { completedAt: 'desc' },
      take: 10,
    }),
    db.pharmacyLoyaltyPointsEntry.findMany({
      where: { organizationId: scope.organizationId, branchId: scope.branchId, customerId },
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
      where: { organizationId: scope.organizationId, branchId: scope.branchId, customerId },
    }),
  ]);
  const accounts = await db.pharmacyFamilyAccount.findMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId,
      active: true, members: { some: { customerId } } },
    select: { id: true, displayName: true, creditLimitMinor: true },
    orderBy: { id: 'asc' },
  });
  const khataAccounts = await Promise.all(accounts.map(async (account) => ({
    ...account, balanceMinor: await readKhataBalance(db, scope, account.id),
  })));
  const creditBalanceMinor = khataAccounts.reduce((sum, a) => sum + a.balanceMinor, 0);
  const creditLimitMinor = khataAccounts.reduce((sum, a) => sum + a.creditLimitMinor, 0);
  return {
    customer: { ...customer, creditLimitMinor },
    khataAccounts,
    pointsBalance: points._sum.points ?? 0,
    pointsHistory,
    pointsCount,
    pointsPage: page,
    creditBalanceMinor,
    availableCreditMinor: Math.max(0, creditLimitMinor - creditBalanceMinor),
    history: sales.map((sale) => ({
      saleId: sale.id,
      receiptNumber: sale.receiptNumber,
      completedAt: sale.completedAt,
      totalMinor: sale.lines.reduce(
        (sum, line) => sum + line.quantity * line.unitPriceMinor - line.discountMinor,
        0
      ),
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

export async function listLoyaltyCustomers(db: ScopedDb, scope: LedgerScope, query = '') {
  if (query.trim().length > 100) throw new RangeError('INVALID_CUSTOMER_QUERY');
  await assertLoyaltyHistoryBranch(db, scope);
  // Retail identities are tenant-wide; balances and entries below are branch-specific.
  const customers = await db.pharmacyCustomer.findMany({
    where: {
      organizationId: scope.organizationId,
      active: true,
      displayName: { contains: query.trim(), mode: 'insensitive' },
    },
    select: { id: true, displayName: true, phoneLast4: true },
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    take: 51,
  });
  return { customers: customers.slice(0, 50), hasMore: customers.length > 50 };
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
    select: { id: true, displayName: true, phoneLast4: true },
  });
  if (!customer) throw new PharmacyLoyaltyError('CUSTOMER_NOT_FOUND');
  const where = { organizationId: scope.organizationId, branchId: scope.branchId, customerId };
  const [balance, total] = await Promise.all([
    db.pharmacyLoyaltyPointsEntry.aggregate({ where, _sum: { points: true } }),
    db.pharmacyLoyaltyPointsEntry.count({ where }),
  ]);
  const pageCount = Math.max(1, Math.ceil(total / LOYALTY_HISTORY_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const entries = await db.pharmacyLoyaltyPointsEntry.findMany({
    where,
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
