/** PH-INV INV-06/07/08(manual)/09 workflows layered on the append-only ledger. */
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { arrangementFor, PharmacyInventoryError } from './inventory';
import type { LedgerScope } from './stock-ledger';

function assertPositive(units: number) {
  if (!Number.isSafeInteger(units) || units <= 0) throw new PharmacyInventoryError('INVALID_UNITS');
}

async function removalArrangement(
  db: ScopedDb,
  scope: LedgerScope,
  inventoryLotId: string,
  stockLocationId: string,
  units: number,
  unitsPerPack: number
) {
  const balance = await db.pharmacyStockBalance.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId,
      stockLocationId,
      disposition: 'AVAILABLE',
    },
  });
  if (!balance || balance.onHandUnits < units)
    throw new PharmacyInventoryError('INSUFFICIENT_STOCK');
  const looseUnits = Math.min(balance.looseUnits, units);
  const sealedUnits = units - looseUnits;
  if (sealedUnits % unitsPerPack !== 0) throw new PharmacyInventoryError('INVALID_ARRANGEMENT');
  return { sealedPacks: sealedUnits / unitsPerPack, looseUnits };
}

export async function createCount(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    varianceThreshold: number;
    readings: ReadonlyArray<{
      inventoryLotId: string;
      stockLocationId: string;
      countedSealedPacks: number;
      countedLooseUnits: number;
    }>;
  }
) {
  if (!Number.isSafeInteger(input.varianceThreshold) || input.varianceThreshold < 0)
    throw new PharmacyInventoryError('INVALID_UNITS');
  const count = await db.pharmacyInventoryCount.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      varianceThreshold: input.varianceThreshold,
      createdById: scope.actorId,
    },
  });
  for (const reading of input.readings) {
    const [lot, balance] = await Promise.all([
      db.pharmacyInventoryLot.findFirst({
        where: {
          id: reading.inventoryLotId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
        },
      }),
      db.pharmacyStockBalance.findFirst({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          inventoryLotId: reading.inventoryLotId,
          stockLocationId: reading.stockLocationId,
          disposition: 'AVAILABLE',
        },
      }),
    ]);
    if (!lot || !balance) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
    if (
      ![reading.countedSealedPacks, reading.countedLooseUnits].every(
        (n) => Number.isSafeInteger(n) && n >= 0
      )
    )
      throw new PharmacyInventoryError('INVALID_UNITS');
    const countedUnits = reading.countedSealedPacks * lot.unitsPerPack + reading.countedLooseUnits;
    await db.pharmacyInventoryCountLine.create({
      data: {
        organizationId: scope.organizationId,
        countId: count.id,
        branchId: scope.branchId,
        inventoryLotId: reading.inventoryLotId,
        stockLocationId: reading.stockLocationId,
        expectedUnits: balance.onHandUnits,
        expectedSealedPacks: balance.sealedPacks,
        expectedLooseUnits: balance.looseUnits,
        countedSealedPacks: reading.countedSealedPacks,
        countedLooseUnits: reading.countedLooseUnits,
        countedUnits,
        varianceUnits: countedUnits - balance.onHandUnits,
      },
    });
  }
  const lines = await db.pharmacyInventoryCountLine.findMany({ where: { countId: count.id } });
  const coauth = lines.some((line) => Math.abs(line.varianceUnits ?? 0) > input.varianceThreshold);
  return db.pharmacyInventoryCount.update({
    where: { id: count.id },
    data: { status: coauth ? 'AWAITING_COAUTH' : 'OPEN' },
    include: { lines: true },
  });
}

export async function approveCount(
  db: ScopedDb,
  scope: LedgerScope,
  countId: string,
  idempotencyKeyPrefix: string
) {
  const count = await db.pharmacyInventoryCount.findFirst({
    where: { id: countId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: { lines: true },
  });
  if (!count) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  if (count.status === 'APPROVED') throw new PharmacyInventoryError('INVALID_STATE');
  if (count.status === 'AWAITING_COAUTH' && count.createdById === scope.actorId)
    throw new PharmacyInventoryError('COAUTH_REQUIRED');
  for (const [index, line] of count.lines.entries()) {
    const variance = line.varianceUnits ?? 0;
    if (!variance) continue;
    await db.pharmacyStockMovement.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        inventoryLotId: line.inventoryLotId,
        stockLocationId: line.stockLocationId,
        kind: 'ADJUSTMENT',
        disposition: 'AVAILABLE',
        quantityUnits: variance,
        sealedPackDelta: (line.countedSealedPacks ?? 0) - line.expectedSealedPacks,
        looseUnitDelta: (line.countedLooseUnits ?? 0) - line.expectedLooseUnits,
        actorId: scope.actorId,
        reason: `Inventory count ${count.id}`,
        idempotencyKey: `${idempotencyKeyPrefix}:${index}`,
      },
    });
  }
  return db.pharmacyInventoryCount.update({
    where: { id: count.id },
    data: { status: 'APPROVED', approvedById: scope.actorId, approvedAt: new Date() },
  });
}

export async function writeOff(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    inventoryLotId: string;
    stockLocationId: string;
    units: number;
    witnessId: string;
    reason: string;
    evidenceRef: string;
    idempotencyKey: string;
  }
) {
  assertPositive(input.units);
  if (input.witnessId === scope.actorId) throw new PharmacyInventoryError('COAUTH_REQUIRED');
  const lot = await db.pharmacyInventoryLot.findFirst({
    where: {
      id: input.inventoryLotId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
  });
  if (!lot) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  const a = await removalArrangement(
    db,
    scope,
    input.inventoryLotId,
    input.stockLocationId,
    input.units,
    lot.unitsPerPack
  );
  const movement = await db.pharmacyStockMovement.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: input.inventoryLotId,
      stockLocationId: input.stockLocationId,
      kind: 'WRITE_OFF',
      disposition: 'AVAILABLE',
      quantityUnits: -input.units,
      sealedPackDelta: -a.sealedPacks,
      looseUnitDelta: -a.looseUnits,
      actorId: scope.actorId,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    },
  });
  const custody = await db.pharmacyCustodyRecord.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      movementId: movement.id,
      actorId: scope.actorId,
      witnessId: input.witnessId,
      reason: input.reason,
      evidenceRef: input.evidenceRef,
    },
  });
  return { movement, custody };
}

export async function quarantinePart(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    inventoryLotId: string;
    stockLocationId: string;
    units: number;
    damaged?: boolean;
    reason: string;
    idempotencyKeyPrefix: string;
  }
) {
  assertPositive(input.units);
  const lot = await db.pharmacyInventoryLot.findFirst({
    where: {
      id: input.inventoryLotId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
  });
  if (!lot) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  const a = await removalArrangement(
    db,
    scope,
    input.inventoryLotId,
    input.stockLocationId,
    input.units,
    lot.unitsPerPack
  );
  const common = {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    inventoryLotId: input.inventoryLotId,
    stockLocationId: input.stockLocationId,
    kind: 'ADJUSTMENT' as const,
    actorId: scope.actorId,
    reason: input.reason,
  };
  const removed = await db.pharmacyStockMovement.create({
    data: {
      ...common,
      disposition: 'AVAILABLE',
      quantityUnits: -input.units,
      sealedPackDelta: -a.sealedPacks,
      looseUnitDelta: -a.looseUnits,
      idempotencyKey: `${input.idempotencyKeyPrefix}:out`,
    },
  });
  const held = await db.pharmacyStockMovement.create({
    data: {
      ...common,
      disposition: input.damaged ? 'DAMAGED' : 'QUARANTINE',
      quantityUnits: input.units,
      sealedPackDelta: a.sealedPacks,
      looseUnitDelta: a.looseUnits,
      idempotencyKey: `${input.idempotencyKeyPrefix}:in`,
    },
  });
  return { removed, held };
}

export async function allocateTransfer(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    toBranchId: string;
    lines: ReadonlyArray<{
      sourceLotId: string;
      sourceStockLocationId: string;
      destinationStockLocationId: string;
      quantityUnits: number;
    }>;
  }
) {
  if (input.toBranchId === scope.branchId)
    throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  for (const line of input.lines) {
    assertPositive(line.quantityUnits);
    const [lot, destination] = await Promise.all([
      db.pharmacyInventoryLot.findFirst({
        where: {
          id: line.sourceLotId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
        },
      }),
      db.pharmacyStockLocation.findFirst({
        where: {
          id: line.destinationStockLocationId,
          organizationId: scope.organizationId,
          branchId: input.toBranchId,
        },
      }),
    ]);
    if (!lot || !destination) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  }
  const transfer = await db.pharmacyInterbranchTransfer.create({
    data: {
      organizationId: scope.organizationId,
      fromBranchId: scope.branchId,
      toBranchId: input.toBranchId,
      allocatedById: scope.actorId,
    },
  });
  await db.pharmacyInterbranchTransferLine.createMany({
    data: input.lines.map((line) => ({
      organizationId: scope.organizationId,
      transferId: transfer.id,
      sourceBranchId: scope.branchId,
      ...line,
    })),
  });
  return db.pharmacyInterbranchTransfer.findFirstOrThrow({
    where: { id: transfer.id },
    include: { lines: true },
  });
}

export async function approveTransfer(db: ScopedDb, scope: LedgerScope, transferId: string) {
  const transfer = await db.pharmacyInterbranchTransfer.findFirst({
    where: { id: transferId, organizationId: scope.organizationId, fromBranchId: scope.branchId },
  });
  if (!transfer) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  if (transfer.status !== 'ALLOCATED' || transfer.allocatedById === scope.actorId)
    throw new PharmacyInventoryError('COAUTH_REQUIRED');
  return db.pharmacyInterbranchTransfer.update({
    where: { id: transfer.id },
    data: { status: 'APPROVED', approvedById: scope.actorId },
  });
}

export async function dispatchTransfer(
  db: ScopedDb,
  scope: LedgerScope,
  transferId: string,
  key: string
) {
  const transfer = await db.pharmacyInterbranchTransfer.findFirst({
    where: { id: transferId, organizationId: scope.organizationId, fromBranchId: scope.branchId },
    include: { lines: true },
  });
  if (!transfer || transfer.status !== 'APPROVED')
    throw new PharmacyInventoryError('INVALID_STATE');
  for (const [i, line] of transfer.lines.entries()) {
    const balances = await db.$queryRaw<
      Array<{ onHandUnits: number; unitsPerPack: number; state: string; expiresAt: Date }>
    >(
      Prisma.sql`SELECT (b."onHandUnits"-COALESCE((SELECT SUM(c."reservedUnits") FROM "pharmacy_supplier_claims" c WHERE c."organizationId"=b."organizationId" AND c."inventoryLotId"=b."inventoryLotId" AND c.status='RESERVED'),0))::int AS "onHandUnits",l."unitsPerPack",mb.state::text,mb."expiresAt" FROM "pharmacy_stock_balances" b JOIN "pharmacy_inventory_lots" l ON l.id=b."inventoryLotId" JOIN "pharmacy_manufacturing_batches" mb ON mb.id=l."manufacturingBatchId" WHERE b."organizationId"=${scope.organizationId} AND b."branchId"=${scope.branchId} AND b."inventoryLotId"=${line.sourceLotId} AND b."stockLocationId"=${line.sourceStockLocationId} AND b."disposition"='AVAILABLE' FOR UPDATE OF b`
    );
    const balance = balances[0];
    if (!balance || Number(balance.onHandUnits) < line.quantityUnits)
      throw new PharmacyInventoryError('INSUFFICIENT_STOCK');
    if (balance.state !== 'ACTIVE' || balance.expiresAt <= new Date())
      throw new PharmacyInventoryError('BLOCKED_STOCK');
    const a = arrangementFor(line.quantityUnits, balance.unitsPerPack);
    const common = {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: line.sourceLotId,
      stockLocationId: line.sourceStockLocationId,
      actorId: scope.actorId,
    };
    await db.pharmacyStockMovement.create({
      data: {
        ...common,
        kind: 'TRANSFER_OUT',
        disposition: 'AVAILABLE',
        quantityUnits: -line.quantityUnits,
        sealedPackDelta: -a.sealedPacks,
        looseUnitDelta: -a.looseUnits,
        idempotencyKey: `${key}:${i}:out`,
      },
    });
    await db.pharmacyStockMovement.create({
      data: {
        ...common,
        kind: 'TRANSFER_IN',
        disposition: 'IN_TRANSIT',
        quantityUnits: line.quantityUnits,
        sealedPackDelta: a.sealedPacks,
        looseUnitDelta: a.looseUnits,
        idempotencyKey: `${key}:${i}:transit`,
      },
    });
  }
  return db.pharmacyInterbranchTransfer.update({
    where: { id: transfer.id },
    data: { status: 'DISPATCHED', dispatchedById: scope.actorId, dispatchedAt: new Date() },
  });
}

export async function receiveTransferLine(
  db: ScopedDb,
  scope: LedgerScope,
  input: { transferId: string; lineId: string; receivedUnits: number; idempotencyKeyPrefix: string }
) {
  assertPositive(input.receivedUnits);
  const transfer = await db.pharmacyInterbranchTransfer.findFirst({
    where: {
      id: input.transferId,
      organizationId: scope.organizationId,
      toBranchId: scope.branchId,
    },
    include: { lines: true },
  });
  const line = transfer?.lines.find((one) => one.id === input.lineId);
  if (
    !transfer ||
    !line ||
    !['DISPATCHED', 'PARTIALLY_RECEIVED', 'EXCEPTION'].includes(transfer.status)
  )
    throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  if (line.receivedUnits + input.receivedUnits > line.quantityUnits)
    throw new PharmacyInventoryError('INVALID_UNITS');
  const source = await db.pharmacyInventoryLot.findFirstOrThrow({
    where: { id: line.sourceLotId },
    include: { batch: true },
  });
  const a = arrangementFor(input.receivedUnits, source.unitsPerPack);
  await db.pharmacyStockMovement.create({
    data: {
      organizationId: scope.organizationId,
      branchId: transfer.fromBranchId,
      inventoryLotId: source.id,
      stockLocationId: line.sourceStockLocationId,
      kind: 'TRANSFER_OUT',
      disposition: 'IN_TRANSIT',
      quantityUnits: -input.receivedUnits,
      sealedPackDelta: -a.sealedPacks,
      looseUnitDelta: -a.looseUnits,
      actorId: scope.actorId,
      idempotencyKey: `${input.idempotencyKeyPrefix}:transit-out`,
    },
  });
  const destinationLot = await db.pharmacyInventoryLot.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      manufacturingBatchId: source.manufacturingBatchId,
      packLevelId: source.packLevelId,
      unitsPerPack: source.unitsPerPack,
      supplierName: source.supplierName,
      supplierInvoiceRef: `${source.supplierInvoiceRef}:transfer:${line.id}:${line.receivedUnits}`,
      unitCostMinor: source.unitCostMinor,
      printedMrpMinor: source.printedMrpMinor,
      receivedExpiresAt: source.receivedExpiresAt,
      receivedExpiryPrecision: source.receivedExpiryPrecision,
      receivedAt: new Date(),
    },
  });
  await db.pharmacyStockMovement.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: destinationLot.id,
      stockLocationId: line.destinationStockLocationId,
      kind: 'TRANSFER_IN',
      disposition: 'AVAILABLE',
      quantityUnits: input.receivedUnits,
      sealedPackDelta: a.sealedPacks,
      looseUnitDelta: a.looseUnits,
      actorId: scope.actorId,
      idempotencyKey: `${input.idempotencyKeyPrefix}:received`,
    },
  });
  await db.pharmacyInterbranchTransferLine.update({
    where: { id: line.id },
    data: { receivedUnits: { increment: input.receivedUnits } },
  });
  const totalReceived =
    transfer.lines.reduce((n, one) => n + one.receivedUnits, 0) + input.receivedUnits;
  const totalExpected = transfer.lines.reduce((n, one) => n + one.quantityUnits, 0);
  return db.pharmacyInterbranchTransfer.update({
    where: { id: transfer.id },
    data: {
      status:
        totalReceived === totalExpected
          ? 'RECEIVED'
          : input.receivedUnits + line.receivedUnits === line.quantityUnits
            ? 'PARTIALLY_RECEIVED'
            : 'EXCEPTION',
      receivedAt: totalReceived === totalExpected ? new Date() : null,
    },
  });
}

export async function createRecall(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'actorId'>,
  input: { batchId?: string; medicineId?: string; reference: string; reason: string }
) {
  if ((input.batchId ? 1 : 0) + (input.medicineId ? 1 : 0) !== 1)
    throw new PharmacyInventoryError('INVALID_STATE');
  const where = input.batchId ? { id: input.batchId } : { medicineId: input.medicineId! };
  const result = await db.pharmacyManufacturingBatch.updateMany({
    where: { organizationId: scope.organizationId, ...where },
    data: { state: 'RECALLED', stateReason: input.reason, stateChangedAt: new Date() },
  });
  if (!result.count) throw new PharmacyInventoryError('NOT_FOUND');
  return db.pharmacyRecallNotice.create({
    data: {
      organizationId: scope.organizationId,
      batchId: input.batchId,
      medicineId: input.medicineId,
      reference: input.reference,
      reason: input.reason,
      createdById: scope.actorId,
    },
  });
}

export async function recallTrace(db: ScopedDb, organizationId: string, recallNoticeId: string) {
  const notice = await db.pharmacyRecallNotice.findFirst({
    where: { id: recallNoticeId, organizationId },
  });
  if (!notice) throw new PharmacyInventoryError('NOT_FOUND');
  return db.$queryRaw<
    Array<{
      branchId: string;
      inventoryLotId: string;
      disposition: string;
      units: number;
      soldUnits: number;
    }>
  >(
    Prisma.sql`SELECT l."branchId",l.id AS "inventoryLotId",b.disposition::text,SUM(b."onHandUnits")::int AS units,COALESCE((SELECT -SUM(m."quantityUnits") FROM "pharmacy_stock_movements" m WHERE m."organizationId"=l."organizationId" AND m."inventoryLotId"=l.id AND m.kind='SALE'),0)::int AS "soldUnits" FROM "pharmacy_inventory_lots" l JOIN "pharmacy_manufacturing_batches" mb ON mb.id=l."manufacturingBatchId" JOIN "pharmacy_stock_balances" b ON b."inventoryLotId"=l.id AND b."organizationId"=l."organizationId" WHERE l."organizationId"=${organizationId} AND (${notice.batchId}::text IS NULL OR mb.id=${notice.batchId}) AND (${notice.medicineId}::text IS NULL OR mb."medicineId"=${notice.medicineId}) GROUP BY l."organizationId",l."branchId",l.id,b.disposition`
  );
}

export async function acknowledgeRecall(db: ScopedDb, scope: LedgerScope, noticeId: string) {
  const notice = await db.pharmacyRecallNotice.findFirst({
    where: { id: noticeId, organizationId: scope.organizationId, status: 'OPEN' },
  });
  if (!notice) throw new PharmacyInventoryError('INVALID_STATE');
  const affectedLot = await db.pharmacyInventoryLot.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      ...(notice.batchId
        ? { manufacturingBatchId: notice.batchId }
        : { batch: { medicineId: notice.medicineId! } }),
      balances: { some: { onHandUnits: { gt: 0 } } },
    },
    select: { id: true },
  });
  if (!affectedLot) throw new PharmacyInventoryError('INVALID_STATE');
  return db.pharmacyRecallAcknowledgement.create({
    data: {
      organizationId: scope.organizationId,
      recallNoticeId: noticeId,
      branchId: scope.branchId,
      actorId: scope.actorId,
    },
  });
}

export async function closeRecall(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'actorId'>,
  noticeId: string
) {
  const notice = await db.pharmacyRecallNotice.findFirst({
    where: { id: noticeId, organizationId: scope.organizationId, status: 'OPEN' },
    include: { acknowledgements: true },
  });
  if (!notice) throw new PharmacyInventoryError('INVALID_STATE');
  const affectedBranches = await db.pharmacyInventoryLot.findMany({
    where: {
      organizationId: scope.organizationId,
      ...(notice.batchId
        ? { manufacturingBatchId: notice.batchId }
        : { batch: { medicineId: notice.medicineId! } }),
      balances: { some: { onHandUnits: { gt: 0 } } },
    },
    distinct: ['branchId'],
    select: { branchId: true },
  });
  const acknowledgedBranches = new Set(notice.acknowledgements.map(({ branchId }) => branchId));
  if (
    !affectedBranches.length ||
    affectedBranches.some(({ branchId }) => !acknowledgedBranches.has(branchId))
  )
    throw new PharmacyInventoryError('INVALID_STATE');
  const where = notice.batchId ? { id: notice.batchId } : { medicineId: notice.medicineId! };
  const remaining = await db.pharmacyRecallNotice.count({
    where: {
      organizationId: scope.organizationId,
      status: 'OPEN',
      id: { not: notice.id },
      OR: [
        { batchId: notice.batchId ?? undefined },
        { medicineId: notice.medicineId ?? undefined },
      ],
    },
  });
  if (!remaining)
    await db.pharmacyManufacturingBatch.updateMany({
      where: { organizationId: scope.organizationId, ...where },
      data: { state: 'ACTIVE', stateReason: null, stateChangedAt: null },
    });
  return db.pharmacyRecallNotice.update({
    where: { id: notice.id },
    data: { status: 'CLOSED', closedById: scope.actorId, closedAt: new Date() },
  });
}

export async function reserveSupplierClaim(
  db: ScopedDb,
  scope: LedgerScope,
  input: { inventoryLotId: string; reservedUnits: number; returnBy: Date }
) {
  assertPositive(input.reservedUnits);
  // Serialize against sales, transfers and purchase returns: lock EVERY AVAILABLE
  // balance row of the lot (the same rows sale allocation and purchase returns
  // lock) FOR UPDATE in key (stockLocationId) order, exactly like purchase returns, then measure availability from the locked rows.
  // The caller must keep this lock and the check/create below in one transaction.
  const locked = await db.$queryRaw<Array<{ onHandUnits: number; state: string }>>(Prisma.sql`
    SELECT b."onHandUnits", mb.state::text
    FROM "pharmacy_stock_balances" b
    JOIN "pharmacy_inventory_lots" l
      ON l.id = b."inventoryLotId" AND l."organizationId" = b."organizationId"
    JOIN "pharmacy_manufacturing_batches" mb
      ON mb.id = l."manufacturingBatchId" AND mb."organizationId" = l."organizationId"
    WHERE b."organizationId" = ${scope.organizationId}
      AND b."branchId" = ${scope.branchId}
      AND l."branchId" = ${scope.branchId}
      AND b."inventoryLotId" = ${input.inventoryLotId}
      AND b."disposition" = 'AVAILABLE'
    ORDER BY mb.id, b."stockLocationId" ASC
    FOR UPDATE OF mb, b
  `);
  if (locked.some((row) => row.state !== 'ACTIVE'))
    throw new PharmacyInventoryError('BLOCKED_STOCK');
  const onHand = locked.reduce((total, row) => total + Number(row.onHandUnits), 0);
  const already = await db.pharmacySupplierClaim.aggregate({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: input.inventoryLotId,
      status: 'RESERVED',
    },
    _sum: { reservedUnits: true },
  });
  if (onHand - (already._sum.reservedUnits ?? 0) < input.reservedUnits)
    throw new PharmacyInventoryError('INSUFFICIENT_STOCK');
  return db.pharmacySupplierClaim.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: input.inventoryLotId,
      reservedUnits: input.reservedUnits,
      returnBy: input.returnBy,
      createdById: scope.actorId,
    },
  });
}

export async function nearExpiryBoard(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  at: Date
) {
  return db.$queryRaw<
    Array<{
      bucketDays: number;
      units: number;
      valueAtRiskMinor: number;
      withinSupplierReturnWindow: boolean;
    }>
  >(
    Prisma.sql`WITH windows(days) AS (VALUES (30),(60),(90),(180)) SELECT w.days AS "bucketDays",COALESCE(SUM(b."onHandUnits"),0)::int units,COALESCE(SUM(b."onHandUnits"*l."unitCostMinor"),0)::int AS "valueAtRiskMinor",COALESCE(bool_or(EXISTS(SELECT 1 FROM "pharmacy_supplier_claims" c WHERE c."organizationId"=l."organizationId" AND c."inventoryLotId"=l.id AND c.status='RESERVED' AND c."returnBy">=${at}::timestamp)),false) AS "withinSupplierReturnWindow" FROM windows w LEFT JOIN "pharmacy_manufacturing_batches" mb ON mb."organizationId"=${scope.organizationId} AND mb."expiresAt">${at}::timestamp AND mb."expiresAt"<=(${at}::timestamp+make_interval(days=>w.days)) LEFT JOIN "pharmacy_inventory_lots" l ON l."manufacturingBatchId"=mb.id AND l."branchId"=${scope.branchId} LEFT JOIN "pharmacy_stock_balances" b ON b."inventoryLotId"=l.id AND b.disposition='AVAILABLE' GROUP BY w.days ORDER BY w.days`
  );
}
