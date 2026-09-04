import 'server-only';

import { randomUUID } from 'node:crypto';

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
  const prior = await db.pharmacyLoyaltyPointsEntry.findUnique({
    where: {
      organizationId_idempotencyKey: { organizationId: scope.organizationId, idempotencyKey: key },
    },
    include: { tender: true },
  });
  if (prior) {
    if (prior.saleId !== input.saleId || prior.requestedPoints !== input.points)
      throw new PharmacyLoyaltyError('IDEMPOTENCY_CONFLICT');
    return { points: -prior.points, amountMinor: prior.tender!.amountMinor, replayed: true };
  }
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
    include: { lines: true, tenders: true },
  });
  if (!sale) throw new PharmacyLoyaltyError('SALE_NOT_OPEN');
  if (!sale.customerId) throw new PharmacyLoyaltyError('SALE_NOT_LINKED');
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_customers WHERE id=${sale.customerId} AND "organizationId"=${scope.organizationId} FOR UPDATE`
  );
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
  const settled = redemption.amountMinor === outstandingMinor;
  let receiptNumber: number | null = null;
  if (settled) {
    const rows = await db.$queryRaw<Array<{ receipt_number: number }>>(Prisma.sql`
      INSERT INTO pharmacy_receipt_number_sequences (id, "organizationId", "branchId", "deviceId", "nextNumber", "updatedAt")
      VALUES (${randomUUID()}, ${scope.organizationId}, ${scope.branchId}, ${input.deviceId}, 2, now())
      ON CONFLICT ("organizationId", "branchId", "deviceId")
      DO UPDATE SET "nextNumber" = pharmacy_receipt_number_sequences."nextNumber" + 1, "updatedAt" = now()
      RETURNING "nextNumber" - 1 AS receipt_number`);
    receiptNumber = rows[0]!.receipt_number;
    await db.pharmacySale.update({
      where: { organizationId_id: { organizationId: scope.organizationId, id: sale.id } },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        receiptNumber,
        receiptDeviceId: input.deviceId,
        businessDate: input.businessDate,
      },
    });
    await accrueSalePoints(db, scope, sale.id);
  }
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

export async function readCustomerSnapshot(db: ScopedDb, scope: LedgerScope, customerId: string) {
  const customer = await db.pharmacyCustomer.findFirst({
    where: { id: customerId, organizationId: scope.organizationId, active: true },
    select: { id: true, displayName: true, phoneLast4: true, creditLimitMinor: true },
  });
  if (!customer) throw new PharmacyLoyaltyError('CUSTOMER_NOT_FOUND');
  const [points, sales] = await Promise.all([
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
    creditBalanceMinor,
    availableCreditMinor: Math.max(0, customer.creditLimitMinor - creditBalanceMinor),
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
