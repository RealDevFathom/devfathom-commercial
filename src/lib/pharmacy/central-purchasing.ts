import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { allocateTransfer } from './inventory-operations';
import type { InterbranchTransferSuggestion } from './interbranch-transfer-suggestions';
import { assertSupplierEligible, PharmacyPurchasingError } from './purchasing';
import {
  effectiveSupplierCompliancePolicy,
  readSupplierCompliancePolicy,
  recordSupplierComplianceSkip,
  strictLicenceEvidence,
} from './supplier-compliance-policy';

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
  const [supplier, branch] = await Promise.all([
    // PUR-01 is decided below by the shared, policy-aware gate rather than by a
    // query filter here, so this path and the ordinary one cannot disagree.
    db.pharmacySupplier.findFirst({
      where: { id: input.supplierId, organizationId: scope.organizationId },
      include: { licences: true },
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
  return db.$transaction(async (transaction) => {
    const tx = transaction as unknown as ScopedDb;
    // DEV-753: the owner's supplier-compliance policy, share-locked for this write.
    // With the checks on, an ineligible supplier stays NOT_FOUND here as before, now
    // with supersession read strictly (DEV-466). With them off the order is raised and
    // the skip is recorded against it in the same transaction.
    // Controlled medicines keep the supplier checks whatever the owner policy says.
    const policy = await effectiveSupplierCompliancePolicy(
      tx,
      scope.organizationId,
      await readSupplierCompliancePolicy(tx, scope.organizationId, { lock: 'share' }),
      { medicineIds: input.lines.map((line) => line.medicineId) }
    );
    const licences = await strictLicenceEvidence(tx, scope.organizationId, supplier.licences);
    let outcome: ReturnType<typeof assertSupplierEligible>;
    try {
      outcome = assertSupplierEligible({
        authorized: supplier.authorized,
        licences,
        at: new Date(),
        policy,
      });
    } catch (error) {
      if (error instanceof PharmacyPurchasingError) throw new CentralPurchasingError('NOT_FOUND');
      throw error;
    }
    const order = await createCentralOrderRow(tx, scope, input, supplier.id, branch.id);
    if (!outcome.checked) {
      await recordSupplierComplianceSkip(tx, scope, {
        operation: 'CENTRAL_PURCHASE_ORDER_CREATE',
        supplierId: supplier.id,
        purchaseOrderId: order.id,
        reference: input.reference,
        outcome,
      });
    }
    return order;
  });
}

function createCentralOrderRow(
  db: ScopedDb,
  scope: Scope,
  input: Parameters<typeof createCentralPurchaseOrder>[2],
  supplierId: string,
  branchId: string
) {
  return db.pharmacyPurchaseOrder.create({
    data: {
      organizationId: scope.organizationId,
      branchId,
      reference: input.reference,
      supplierId,
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

/**
 * Materialise a planning suggestion as an INV-07 draft. This path
 * deliberately stops at ALLOCATED; the existing approval/PIN workflow remains
 * the only path that can approve or dispatch it.
 */
export async function createSuggestedTransferDraft(
  db: ScopedDb,
  scope: Scope,
  suggestion: InterbranchTransferSuggestion
) {
  await requireOrganizationPurchaser(db, scope);
  if (
    suggestion.fromBranchId === suggestion.toBranchId ||
    suggestion.quantityUnits <= 0 ||
    suggestion.lines.length === 0 ||
    suggestion.lines.reduce((sum, line) => sum + line.quantityUnits, 0) !== suggestion.quantityUnits
  )
    throw new CentralPurchasingError('INVALID_ALLOCATION');

  const boundSources = await Promise.all(
    suggestion.lines.map((line) =>
      Promise.all([
        db.pharmacyInventoryLot.findFirst({
          where: {
            id: line.sourceLotId,
            organizationId: scope.organizationId,
            branchId: suggestion.fromBranchId,
            batch: { medicineId: suggestion.medicineId },
          },
          select: { id: true },
        }),
        db.pharmacyStockLocation.findFirst({
          where: {
            id: line.sourceStockLocationId,
            organizationId: scope.organizationId,
            branchId: suggestion.fromBranchId,
          },
          select: { id: true },
        }),
      ])
    )
  );
  if (boundSources.some(([lot, location]) => !lot || !location))
    throw new CentralPurchasingError('INVALID_ALLOCATION');

  const transfer = await allocateTransfer(
    db,
    { ...scope, branchId: suggestion.fromBranchId },
    {
      toBranchId: suggestion.toBranchId,
      lines: suggestion.lines.map((line) => ({
        sourceLotId: line.sourceLotId,
        sourceStockLocationId: line.sourceStockLocationId,
        destinationStockLocationId: line.destinationStockLocationId,
        quantityUnits: line.quantityUnits,
      })),
    }
  );
  if (transfer.status !== 'ALLOCATED' || transfer.approvedById !== null)
    throw new Error('SUGGESTED_TRANSFER_MUST_BE_DRAFT');
  return transfer;
}
