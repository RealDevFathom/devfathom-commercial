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
  assertColdChainStorage,
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
 * through its day. Printed pharmacy dates are Pakistan-local calendar dates,
 * so their exclusive boundary is midnight in Asia/Karachi (UTC+05:00), not
 * midnight UTC. Pakistan does not observe daylight saving time. Storing the
 * exclusive instant is what lets INV-03 decide expiry with one comparison and
 * never sell into an expiry period.
 */
export function expiryInstant(printed: Date, precision: 'DAY' | 'MONTH'): Date {
  return precision === 'MONTH'
    ? new Date(Date.UTC(printed.getUTCFullYear(), printed.getUTCMonth() + 1, 1, -5))
    : new Date(
        Date.UTC(printed.getUTCFullYear(), printed.getUTCMonth(), printed.getUTCDate() + 1, -5)
      );
}

/**
 * Normalise an already-exclusive expiry boundary, not a printed date. Before
 * PR #84 these were stored at UTC midnight; shift only that legacy boundary.
 * PKT boundaries (19:00 UTC) and other instants must not move on repeated reads.
 * Keep this predicate in sync with the PKT backfill migration.
 */
export function normalizeExpiryBoundary(expiresAt: Date): Date {
  return expiresAt.getTime() % (24 * 60 * 60 * 1000) === 0
    ? new Date(expiresAt.getTime() - 5 * 60 * 60 * 1000)
    : expiresAt;
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
  ), 0) - COALESCE((
    SELECT SUM(reservation."reservedUnits") FROM "pharmacy_restock_reservations" reservation
    WHERE reservation."organizationId" = balance."organizationId"
      AND reservation."branchId" = balance."branchId"
      AND reservation."inventoryLotId" = balance."inventoryLotId"
      AND reservation."stockLocationId" = balance."stockLocationId"
      AND reservation."status" = 'RESERVED'
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
      ), 0) - COALESCE((
        SELECT SUM(reservation."reservedUnits") FROM "pharmacy_restock_reservations" reservation
        WHERE reservation."organizationId" = balance."organizationId"
          AND reservation."branchId" = balance."branchId"
          AND reservation."inventoryLotId" = balance."inventoryLotId"
          AND reservation."stockLocationId" = balance."stockLocationId"
          AND reservation."status" = 'RESERVED'
      ), 0)) > 0
    ORDER BY batch."expiresAt" ASC, lot."receivedAt" ASC NULLS FIRST,
             balance."inventoryLotId" ASC, balance."stockLocationId" ASC`;

  // The lock covers the projection rows only. The joined lot and batch rows are
  // read-only here, and locking a batch would serialize every other branch
  // holding the same batch.
  if (!lock) return db.$queryRaw<CandidateRow[]>(query);
  // Lock first, then read availability in a SEPARATE statement. Under READ
  // COMMITTED a locking SELECT that waits keeps its original statement
  // snapshot for the claim/reservation subqueries, so a supplier claim that
  // committed while we waited would be invisible and its units sellable.
  // The second statement takes a fresh snapshot after every lock is held.
  await db.$queryRaw`
    SELECT balance."inventoryLotId"
    ${CANDIDATE_JOINS}
    WHERE balance."organizationId" = ${scope.organizationId}
      AND balance."branchId" = ${scope.branchId}
      AND batch."medicineId" = ${medicineId}
      AND balance."onHandUnits" > 0
    ORDER BY batch."expiresAt" ASC, lot."receivedAt" ASC NULLS FIRST,
             balance."inventoryLotId" ASC, balance."stockLocationId" ASC
    FOR UPDATE OF balance`;
  return db.$queryRaw<CandidateRow[]>(query);
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

/** Read-only ledger evidence, net of supplier claims and customer restock reservations. */
export async function loadStockCandidatesForRead(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  medicineId: string
): Promise<AllocationCandidate[]> {
  return (await loadCandidates(db, scope, medicineId, false)).map(toCandidate);
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
  /**
   * Canonical units accepted onto the shelf. Zero posts no AVAILABLE movement
   * at all, which is what a wholly rejected delivery looks like.
   */
  quantityUnits: number;
  idempotencyKey: string;
  /** Omit to book goods that have not arrived: the lot stays unreceived. */
  receivedAt?: Date;
  /**
   * PUR-04: units refused at the door. They belong to this same lot — same
   * batch, same invoice, same landed cost — but are posted to a quarantine or
   * returns location and never to AVAILABLE, so rejected goods can never be
   * sold while the exception they raised is still open.
   */
  quarantine?: {
    units: number;
    stockLocationId: string;
    idempotencyKey: string;
    reason: string;
  };
};

/**
 * INV-01: create the receipt-specific lot and post its opening RECEIPT.
 *
 * Both writes belong to the caller's transaction. Omitting `receivedAt` books
 * the lot without a receipt movement — unreceived stock, which the ledger
 * trigger then refuses to move at all (INV-03).
 *
 * A delivery that was partly refused posts two RECEIPT movements against the
 * one lot: the accepted units to AVAILABLE and the rejected units to
 * QUARANTINE. They are separate buckets of the same lot (§8A invariant 18 —
 * quarantine can apply to part of one inventory lot), so the rejected units are
 * visible, counted and unsellable rather than absent from the books.
 */
export async function receiveLot(db: ScopedDb, scope: LedgerScope, input: ReceiveLotInput) {
  const batch = await db.pharmacyManufacturingBatch.findFirst({
    where: { id: input.manufacturingBatchId, organizationId: scope.organizationId },
    include: { medicine: { select: { coldChain: true } } },
  });
  if (!batch) throw new PharmacyInventoryError('CROSS_TENANT_REFERENCE');

  const receivingLocation = await assertLocationInBranch(db, scope, input.stockLocationId);
  assertColdChainStorage(batch.medicine.coldChain, receivingLocation.coldChain);
  if (input.quarantine) {
    if (!Number.isSafeInteger(input.quarantine.units) || input.quarantine.units <= 0) {
      throw new PharmacyInventoryError('INVALID_QUANTITY');
    }
    await assertLocationInBranch(db, scope, input.quarantine.stockLocationId);
  }
  if (!Number.isSafeInteger(input.quantityUnits) || input.quantityUnits < 0) {
    throw new PharmacyInventoryError('INVALID_QUANTITY');
  }
  if (input.quantityUnits === 0 && !input.quarantine) {
    throw new PharmacyInventoryError('INVALID_QUANTITY');
  }

  const receivedAt = input.receivedAt ?? null;

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

  if (receivedAt === null) return { lot, movement: null, quarantineMovement: null };

  const movement =
    input.quantityUnits > 0
      ? await postReceipt(db, scope, {
          inventoryLotId: lot.id,
          stockLocationId: input.stockLocationId,
          disposition: 'AVAILABLE',
          units: input.quantityUnits,
          unitsPerPack: input.unitsPerPack,
          idempotencyKey: input.idempotencyKey,
          occurredAt: receivedAt,
        })
      : null;

  const quarantineMovement = input.quarantine
    ? await postReceipt(db, scope, {
        inventoryLotId: lot.id,
        stockLocationId: input.quarantine.stockLocationId,
        disposition: 'QUARANTINE',
        units: input.quarantine.units,
        unitsPerPack: input.unitsPerPack,
        idempotencyKey: input.quarantine.idempotencyKey,
        occurredAt: receivedAt,
        reason: input.quarantine.reason,
      })
    : null;

  return { lot, movement, quarantineMovement };
}

async function assertLocationInBranch(db: ScopedDb, scope: LedgerScope, stockLocationId: string) {
  const location = await db.pharmacyStockLocation.findFirst({
    where: { id: stockLocationId, organizationId: scope.organizationId },
  });
  if (!location) throw new PharmacyInventoryError('CROSS_TENANT_REFERENCE');
  if (location.branchId !== scope.branchId) {
    throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  }
  return location;
}

async function postReceipt(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    inventoryLotId: string;
    stockLocationId: string;
    disposition: 'AVAILABLE' | 'QUARANTINE';
    units: number;
    unitsPerPack: number;
    idempotencyKey: string;
    occurredAt: Date;
    reason?: string;
  }
) {
  const arrangement = arrangementFor(input.units, input.unitsPerPack);
  return db.pharmacyStockMovement.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: input.inventoryLotId,
      stockLocationId: input.stockLocationId,
      kind: 'RECEIPT',
      disposition: input.disposition,
      quantityUnits: input.units,
      sealedPackDelta: arrangement.sealedPacks,
      looseUnitDelta: arrangement.looseUnits,
      actorId: scope.actorId,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      occurredAt: input.occurredAt,
    },
  });
}

export type ReverseMovementsInput = {
  /** Movements to compensate, in the order the reversals should be posted. */
  movementIds: readonly string[];
  reason: string;
  at: Date;
};

/**
 * PUR-04 / §8A invariant 8: undo a posting by adding its negation, never by
 * editing it.
 *
 * Each reversal is an ADJUSTMENT that names the movement it cancels, lands in
 * the same lot, location and disposition, and carries the exact opposite
 * quantity and arrangement. The migration's trigger re-checks all of that, and
 * the balance's non-negative CHECK is what stops a receipt being reversed after
 * its stock has already been sold — the reversal fails rather than pushing the
 * shelf below zero (§8A invariant 6).
 */
export async function reverseMovements(
  db: ScopedDb,
  scope: LedgerScope,
  input: ReverseMovementsInput
) {
  const reversals = [];
  for (const movementId of input.movementIds) {
    const original = await db.pharmacyStockMovement.findFirst({
      where: {
        id: movementId,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
      },
    });
    if (!original) throw new PharmacyInventoryError('NOT_FOUND');

    reversals.push(
      await db.pharmacyStockMovement.create({
        data: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          inventoryLotId: original.inventoryLotId,
          stockLocationId: original.stockLocationId,
          kind: 'ADJUSTMENT',
          disposition: original.disposition,
          quantityUnits: -original.quantityUnits,
          sealedPackDelta: -original.sealedPackDelta,
          looseUnitDelta: -original.looseUnitDelta,
          actorId: scope.actorId,
          reason: input.reason,
          idempotencyKey: `${original.idempotencyKey}:reversal`,
          reversesMovementId: original.id,
          occurredAt: input.at,
        },
      })
    );
  }
  return reversals;
}

export type AllocateForSaleInput = {
  medicineId: string;
  requiredUnits: number;
  at: Date;
  idempotencyKeyPrefix: string;
  /** A scanned shelf label must allocate exclusively from this lot. */
  labelLotId?: string;
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
    // Plans debit AVAILABLE only; blocked dispositions remain candidates for refusal evidence.
    rows
      .filter((row) => row.disposition === 'AVAILABLE')
      .map((row) => [`${row.inventoryLotId}:${row.stockLocationId}`, row])
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
    const blockReasons = candidates.map((candidate) => blockReasonFor(candidate, allocationScope));
    if (
      shortOfStock &&
      blockReasons.every((reason) => reason !== null) &&
      blockReasons.some((reason) => reason === 'RECALLED' || reason === 'QUARANTINED')
    ) {
      throw new PharmacyInventoryError('BLOCKED_STOCK');
    }
    if (!shortOfStock || !input.emergency || input.labelLotId) throw error;
    return emergencyShortfall(db, scope, input, candidates, byBucket, input.emergency.reason);
  }

  if (input.labelLotId) {
    if (
      (input.override && input.override.inventoryLotId !== input.labelLotId) ||
      (!input.override && plan.recommendedLotId !== input.labelLotId)
    ) {
      throw new PharmacyInventoryError('OVERRIDE_EVIDENCE_MISSING');
    }
    if (plan.allocations.some((part) => part.inventoryLotId !== input.labelLotId)) {
      throw new PharmacyInventoryError('INSUFFICIENT_STOCK');
    }
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

/** Internal, already locked customer-order reservation plan; never public counter input. */
export type ReservedSaleAllocation = {
  allocations: readonly Allocation[];
  expiresAt: Date;
};

export async function allocateReservedForSale(
  db: ScopedDb,
  scope: LedgerScope,
  input: AllocateForSaleInput,
  packLevelId: string,
  reservation: ReservedSaleAllocation
): Promise<AllocateForSaleResult> {
  // Aggregate identical buckets, never distinct locations of the same lot.
  const buckets = new Map<string, Allocation>();
  for (const part of reservation.allocations) {
    if (!Number.isSafeInteger(part.units) || part.units <= 0) {
      throw new PharmacyInventoryError('INVALID_QUANTITY');
    }
    const key = `${part.inventoryLotId}:${part.stockLocationId}`;
    const prior = buckets.get(key);
    buckets.set(key, { ...part, units: part.units + (prior?.units ?? 0) });
  }
  const allocations = [...buckets.values()];
  if (
    !allocations.length ||
    input.override ||
    input.emergency ||
    allocations.reduce((sum, part) => sum + part.units, 0) !== input.requiredUnits
  ) {
    throw new PharmacyInventoryError('INSUFFICIENT_STOCK');
  }
  const query = Prisma.sql`
    /* reserved_sale_buckets */
    SELECT ${CANDIDATE_COLUMNS}
    ${CANDIDATE_JOINS}
    JOIN "pharmacy_medicines" medicine
      ON medicine.id = batch."medicineId" AND medicine."organizationId" = batch."organizationId"
    WHERE balance."organizationId" = ${scope.organizationId}
      AND balance."branchId" = ${scope.branchId} AND lot."branchId" = ${scope.branchId}
      AND batch."medicineId" = ${input.medicineId} AND lot."packLevelId" = ${packLevelId}
      AND medicine.saleable AND medicine.otc AND NOT medicine.rx
      AND NOT medicine.restricted AND NOT medicine.controlled
      AND balance.disposition = 'AVAILABLE'
      AND (${Prisma.join(
        allocations.map(
          (part) => Prisma.sql`
        (balance."inventoryLotId" = ${part.inventoryLotId} AND balance."stockLocationId" = ${part.stockLocationId})
      `
        ),
        ' OR '
      )})
    ORDER BY batch.id, lot.id, balance."stockLocationId"
  `;
  await db.$queryRaw(Prisma.sql`${query} FOR UPDATE OF batch, medicine, lot, balance`);
  const rows = await db.$queryRaw<CandidateRow[]>(query);
  const byBucket = new Map(
    rows.map((row) => [`${row.inventoryLotId}:${row.stockLocationId}`, row])
  );
  const at = new Date();
  if (reservation.expiresAt.getTime() <= at.getTime()) {
    throw new PharmacyInventoryError('BLOCKED_STOCK');
  }
  for (const part of allocations) {
    const row = byBucket.get(`${part.inventoryLotId}:${part.stockLocationId}`);
    if (
      !row ||
      blockReasonFor(toCandidate(row), { ...scope, at }) ||
      Number(row.availableUnits) < part.units
    ) {
      throw new PharmacyInventoryError('BLOCKED_STOCK');
    }
  }
  return {
    allocations,
    recommendedLotId: null,
    blocked: [],
    overrideId: null,
    discrepancyId: null,
    movementIds: await postSaleMovements(db, scope, { ...input, at }, allocations, byBucket, null),
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

    // Maximize loose depletion subject to the remainder being whole sealed packs.
    // Partial dispensing still requires explicit BREAK_PACK; never open one here.
    const remainder = allocation.units % row.unitsPerPack;
    const maxLoose = Math.min(row.looseUnits, allocation.units);
    if (maxLoose < remainder) throw new PharmacyInventoryError('INVALID_ARRANGEMENT');
    const fromLoose =
      remainder + Math.floor((maxLoose - remainder) / row.unitsPerPack) * row.unitsPerPack;
    const fromSealed = allocation.units - fromLoose;
    if (
      !Number.isInteger(fromLoose) ||
      fromLoose < 0 ||
      !Number.isInteger(fromSealed / row.unitsPerPack) ||
      fromSealed < 0 ||
      fromSealed / row.unitsPerPack > row.sealedPacks
    ) {
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
