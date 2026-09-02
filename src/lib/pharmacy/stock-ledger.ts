/**
 * PH-INV / INV-01..04 — the stock ledger service.
 *
 * The only writer of `pharmacy_stock_movements`. Everything downstream of a
 * movement (the on-hand projection, the non-negative balance, the arrangement
 * reconciliation, the unreceived-stock refusal) is enforced by the migration's
 * trigger, so this module is responsible for the decisions a trigger cannot
 * make: which lots are candidates, which one FEFO picks, what evidence an
 * override needs, and how the emergency path records a shortfall.
 *
 * CONCURRENCY (INV-02 acceptance: "concurrent sale of last units never
 * oversells"). `allocateForSale` locks the candidate balance rows FOR UPDATE in
 * one deterministically ordered statement before it plans, so two counters
 * racing for the same last unit serialize: the loser re-reads the post-commit
 * balance and refuses. The non-negative CHECK on the projection is the backstop
 * behind that lock, not the primary mechanism — a caller that skipped the lock
 * would still be unable to push a balance below zero.
 */
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  arrangementFor,
  assertArrangementReconciles,
  blockReasonFor,
  planAllocation,
  planBreakPack,
  PharmacyInventoryError,
} from './inventory';
import type {
  Allocation,
  AllocationCandidate,
  BatchState,
  BlockReason,
  StockDisposition,
} from './inventory';

export type LedgerScope = {
  organizationId: string;
  branchId: string;
  actorId: string;
};

type CandidateRow = {
  inventoryLotId: string;
  stockLocationId: string;
  organizationId: string;
  branchId: string;
  batchState: BatchState;
  disposition: StockDisposition;
  expiresAt: Date;
  receivedAt: Date | null;
  availableUnits: number;
  unitsPerPack: number;
  sealedPacks: number;
  looseUnits: number;
};

/**
 * Normalise a printed expiry to the instant the stock becomes expired. A
 * MONTH-precision expiry ("06/2027") is good through that whole month, so it
 * expires at the first instant of the next one; a DAY-precision expiry is good
 * through its day. Storing the exclusive instant is what lets INV-03 decide
 * expiry with one comparison and never sell into an expiry period.
 */
export function expiryInstant(printed: Date, precision: 'DAY' | 'MONTH'): Date {
  return precision === 'MONTH'
    ? new Date(Date.UTC(printed.getUTCFullYear(), printed.getUTCMonth() + 1, 1))
    : new Date(Date.UTC(printed.getUTCFullYear(), printed.getUTCMonth(), printed.getUTCDate() + 1));
}

const CANDIDATE_COLUMNS = Prisma.sql`
  balance."inventoryLotId"    AS "inventoryLotId",
  balance."stockLocationId"   AS "stockLocationId",
  balance."organizationId"    AS "organizationId",
  balance."branchId"          AS "branchId",
  batch."state"::text         AS "batchState",
  balance."disposition"::text AS "disposition",
  batch."expiresAt"           AS "expiresAt",
  lot."receivedAt"            AS "receivedAt",
  (balance."onHandUnits" - COALESCE((
    SELECT SUM(claim."reservedUnits") FROM "pharmacy_supplier_claims" claim
    WHERE claim."organizationId" = balance."organizationId"
      AND claim."branchId" = balance."branchId"
      AND claim."inventoryLotId" = balance."inventoryLotId"
      AND claim."status" = 'RESERVED'
  ), 0))                         AS "availableUnits",
  lot."unitsPerPack"          AS "unitsPerPack",
  balance."sealedPacks"       AS "sealedPacks",
  balance."looseUnits"        AS "looseUnits"`;

const CANDIDATE_JOINS = Prisma.sql`
  FROM "pharmacy_stock_balances" balance
  JOIN "pharmacy_inventory_lots" lot
    ON lot."id" = balance."inventoryLotId" AND lot."organizationId" = balance."organizationId"
  JOIN "pharmacy_manufacturing_batches" batch
    ON batch."id" = lot."manufacturingBatchId" AND batch."organizationId" = lot."organizationId"`;

/**
 * Every (lot, location, disposition) bucket holding stock of `medicineId` in
 * this branch, blocked ones INCLUDED.
 *
 * Blocked buckets are deliberately not filtered in SQL: INV-03 requires the
 * refusal to name its reason, and a query that never returns recalled stock
 * cannot report that recalled stock was why nothing could be sold.
 *
 * @param lock take a row lock on each candidate balance, in FEFO order, for the
 * remainder of the caller's transaction.
 */
async function loadCandidates(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  medicineId: string,
  lock: boolean
): Promise<CandidateRow[]> {
  const query = Prisma.sql`
    SELECT ${CANDIDATE_COLUMNS}
    ${CANDIDATE_JOINS}
    WHERE balance."organizationId" = ${scope.organizationId}
      AND balance."branchId" = ${scope.branchId}
      AND batch."medicineId" = ${medicineId}
      AND balance."onHandUnits" > 0
      AND (balance."onHandUnits" - COALESCE((
        SELECT SUM(claim."reservedUnits") FROM "pharmacy_supplier_claims" claim
        WHERE claim."organizationId" = balance."organizationId"
          AND claim."branchId" = balance."branchId"
          AND claim."inventoryLotId" = balance."inventoryLotId"
          AND claim."status" = 'RESERVED'
      ), 0)) > 0
    ORDER BY batch."expiresAt" ASC, lot."receivedAt" ASC NULLS FIRST,
             balance."inventoryLotId" ASC, balance."stockLocationId" ASC`;

  // The lock covers the projection rows only. The joined lot and batch rows are
  // read-only here, and locking a batch would serialize every other branch
  // holding the same batch.
  return db.$queryRaw<CandidateRow[]>(lock ? Prisma.sql`${query} FOR UPDATE OF balance` : query);
}

function toCandidate(row: CandidateRow): AllocationCandidate {
  return {
    inventoryLotId: row.inventoryLotId,
    stockLocationId: row.stockLocationId,
    organizationId: row.organizationId,
    branchId: row.branchId,
    batchState: row.batchState,
    disposition: row.disposition,
    expiresAt: row.expiresAt,
    receivedAt: row.receivedAt,
    availableUnits: Number(row.availableUnits),
  };
}

export type ReceiveLotInput = {
  manufacturingBatchId: string;
  packLevelId: string;
  stockLocationId: string;
  unitsPerPack: number;
  supplierName: string;
  supplierInvoiceRef: string;
  unitCostMinor: number;
  printedMrpMinor: number;
  receivedExpiresAt: Date;
  receivedExpiryPrecision: 'DAY' | 'MONTH';
  quantityUnits: number;
  idempotencyKey: string;
  /** Omit to book goods that have not arrived: the lot stays unreceived. */
  receivedAt?: Date;
};

/**
 * INV-01: create the receipt-specific lot and post its opening RECEIPT.
 *
 * Both writes belong to the caller's transaction. Omitting `receivedAt` books
 * the lot without a receipt movement — unreceived stock, which the ledger
 * trigger then refuses to move at all (INV-03).
 */
export async function receiveLot(db: ScopedDb, scope: LedgerScope, input: ReceiveLotInput) {
  const batch = await db.pharmacyManufacturingBatch.findFirst({
    where: { id: input.manufacturingBatchId, organizationId: scope.organizationId },
  });
  if (!batch) throw new PharmacyInventoryError('CROSS_TENANT_REFERENCE');

  const location = await db.pharmacyStockLocation.findFirst({
    where: { id: input.stockLocationId, organizationId: scope.organizationId },
  });
  if (!location) throw new PharmacyInventoryError('CROSS_TENANT_REFERENCE');
  if (location.branchId !== scope.branchId) {
    throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  }

  const receivedAt = input.receivedAt ?? null;
  const arrangement = arrangementFor(input.quantityUnits, input.unitsPerPack);

  const lot = await db.pharmacyInventoryLot.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      manufacturingBatchId: input.manufacturingBatchId,
      packLevelId: input.packLevelId,
      unitsPerPack: input.unitsPerPack,
      supplierName: input.supplierName,
      supplierInvoiceRef: input.supplierInvoiceRef,
      unitCostMinor: input.unitCostMinor,
      printedMrpMinor: input.printedMrpMinor,
      receivedExpiresAt: input.receivedExpiresAt,
      receivedExpiryPrecision: input.receivedExpiryPrecision,
      receivedAt,
    },
  });

  if (receivedAt === null) return { lot, movement: null };

  const movement = await db.pharmacyStockMovement.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: lot.id,
      stockLocationId: input.stockLocationId,
      kind: 'RECEIPT',
      disposition: 'AVAILABLE',
      quantityUnits: input.quantityUnits,
      sealedPackDelta: arrangement.sealedPacks,
      looseUnitDelta: arrangement.looseUnits,
      actorId: scope.actorId,
      idempotencyKey: input.idempotencyKey,
      occurredAt: receivedAt,
    },
  });
  return { lot, movement };
}

export type AllocateForSaleInput = {
  medicineId: string;
  requiredUnits: number;
  at: Date;
  idempotencyKeyPrefix: string;
  override?: { inventoryLotId: string; reason: string; approvalPolicy: string };
  /**
   * §8A invariant 6. When the branch cannot cover the quantity, allocate what
   * safely exists and record a PENDING discrepancy for the rest, instead of
   * driving a balance negative. Off by default: a normal sale refuses outright.
   */
  emergency?: { reason: string };
};

export type AllocateForSaleResult = {
  allocations: readonly Allocation[];
  recommendedLotId: string | null;
  blocked: ReadonlyArray<{ inventoryLotId: string; stockLocationId: string; reason: BlockReason }>;
  overrideId: string | null;
  discrepancyId: string | null;
  movementIds: string[];
};

/**
 * INV-02 + INV-03: allocate `requiredUnits` by FEFO and post the SALE movements.
 *
 * Must run inside the caller's transaction — the FOR UPDATE locks taken while
 * loading candidates only hold until that transaction ends.
 */
export async function allocateForSale(
  db: ScopedDb,
  scope: LedgerScope,
  input: AllocateForSaleInput
): Promise<AllocateForSaleResult> {
  const rows = await loadCandidates(db, scope, input.medicineId, true);
  const byBucket = new Map(
    rows.map((row) => [`${row.inventoryLotId}:${row.stockLocationId}`, row])
  );
  const candidates = rows.map(toCandidate);
  const allocationScope = {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    at: input.at,
  };

  let plan;
  try {
    plan = planAllocation({
      candidates,
      requiredUnits: input.requiredUnits,
      scope: allocationScope,
      select: input.override && {
        inventoryLotId: input.override.inventoryLotId,
        actorId: scope.actorId,
        reason: input.override.reason,
        approvalPolicy: input.override.approvalPolicy,
      },
    });
  } catch (error) {
    const shortOfStock =
      error instanceof PharmacyInventoryError && error.reason === 'INSUFFICIENT_STOCK';
    if (!shortOfStock || !input.emergency) throw error;
    return emergencyShortfall(db, scope, input, candidates, byBucket, input.emergency.reason);
  }

  let overrideId: string | null = null;
  if (plan.override) {
    const override = await db.pharmacyAllocationOverride.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        actorId: plan.override.actorId,
        reason: plan.override.reason,
        approvalPolicy: plan.override.approvalPolicy,
        recommendedLotId: plan.override.recommendedLotId,
        selectedLotId: plan.override.selectedLotId,
      },
    });
    overrideId = override.id;
  }

  return {
    allocations: plan.allocations,
    recommendedLotId: plan.recommendedLotId,
    blocked: plan.blocked,
    overrideId,
    discrepancyId: null,
    movementIds: await postSaleMovements(db, scope, input, plan.allocations, byBucket, overrideId),
  };
}

/**
 * §8A invariant 6: sell every safe unit the branch actually holds, then book the
 * unmet remainder as a pending discrepancy. No balance is ever driven negative,
 * and the shortfall is visible rather than hidden.
 */
async function emergencyShortfall(
  db: ScopedDb,
  scope: LedgerScope,
  input: AllocateForSaleInput,
  candidates: readonly AllocationCandidate[],
  byBucket: Map<string, CandidateRow>,
  reason: string
): Promise<AllocateForSaleResult> {
  const allocationScope = {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    at: input.at,
  };
  // Everything FEFO would have been allowed to take. Asking for exactly that
  // much reuses the one allocation planner instead of a second, divergent
  // "what is safe" rule.
  const safeUnits = candidates.reduce(
    (total, candidate) =>
      blockReasonFor(candidate, allocationScope) === null
        ? total + candidate.availableUnits
        : total,
    0
  );
  const plan =
    safeUnits > 0
      ? planAllocation({ candidates, requiredUnits: safeUnits, scope: allocationScope })
      : {
          allocations: [] as Allocation[],
          recommendedLotId: null,
          blocked: candidates.map((candidate) => ({
            inventoryLotId: candidate.inventoryLotId,
            stockLocationId: candidate.stockLocationId,
            reason: blockReasonFor(candidate, allocationScope) as BlockReason,
          })),
          override: null,
        };

  const allocatedUnits = plan.allocations.reduce((total, one) => total + one.units, 0);

  const discrepancy = await db.pharmacyStockDiscrepancy.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: plan.allocations[0]?.inventoryLotId ?? null,
      stockLocationId: plan.allocations[0]?.stockLocationId ?? null,
      requestedUnits: input.requiredUnits,
      allocatedUnits,
      shortfallUnits: input.requiredUnits - allocatedUnits,
      actorId: scope.actorId,
      reason,
    },
  });

  return {
    allocations: plan.allocations,
    recommendedLotId: plan.recommendedLotId,
    blocked: plan.blocked,
    overrideId: null,
    discrepancyId: discrepancy.id,
    movementIds: await postSaleMovements(db, scope, input, plan.allocations, byBucket, null),
  };
}

async function postSaleMovements(
  db: ScopedDb,
  scope: LedgerScope,
  input: AllocateForSaleInput,
  allocations: readonly Allocation[],
  byBucket: Map<string, CandidateRow>,
  overrideId: string | null
): Promise<string[]> {
  const movementIds: string[] = [];
  for (const [index, allocation] of allocations.entries()) {
    const row = byBucket.get(`${allocation.inventoryLotId}:${allocation.stockLocationId}`);
    if (!row) throw new PharmacyInventoryError('NOT_FOUND');

    // Draw loose units first, so a sale never silently breaks a sealed pack.
    // Breaking one is its own BREAK_PACK movement (INV-04); a sale that would
    // need to break a pack is refused rather than reinterpreting the shelf.
    const fromLoose = Math.min(row.looseUnits, allocation.units);
    const fromSealed = allocation.units - fromLoose;
    if (fromSealed % row.unitsPerPack !== 0) {
      throw new PharmacyInventoryError('INVALID_ARRANGEMENT');
    }

    const movement = await db.pharmacyStockMovement.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        inventoryLotId: allocation.inventoryLotId,
        stockLocationId: allocation.stockLocationId,
        kind: 'SALE',
        disposition: 'AVAILABLE',
        quantityUnits: -allocation.units,
        sealedPackDelta: -(fromSealed / row.unitsPerPack),
        looseUnitDelta: -fromLoose,
        actorId: scope.actorId,
        idempotencyKey: `${input.idempotencyKeyPrefix}:${index}`,
        allocationOverrideId: overrideId,
        occurredAt: input.at,
      },
    });
    movementIds.push(movement.id);
  }
  return movementIds;
}

export type BreakPackInput = {
  inventoryLotId: string;
  stockLocationId: string;
  requiredLooseUnits: number;
  idempotencyKey: string;
  at: Date;
};

/**
 * INV-04: break sealed packs until `requiredLooseUnits` loose units exist.
 *
 * The canonical total does not move — only the arrangement does — so the ledger
 * row carries `quantityUnits = 0` with a negative sealed delta and a positive
 * loose delta that reconcile through the lot's pack size (§8A invariant 17).
 */
export async function breakPack(db: ScopedDb, scope: LedgerScope, input: BreakPackInput) {
  const lot = await db.pharmacyInventoryLot.findFirst({
    where: {
      id: input.inventoryLotId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
  });
  if (!lot) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');

  const balance = await db.pharmacyStockBalance.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: input.inventoryLotId,
      stockLocationId: input.stockLocationId,
      disposition: 'AVAILABLE',
    },
  });
  if (!balance) throw new PharmacyInventoryError('NOT_FOUND');

  const plan = planBreakPack({
    sealedPacks: balance.sealedPacks,
    looseUnits: balance.looseUnits,
    unitsPerPack: lot.unitsPerPack,
    requiredLooseUnits: input.requiredLooseUnits,
  });
  if (plan.packsToBreak === 0) return { movement: null, ...plan };

  const movement = await db.pharmacyStockMovement.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: input.inventoryLotId,
      stockLocationId: input.stockLocationId,
      kind: 'BREAK_PACK',
      disposition: 'AVAILABLE',
      quantityUnits: 0,
      sealedPackDelta: plan.sealedPackDelta,
      looseUnitDelta: plan.looseUnitDelta,
      actorId: scope.actorId,
      idempotencyKey: input.idempotencyKey,
      occurredAt: input.at,
    },
  });
  return { movement, ...plan };
}

export type TransferInput = {
  inventoryLotId: string;
  fromStockLocationId: string;
  toStockLocationId: string;
  units: number;
  at: Date;
  idempotencyKeyPrefix: string;
};

/**
 * INV-03 on the transfer path: the hard blocks that stop a sale stop a transfer.
 *
 * The pair of movements leaves the units IN_TRANSIT at the receiving location,
 * so the same units are never AVAILABLE in two places at once.
 */
export async function transferStock(db: ScopedDb, scope: LedgerScope, input: TransferInput) {
  const rows = await db.$queryRaw<CandidateRow[]>(Prisma.sql`
    SELECT ${CANDIDATE_COLUMNS}
    ${CANDIDATE_JOINS}
    WHERE balance."organizationId" = ${scope.organizationId}
      AND balance."inventoryLotId" = ${input.inventoryLotId}
      AND balance."stockLocationId" = ${input.fromStockLocationId}
      AND balance."disposition" = 'AVAILABLE'
    FOR UPDATE OF balance`);

  const source = rows[0];
  if (!source) throw new PharmacyInventoryError('NOT_FOUND');

  const blockedBy = blockReasonFor(toCandidate(source), {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    at: input.at,
  });
  if (blockedBy !== null) throw new PharmacyInventoryError('BLOCKED_STOCK');
  if (Number(source.availableUnits) < input.units) {
    throw new PharmacyInventoryError('INSUFFICIENT_STOCK');
  }

  const arrangement = arrangementFor(input.units, source.unitsPerPack);
  if (arrangement.looseUnits > source.looseUnits) {
    throw new PharmacyInventoryError('INVALID_ARRANGEMENT');
  }

  const out = await db.pharmacyStockMovement.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: input.inventoryLotId,
      stockLocationId: input.fromStockLocationId,
      kind: 'TRANSFER_OUT',
      disposition: 'AVAILABLE',
      quantityUnits: -input.units,
      sealedPackDelta: -arrangement.sealedPacks,
      looseUnitDelta: -arrangement.looseUnits,
      actorId: scope.actorId,
      idempotencyKey: `${input.idempotencyKeyPrefix}:out`,
      occurredAt: input.at,
    },
  });
  const received = await db.pharmacyStockMovement.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: input.inventoryLotId,
      stockLocationId: input.toStockLocationId,
      kind: 'TRANSFER_IN',
      disposition: 'IN_TRANSIT',
      quantityUnits: input.units,
      sealedPackDelta: arrangement.sealedPacks,
      looseUnitDelta: arrangement.looseUnits,
      actorId: scope.actorId,
      idempotencyKey: `${input.idempotencyKeyPrefix}:in`,
      occurredAt: input.at,
    },
  });
  return { out, received };
}

/**
 * The branch's on-hand projection for one medicine, blocked buckets included.
 *
 * Every row is checked against INV-04 before it is returned: the trigger makes
 * a non-reconciling balance unreachable, so a row that fails here means the
 * projection has been corrupted out of band and a count that does not
 * reconcile must not be shown as if it did.
 */
export async function onHand(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  medicineId: string,
  at: Date
) {
  const rows = await loadCandidates(db, scope, medicineId, false);
  return rows.map((row) => {
    const bucket = {
      inventoryLotId: row.inventoryLotId,
      stockLocationId: row.stockLocationId,
      disposition: row.disposition,
      onHandUnits: Number(row.availableUnits),
      sealedPacks: Number(row.sealedPacks),
      looseUnits: Number(row.looseUnits),
      unitsPerPack: row.unitsPerPack,
    };
    assertArrangementReconciles(bucket);
    return {
      ...bucket,
      blockedBy: blockReasonFor(toCandidate(row), {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        at,
      }),
    };
  });
}
