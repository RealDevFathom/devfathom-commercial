import 'server-only';

import { createHash, randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { accrueSalePoints, restoreRefundedLoyaltyPoints } from './customer-loyalty';
import { firstCloseIsFinal } from './migration/first-close';
import { PharmacyReceiptIdentityError, validateReceiptIdentity } from './receipt-identity';
import type { LedgerScope } from './stock-ledger';

export type PharmacyTenderType = 'CASH' | 'CARD' | 'BANK_TRANSFER' | 'WALLET' | 'CREDIT';

export class PharmacySettlementError extends Error {
  constructor(
    readonly reason:
      | 'SALE_NOT_OPEN'
      | 'INVALID_AMOUNT'
      | 'OVER_TENDER'
      | 'DRAWER_NOT_OPEN'
      | 'REFUND_EXCEEDS_TENDER'
      | 'IDEMPOTENCY_CONFLICT'
      | 'UNCERTIFIED_PROVIDER'
      | 'MOCK_PROVIDER_IN_RELEASE'
      | 'OPEN_DRAWER'
      | 'REOPEN_REASON_REQUIRED'
  ) {
    super(reason);
  }
}

export interface PharmacyPaymentAdapter {
  readonly name: string;
  readonly certified: boolean;
  execute(input: {
    capability: 'SALE' | 'REFUND';
    amountMinor: number;
    operationRef: string;
    priorRef?: string;
  }): Promise<{ approved: boolean; providerRef: string }>;
}

export function requireReleaseSafeAdapter(
  adapter: PharmacyPaymentAdapter,
  environment = process.env.NODE_ENV
) {
  if (environment === 'production' && adapter.name.toUpperCase() === 'MOCK')
    throw new PharmacySettlementError('MOCK_PROVIDER_IN_RELEASE');
  if (!adapter.certified) throw new PharmacySettlementError('UNCERTIFIED_PROVIDER');
  return adapter;
}

export function saleTotalMinor(
  lines: readonly { quantity: number; unitPriceMinor: number; discountMinor: number }[]
) {
  return lines.reduce(
    (total, line) => total + line.quantity * line.unitPriceMinor - line.discountMinor,
    0
  );
}

export function assertPositiveMinor(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new PharmacySettlementError('INVALID_AMOUNT');
}

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function bindIdempotency(
  db: ScopedDb,
  organizationId: string,
  deviceId: string,
  key: string,
  commandType: string,
  payloadHash: string
) {
  await db.$executeRaw(Prisma.sql`
    INSERT INTO pharmacy_money_idempotency_keys
      (id, "organizationId", "deviceId", key, "commandType", "payloadHash", "createdAt")
    VALUES (${randomUUID()}, ${organizationId}, ${deviceId}, ${key}, ${commandType}, ${payloadHash}, now())
    ON CONFLICT ("organizationId", "deviceId", key) DO NOTHING`);
  const prior = await db.pharmacyMoneyIdempotencyKey.findUnique({
    where: { organizationId_deviceId_key: { organizationId, deviceId, key } },
  });
  if (!prior || prior.commandType !== commandType || prior.payloadHash !== payloadHash)
    throw new PharmacySettlementError('IDEMPOTENCY_CONFLICT');
  return prior;
}

export async function applyPharmacyTender(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    saleId: string;
    deviceId: string;
    businessDate: Date;
    type: PharmacyTenderType;
    amountMinor: number;
    cashReceivedMinor?: number;
    idempotencyKey: string;
    adapter?: PharmacyPaymentAdapter;
  }
) {
  assertPositiveMinor(input.amountMinor);
  const payloadHash = hash(input);
  const idem = await bindIdempotency(
    db,
    scope.organizationId,
    input.deviceId,
    input.idempotencyKey,
    'tender',
    payloadHash
  );
  if (idem.resultPayload) return { ...(idem.resultPayload as object), replayed: true };

  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_sales WHERE id = ${input.saleId} AND "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId} FOR UPDATE`
  );
  const sale = await db.pharmacySale.findFirst({
    where: { id: input.saleId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: {
      lines: {
        include: {
          medicine: { include: { strengths: { orderBy: { id: 'asc' } } } },
          presentation: true,
          allocations: { orderBy: { id: 'asc' }, include: { lot: { include: { batch: true } } } },
        },
      },
      tenders: true,
    },
  });
  if (!sale || sale.status !== 'OPEN') throw new PharmacySettlementError('SALE_NOT_OPEN');
  const totalMinor = saleTotalMinor(sale.lines);
  const tenderedMinor = sale.tenders.reduce((sum, tender) => sum + tender.amountMinor, 0);
  if (input.amountMinor > totalMinor - tenderedMinor)
    throw new PharmacySettlementError('OVER_TENDER');

  let drawerSessionId: string | undefined;
  let cashReceivedMinor: number | undefined;
  let changeGivenMinor: number | undefined;
  let provider: string | undefined;
  let providerRef: string | undefined;
  if (input.type === 'CASH') {
    cashReceivedMinor = input.cashReceivedMinor ?? input.amountMinor;
    if (!Number.isSafeInteger(cashReceivedMinor) || cashReceivedMinor < input.amountMinor)
      throw new PharmacySettlementError('INVALID_AMOUNT');
    changeGivenMinor = cashReceivedMinor - input.amountMinor;
    const drawer = await db.pharmacyDrawerSession.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        deviceId: input.deviceId,
        status: 'OPEN',
      },
    });
    if (!drawer) throw new PharmacySettlementError('DRAWER_NOT_OPEN');
    drawerSessionId = drawer.id;
  } else if (input.type === 'CARD' || input.type === 'WALLET') {
    if (!input.adapter) throw new PharmacySettlementError('UNCERTIFIED_PROVIDER');
    const adapter = requireReleaseSafeAdapter(input.adapter);
    const result = await adapter.execute({
      capability: 'SALE',
      amountMinor: input.amountMinor,
      operationRef: input.idempotencyKey,
    });
    if (!result.approved) throw new PharmacySettlementError('UNCERTIFIED_PROVIDER');
    provider = adapter.name;
    providerRef = result.providerRef;
  }

  const tender = await db.pharmacyTender.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId: sale.id,
      type: input.type,
      amountMinor: input.amountMinor,
      cashReceivedMinor,
      changeGivenMinor,
      drawerSessionId,
      provider,
      providerRef,
      businessDate: input.businessDate,
      actorId: scope.actorId,
      deviceId: input.deviceId,
    },
  });
  if (drawerSessionId)
    await db.pharmacyDrawerMovement.create({
      data: {
        organizationId: scope.organizationId,
        drawerSessionId,
        kind: 'CASH_SALE',
        amountMinor: input.amountMinor,
        actorId: scope.actorId,
      },
    });

  const settled = tenderedMinor + input.amountMinor === totalMinor;
  let receiptNumber: number | null = null;
  if (settled) {
    const rows = await db.$queryRaw<Array<{ receipt_number: number }>>(Prisma.sql`
      INSERT INTO pharmacy_receipt_number_sequences (id, "organizationId", "branchId", "deviceId", "nextNumber", "updatedAt")
      VALUES (${randomUUID()}, ${scope.organizationId}, ${scope.branchId}, ${input.deviceId}, 2, now())
      ON CONFLICT ("organizationId", "branchId", "deviceId")
      DO UPDATE SET "nextNumber" = pharmacy_receipt_number_sequences."nextNumber" + 1, "updatedAt" = now()
      RETURNING "nextNumber" - 1 AS receipt_number`);
    receiptNumber = rows[0]!.receipt_number;
    const issuedAt = new Date();
    await db.pharmacySale.update({
      where: { organizationId_id: { organizationId: scope.organizationId, id: sale.id } },
      data: {
        status: 'COMPLETED',
        completedAt: issuedAt,
        receiptNumber,
        receiptDeviceId: input.deviceId,
        businessDate: input.businessDate,
      },
    });
    for (const line of sale.lines) {
      if (
        line.organizationId !== scope.organizationId ||
        line.branchId !== scope.branchId ||
        line.medicine.organizationId !== scope.organizationId ||
        line.presentation.organizationId !== scope.organizationId ||
        line.presentation.medicineId !== line.medicineId ||
        line.allocations.some(
          (allocation) =>
            allocation.organizationId !== scope.organizationId ||
            allocation.branchId !== scope.branchId ||
            allocation.lot.organizationId !== scope.organizationId ||
            allocation.lot.branchId !== scope.branchId ||
            allocation.lot.batch.organizationId !== scope.organizationId ||
            allocation.lot.batch.medicineId !== line.medicineId
        )
      )
        throw new PharmacyReceiptIdentityError();
    }
    const snapshot = validateReceiptIdentity(
      {
        receiptIdentitySnapshotVersion: 1,
        saleId: sale.id,
        receiptNumber,
        deviceId: input.deviceId,
        businessDate: input.businessDate.toISOString().slice(0, 10),
        issuedAt: issuedAt.toISOString(),
        lines: sale.lines.map((line) => ({
          saleLineId: line.id,
          medicineId: line.medicineId,
          presentationId: line.presentationId,
          medicineName: line.medicine.productName,
          strength: line.medicine.strengths.length
            ? line.medicine.strengths
                .map((component) => {
                  const raw = String(component.value);
                  const value = raw.includes('.')
                    ? raw.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
                    : raw;
                  return `${value} ${component.unit}`;
                })
                .join(' + ')
            : null,
          presentation: line.presentation.presentation,
          allocations: line.allocations.map((allocation) => ({
            allocationId: allocation.id,
            inventoryLotId: allocation.inventoryLotId,
            batchNumber: allocation.lot.batch.batchNumber,
            expiresAt: allocation.lot.batch.expiresAt.toISOString(),
            canonicalUnits: allocation.canonicalUnits,
          })),
        })),
      },
      {
        ...sale,
        receiptNumber,
        receiptDeviceId: input.deviceId,
        businessDate: input.businessDate,
        completedAt: issuedAt,
      }
    );
    await db.pharmacySaleEvent.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        saleId: sale.id,
        kind: 'COMPLETED',
        actorId: scope.actorId,
        occurredAt: issuedAt,
        payload: snapshot,
      },
    });
    if (sale.customerId) await accrueSalePoints(db, scope, sale.id);
  }
  const result = {
    tenderId: tender.id,
    settled,
    receiptNumber,
    remainingMinor: totalMinor - tenderedMinor - input.amountMinor,
  };
  await db.pharmacyMoneyIdempotencyKey.update({
    where: { id: idem.id },
    data: { resultPayload: result },
  });
  return { ...result, replayed: false };
}

export function assertRefundWithinTender(
  tenderedMinor: number,
  refundedMinor: number,
  requestedMinor: number
) {
  assertPositiveMinor(requestedMinor);
  if (refundedMinor + requestedMinor > tenderedMinor)
    throw new PharmacySettlementError('REFUND_EXCEEDS_TENDER');
}

export async function refundPharmacyTender(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    originalTenderId: string;
    deviceId: string;
    businessDate: Date;
    amountMinor: number;
    reason: string;
    idempotencyKey: string;
    adapter?: PharmacyPaymentAdapter;
  }
) {
  if (!input.reason.trim()) throw new PharmacySettlementError('INVALID_AMOUNT');
  const payloadHash = hash(input);
  const idem = await bindIdempotency(
    db,
    scope.organizationId,
    input.deviceId,
    input.idempotencyKey,
    'refund',
    payloadHash
  );
  if (idem.resultPayload) return { ...(idem.resultPayload as object), replayed: true };
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_tenders WHERE id=${input.originalTenderId} AND "organizationId"=${scope.organizationId} FOR UPDATE`
  );
  const tender = await db.pharmacyTender.findFirst({
    where: {
      id: input.originalTenderId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
    include: { refunds: true, sale: { select: { customerId: true } } },
  });
  if (!tender) throw new PharmacySettlementError('REFUND_EXCEEDS_TENDER');
  assertRefundWithinTender(
    tender.amountMinor,
    tender.refunds.reduce((sum, row) => sum + row.amountMinor, 0),
    input.amountMinor
  );
  let providerRef: string | undefined;
  let drawerSessionId: string | undefined;
  if (tender.type === 'CARD' || tender.type === 'WALLET') {
    if (!input.adapter || !tender.providerRef)
      throw new PharmacySettlementError('UNCERTIFIED_PROVIDER');
    const adapter = requireReleaseSafeAdapter(input.adapter);
    const result = await adapter.execute({
      capability: 'REFUND',
      amountMinor: input.amountMinor,
      operationRef: input.idempotencyKey,
      priorRef: tender.providerRef,
    });
    if (!result.approved) throw new PharmacySettlementError('UNCERTIFIED_PROVIDER');
    providerRef = result.providerRef;
  } else if (tender.type === 'CASH') {
    const drawer = await db.pharmacyDrawerSession.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        deviceId: input.deviceId,
        status: 'OPEN',
      },
    });
    if (!drawer) throw new PharmacySettlementError('DRAWER_NOT_OPEN');
    drawerSessionId = drawer.id;
  }
  const refund = await db.pharmacyRefund.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId: tender.saleId,
      originalTenderId: tender.id,
      amountMinor: input.amountMinor,
      providerRef,
      drawerSessionId,
      businessDate: input.businessDate,
      reason: input.reason.trim(),
      actorId: scope.actorId,
    },
  });
  if (tender.type === 'LOYALTY' && tender.sale.customerId) {
    await restoreRefundedLoyaltyPoints(db, scope, {
      refundId: refund.id,
      tenderId: tender.id,
      saleId: tender.saleId,
      customerId: tender.sale.customerId,
    });
  }
  if (drawerSessionId)
    await db.pharmacyDrawerMovement.create({
      data: {
        organizationId: scope.organizationId,
        drawerSessionId,
        kind: 'CASH_REFUND',
        amountMinor: input.amountMinor,
        reason: input.reason.trim(),
        actorId: scope.actorId,
      },
    });
  const result = {
    refundId: refund.id,
    originalTenderId: tender.id,
    amountMinor: refund.amountMinor,
  };
  await db.pharmacyMoneyIdempotencyKey.update({
    where: { id: idem.id },
    data: { resultPayload: result },
  });
  return { ...result, replayed: false };
}

export type CloseSource = {
  sales: readonly { id: string; totalMinor: number }[];
  refunds: readonly { id: string; amountMinor: number }[];
  drawers: readonly { id: string; expectedMinor: number; countedMinor: number }[];
};

export function computePharmacyClose(source: CloseSource) {
  const ordered = {
    sales: [...source.sales].sort((a, b) => a.id.localeCompare(b.id)),
    refunds: [...source.refunds].sort((a, b) => a.id.localeCompare(b.id)),
    drawers: [...source.drawers].sort((a, b) => a.id.localeCompare(b.id)),
  };
  const grossSalesMinor = ordered.sales.reduce((sum, row) => sum + row.totalMinor, 0);
  const refundTotalMinor = ordered.refunds.reduce((sum, row) => sum + row.amountMinor, 0);
  const cashExpectedMinor = ordered.drawers.reduce((sum, row) => sum + row.expectedMinor, 0);
  const cashCountedMinor = ordered.drawers.reduce((sum, row) => sum + row.countedMinor, 0);
  return {
    grossSalesMinor,
    refundTotalMinor,
    netSalesMinor: grossSalesMinor - refundTotalMinor,
    cashExpectedMinor,
    cashCountedMinor,
    cashVarianceMinor: cashCountedMinor - cashExpectedMinor,
    sourceHash: hash(ordered),
  };
}

export type DrawerMovement = {
  kind: 'OPENING_FLOAT' | 'CASH_SALE' | 'CASH_REFUND' | 'PAID_IN' | 'PAID_OUT';
  amountMinor: number;
};

export function foldExpectedCash(movements: readonly DrawerMovement[]) {
  return movements.reduce((total, movement) => {
    assertPositiveMinor(movement.amountMinor);
    return movement.kind === 'CASH_REFUND' || movement.kind === 'PAID_OUT'
      ? total - movement.amountMinor
      : total + movement.amountMinor;
  }, 0);
}

export async function openPharmacyDrawer(
  db: ScopedDb,
  scope: LedgerScope,
  input: { deviceId: string; businessDate: Date; openingFloatMinor: number }
) {
  if (!Number.isSafeInteger(input.openingFloatMinor) || input.openingFloatMinor < 0)
    throw new PharmacySettlementError('INVALID_AMOUNT');
  const drawer = await db.pharmacyDrawerSession.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      deviceId: input.deviceId,
      businessDate: input.businessDate,
      openingFloatMinor: input.openingFloatMinor,
      openedByActorId: scope.actorId,
    },
  });
  if (input.openingFloatMinor > 0)
    await db.pharmacyDrawerMovement.create({
      data: {
        organizationId: scope.organizationId,
        drawerSessionId: drawer.id,
        kind: 'OPENING_FLOAT',
        amountMinor: input.openingFloatMinor,
        actorId: scope.actorId,
      },
    });
  return drawer;
}

export async function recordPharmacyCashMovement(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    drawerSessionId: string;
    kind: 'PAID_IN' | 'PAID_OUT';
    amountMinor: number;
    reason: string;
  }
) {
  assertPositiveMinor(input.amountMinor);
  if (!input.reason.trim()) throw new PharmacySettlementError('INVALID_AMOUNT');
  const drawer = await db.pharmacyDrawerSession.findFirst({
    where: {
      id: input.drawerSessionId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'OPEN',
    },
  });
  if (!drawer) throw new PharmacySettlementError('DRAWER_NOT_OPEN');
  return db.pharmacyDrawerMovement.create({
    data: {
      organizationId: scope.organizationId,
      drawerSessionId: drawer.id,
      kind: input.kind,
      amountMinor: input.amountMinor,
      reason: input.reason.trim(),
      actorId: scope.actorId,
    },
  });
}

export async function closePharmacyDrawer(
  db: ScopedDb,
  scope: LedgerScope,
  input: { drawerSessionId: string; countedCashMinor: number; controlledCountHook?: unknown }
) {
  if (!Number.isSafeInteger(input.countedCashMinor) || input.countedCashMinor < 0)
    throw new PharmacySettlementError('INVALID_AMOUNT');
  const drawer = await db.pharmacyDrawerSession.findFirst({
    where: {
      id: input.drawerSessionId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'OPEN',
    },
    include: { movements: true },
  });
  if (!drawer) throw new PharmacySettlementError('DRAWER_NOT_OPEN');
  const expectedCashMinor = foldExpectedCash(drawer.movements as DrawerMovement[]);
  await db.pharmacyDrawerMovement.create({
    data: {
      organizationId: scope.organizationId,
      drawerSessionId: drawer.id,
      kind: 'CLOSING_COUNT',
      amountMinor: input.countedCashMinor,
      actorId: scope.actorId,
    },
  });
  const closed = await db.pharmacyDrawerSession.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: drawer.id } },
    data: {
      status: 'CLOSED',
      countedCashMinor: input.countedCashMinor,
      controlledCountHook: input.controlledCountHook as Prisma.InputJsonValue | undefined,
      closedByActorId: scope.actorId,
      closedAt: new Date(),
    },
  });
  return {
    drawer: closed,
    expectedCashMinor,
    varianceMinor: input.countedCashMinor - expectedCashMinor,
  };
}

export async function cutPharmacyDailyClose(
  db: ScopedDb,
  scope: LedgerScope,
  input: { businessDate: Date; reopenReason?: string; controlledCountHook?: unknown }
) {
  await db.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`${scope.organizationId}:${scope.branchId}:${input.businessDate.toISOString().slice(0, 10)}`}))`
  );
  const openDrawers = await db.pharmacyDrawerSession.count({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      businessDate: input.businessDate,
      status: 'OPEN',
    },
  });
  if (openDrawers > 0) throw new PharmacySettlementError('OPEN_DRAWER');
  const prior = await db.pharmacyDailyClose.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      businessDate: input.businessDate,
    },
    orderBy: { sequence: 'desc' },
  });
  if (prior && !input.reopenReason?.trim())
    throw new PharmacySettlementError('REOPEN_REASON_REQUIRED');
  const [sales, refunds, drawers] = await Promise.all([
    db.pharmacySale.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        businessDate: input.businessDate,
        status: 'COMPLETED',
      },
      include: { lines: true },
    }),
    db.pharmacyRefund.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        businessDate: input.businessDate,
      },
    }),
    db.pharmacyDrawerSession.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        businessDate: input.businessDate,
      },
      include: { movements: true },
    }),
  ]);
  const aggregate = computePharmacyClose({
    sales: sales.map((sale) => ({ id: sale.id, totalMinor: saleTotalMinor(sale.lines) })),
    refunds: refunds.map((refund) => ({ id: refund.id, amountMinor: refund.amountMinor })),
    drawers: drawers.map((drawer) => ({
      id: drawer.id,
      expectedMinor: foldExpectedCash(
        drawer.movements.filter((row) => row.kind !== 'CLOSING_COUNT') as DrawerMovement[]
      ),
      countedMinor: drawer.countedCashMinor ?? 0,
    })),
  });
  // MIG-05: a switching branch's first close is not final until the parallel run
  // reconciles. One helper, consulted here and nowhere else in the close.
  const isFinal = await firstCloseIsFinal(db, scope.organizationId, scope.branchId);

  return db.pharmacyDailyClose.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      businessDate: input.businessDate,
      sequence: (prior?.sequence ?? 0) + 1,
      supersedesCloseId: prior?.id,
      reason: input.reopenReason?.trim(),
      ...aggregate,
      isFinal,
      controlledCountHook: input.controlledCountHook as Prisma.InputJsonValue | undefined,
      actorId: scope.actorId,
    },
  });
}
