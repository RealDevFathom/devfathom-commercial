import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { allocateTransfer } from './inventory-operations';

export class CentralPurchasingError extends Error {
  constructor(readonly reason: 'FORBIDDEN' | 'INVALID_ALLOCATION' | 'NOT_FOUND') {
    super(reason);
  }
}

type Scope = { organizationId: string; actorId: string };

export async function purchasingAccess(db: ScopedDb, scope: Scope, branchId?: string) {
  const grants = await db.pharmacyCentralPurchasingAccess.findMany({
    where: { organizationId: scope.organizationId, userId: scope.actorId },
    select: { branchId: true },
  });
  const organizationWide = grants.some((grant) => grant.branchId === null);
  if (organizationWide) return { organizationWide, branchIds: branchId ? [branchId] : undefined };
  const branchIds = grants.flatMap((grant) => (grant.branchId ? [grant.branchId] : []));
  if (branchId) {
    if (!branchIds.includes(branchId)) throw new CentralPurchasingError('FORBIDDEN');
    return { organizationWide: false, branchIds: [branchId] };
  }
  if (branchIds.length === 0) throw new CentralPurchasingError('FORBIDDEN');
  return { organizationWide: false, branchIds };
}

async function requireOrganizationPurchaser(db: ScopedDb, scope: Scope) {
  const access = await purchasingAccess(db, scope);
  if (!access.organizationWide) throw new CentralPurchasingError('FORBIDDEN');
}

/** INV-10: exact PUR-07 demand and coverage, grouped without forecasting. */
export async function centralDemand(db: ScopedDb, scope: Scope, branchId?: string) {
  const access = await purchasingAccess(db, scope, branchId);
  const rows = await db.pharmacyStockSignal.findMany({
    where: {
      organizationId: scope.organizationId,
      ...(access.branchIds ? { branchId: { in: access.branchIds } } : {}),
      status: { in: ['OPEN', 'ACKNOWLEDGED'] },
      kind: { in: ['LOW_STOCK', 'STOCKOUT', 'INBOUND_COVERAGE'] },
    },
    orderBy: [{ medicineId: 'asc' }, { branchId: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      branchId: true,
      medicineId: true,
      neededUnits: true,
      onHandUnits: true,
      inboundUnits: true,
      confidence: true,
      computedAt: true,
    },
  });
  return {
    organizationWide: access.organizationWide,
    branches: [...new Set(rows.map((row) => row.branchId))],
    rows,
  };
}

export async function createCentralPurchaseOrder(
  db: ScopedDb,
  scope: Scope,
  input: {
    reference: string;
    supplierId: string;
    receivingBranchId: string;
    lines: ReadonlyArray<{
      medicineId: string;
      packLevelId: string;
      orderedPacks: number;
      canonicalUnitsPerPack: number;
      listPricePerPackMinor: number;
    }>;
  }
) {
  await requireOrganizationPurchaser(db, scope);
  const now = new Date();
  const [supplier, branch] = await Promise.all([
    db.pharmacySupplier.findFirst({
      where: {
        id: input.supplierId,
        organizationId: scope.organizationId,
        authorized: true,
        licences: {
          some: {
            verifiedAt: { not: null },
            issuedAt: { lte: now },
            expiresAt: { gt: now },
          },
        },
      },
    }),
    db.pharmacyBranch.findFirst({
      where: { id: input.receivingBranchId, organizationId: scope.organizationId, active: true },
    }),
  ]);
  if (!supplier || !branch) throw new CentralPurchasingError('NOT_FOUND');
  for (const line of input.lines) {
    const [medicine, packLevel] = await Promise.all([
      db.medicine.findFirst({
        where: {
          id: line.medicineId,
          organizationId: scope.organizationId,
          saleable: true,
        },
      }),
      db.packLevel.findFirst({
        where: { id: line.packLevelId, organizationId: scope.organizationId },
      }),
    ]);
    if (!medicine || !packLevel) throw new CentralPurchasingError('NOT_FOUND');
  }
  return db.pharmacyPurchaseOrder.create({
    data: {
      organizationId: scope.organizationId,
      branchId: branch.id,
      reference: input.reference,
      supplierId: supplier.id,
      createdByUserId: scope.actorId,
      lines: {
        create: input.lines.map((line, index) => ({
          ...line,
          lineNumber: index + 1,
          bonusPacks: 0,
          bonusCanonicalUnits: 0,
          orderedCanonicalUnits: line.orderedPacks * line.canonicalUnitsPerPack,
        })),
      },
    },
    include: { lines: true },
  });
}

export async function allocateCentralReceipt(
  db: ScopedDb,
  scope: Scope,
  input: {
    goodsReceiptId: string;
    allocations: ReadonlyArray<{
      goodsReceiptLineId: string;
      destinationBranchId: string;
      destinationStockLocationId: string;
      quantityUnits: number;
    }>;
  }
) {
  await requireOrganizationPurchaser(db, scope);
  const receipt = await db.pharmacyGoodsReceipt.findFirst({
    where: { id: input.goodsReceiptId, organizationId: scope.organizationId, status: 'POSTED' },
    include: { lines: true },
  });
  if (!receipt) throw new CentralPurchasingError('NOT_FOUND');
  if (
    await db.pharmacyCentralPurchaseAllocation.count({
      where: {
        organizationId: scope.organizationId,
        goodsReceiptLineId: { in: receipt.lines.map((line) => line.id) },
      },
    })
  )
    throw new CentralPurchasingError('INVALID_ALLOCATION');
  for (const line of receipt.lines) {
    const assigned = input.allocations
      .filter((allocation) => allocation.goodsReceiptLineId === line.id)
      .reduce((sum, allocation) => sum + allocation.quantityUnits, 0);
    if (assigned !== line.acceptedCanonicalUnits || assigned <= 0 || !line.inventoryLotId)
      throw new CentralPurchasingError('INVALID_ALLOCATION');
  }
  if (
    input.allocations.some(
      (allocation) =>
        !receipt.lines.some((line) => line.id === allocation.goodsReceiptLineId) ||
        allocation.quantityUnits <= 0 ||
        allocation.destinationBranchId === receipt.branchId
    )
  )
    throw new CentralPurchasingError('INVALID_ALLOCATION');
  const results = [];
  for (const allocation of input.allocations) {
    const line = receipt.lines.find((candidate) => candidate.id === allocation.goodsReceiptLineId)!;
    const transfer = await allocateTransfer(
      db,
      { ...scope, branchId: receipt.branchId },
      {
        toBranchId: allocation.destinationBranchId,
        lines: [
          {
            sourceLotId: line.inventoryLotId!,
            sourceStockLocationId: line.stockLocationId,
            destinationStockLocationId: allocation.destinationStockLocationId,
            quantityUnits: allocation.quantityUnits,
          },
        ],
      }
    );
    const evidence = await db.pharmacyCentralPurchaseAllocation.create({
      data: {
        organizationId: scope.organizationId,
        sourceBranchId: receipt.branchId,
        destinationBranchId: allocation.destinationBranchId,
        goodsReceiptLineId: line.id,
        transferId: transfer.id,
        transferLineId: transfer.lines[0]!.id,
        quantityUnits: allocation.quantityUnits,
        allocatedById: scope.actorId,
      },
    });
    results.push({ allocation: evidence, transfer });
  }
  return results;
}
