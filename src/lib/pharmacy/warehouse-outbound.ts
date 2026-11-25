import { Prisma } from '@/generated/prisma/client';
import type { PharmacyStockDisposition } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { assertBranchTransferAllowed, BranchTransferPolicyError } from './branch-transfer-policy';
import { postInterbranchTransferEntry } from './finance-postings';
import { parseGs1DataMatrix } from './gs1-datamatrix';
import { PharmacyInventoryError } from './inventory';
import { normalizeMedicineText } from './medicine';
import { parseShelfLabelCode, shelfLabelCode } from './shelf-label-code';
import {
  breakPack,
  expiryInstant,
  loadStockCandidatesForRead,
  normalizeExpiryBoundary,
  type LedgerScope,
} from './stock-ledger';
import { lockStockBalances, lockStockRowsFrom } from './stock-lock-order';
import {
  noteMissingWarehouseDispatchEvidence,
  openWarehouseIncident,
  registerWarehouseCancellationHold,
  warehouseDispatchQualityReason,
  warehouseStockQualityReason,
} from './warehouse-quality';

type DemandInput = {
  medicineId: string;
  destinationStockLocationId: string;
  requestedUnits: number;
};
type CreateInput = { toBranchId: string; lines: readonly DemandInput[]; idempotencyKey: string };
type OrderInput = { orderId: string; idempotencyKey: string };
type ScanInput = {
  reservationId: string;
  productScan: string;
  lotScan: string;
  stagingBinScan: string;
  quantityUnits: number;
  idempotencyKey: string;
};
type Bin = {
  id: string;
  code: string;
  active: boolean;
  coldChain: boolean;
  warehouseStaging: boolean;
  kind: string;
};
const lotInclude = {
  batch: { include: { medicine: true } },
  packLevel: { select: { presentationId: true } },
} as const;
type Lot = Prisma.PharmacyInventoryLotGetPayload<{ include: typeof lotInclude }>;
const allLines = {
  demands: { orderBy: { id: 'asc' } },
  reservations: { orderBy: { id: 'asc' } },
} as const;

function invalid(reason: string): never {
  throw new PharmacyInventoryError('INVALID_STATE', reason);
}

const stockBins = new Set(['STORE', 'RACK_BIN', 'FRIDGE', 'SAFE']);

export function warehouseLotEligible(
  lot: Pick<Lot, 'receivedAt'> & {
    batch: Pick<Lot['batch'], 'state' | 'batchNumber' | 'expiresAt'> & {
      medicine: Pick<Lot['batch']['medicine'], 'productFamily' | 'controlled'>;
    };
  },
  shelfLifeDays: number,
  now: Date
) {
  const batch = lot.batch;
  if (
    batch.state !== 'ACTIVE' ||
    !lot.receivedAt ||
    lot.receivedAt > now ||
    batch.medicine.controlled
  )
    return false;
  // All pharmacy products except front-shop retail require a recorded batch and expiry.
  if (
    batch.medicine.productFamily !== 'FRONT_SHOP' &&
    (!batch.batchNumber?.trim() || !batch.expiresAt)
  )
    return false;
  return (
    !batch.expiresAt ||
    normalizeExpiryBoundary(batch.expiresAt).getTime() > now.getTime() + shelfLifeDays * 86_400_000
  );
}

function compatible(bin: Bin | null, cold: boolean, staging: boolean) {
  return (
    !!bin &&
    bin.active &&
    bin.warehouseStaging === staging &&
    stockBins.has(bin.kind) &&
    (!cold || bin.coldChain)
  );
}

function branchScope(scope: LedgerScope) {
  return { organizationId: scope.organizationId, branchId: scope.branchId };
}

/** Ordinary work proceeds concurrently; a recorded quality hold waits for it and excludes new allocations. */
export async function lockWarehouseQuality(
  db: ScopedDb,
  organizationId: string,
  exclusive: boolean
) {
  const key = 'pharmacy-recall-authority:' + organizationId;
  if (exclusive) await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`;
  else await db.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key},0))`;
}

async function configuration(db: ScopedDb, scope: LedgerScope) {
  const [branch] = await db.$queryRaw<
    { warehouseEnabled: boolean; warehouseMinimumShelfLifeDays: number }[]
  >`SELECT "warehouseEnabled","warehouseMinimumShelfLifeDays" FROM pharmacy_branches WHERE id=${scope.branchId} AND "organizationId"=${scope.organizationId} AND active FOR SHARE`;
  if (!branch?.warehouseEnabled) invalid('This pharmacy branch is not enabled as a warehouse.');
  return branch;
}

async function minimumShelfLife(
  db: ScopedDb,
  scope: LedgerScope,
  toBranchId: string,
  sourceDays: number
) {
  const destination = await db.pharmacyBranch.findFirstOrThrow({
    where: { organizationId: scope.organizationId, id: toBranchId, active: true },
    select: { warehouseMinimumShelfLifeDays: true },
  });
  return Math.max(sourceDays, destination.warehouseMinimumShelfLifeDays);
}

export async function warehouseDispatchSource(
  db: ScopedDb,
  scope: LedgerScope,
  transferId: string
) {
  const [branch] = await db.$queryRaw<
    { managed: boolean }[]
  >`SELECT (branch."warehouseEnabled" OR EXISTS (
    SELECT 1 FROM pharmacy_warehouse_reservations r WHERE r."organizationId"=branch."organizationId"
      AND r."branchId"=branch.id AND r."transferId"=${transferId}
    )) AS managed FROM pharmacy_branches branch WHERE branch.id=${scope.branchId} AND branch."organizationId"=${scope.organizationId} FOR SHARE OF branch`;
  return branch?.managed === true;
}

type OrderWithLines = Prisma.PharmacyWarehouseOrderGetPayload<{ include: typeof allLines }>;

async function presentOrders(db: ScopedDb, scope: LedgerScope, orders: OrderWithLines[]) {
  if (!orders.length) return [];
  const reservations = orders.flatMap((order) => order.reservations);
  const lots = await db.pharmacyInventoryLot.findMany({
    where: { ...branchScope(scope), id: { in: reservations.map((r) => r.inventoryLotId) } },
    include: lotInclude,
  });
  const bins = await db.pharmacyStockLocation.findMany({
    where: {
      ...branchScope(scope),
      id: {
        in: reservations.flatMap((r) => [
          r.sourceStockLocationId,
          ...(r.stagingStockLocationId ? [r.stagingStockLocationId] : []),
        ]),
      },
    },
    select: { id: true, code: true },
  });
  const branches = await db.pharmacyBranch.findMany({
    where: { organizationId: scope.organizationId, id: { in: orders.map((o) => o.toBranchId) } },
    select: { id: true, name: true },
  });
  const transfers = await db.pharmacyInterbranchTransfer.findMany({
    where: {
      organizationId: scope.organizationId,
      fromBranchId: scope.branchId,
      id: { in: orders.flatMap((o) => (o.transferId ? [o.transferId] : [])) },
    },
    select: { id: true, status: true },
  });
  const lotMap = new Map(lots.map((l) => [l.id, l]));
  const binMap = new Map(bins.map((b) => [b.id, b.code]));
  const branchMap = new Map(branches.map((b) => [b.id, b.name]));
  const transferMap = new Map(transfers.map((t) => [t.id, t.status]));
  return orders.map((order) => ({
    ...order,
    transferStatus: order.transferId ? (transferMap.get(order.transferId) ?? null) : null,
    toBranchName: branchMap.get(order.toBranchId) ?? order.toBranchId,
    demands: order.demands.map((d) => ({
      ...d,
      shortfallUnits:
        d.requestedUnits -
        order.reservations
          .filter((r) => r.demandId === d.id && r.state !== 'CANCELLED')
          .reduce((n, r) => n + r.quantityUnits, 0),
    })),
    reservations: order.reservations.map((r) => {
      const lot = lotMap.get(r.inventoryLotId);
      return {
        ...r,
        productName: lot?.batch.medicine.productName ?? '',
        coldChain: lot?.batch.medicine.coldChain ?? false,
        medicineId: lot?.batch.medicineId ?? '',
        batchNumber: lot?.batch.batchNumber ?? null,
        expiresAt: lot?.batch.expiresAt ?? null,
        lotCode: lot ? shelfLabelCode(lot.shelfLabelNumber) : null,
        sourceBinCode: binMap.get(r.sourceStockLocationId) ?? null,
        stagingBinCode: r.stagingStockLocationId
          ? (binMap.get(r.stagingStockLocationId) ?? null)
          : null,
      };
    }),
  }));
}

async function readOrder(db: ScopedDb, scope: LedgerScope, id: string) {
  const order = await db.pharmacyWarehouseOrder.findFirst({
    where: { ...branchScope(scope), id },
    include: allLines,
  });
  if (!order) throw new PharmacyInventoryError('NOT_FOUND');
  const [result] = await presentOrders(db, scope, [order]);
  return result!;
}

export async function listWarehouseOutbound(db: ScopedDb, scope: LedgerScope) {
  await configuration(db, scope);
  const open = await db.pharmacyWarehouseOrder.findMany({
    where: { ...branchScope(scope), status: 'OPEN' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: allLines,
  });
  const history = await db.pharmacyWarehouseOrder.findMany({
    where: { ...branchScope(scope), status: { not: 'OPEN' } },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: 100,
    include: allLines,
  });
  return presentOrders(db, scope, [...open, ...history]);
}

async function lockOrder(db: ScopedDb, scope: LedgerScope, id: string) {
  const found = await db.$queryRaw<
    { id: string }[]
  >`SELECT id FROM pharmacy_warehouse_orders WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} AND id=${id} FOR UPDATE`;
  if (!found.length) throw new PharmacyInventoryError('NOT_FOUND');
}

async function command(
  db: ScopedDb,
  scope: LedgerScope,
  kind: string,
  input: object & { idempotencyKey: string },
  run: () => Promise<string>
) {
  await lockWarehouseQuality(db, scope.organizationId, false);
  const key = input.idempotencyKey.trim();
  if (!key || key.length > 160 || key.startsWith('wh-system:'))
    invalid('Provide a warehouse command key.');
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['warehouse', scope.organizationId, scope.branchId, key])},0))`;
  const payload = JSON.parse(JSON.stringify(input)) as Prisma.InputJsonObject;
  const previous = await db.pharmacyWarehouseCommand.findUnique({
    where: { organizationId_branchId_key: { ...branchScope(scope), key } },
  });
  if (previous) {
    const matches = await db.$queryRaw<
      { matches: boolean }[]
    >`SELECT payload = ${JSON.stringify(payload)}::jsonb AS matches FROM pharmacy_warehouse_commands WHERE id=${previous.id}`;
    if (previous.kind !== kind || !matches[0]?.matches)
      throw new PharmacyInventoryError('IDEMPOTENCY_CONFLICT');
    return readOrder(db, scope, previous.orderId);
  }
  const id = await run();
  await db.pharmacyWarehouseCommand.create({
    data: { ...branchScope(scope), orderId: id, actorId: scope.actorId, kind, key, payload },
  });
  return readOrder(db, scope, id);
}

async function bin(
  db: ScopedDb,
  scope: LedgerScope,
  branchId: string,
  match: { id: string } | { code: string }
) {
  return db.pharmacyStockLocation.findFirst({
    where: { organizationId: scope.organizationId, branchId, ...match },
  });
}

async function lockMedicineStock(db: ScopedDb, scope: LedgerScope, medicineIds: readonly string[]) {
  if (!medicineIds.length) return;
  const source = Prisma.sql`SELECT mb.id AS "batchId", b."branchId", b."inventoryLotId", b."stockLocationId", b.disposition::text AS disposition
    FROM pharmacy_stock_balances b JOIN pharmacy_inventory_lots l ON l.id=b."inventoryLotId"
    JOIN pharmacy_manufacturing_batches mb ON mb.id=l."manufacturingBatchId"
    WHERE b."organizationId"=${scope.organizationId} AND b."branchId"=${scope.branchId} AND mb."medicineId" IN (${Prisma.join([...medicineIds])})`;
  await lockStockRowsFrom(db, scope.organizationId, source, { batch: 'share', balance: true });
}

type Bucket = { id: string; disposition: PharmacyStockDisposition };

async function reservedArrangement(db: ScopedDb, scope: LedgerScope, reservationId: string) {
  const posted = await db.pharmacyStockMovement.aggregate({
    where: {
      ...branchScope(scope),
      kind: 'TRANSFER_IN',
      disposition: 'WAREHOUSE_RESERVED',
      idempotencyKey: { startsWith: 'wh:reserve:' + reservationId + ':' },
    },
    _sum: { sealedPackDelta: true, looseUnitDelta: true },
  });
  return {
    sealedPacks: posted._sum.sealedPackDelta ?? 0,
    looseUnits: posted._sum.looseUnitDelta ?? 0,
  };
}

async function move(
  db: ScopedDb,
  scope: LedgerScope,
  lot: Pick<Lot, 'id' | 'unitsPerPack'>,
  units: number,
  from: Bucket,
  to: Bucket,
  key: string,
  arrangement: { sealedPacks: number; looseUnits: number }
) {
  if (arrangement.sealedPacks * lot.unitsPerPack + arrangement.looseUnits !== units)
    invalid('Reserved units do not reconcile to their recorded pack arrangement.');
  for (const [leg, sign, kind] of [
    [from, -1, 'TRANSFER_OUT'],
    [to, 1, 'TRANSFER_IN'],
  ] as const) {
    await db.pharmacyStockMovement.create({
      data: {
        ...branchScope(scope),
        actorId: scope.actorId,
        inventoryLotId: lot.id,
        stockLocationId: leg.id,
        disposition: leg.disposition,
        kind,
        quantityUnits: units * sign,
        sealedPackDelta: arrangement.sealedPacks * sign,
        looseUnitDelta: arrangement.looseUnits * sign,
        idempotencyKey: key + ':' + kind,
      },
    });
  }
}

async function eligible(
  db: ScopedDb,
  scope: LedgerScope,
  lot: Lot,
  days: number,
  binIds: string[],
  transferId?: string
) {
  return (
    warehouseLotEligible(lot, days, new Date()) &&
    !(await warehouseStockQualityReason(db, scope, lot.id, binIds, new Date(), transferId))
  );
}

/** Take complete packs while available and retain every remaining unit as loose. */
export function reservationArrangement(
  quantityUnits: number,
  unitsPerPack: number,
  sealedAvailable: number
) {
  const sealedPacks = Math.min(Math.floor(quantityUnits / unitsPerPack), sealedAvailable);
  return { sealedPacks, looseUnits: quantityUnits - sealedPacks * unitsPerPack };
}

async function warehouseCandidates(
  db: ScopedDb,
  scope: LedgerScope,
  medicineId: string,
  destinationBranchId: string,
  destinationStockLocationId: string,
  shelfLifeDays: number
) {
  const medicine = await db.medicine.findFirst({
    where: { id: medicineId, organizationId: scope.organizationId },
  });
  if (!medicine) throw new PharmacyInventoryError('NOT_FOUND');
  if (medicine.controlled) throw new BranchTransferPolicyError('CONTROLLED_DRUG_TRANSFER');
  const destination = await bin(db, scope, destinationBranchId, { id: destinationStockLocationId });
  if (!compatible(destination, medicine.coldChain, false))
    invalid('Select an active compatible receiving bin at the destination.');
  const days = await minimumShelfLife(db, scope, destinationBranchId, shelfLifeDays);
  const result = [];
  for (const c of await loadStockCandidatesForRead(db, scope, medicineId)) {
    if (c.disposition !== 'AVAILABLE' || c.batchState !== 'ACTIVE' || c.availableUnits <= 0)
      continue;
    if (
      !compatible(
        await bin(db, scope, scope.branchId, { id: c.stockLocationId }),
        medicine.coldChain,
        false
      )
    )
      continue;
    const lot = await db.pharmacyInventoryLot.findFirstOrThrow({
      where: { ...branchScope(scope), id: c.inventoryLotId },
      include: lotInclude,
    });
    if (await eligible(db, scope, lot, days, [c.stockLocationId]))
      result.push({ lot, stockLocationId: c.stockLocationId, availableUnits: c.availableUnits });
  }
  return result;
}

export async function warehouseAvailableUnits(
  db: ScopedDb,
  scope: LedgerScope,
  medicineId: string,
  destinationBranchId: string,
  destinationStockLocationId: string
) {
  try {
    const config = await configuration(db, scope);
    await assertBranchTransferAllowed(db, {
      organizationId: scope.organizationId,
      fromBranchId: scope.branchId,
      toBranchId: destinationBranchId,
      sourceLotIds: [],
      requireSwitch: true,
    });
    const stock = await warehouseCandidates(
      db,
      scope,
      medicineId,
      destinationBranchId,
      destinationStockLocationId,
      config.warehouseMinimumShelfLifeDays
    );
    return stock.reduce((units, lot) => units + lot.availableUnits, 0);
  } catch (error) {
    if (error instanceof BranchTransferPolicyError || error instanceof PharmacyInventoryError)
      return 0;
    throw error;
  }
}

async function holdUnits(
  db: ScopedDb,
  scope: LedgerScope,
  lot: Lot,
  binId: string,
  reservationId: string,
  units: number,
  key: string
) {
  const balance = await db.pharmacyStockBalance.findFirstOrThrow({
    where: {
      ...branchScope(scope),
      inventoryLotId: lot.id,
      stockLocationId: binId,
      disposition: 'AVAILABLE',
    },
  });
  const arrangement = reservationArrangement(units, lot.unitsPerPack, balance.sealedPacks);
  const movementKey = 'wh:reserve:' + reservationId + ':' + key;
  if (arrangement.looseUnits > balance.looseUnits) {
    await breakPack(db, scope, {
      inventoryLotId: lot.id,
      stockLocationId: binId,
      requiredLooseUnits: arrangement.looseUnits,
      idempotencyKey: movementKey + ':break',
      at: new Date(),
    });
  }
  await move(
    db,
    scope,
    lot,
    units,
    { id: binId, disposition: 'AVAILABLE' },
    { id: binId, disposition: 'WAREHOUSE_RESERVED' },
    movementKey,
    arrangement
  );
}

async function fillDemand(db: ScopedDb, scope: LedgerScope, orderId: string, key: string) {
  const config = await configuration(db, scope);
  const order = await db.pharmacyWarehouseOrder.findFirstOrThrow({
    where: { ...branchScope(scope), id: orderId },
    include: allLines,
  });
  if (order.status !== 'OPEN') invalid('This replenishment order is closed.');
  await assertBranchTransferAllowed(db, {
    organizationId: scope.organizationId,
    fromBranchId: scope.branchId,
    toBranchId: order.toBranchId,
    sourceLotIds: [],
    requireSwitch: true,
  });
  let transferId = order.transferId;
  if (transferId) {
    await db.$queryRaw`SELECT id FROM pharmacy_interbranch_transfers WHERE id=${transferId} FOR UPDATE`;
    const transfer = await db.pharmacyInterbranchTransfer.findFirstOrThrow({
      where: { id: transferId, organizationId: scope.organizationId },
    });
    if (transfer.dispatchedAt) transferId = null;
    else if (transfer.status !== 'ALLOCATED')
      invalid('Dispatch the approved shipment before allocating more stock.');
  }
  await lockMedicineStock(
    db,
    scope,
    order.demands.map((d) => d.medicineId)
  );
  for (const d of order.demands) {
    const reserved = order.reservations.filter(
      (r) => r.demandId === d.id && r.state !== 'CANCELLED'
    );
    let needed = d.requestedUnits - reserved.reduce((n, r) => n + r.quantityUnits, 0);
    if (!needed) continue;
    const candidates = await warehouseCandidates(
      db,
      scope,
      d.medicineId,
      order.toBranchId,
      d.destinationStockLocationId,
      config.warehouseMinimumShelfLifeDays
    );
    for (const c of candidates) {
      if (!needed) break;
      const { lot } = c;
      const existing = order.reservations.find(
        (r) =>
          r.transferId === transferId &&
          r.inventoryLotId === lot.id &&
          r.sourceStockLocationId === c.stockLocationId
      );
      if (existing && existing.state !== 'RESERVED') continue;
      const quantityUnits = Math.min(needed, c.availableUnits);
      if (!transferId) {
        const transfer = await db.pharmacyInterbranchTransfer.create({
          data: {
            organizationId: scope.organizationId,
            fromBranchId: scope.branchId,
            toBranchId: order.toBranchId,
            allocatedById: scope.actorId,
          },
        });
        transferId = transfer.id;
        await db.pharmacyWarehouseOrder.update({ where: { id: order.id }, data: { transferId } });
      }
      let reservation;
      if (existing) {
        await db.pharmacyInterbranchTransferLine.update({
          where: { id: existing.transferLineId },
          data: { quantityUnits: { increment: quantityUnits } },
        });
        reservation = await db.pharmacyWarehouseReservation.update({
          where: { id: existing.id },
          data: { quantityUnits: { increment: quantityUnits } },
        });
      } else {
        const line = await db.pharmacyInterbranchTransferLine.create({
          data: {
            organizationId: scope.organizationId,
            transferId,
            sourceBranchId: scope.branchId,
            sourceStockLocationId: c.stockLocationId,
            destinationStockLocationId: d.destinationStockLocationId,
            sourceLotId: lot.id,
            quantityUnits,
          },
        });
        reservation = await db.pharmacyWarehouseReservation.create({
          data: {
            ...branchScope(scope),
            orderId: order.id,
            demandId: d.id,
            transferId,
            transferLineId: line.id,
            inventoryLotId: lot.id,
            sourceStockLocationId: c.stockLocationId,
            quantityUnits,
          },
        });
      }
      await holdUnits(db, scope, lot, c.stockLocationId, reservation.id, quantityUnits, key);
      needed -= quantityUnits;
    }
  }
  return order.id;
}

async function newOrder(
  db: ScopedDb,
  scope: LedgerScope,
  toBranchId: string,
  lines: readonly DemandInput[],
  transferId: string | null
) {
  if (
    !lines.length ||
    new Set(lines.map((d) => d.medicineId)).size !== lines.length ||
    lines.some((d) => !Number.isSafeInteger(d.requestedUnits) || d.requestedUnits <= 0)
  )
    invalid('Request each product once, with a positive whole quantity.');
  return db.pharmacyWarehouseOrder.create({
    data: {
      ...branchScope(scope),
      toBranchId,
      transferId,
      createdById: scope.actorId,
      demands: { create: lines.map((d) => ({ ...d })) },
    },
  });
}

export async function createWarehouseOutbound(
  db: ScopedDb,
  scope: LedgerScope,
  input: CreateInput
) {
  return command(db, scope, 'CREATE', input, async () => {
    const order = await newOrder(db, scope, input.toBranchId, input.lines, null);
    return fillDemand(db, scope, order.id, input.idempotencyKey);
  });
}

export async function replenishWarehouseOutbound(
  db: ScopedDb,
  scope: LedgerScope,
  input: OrderInput
) {
  return command(db, scope, 'REPLENISH', input, async () => {
    await lockOrder(db, scope, input.orderId);
    return fillDemand(db, scope, input.orderId, input.idempotencyKey);
  });
}

export async function adoptWarehouseTransfer(
  db: ScopedDb,
  scope: LedgerScope,
  input: { transferId: string; idempotencyKey: string }
) {
  return command(db, scope, 'ADOPT', input, async () => {
    await configuration(db, scope);
    await db.$queryRaw`SELECT id FROM pharmacy_interbranch_transfers WHERE "organizationId"=${scope.organizationId} AND "fromBranchId"=${scope.branchId} AND id=${input.transferId} FOR UPDATE`;
    const transfer = await db.pharmacyInterbranchTransfer.findFirst({
      where: {
        organizationId: scope.organizationId,
        fromBranchId: scope.branchId,
        id: input.transferId,
      },
      include: { lines: { include: { sourceLot: { include: { batch: true } } } } },
    });
    if (!transfer || !['DRAFT', 'ALLOCATED', 'APPROVED'].includes(transfer.status))
      invalid('Only a transfer awaiting dispatch can be adopted.');
    if (
      (await db.pharmacyWarehouseOrder.findFirst({
        where: { ...branchScope(scope), transferId: transfer.id },
      })) ||
      (await db.pharmacyWarehouseReservation.count({
        where: { ...branchScope(scope), transferId: transfer.id },
      }))
    )
      invalid('This transfer is already managed by the warehouse.');
    const demands = new Map<string, DemandInput>();
    for (const l of transfer.lines) {
      const medicineId = l.sourceLot.batch.medicineId;
      const d = demands.get(medicineId);
      if (d && d.destinationStockLocationId !== l.destinationStockLocationId)
        invalid('A replenishment request must use one receiving bin per product.');
      demands.set(medicineId, {
        medicineId,
        destinationStockLocationId: l.destinationStockLocationId,
        requestedUnits: (d?.requestedUnits ?? 0) + l.quantityUnits,
      });
    }
    const order = await newOrder(
      db,
      scope,
      transfer.toBranchId,
      [...demands.values()],
      transfer.id
    );
    // Existing transfer lines may be referenced by permanent central receipt allocations.
    // Adopt those exact lots, locations and quantities, preserving every line identifier.
    const { warehouseMinimumShelfLifeDays } = await configuration(db, scope);
    await assertBranchTransferAllowed(db, {
      organizationId: scope.organizationId,
      fromBranchId: scope.branchId,
      toBranchId: transfer.toBranchId,
      sourceLotIds: transfer.lines.map((l) => l.sourceLotId),
      requireSwitch: true,
    });
    await lockMedicineStock(db, scope, [...demands.keys()]);
    const demandRows = await db.pharmacyWarehouseDemand.findMany({
      where: { ...branchScope(scope), orderId: order.id },
    });
    for (const line of transfer.lines) {
      const medicineId = line.sourceLot.batch.medicineId;
      const options = await warehouseCandidates(
        db,
        scope,
        medicineId,
        transfer.toBranchId,
        line.destinationStockLocationId,
        warehouseMinimumShelfLifeDays
      );
      const chosen = options.find(
        (c) => c.lot.id === line.sourceLotId && c.stockLocationId === line.sourceStockLocationId
      );
      if (!chosen || chosen.availableUnits < line.quantityUnits)
        invalid(
          'The existing transfer lot or bin is unavailable. Resolve the source allocation before adopting this transfer.'
        );
      const demand = demandRows.find((d) => d.medicineId === medicineId)!;
      const reservation = await db.pharmacyWarehouseReservation.create({
        data: {
          ...branchScope(scope),
          transferId: transfer.id,
          transferLineId: line.id,
          orderId: order.id,
          demandId: demand.id,
          quantityUnits: line.quantityUnits,
          sourceStockLocationId: line.sourceStockLocationId,
          inventoryLotId: line.sourceLotId,
        },
      });
      await holdUnits(
        db,
        scope,
        chosen.lot,
        line.sourceStockLocationId,
        reservation.id,
        line.quantityUnits,
        input.idempotencyKey
      );
    }
    await db.pharmacyInterbranchTransfer.update({
      where: { id: transfer.id },
      data: { status: 'ALLOCATED', approvedById: null, allocatedById: scope.actorId },
    });
    return order.id;
  });
}

type ScanLot = Pick<Lot, 'id' | 'packLevelId' | 'manufacturingBatchId' | 'shelfLabelNumber'> & {
  packLevel: { presentationId: string };
  batch: { medicineId: string; batchNumber: string | null; expiresAt: Date | null };
};
export async function assertWarehouseScans(
  db: ScopedDb,
  scope: LedgerScope,
  lot: ScanLot,
  locationId: string,
  productScan: string,
  lotScan: string,
  transit = false
) {
  const mismatch = () =>
    new PharmacyInventoryError(
      'LABEL_LOT_MISMATCH',
      'Scan the product, strength and lot listed on the task.'
    );
  async function verifyProduct(scan: string) {
    if (scan.trim() === lot.batch.medicineId) return null;
    const parsed = parseGs1DataMatrix(scan);
    if (parsed.kind === 'invalid') throw mismatch();
    const fields = parsed.kind === 'parsed' ? parsed.fields : null;
    if (fields?.batch && fields.batch !== lot.batch.batchNumber) throw mismatch();
    if (fields?.expiryDate) {
      const printed = expiryInstant(new Date(fields.expiryDate + 'T00:00:00.000Z'), 'DAY');
      if (
        !lot.batch.expiresAt ||
        printed.getTime() !== normalizeExpiryBoundary(lot.batch.expiresAt).getTime()
      )
        throw mismatch();
    }
    const codes = fields ? [fields.gtin, ...(fields.gtin13 ? [fields.gtin13] : [])] : [scan];
    const barcode = await db.medicineBarcode.findFirst({
      where: {
        organizationId: scope.organizationId,
        normalizedCode: { in: codes.map(normalizeMedicineText) },
        presentationId: lot.packLevel.presentationId,
        OR: [{ packLevelId: lot.packLevelId }, { packLevelId: null }],
      },
      select: { id: true },
    });
    if (!barcode) throw mismatch();
    return fields;
  }
  await verifyProduct(productScan);
  const value = lotScan.trim();
  if (value === lot.id || parseShelfLabelCode(value) === lot.shelfLabelNumber) return;
  const parsed = parseGs1DataMatrix(value);
  const batchNumber = parsed.kind === 'parsed' ? (await verifyProduct(value))?.batch : value;
  if (parsed.kind === 'invalid' || !batchNumber || batchNumber !== lot.batch.batchNumber)
    throw mismatch();
  const count = await db.pharmacyInventoryLot.count({
    where: {
      ...branchScope(scope),
      manufacturingBatchId: lot.manufacturingBatchId,
      balances: {
        some: {
          stockLocationId: locationId,
          onHandUnits: { gt: 0 },
          disposition: {
            in: transit
              ? ['IN_TRANSIT']
              : ['AVAILABLE', 'WAREHOUSE_RESERVED', 'QUARANTINE', 'DAMAGED', 'WAREHOUSE_RECEIVING'],
          },
        },
      },
    },
  });
  if (count !== 1)
    throw new PharmacyInventoryError(
      'LABEL_LOT_MISMATCH',
      'Several receipt lots share this batch in the bin. Scan the internal lot label.'
    );
}

async function scanLine(
  db: ScopedDb,
  scope: LedgerScope,
  input: ScanInput & { sourceBinScan?: string },
  picking: boolean
) {
  return command(db, scope, picking ? 'PICK' : 'PACK', input, async () => {
    const config = await configuration(db, scope);
    const ref = await db.pharmacyWarehouseReservation.findFirst({
      where: { ...branchScope(scope), id: input.reservationId },
      select: { orderId: true, order: { select: { toBranchId: true } } },
    });
    if (!ref) throw new PharmacyInventoryError('NOT_FOUND');
    await lockOrder(db, scope, ref.orderId);
    const r = await db.pharmacyWarehouseReservation.findFirstOrThrow({
      where: { ...branchScope(scope), id: input.reservationId },
    });
    const lot = await db.pharmacyInventoryLot.findFirstOrThrow({
      where: { ...branchScope(scope), id: r.inventoryLotId },
      include: lotInclude,
    });
    const source = await bin(db, scope, scope.branchId, { id: r.sourceStockLocationId });
    const staging = await bin(db, scope, scope.branchId, { code: input.stagingBinScan.trim() });
    if (!staging || !compatible(staging, lot.batch.medicine.coldChain, true))
      invalid('Scan a compatible warehouse staging bin.');
    if (r.state !== (picking ? 'RESERVED' : 'PICKED') || r.quantityUnits !== input.quantityUnits)
      invalid('The scanned quantity or task status does not match the reservation.');
    if (
      picking
        ? !compatible(source, lot.batch.medicine.coldChain, false) ||
          source?.code !== input.sourceBinScan?.trim()
        : staging.id !== r.stagingStockLocationId
    )
      invalid('The scanned bin does not match the task.');
    await assertWarehouseScans(
      db,
      scope,
      lot,
      picking ? r.sourceStockLocationId : staging.id,
      input.productScan,
      input.lotScan
    );
    await lockMedicineStock(db, scope, [lot.batch.medicineId]);
    const checkedLot = await db.pharmacyInventoryLot.findFirstOrThrow({
      where: { ...branchScope(scope), id: r.inventoryLotId },
      include: lotInclude,
    });
    if (
      !(await eligible(
        db,
        scope,
        checkedLot,
        await minimumShelfLife(
          db,
          scope,
          ref.order.toBranchId,
          config.warehouseMinimumShelfLifeDays
        ),
        [r.sourceStockLocationId, staging.id],
        r.transferId
      ))
    )
      invalid('The lot is on hold or does not meet the warehouse shelf-life requirement.');
    if (picking)
      await move(
        db,
        scope,
        lot,
        r.quantityUnits,
        { id: r.sourceStockLocationId, disposition: 'WAREHOUSE_RESERVED' },
        { id: staging.id, disposition: 'WAREHOUSE_RESERVED' },
        'wh:pick:' + r.id,
        await reservedArrangement(db, scope, r.id)
      );
    await db.pharmacyWarehouseReservation.update({
      where: { id: r.id },
      data: { state: picking ? 'PICKED' : 'PACKED', stagingStockLocationId: staging.id },
    });
    return r.orderId;
  });
}

export function pickWarehouseLine(
  db: ScopedDb,
  scope: LedgerScope,
  input: ScanInput & { sourceBinScan: string }
) {
  return scanLine(db, scope, input, true);
}

export function packWarehouseLine(db: ScopedDb, scope: LedgerScope, input: ScanInput) {
  return scanLine(db, scope, input, false);
}

export async function cancelWarehouseOutbound(
  db: ScopedDb,
  scope: LedgerScope,
  input: OrderInput & { reason: string }
) {
  return command(db, scope, 'CANCEL', input, async () => {
    if (!input.reason.trim()) invalid('Record why the replenishment order is being cancelled.');
    await lockOrder(db, scope, input.orderId);
    const order = await db.pharmacyWarehouseOrder.findFirstOrThrow({
      where: { ...branchScope(scope), id: input.orderId },
      include: allLines,
    });
    if (order.status !== 'OPEN') invalid('Only an open replenishment order may be cancelled.');
    const pending = order.reservations.filter(
      (r) => !['CANCELLED', 'DISPATCHED'].includes(r.state)
    );
    await lockMedicineStock(
      db,
      scope,
      order.demands.map((d) => d.medicineId)
    );
    for (const r of pending) {
      const lot = await db.pharmacyInventoryLot.findFirstOrThrow({
        where: { ...branchScope(scope), id: r.inventoryLotId },
        include: lotInclude,
      });
      const currentBin = r.stagingStockLocationId ?? r.sourceStockLocationId;
      const held =
        lot.batch.state !== 'ACTIVE' ||
        !warehouseLotEligible(lot, 0, new Date()) ||
        (await warehouseStockQualityReason(
          db,
          scope,
          lot.id,
          [currentBin, r.sourceStockLocationId],
          new Date(),
          r.transferId
        ));
      // A staged pick remains at its physical bin on cancellation. A later supervised put-away
      // moves it to storage; stock on a quality hold can never be restored to available.
      const disposition =
        held || currentBin !== r.sourceStockLocationId ? 'QUARANTINE' : 'AVAILABLE';
      await move(
        db,
        scope,
        lot,
        r.quantityUnits,
        { id: currentBin, disposition: 'WAREHOUSE_RESERVED' },
        { id: currentBin, disposition },
        'wh:cancel:' + r.id,
        await reservedArrangement(db, scope, r.id)
      );
      if (disposition === 'QUARANTINE') {
        await registerWarehouseCancellationHold(db, scope, {
          inventoryLotId: lot.id,
          stockLocationId: currentBin,
          quantityUnits: r.quantityUnits,
          reservationId: r.id,
        });
      }
      await db.pharmacyWarehouseReservation.update({
        where: { id: r.id },
        data: { state: 'CANCELLED' },
      });
    }
    await db.pharmacyWarehouseOrder.update({
      where: { id: order.id },
      data: { status: 'CANCELLED' },
    });
    return order.id;
  });
}

/** Called inside the existing dispatch transaction, with the existing transfer approval. */
export async function dispatchWarehouseTransfer(
  db: ScopedDb,
  scope: LedgerScope,
  transferId: string,
  key: string
) {
  await lockWarehouseQuality(db, scope.organizationId, true);
  const commandKey = key.trim();
  if (!commandKey || commandKey.length > 160 || commandKey.startsWith('wh-system:'))
    invalid('Provide a dispatch command key.');
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['warehouse', scope.organizationId, scope.branchId, commandKey])},0))`;
  const ref = await db.pharmacyWarehouseReservation.findFirst({
    where: { ...branchScope(scope), transferId },
    select: { orderId: true },
  });
  if (!ref)
    invalid('Adopt the transfer in the warehouse and scan its picks and packs before dispatch.');
  await lockOrder(db, scope, ref.orderId);
  await db.$queryRaw`SELECT id FROM pharmacy_interbranch_transfers WHERE id=${transferId} AND "organizationId"=${scope.organizationId} AND "fromBranchId"=${scope.branchId} FOR UPDATE`;
  const transfer = await db.pharmacyInterbranchTransfer.findFirstOrThrow({
    where: { organizationId: scope.organizationId, fromBranchId: scope.branchId, id: transferId },
    include: { lines: true },
  });
  const previous = await db.pharmacyWarehouseCommand.findUnique({
    where: { organizationId_branchId_key: { ...branchScope(scope), key: commandKey } },
  });
  if (previous) {
    if (
      previous.kind !== 'DISPATCH' ||
      (previous.payload as { transferId?: string }).transferId !== transferId
    )
      throw new PharmacyInventoryError('IDEMPOTENCY_CONFLICT');
    return transfer;
  }
  const config = await configuration(db, scope);
  const order = await db.pharmacyWarehouseOrder.findFirstOrThrow({
    where: { ...branchScope(scope), id: ref.orderId },
    include: allLines,
  });
  const matched = order.reservations.filter((r) => r.transferId === transferId);
  const lines = matched.filter((r) => r.state !== 'CANCELLED');
  if (
    order.status !== 'OPEN' ||
    transfer.status !== 'APPROVED' ||
    !lines.length ||
    matched.length !== transfer.lines.length ||
    lines.some((r) => r.state !== 'PACKED' || !r.stagingStockLocationId)
  )
    invalid('Approve the transfer and scan every packed reservation before dispatch.');
  const licences = await assertBranchTransferAllowed(db, {
    organizationId: scope.organizationId,
    fromBranchId: scope.branchId,
    toBranchId: transfer.toBranchId,
    sourceLotIds: lines.map((r) => r.inventoryLotId),
    requireSwitch: true,
  });
  if (await noteMissingWarehouseDispatchEvidence(db, scope, transferId)) {
    return db.pharmacyInterbranchTransfer.findFirstOrThrow({
      where: { id: transfer.id, organizationId: scope.organizationId },
    });
  }
  await lockMedicineStock(
    db,
    scope,
    order.demands.map((d) => d.medicineId)
  );
  const now = new Date();
  for (const r of lines) {
    const line = transfer.lines.find((l) => l.id === r.transferLineId);
    const stagingId = r.stagingStockLocationId!;
    const lot = await db.pharmacyInventoryLot.findFirstOrThrow({
      where: { ...branchScope(scope), id: r.inventoryLotId },
      include: lotInclude,
    });
    if (
      !line ||
      line.sourceLotId !== lot.id ||
      line.sourceStockLocationId !== r.sourceStockLocationId ||
      line.quantityUnits !== r.quantityUnits
    )
      invalid('The transfer and packed reservations differ.');
    if (
      !compatible(
        await bin(db, scope, scope.branchId, { id: stagingId }),
        lot.batch.medicine.coldChain,
        true
      ) ||
      !compatible(
        await bin(db, scope, transfer.toBranchId, { id: line.destinationStockLocationId }),
        lot.batch.medicine.coldChain,
        false
      )
    )
      invalid('The shipment requires compatible active storage at both ends.');
    if (
      !(await eligible(
        db,
        scope,
        lot,
        await minimumShelfLife(
          db,
          scope,
          transfer.toBranchId,
          config.warehouseMinimumShelfLifeDays
        ),
        [r.sourceStockLocationId, stagingId],
        r.transferId
      ))
    )
      invalid('A packed lot is held, expired or below the required remaining shelf life.');
    const quality = await warehouseDispatchQualityReason(db, scope, transferId, lot.id, stagingId);
    if (quality) invalid(quality);
    // The existing receiving path consumes the IN_TRANSIT bucket keyed by the transfer's source bin.
    await move(
      db,
      scope,
      lot,
      r.quantityUnits,
      { id: stagingId, disposition: 'WAREHOUSE_RESERVED' },
      { id: r.sourceStockLocationId, disposition: 'IN_TRANSIT' },
      'wh:dispatch:' + r.id,
      await reservedArrangement(db, scope, r.id)
    );
    await postInterbranchTransferEntry(db, scope, { transferLineId: line.id, at: now });
    await db.pharmacyWarehouseReservation.update({
      where: { id: r.id },
      data: { state: 'DISPATCHED' },
    });
  }
  const dispatched = await db.pharmacyInterbranchTransfer.update({
    where: { id: transferId },
    data: {
      status: 'DISPATCHED',
      dispatchedById: scope.actorId,
      dispatchedAt: now,
      fromLicenceNumber: licences.from.licenceNumber,
      toLicenceNumber: licences.to.licenceNumber,
    },
  });
  const allocated = new Set(lines.map((r) => r.id));
  const complete = order.demands.every(
    (d) =>
      order.reservations
        .filter((r) => r.demandId === d.id && (r.state === 'DISPATCHED' || allocated.has(r.id)))
        .reduce((sum, r) => sum + r.quantityUnits, 0) === d.requestedUnits
  );
  if (complete)
    await db.pharmacyWarehouseOrder.update({ where: { id: order.id }, data: { status: 'CLOSED' } });
  await db.pharmacyWarehouseCommand.create({
    data: {
      ...branchScope(scope),
      orderId: order.id,
      actorId: scope.actorId,
      key: commandKey,
      kind: 'DISPATCH',
      payload: { transferId },
    },
  });
  return dispatched;
}

type WarehouseHoldTarget = {
  batchId?: string;
  batchIds?: readonly string[];
  medicineId?: string;
  inventoryLotId?: string;
  stockLocationId?: string;
  transferId?: string;
  reservationId?: string;
  qualityIncidentId?: string;
  reason: string;
  sourceKey: string;
};

/** Caller holds the exclusive quality lock before taking any transfer, order or stock locks.
 * Original manifest lines remain attached as evidence; only still-held units move.
 */
export async function releaseWarehouseReservationsForHold(
  db: ScopedDb,
  actor: { organizationId: string; actorId: string | null },
  target: WarehouseHoldTarget
): Promise<number> {
  if (!(target.batchId || target.batchIds?.length || target.medicineId || target.inventoryLotId))
    invalid('Specify the lot or batch affected by the hold.');
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      branchId: string;
      orderId: string;
      transferId: string;
      inventoryLotId: string;
      locationId: string;
      quantityUnits: number;
      unitsPerPack: number;
    }>
  >(Prisma.sql`
    SELECT r.id,r."branchId",r."orderId",r."transferId",r."inventoryLotId",r."quantityUnits",l."unitsPerPack",
           COALESCE(r."stagingStockLocationId",r."sourceStockLocationId") AS "locationId"
    FROM pharmacy_warehouse_reservations r JOIN pharmacy_inventory_lots l ON l.id=r."inventoryLotId" AND l."organizationId"=r."organizationId"
    JOIN pharmacy_manufacturing_batches mb ON mb.id=l."manufacturingBatchId" AND mb."organizationId"=l."organizationId"
    WHERE r."organizationId"=${actor.organizationId} AND r.state IN ('RESERVED','PICKED','PACKED')
    ${target.batchId ? Prisma.sql`AND mb.id=${target.batchId}` : Prisma.empty}
    ${target.batchIds?.length ? Prisma.sql`AND mb.id IN (${Prisma.join([...target.batchIds])})` : Prisma.empty}
    ${target.medicineId ? Prisma.sql`AND mb."medicineId"=${target.medicineId}` : Prisma.empty}
    ${target.inventoryLotId ? Prisma.sql`AND l.id=${target.inventoryLotId}` : Prisma.empty}
    ${target.stockLocationId ? Prisma.sql`AND COALESCE(r."stagingStockLocationId",r."sourceStockLocationId")=${target.stockLocationId}` : Prisma.empty}
    ${target.transferId ? Prisma.sql`AND r."transferId"=${target.transferId}` : Prisma.empty}
    ${target.reservationId ? Prisma.sql`AND r.id=${target.reservationId}` : Prisma.empty}
    ORDER BY r."branchId",r."orderId",r.id`);
  if (!rows.length) return 0;
  await lockStockBalances(
    db,
    { organizationId: actor.organizationId },
    rows.flatMap((r) =>
      (['WAREHOUSE_RESERVED', 'QUARANTINE'] as const).map((disposition) => ({
        inventoryLotId: r.inventoryLotId,
        stockLocationId: r.locationId,
        disposition,
      }))
    )
  );
  for (const r of rows) {
    const scope = {
      organizationId: actor.organizationId,
      branchId: r.branchId,
      actorId: actor.actorId ?? 'pharmacy-safety',
    };
    await move(
      db,
      scope,
      { id: r.inventoryLotId, unitsPerPack: r.unitsPerPack },
      r.quantityUnits,
      { id: r.locationId, disposition: 'WAREHOUSE_RESERVED' },
      { id: r.locationId, disposition: 'QUARANTINE' },
      'wh:safety:' + r.id,
      await reservedArrangement(db, scope, r.id)
    );
    await db.pharmacyWarehouseReservation.update({
      where: { id: r.id },
      data: { state: 'CANCELLED' },
    });
    if (!target.qualityIncidentId)
      await openWarehouseIncident(db, scope, {
        inventoryLotId: r.inventoryLotId,
        stockLocationId: r.locationId,
        quantityUnits: r.quantityUnits,
        quarantineUnits: r.quantityUnits,
        transferId: r.transferId,
        reason: target.reason,
        sourceKey: 'withdraw:' + r.id + ':' + target.sourceKey,
      });
    await db.pharmacyWarehouseCommand.create({
      data: {
        ...branchScope(scope),
        actorId: scope.actorId,
        orderId: r.orderId,
        key: 'wh-system:hold:' + r.id,
        kind: 'QUALITY_HOLD',
        payload: { reservationId: r.id, sourceKey: target.sourceKey, reason: target.reason },
      },
    });
  }
  const affected = new Map(rows.map((r) => [r.transferId, r]));
  for (const [id, r] of affected) {
    await db.pharmacyInterbranchTransfer.updateMany({
      where: {
        id,
        organizationId: actor.organizationId,
        dispatchedAt: null,
        status: { in: ['APPROVED', 'ALLOCATED'] },
      },
      data: { status: 'ALLOCATED', approvedById: null },
    });
    if (
      !(await db.pharmacyWarehouseReservation.count({
        where: {
          organizationId: actor.organizationId,
          transferId: id,
          state: { in: ['RESERVED', 'PICKED', 'PACKED'] },
        },
      }))
    ) {
      await db.pharmacyWarehouseOrder.updateMany({
        where: {
          id: r.orderId,
          organizationId: actor.organizationId,
          transferId: id,
          status: 'OPEN',
        },
        data: { transferId: null },
      });
    }
  }
  return rows.reduce((sum, r) => sum + r.quantityUnits, 0);
}
