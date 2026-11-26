import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { PharmacyInventoryError } from './inventory';
import { packConversions } from './pack-conversion';
import type { LedgerScope } from './stock-ledger';
import { createWarehouseOutbound, warehouseAvailableUnits } from './warehouse-outbound';

type RequestInput = {
  warehouseBranchId: string;
  medicineId: string;
  destinationStockLocationId: string;
  requestedUnits: number;
  signalId?: string;
  idempotencyKey: string;
};

const actionableSignals = ['OPEN', 'ACKNOWLEDGED'] as const;
const shortageKinds = ['LOW_STOCK', 'STOCKOUT'] as const;

function stale(signal: { computedAt: Date; freshnessSeconds: number }, at = new Date()) {
  return at.getTime() - signal.computedAt.getTime() > signal.freshnessSeconds * 1000;
}

export async function listWarehouseRequests(db: ScopedDb, scope: LedgerScope) {
  const { organizationId, branchId } = scope;
  const [requests, signals] = await Promise.all([
    db.pharmacyWarehouseRequest.findMany({
      where: { organizationId, OR: [{ branchId }, { warehouseBranchId: branchId }] },
      include: { branch: { select: { name: true } }, medicine: { select: { productName: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    db.pharmacyStockSignal.findMany({
      where: {
        organizationId,
        branchId,
        status: { in: [...actionableSignals] },
        kind: { in: [...shortageKinds] },
        neededUnits: { gt: 0 },
      },
      select: {
        id: true,
        medicineId: true,
        neededUnits: true,
        computedAt: true,
        freshnessSeconds: true,
        medicine: { select: { productName: true } },
      },
      orderBy: { dueAt: 'asc' },
    }),
  ]);
  const submitted = new Set(
    requests.filter((row) => row.branchId === branchId).map((row) => row.signalId)
  );
  const promiseByDestination = new Map<string, Promise<number>>();
  function promiseFor(row: (typeof requests)[number]) {
    if (row.warehouseBranchId !== branchId || row.status !== 'REQUESTED') return null;
    const key = JSON.stringify([row.medicineId, row.branchId, row.destinationStockLocationId]);
    const existing = promiseByDestination.get(key);
    if (existing) return existing;
    const quantity = warehouseAvailableUnits(
      db,
      scope,
      row.medicineId,
      row.branchId,
      row.destinationStockLocationId
    );
    promiseByDestination.set(key, quantity);
    return quantity;
  }
  return {
    requests: await Promise.all(
      requests.map(async (row) => ({
        availableToPromiseUnits: await promiseFor(row),
        id: row.id,
        branchId: row.branchId,
        branchName: row.branch.name,
        warehouseBranchId: row.warehouseBranchId,
        medicineId: row.medicineId,
        medicineName: row.medicine.productName,
        requestedUnits: row.requestedUnits,
        status: row.status,
        orderId: row.orderId,
        requisitionId: row.requisitionId,
        createdAt: row.createdAt,
      }))
    ),
    suggestions: signals
      .filter((row) => !submitted.has(row.id) && !stale(row))
      .map((row) => ({
        id: row.id,
        medicineId: row.medicineId,
        medicineName: row.medicine.productName,
        neededUnits: row.neededUnits,
      })),
  };
}

export async function submitWarehouseRequest(
  db: ScopedDb,
  scope: LedgerScope,
  input: RequestInput
) {
  const { organizationId, branchId } = scope;
  // Serialize both retries and independent operators accepting the same recommendation.
  const keys = [`request:${branchId}:${input.idempotencyKey}`];
  if (input.signalId) keys.push(`signal:${input.signalId}`);
  for (const key of keys.sort())
    await db.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${organizationId + ':' + key},0))`;
  const previous = await db.pharmacyWarehouseRequest.findFirst({
    where: {
      organizationId,
      branchId,
      OR: [
        { idempotencyKey: input.idempotencyKey },
        ...(input.signalId ? [{ signalId: input.signalId }] : []),
      ],
    },
  });
  if (previous) {
    if (
      previous.medicineId !== input.medicineId ||
      previous.requestedUnits !== input.requestedUnits ||
      previous.destinationStockLocationId !== input.destinationStockLocationId ||
      previous.warehouseBranchId !== input.warehouseBranchId ||
      previous.signalId !== (input.signalId ?? null)
    )
      throw new PharmacyInventoryError('IDEMPOTENCY_CONFLICT');
    return previous;
  }
  const enabled = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM pharmacy_branches WHERE "organizationId"=${organizationId} AND id=${input.warehouseBranchId}
      AND active AND "warehouseEnabled" FOR SHARE`;
  if (!enabled.length || branchId === input.warehouseBranchId)
    throw new PharmacyInventoryError('INVALID_STATE', 'Choose another active warehouse.');
  const [medicine, bin] = await Promise.all([
    db.medicine.findFirst({
      where: { id: input.medicineId, organizationId, saleable: true },
      select: { id: true, controlled: true, coldChain: true },
    }),
    db.pharmacyStockLocation.findFirst({
      where: {
        id: input.destinationStockLocationId,
        branchId,
        organizationId,
        active: true,
        warehouseStaging: false,
        kind: { in: ['STORE', 'RACK_BIN', 'FRIDGE', 'SAFE'] },
      },
      select: { id: true, kind: true, coldChain: true },
    }),
  ]);
  if (!medicine || !bin)
    throw new PharmacyInventoryError(
      'NOT_FOUND',
      'Select a catalog medicine and an active receiving bin at this branch.'
    );
  if (medicine.coldChain && !bin.coldChain)
    throw new PharmacyInventoryError('COLD_CHAIN_STORAGE_REQUIRED');
  if (medicine.controlled && bin.kind !== 'SAFE')
    throw new PharmacyInventoryError(
      'BLOCKED_STOCK',
      'Select a secure storage bin for controlled medicine.'
    );
  if (input.signalId) {
    const signal = await db.pharmacyStockSignal.findFirst({
      where: {
        organizationId,
        branchId,
        id: input.signalId,
        medicineId: medicine.id,
        status: { in: [...actionableSignals] },
        kind: { in: [...shortageKinds] },
        neededUnits: { gt: 0 },
      },
    });
    if (!signal || stale(signal))
      throw new PharmacyInventoryError(
        'INVALID_STATE',
        'This suggestion has changed. Refresh the queue.'
      );
  }
  return db.pharmacyWarehouseRequest.create({
    data: {
      ...input,
      organizationId,
      branchId,
      requestedById: scope.actorId,
      status: medicine.controlled ? 'DIRECT_PURCHASE' : 'REQUESTED',
    },
  });
}

async function lockRequest(db: ScopedDb, scope: LedgerScope, requestId: string) {
  const found = await db.$queryRaw<{ id: string }[]>`SELECT id FROM pharmacy_warehouse_requests
    WHERE "organizationId"=${scope.organizationId} AND id=${requestId}
    AND ("branchId"=${scope.branchId} OR "warehouseBranchId"=${scope.branchId}) FOR UPDATE`;
  if (!found.length) throw new PharmacyInventoryError('NOT_FOUND');
  return db.pharmacyWarehouseRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { medicine: { select: { controlled: true } } },
  });
}

export async function withdrawWarehouseRequest(
  db: ScopedDb,
  scope: LedgerScope,
  requestId: string
) {
  const request = await lockRequest(db, scope, requestId);
  if (request.status === 'CANCELLED') return request;
  if (request.status !== 'REQUESTED' && request.status !== 'DIRECT_PURCHASE')
    throw new PharmacyInventoryError(
      'INVALID_STATE',
      'This request already has a fulfillment or purchasing document.'
    );
  return db.pharmacyWarehouseRequest.update({
    where: { id: request.id },
    data: { status: 'CANCELLED' },
  });
}

export async function fulfillWarehouseRequest(db: ScopedDb, scope: LedgerScope, requestId: string) {
  const request = await lockRequest(db, scope, requestId);
  if (request.warehouseBranchId !== scope.branchId)
    throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  if (request.status === 'ALLOCATED' || request.status === 'DIRECT_PURCHASE') return request;
  if (request.status !== 'REQUESTED') throw new PharmacyInventoryError('INVALID_STATE');
  if (request.medicine.controlled)
    return db.pharmacyWarehouseRequest.update({
      where: { id: requestId },
      data: { status: 'DIRECT_PURCHASE' },
    });
  const order = await createWarehouseOutbound(db, scope, {
    toBranchId: request.branchId,
    lines: [
      {
        medicineId: request.medicineId,
        destinationStockLocationId: request.destinationStockLocationId,
        requestedUnits: request.requestedUnits,
      },
    ],
    idempotencyKey: `warehouse-request:${requestId}`,
  });
  return db.pharmacyWarehouseRequest.update({
    where: { id: requestId },
    data: { status: 'ALLOCATED', orderId: order.id },
  });
}

export async function purchaseWarehouseRequest(
  db: ScopedDb,
  scope: LedgerScope,
  requestId: string
) {
  const request = await lockRequest(db, scope, requestId);
  if (request.branchId !== scope.branchId)
    throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  if (request.requisitionId) return request;
  if (request.status !== 'DIRECT_PURCHASE') throw new PharmacyInventoryError('INVALID_STATE');
  const levels = await db.packLevel.findMany({
    where: {
      organizationId: scope.organizationId,
      presentation: { medicineId: request.medicineId },
    },
  });
  const packs = packConversions(levels).filter(
    (p) => Number.isSafeInteger(p.canonicalUnitsPerPack) && p.canonicalUnitsPerPack > 0
  );
  // Minimize over-ordering, then use the largest pack that gives the same quantity.
  const quantityFor = (units: number) => Math.ceil(request.requestedUnits / units) * units;
  packs.sort(
    (a, b) =>
      quantityFor(a.canonicalUnitsPerPack) - quantityFor(b.canonicalUnitsPerPack) ||
      b.canonicalUnitsPerPack - a.canonicalUnitsPerPack ||
      a.packLevelId.localeCompare(b.packLevelId)
  );
  const pack = packs[0];
  if (!pack || quantityFor(pack.canonicalUnitsPerPack) > 2147483647)
    throw new PharmacyInventoryError(
      'INVALID_STATE',
      'Configure an effective purchasing pack for this medicine before creating the requisition.'
    );
  const requisition = await db.pharmacyRequisition.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      reference: `WMS-${request.id}`,
      requestedByUserId: scope.actorId,
      note: `Direct supplier delivery of controlled medicine. Branch requested ${request.requestedUnits} base units.`,
      lines: {
        create: {
          lineNumber: 1,
          medicineId: request.medicineId,
          packLevelId: pack.packLevelId,
          canonicalUnitsPerPack: pack.canonicalUnitsPerPack,
          quantityPacks: Math.ceil(request.requestedUnits / pack.canonicalUnitsPerPack),
          canonicalUnits: quantityFor(pack.canonicalUnitsPerPack),
        },
      },
    },
  });
  return db.pharmacyWarehouseRequest.update({
    where: { id: requestId },
    data: { status: 'REQUISITIONED', requisitionId: requisition.id },
  });
}
