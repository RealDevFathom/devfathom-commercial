/**
 * PH-INV / INV-01..04 — the pure inventory kernel.
 *
 * Everything here is total, synchronous and database-free: canonical-unit
 * arrangement arithmetic (INV-04), the hard-block predicate (INV-03) and FEFO
 * selection with override evidence (INV-02). `stock-ledger.ts` is the only
 * caller that touches PostgreSQL; keeping the decisions here is what lets the
 * property and negative-path suites enumerate them exhaustively.
 *
 * FAIL CLOSED. `blockReasonFor` returns a reason for anything it cannot prove
 * safe — an unreceived lot, a non-AVAILABLE disposition, a batch state it does
 * not recognise, a lot outside the caller's tenant or branch. A lot is sellable
 * only when every hard block is positively cleared (§8A invariant 4).
 *
 * INTEGER UNITS ONLY (§8A invariant 1). Every quantity crossing this module is
 * a safe integer count of canonical base units. A non-integer, negative or
 * unsafe value is a programming error and raises rather than rounding.
 */

import { compareKnownExpiryFirst, hasKnownExpiryPassed } from './unrecorded-batch';

export class PharmacyInventoryError extends Error {
  constructor(
    readonly reason:
      | 'INVALID_QUANTITY'
      | 'INVALID_ARRANGEMENT'
      | 'INSUFFICIENT_STOCK'
      | 'BLOCKED_STOCK'
      | 'LABEL_LOT_MISMATCH'
      | 'OVERRIDE_EVIDENCE_MISSING'
      | 'NOT_FOUND'
      | 'CROSS_TENANT_REFERENCE'
      | 'CROSS_BRANCH_REFERENCE'
      | 'INVALID_UNITS'
      | 'INVALID_STATE'
      | 'COAUTH_REQUIRED'
      | 'COLD_CHAIN_STORAGE_REQUIRED'
      | 'VARIANCE_REASON_REQUIRED'
      | 'UNSALEABLE_DESTINATION'
      | 'IDEMPOTENCY_CONFLICT'
      /** DEV-957: the units are set aside for an offline counter; `userMessage` names it. */
      | 'HELD_FOR_COUNTER'
      /** DEV-1052: the caller may not release these quarantined units; `userMessage` says why. */
      | 'QUARANTINE_RELEASE_REFUSED',
    /** A plain sentence for the person, when the reason alone does not say enough. */
    readonly userMessage?: string
  ) {
    super(reason);
  }
}

/** INV-05 put-away gate: cold-chain stock needs positively validated storage. */
export function assertColdChainStorage(
  medicineRequiresColdChain: boolean,
  locationIsValidated: boolean
): void {
  if (medicineRequiresColdChain && !locationIsValidated) {
    throw new PharmacyInventoryError('COLD_CHAIN_STORAGE_REQUIRED');
  }
}

/** Batch-scope state (§8A invariant 18: recall applies globally at batch scope). */
export type BatchState = 'ACTIVE' | 'RECALLED' | 'QUARANTINED';

/** Lot/location-scope state; quarantine and damage can apply to part of one lot. */
export type StockDisposition =
  | 'AVAILABLE'
  | 'QUARANTINE'
  | 'DAMAGED'
  | 'DESTROYED'
  | 'IN_TRANSIT'
  /** PUR-06: dispatched back to the supplier on a return or expiry claim. */
  | 'RETURN_TO_SUPPLIER';

/** Why a candidate may not be sold or transferred (INV-03). */
export type BlockReason =
  | 'EXPIRED'
  | 'RECALLED'
  | 'QUARANTINED'
  | 'DAMAGED'
  | 'DESTROYED'
  | 'IN_TRANSIT'
  | 'RETURNED_TO_SUPPLIER'
  | 'UNRECEIVED'
  | 'UNAUTHORIZED'
  | 'EMPTY';

export type AllocationCandidate = {
  inventoryLotId: string;
  stockLocationId: string;
  organizationId: string;
  branchId: string;
  batchState: BatchState;
  disposition: StockDisposition;
  /**
   * The instant at which the batch becomes expired. Receiving normalises a
   * MONTH-precision printed expiry to the first instant after that month, so
   * comparing `at >= expiresAt` never sells a lot into its expiry period.
   *
   * DEV-853: `null` when the expiry was never recorded (legacy opening stock).
   * An unknown expiry is never treated as expired, never blocks a sale, and
   * sorts after every known expiry in FEFO order.
   */
  expiresAt: Date | null;
  /** `null` until the goods are actually received; unreceived stock is blocked. */
  receivedAt: Date | null;
  availableUnits: number;
};

export type AllocationScope = {
  organizationId: string;
  branchId: string;
  at: Date;
};

export type Allocation = {
  inventoryLotId: string;
  stockLocationId: string;
  units: number;
};

export type OverrideEvidence = {
  actorId: string;
  reason: string;
  approvalPolicy: string;
  recommendedLotId: string;
  selectedLotId: string;
};

export type AllocationPlan = {
  allocations: Allocation[];
  /** The lot FEFO would have chosen first; `null` when nothing is safe. */
  recommendedLotId: string | null;
  blocked: ReadonlyArray<{ inventoryLotId: string; stockLocationId: string; reason: BlockReason }>;
  override: OverrideEvidence | null;
};

function assertUnitCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PharmacyInventoryError('INVALID_QUANTITY');
  }
}

function assertPackSize(unitsPerPack: number): void {
  if (!Number.isSafeInteger(unitsPerPack) || unitsPerPack <= 0) {
    throw new PharmacyInventoryError('INVALID_ARRANGEMENT');
  }
}

// ── INV-04: sealed/open arrangement ──────────────────────────────────────────

/**
 * The physical arrangement holding `units` canonical units without breaking any
 * pack that need not be broken: 57 tablets at 10 per strip is 5 sealed strips
 * and 7 loose (§8A invariant 17).
 */
export function arrangementFor(
  units: number,
  unitsPerPack: number
): { sealedPacks: number; looseUnits: number } {
  assertUnitCount(units);
  assertPackSize(unitsPerPack);
  return {
    sealedPacks: Math.floor(units / unitsPerPack),
    looseUnits: units % unitsPerPack,
  };
}

/** The canonical-unit total a sealed/open arrangement represents. */
export function unitsForArrangement(
  sealedPacks: number,
  looseUnits: number,
  unitsPerPack: number
): number {
  assertUnitCount(sealedPacks);
  assertUnitCount(looseUnits);
  assertPackSize(unitsPerPack);
  const total = sealedPacks * unitsPerPack + looseUnits;
  if (!Number.isSafeInteger(total)) throw new PharmacyInventoryError('INVALID_ARRANGEMENT');
  return total;
}

/**
 * INV-04 acceptance: a count reconciles only when the total AND the physical
 * arrangement agree.
 *
 * NOT a normalisation check. A shelf holding a freshly broken strip really does
 * carry a full pack's worth of loose units (5 sealed + 10 loose at 10 per
 * strip), and rejecting that would reject a legitimate physical state. Only
 * `arrangementFor` produces normalised arrangements, and only it promises to.
 */
export function assertArrangementReconciles(input: {
  onHandUnits: number;
  sealedPacks: number;
  looseUnits: number;
  unitsPerPack: number;
}): void {
  const { onHandUnits, sealedPacks, looseUnits, unitsPerPack } = input;
  assertUnitCount(onHandUnits);
  if (unitsForArrangement(sealedPacks, looseUnits, unitsPerPack) !== onHandUnits) {
    throw new PharmacyInventoryError('INVALID_ARRANGEMENT');
  }
}

/**
 * The BREAK_PACK movement that exposes `requiredLooseUnits` loose units.
 *
 * The canonical total never changes (`quantityUnits` is 0); only the
 * arrangement does, which is exactly what makes breaking a pack an explicit
 * movement rather than an invisible reinterpretation of the same stock.
 */
export function planBreakPack(input: {
  sealedPacks: number;
  looseUnits: number;
  unitsPerPack: number;
  requiredLooseUnits: number;
}): { packsToBreak: number; sealedPackDelta: number; looseUnitDelta: number } {
  const { sealedPacks, looseUnits, unitsPerPack, requiredLooseUnits } = input;
  assertUnitCount(sealedPacks);
  assertUnitCount(looseUnits);
  assertUnitCount(requiredLooseUnits);
  assertPackSize(unitsPerPack);

  const shortfall = requiredLooseUnits - looseUnits;
  const packsToBreak = shortfall <= 0 ? 0 : Math.ceil(shortfall / unitsPerPack);
  if (packsToBreak > sealedPacks) throw new PharmacyInventoryError('INSUFFICIENT_STOCK');

  return {
    // `-0` is a valid Number but not a valid delta: normalise it so a no-op
    // plan compares equal to a plain zero everywhere downstream.
    packsToBreak,
    sealedPackDelta: packsToBreak === 0 ? 0 : -packsToBreak,
    looseUnitDelta: packsToBreak * unitsPerPack,
  };
}

// ── INV-03: hard blocks ──────────────────────────────────────────────────────

/**
 * The single reason `candidate` cannot be sold or transferred, or `null` when
 * it is safe. Ordered most-severe first so the caller records the reason an
 * operator must act on rather than an incidental one.
 */
export function blockReasonFor(
  candidate: AllocationCandidate,
  scope: AllocationScope
): BlockReason | null {
  if (candidate.organizationId !== scope.organizationId || candidate.branchId !== scope.branchId) {
    return 'UNAUTHORIZED';
  }
  if (candidate.batchState === 'RECALLED') return 'RECALLED';
  if (candidate.batchState === 'QUARANTINED') return 'QUARANTINED';
  if (candidate.batchState !== 'ACTIVE') return 'UNAUTHORIZED';
  if (candidate.disposition === 'QUARANTINE') return 'QUARANTINED';
  if (candidate.disposition === 'DAMAGED') return 'DAMAGED';
  if (candidate.disposition === 'DESTROYED') return 'DESTROYED';
  if (candidate.disposition === 'IN_TRANSIT') return 'IN_TRANSIT';
  if (candidate.disposition === 'RETURN_TO_SUPPLIER') return 'RETURNED_TO_SUPPLIER';
  if (candidate.disposition !== 'AVAILABLE') return 'UNAUTHORIZED';
  if (candidate.receivedAt === null || candidate.receivedAt.getTime() > scope.at.getTime()) {
    return 'UNRECEIVED';
  }
  if (hasKnownExpiryPassed(candidate.expiresAt, scope.at)) return 'EXPIRED';
  if (!Number.isSafeInteger(candidate.availableUnits) || candidate.availableUnits <= 0) {
    return 'EMPTY';
  }
  return null;
}

// ── INV-02: FEFO ─────────────────────────────────────────────────────────────

/**
 * FEFO order: earliest safe expiry first (DEV-853: a lot whose expiry was
 * never recorded comes after every lot with a known expiry), then the oldest receipt, then the lot
 * and location identifiers. The last two keys exist so two lots sharing an
 * expiry always allocate in the same order — an unordered tiebreak makes the
 * "recommended batch" recorded on an override non-reproducible.
 */
function byFefo(a: AllocationCandidate, b: AllocationCandidate): number {
  return (
    compareKnownExpiryFirst(a.expiresAt, b.expiresAt) ||
    (a.receivedAt?.getTime() ?? 0) - (b.receivedAt?.getTime() ?? 0) ||
    a.inventoryLotId.localeCompare(b.inventoryLotId) ||
    a.stockLocationId.localeCompare(b.stockLocationId)
  );
}

/**
 * Plan an allocation of exactly `requiredUnits` canonical units (§8A invariant
 * 3: allocations total the quantity sold, or nothing is allocated at all).
 *
 * Without `select`, stock is drawn in FEFO order. With `select`, the named lot
 * is drawn first and the remainder still follows FEFO; the returned plan then
 * carries the override evidence — actor, reason, approval policy, and the
 * recommended lot the operator passed over (§8A invariant 5).
 *
 * An override never unblocks stock. A selected lot that fails `blockReasonFor`
 * raises `BLOCKED_STOCK`: the hard blocks in INV-03 are not overridable.
 */
export function planAllocation(input: {
  candidates: readonly AllocationCandidate[];
  requiredUnits: number;
  scope: AllocationScope;
  select?: {
    inventoryLotId: string;
    actorId: string;
    reason: string;
    approvalPolicy: string;
  };
}): AllocationPlan {
  const { candidates, requiredUnits, scope, select } = input;
  if (!Number.isSafeInteger(requiredUnits) || requiredUnits <= 0) {
    throw new PharmacyInventoryError('INVALID_QUANTITY');
  }

  const blocked: Array<{
    inventoryLotId: string;
    stockLocationId: string;
    reason: BlockReason;
  }> = [];
  const safe: AllocationCandidate[] = [];
  for (const candidate of candidates) {
    const reason = blockReasonFor(candidate, scope);
    if (reason === null) safe.push(candidate);
    else
      blocked.push({
        inventoryLotId: candidate.inventoryLotId,
        stockLocationId: candidate.stockLocationId,
        reason,
      });
  }
  safe.sort(byFefo);

  const recommendedLotId = safe[0]?.inventoryLotId ?? null;

  let order = safe;
  let override: OverrideEvidence | null = null;
  if (select) {
    const selected = safe.filter((c) => c.inventoryLotId === select.inventoryLotId);
    if (selected.length === 0) {
      // Either the lot is not a candidate at all, or it is blocked. Both are a
      // refusal, never a silent fallback to FEFO.
      throw new PharmacyInventoryError(
        candidates.some((c) => c.inventoryLotId === select.inventoryLotId)
          ? 'BLOCKED_STOCK'
          : 'NOT_FOUND'
      );
    }
    if (
      select.actorId.trim() === '' ||
      select.reason.trim() === '' ||
      select.approvalPolicy.trim() === ''
    ) {
      throw new PharmacyInventoryError('OVERRIDE_EVIDENCE_MISSING');
    }
    order = [...selected, ...safe.filter((c) => c.inventoryLotId !== select.inventoryLotId)];
    if (select.inventoryLotId !== recommendedLotId) {
      override = {
        actorId: select.actorId,
        reason: select.reason,
        approvalPolicy: select.approvalPolicy,
        recommendedLotId: recommendedLotId as string,
        selectedLotId: select.inventoryLotId,
      };
    }
  }

  const allocations: Allocation[] = [];
  let outstanding = requiredUnits;
  for (const candidate of order) {
    if (outstanding === 0) break;
    const units = Math.min(outstanding, candidate.availableUnits);
    allocations.push({
      inventoryLotId: candidate.inventoryLotId,
      stockLocationId: candidate.stockLocationId,
      units,
    });
    outstanding -= units;
  }
  if (outstanding > 0) throw new PharmacyInventoryError('INSUFFICIENT_STOCK');

  return { allocations, recommendedLotId, blocked, override };
}
