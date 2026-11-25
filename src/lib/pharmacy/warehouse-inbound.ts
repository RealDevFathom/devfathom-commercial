import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { licensedPremises } from './branch-transfer-policy';
import { parseGs1DataMatrix } from './gs1-datamatrix';
import { PharmacyInventoryError } from './inventory';
import { normalizeMedicineText } from './medicine';
import { assertControlledWarehouseStorage } from './warehouse-controlled-storage';
import {
  expiryInstant,
  normalizeExpiryBoundary,
  SALEABLE_TRANSFER_DESTINATIONS,
  type LedgerScope,
} from './stock-ledger';
import { lockStockBalances, lockStockRowsFrom } from './stock-lock-order';
import { warehouseStockQualityReason } from './warehouse-quality';

/** Serializes opting into warehouse receiving with receipt posting. */
export async function warehouseReceivingSite(db: ScopedDb, scope: LedgerScope, at: Date) {
  const [branch] = await db.$queryRaw<{ warehouseEnabled: boolean }[]>`
    SELECT "warehouseEnabled" FROM pharmacy_branches WHERE id=${scope.branchId}
      AND "organizationId"=${scope.organizationId} FOR SHARE`;
  if (!branch?.warehouseEnabled) return false;
  await db.$queryRaw`SELECT id FROM pharmacy_branch_regulatory_profiles
    WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId}
    ORDER BY id FOR SHARE`;
  const org = await db.organization.findUnique({
    where: { id: scope.organizationId },
    select: { timezone: true },
  });
  await licensedPremises(db, scope.organizationId, scope.branchId, at, org?.timezone ?? null);
  return true;
}

export async function listWarehousePutAwayTasks(db: ScopedDb, scope: LedgerScope) {
  const tasks = await db.pharmacyWarehousePutAway.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      completedAt: null,
      line: {
        goodsReceipt: { status: 'POSTED' },
        inventoryLot: {
          balances: { some: { disposition: 'WAREHOUSE_RECEIVING', onHandUnits: { gt: 0 } } },
        },
      },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      quantityUnits: true,
      line: {
        select: {
          medicineId: true,
          medicine: { select: { productName: true } },
          batchNumber: true,
          goodsReceipt: { select: { reference: true } },
          stockLocation: { select: { code: true } },
        },
      },
    },
  });
  return tasks.map(({ id, quantityUnits, line }) => ({
    id,
    quantityUnits,
    medicineId: line.medicineId,
    medicineName: line.medicine.productName,
    batchNumber: line.batchNumber,
    receiptReference: line.goodsReceipt.reference,
    sourceLocationCode: line.stockLocation.code,
  }));
}

export type WarehousePutAwayInput = {
  taskId: string;
  productScan: string;
  batchScan: string;
  destinationCode: string;
  quantityUnits: number;
};

async function assertProductScan(
  db: ScopedDb,
  organizationId: string,
  line: {
    medicineId: string;
    packLevelId: string;
    batchNumber: string;
    printedExpiry: Date;
    expiryPrecision: 'DAY' | 'MONTH';
    serialNumber: string | null;
    gtin: string | null;
  },
  scan: string,
  at: Date
) {
  if (scan === line.medicineId) return;
  const parsed = parseGs1DataMatrix(scan, at);
  const mismatch = () =>
    new PharmacyInventoryError(
      'LABEL_LOT_MISMATCH',
      'Scan the pack and batch on this receipt line.'
    );
  if (parsed.kind === 'invalid') throw mismatch();
  const fields = parsed.kind === 'parsed' ? parsed.fields : null;
  if (
    fields &&
    ((fields.batch && fields.batch !== line.batchNumber) ||
      (fields.expiryDate &&
        expiryInstant(
          new Date(fields.expiryDate),
          fields.expiry?.endsWith('00') ? 'MONTH' : 'DAY'
        ).getTime() !== expiryInstant(line.printedExpiry, line.expiryPrecision).getTime()) ||
      (line.serialNumber && fields.serial && fields.serial !== line.serialNumber))
  )
    throw mismatch();
  const codes = fields ? [fields.gtin, ...(fields.gtin13 ? [fields.gtin13] : [])] : [scan];
  if (line.gtin && codes.includes(line.gtin)) return;
  const barcode = await db.medicineBarcode.findFirst({
    where: {
      organizationId,
      normalizedCode: { in: codes.map(normalizeMedicineText) },
      presentation: { medicineId: line.medicineId },
      OR: [{ packLevelId: line.packLevelId }, { packLevelId: null }],
    },
    select: { id: true },
  });
  if (!barcode) throw mismatch();
}

/** Called inside one tenant transaction. Each receipt line stays intact, including its pack arrangement. */
export async function completeWarehousePutAway(
  db: ScopedDb,
  scope: LedgerScope,
  input: WarehousePutAwayInput,
  at = new Date()
) {
  const productScan = input.productScan.trim();
  const batchScan = input.batchScan.trim();
  const destinationCode = input.destinationCode.trim();
  if (
    !productScan ||
    !batchScan ||
    !destinationCode ||
    !Number.isSafeInteger(input.quantityUnits) ||
    input.quantityUnits < 1
  ) {
    throw new PharmacyInventoryError(
      'INVALID_QUANTITY',
      'Scan the medicine, batch and destination, and confirm the whole receipt quantity.'
    );
  }
  await db.$queryRaw`SELECT id FROM pharmacy_warehouse_putaways WHERE id=${input.taskId}
    AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`;
  const task = await db.pharmacyWarehousePutAway.findFirst({
    where: { id: input.taskId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: { line: { include: { goodsReceipt: { select: { status: true } } } } },
  });
  if (!task) throw new PharmacyInventoryError('NOT_FOUND');
  if (task.completedAt) {
    if (
      task.productScan !== productScan ||
      task.batchScan !== batchScan ||
      task.quantityUnits !== input.quantityUnits ||
      task.destinationCode !== destinationCode
    ) {
      throw new PharmacyInventoryError('IDEMPOTENCY_CONFLICT');
    }
    return { id: task.id, completedAt: task.completedAt, quantityUnits: task.quantityUnits };
  }
  if (!(await warehouseReceivingSite(db, scope, at))) {
    throw new PharmacyInventoryError(
      'INVALID_STATE',
      'This branch is not enabled for warehouse receiving.'
    );
  }
  const line = task.line;
  if (line.goodsReceipt.status !== 'POSTED' || !line.inventoryLotId)
    throw new PharmacyInventoryError('INVALID_STATE');
  if (input.quantityUnits !== task.quantityUnits)
    throw new PharmacyInventoryError(
      'INVALID_QUANTITY',
      'Confirm all accepted units on this line.'
    );
  if (batchScan !== line.batchNumber) throw new PharmacyInventoryError('LABEL_LOT_MISMATCH');
  await assertProductScan(db, scope.organizationId, line, productScan, at);
  const inventoryLotId = line.inventoryLotId;
  await lockStockRowsFrom(
    db,
    scope.organizationId,
    Prisma.sql`
    SELECT l."manufacturingBatchId" AS "batchId", mb."medicineId", l.id AS "inventoryLotId"
      FROM pharmacy_inventory_lots l JOIN pharmacy_manufacturing_batches mb
        ON mb."organizationId"=l."organizationId" AND mb.id=l."manufacturingBatchId"
      WHERE l."organizationId"=${scope.organizationId} AND l."branchId"=${scope.branchId}
        AND l.id=${inventoryLotId}`,
    { batch: 'share', medicine: 'share', lot: 'share' }
  );
  const lot = await db.pharmacyInventoryLot.findFirst({
    where: { id: inventoryLotId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: { batch: { include: { medicine: { select: { controlled: true, saleable: true } } } } },
  });
  if (
    !lot ||
    lot.batch.medicineId !== line.medicineId ||
    lot.batch.batchNumber !== batchScan ||
    !lot.batch.medicine.saleable ||
    lot.batch.state !== 'ACTIVE' ||
    !lot.receivedAt ||
    lot.receivedAt > at ||
    !lot.batch.expiresAt ||
    normalizeExpiryBoundary(lot.batch.expiresAt) <= at
  ) {
    throw new PharmacyInventoryError(
      'BLOCKED_STOCK',
      'This lot cannot be released. Check the batch, expiry and recall status.'
    );
  }

  await db.$queryRaw`SELECT id FROM pharmacy_stock_locations WHERE "organizationId"=${scope.organizationId}
    AND "branchId"=${scope.branchId} AND (code=${destinationCode} OR id=${line.stockLocationId})
    ORDER BY id FOR SHARE`;
  const destination = await db.pharmacyStockLocation.findFirst({
    where: {
      branchId: scope.branchId,
      organizationId: scope.organizationId,
      code: destinationCode,
      active: true,
      warehouseStaging: false,
    },
    select: { id: true, kind: true },
  });
  if (!destination || !SALEABLE_TRANSFER_DESTINATIONS.has(destination.kind)) {
    throw new PharmacyInventoryError(
      'UNSALEABLE_DESTINATION',
      'Scan an active storage bin at this warehouse.'
    );
  }
  if (lot.batch.medicine.controlled) {
    await assertControlledWarehouseStorage(
      db,
      scope,
      destination.kind,
      'warehouse.controlledPutAway',
      at
    );
  }
  await lockStockBalances(db, scope, [
    { inventoryLotId, stockLocationId: line.stockLocationId, disposition: 'WAREHOUSE_RECEIVING' },
    { inventoryLotId, stockLocationId: destination.id, disposition: 'AVAILABLE' },
  ]);
  const blocked = await warehouseStockQualityReason(
    db,
    scope,
    inventoryLotId,
    [line.stockLocationId, destination.id],
    at
  );
  if (blocked) throw new PharmacyInventoryError('BLOCKED_STOCK', blocked);
  const balance = await db.pharmacyStockBalance.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId,
      stockLocationId: line.stockLocationId,
      disposition: 'WAREHOUSE_RECEIVING',
    },
    select: { onHandUnits: true, sealedPacks: true, looseUnits: true },
  });
  if (!balance || balance.onHandUnits !== task.quantityUnits)
    throw new PharmacyInventoryError('INSUFFICIENT_STOCK');
  const shared = {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    inventoryLotId,
    actorId: scope.actorId,
    occurredAt: at,
    reason: 'Warehouse put-away',
  };
  await db.pharmacyStockMovement.create({
    data: {
      ...shared,
      kind: 'TRANSFER_OUT',
      stockLocationId: line.stockLocationId,
      disposition: 'WAREHOUSE_RECEIVING',
      quantityUnits: -task.quantityUnits,
      sealedPackDelta: -balance.sealedPacks,
      looseUnitDelta: -balance.looseUnits,
      idempotencyKey: `warehouse-putaway:${task.id}:out`,
    },
  });
  await db.pharmacyStockMovement.create({
    data: {
      ...shared,
      kind: 'TRANSFER_IN',
      stockLocationId: destination.id,
      disposition: 'AVAILABLE',
      quantityUnits: task.quantityUnits,
      sealedPackDelta: balance.sealedPacks,
      looseUnitDelta: balance.looseUnits,
      idempotencyKey: `warehouse-putaway:${task.id}:in`,
    },
  });
  await db.pharmacyWarehousePutAway.update({
    where: { id: task.id },
    data: {
      completedAt: at,
      completedById: scope.actorId,
      productScan,
      batchScan,
      destinationCode,
    },
  });
  return { id: task.id, completedAt: at, quantityUnits: task.quantityUnits };
}
