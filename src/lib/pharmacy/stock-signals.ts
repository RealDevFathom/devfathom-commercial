/**
 * PUR-07 — the deterministic stock action centre evaluator (PRD §6.3 PUR-07;
 * §8A invariant 29).
 *
 * DETERMINISTIC MEANS DETERMINISTIC. Every signal below is a comparison between
 * exact ledger facts, an *approved* safety-stock number, and open PO/transfer
 * quantities. There is no demand velocity, no seasonality, no lead-time model
 * and no smoothing anywhere in this file — PUR-09 forecasting is P1 and is
 * deliberately absent. The same facts and the same instant always produce the
 * same signals in the same order.
 *
 * NO APPROVED THRESHOLD, NO SIGNAL. A stock-level signal is measured against an
 * approved `SafetyStockFact`. When a product has none, the evaluator raises
 * nothing for it rather than defaulting to a threshold nobody approved — a
 * guessed number would make the explanation a fiction.
 *
 * WHAT THIS FILE CANNOT DO. It returns plain data. It has no database handle and
 * no way to create an order, a requisition or a stock movement, which is the
 * structural half of §8A invariant 29; the behavioural half lives in
 * `stock-signals-operations.createDraftAction`, which may only create DRAFT
 * documents.
 */

export class PharmacyStockSignalError extends Error {
  constructor(readonly reason: 'INVALID_UNITS' | 'INVALID_POLICY' | 'NOT_FOUND' | 'INVALID_STATE') {
    super(reason);
  }
}

export type StockSignalKind =
  | 'LOW_STOCK'
  | 'STOCKOUT'
  | 'PROJECTED_STOCKOUT'
  | 'INBOUND_COVERAGE'
  | 'NEAR_EXPIRY'
  | 'RETURN_WINDOW'
  | 'RECALL'
  | 'QUARANTINE'
  | 'COLD_CHAIN'
  | 'COUNT_VARIANCE';

export type StockSignalConfidence = 'EXACT' | 'PARTIAL';

export type StockSignalStatus =
  'OPEN' | 'ACKNOWLEDGED' | 'SNOOZED' | 'DISMISSED' | 'CLOSED' | 'STALE';

const DAY_MS = 86_400_000;

/** One (lot, location, disposition) bucket, exactly as the ledger projects it. */
export type LotFact = {
  inventoryLotId: string;
  medicineId: string;
  stockLocationId: string;
  /**
   * The batch's printed expiry, normalised to the instant it becomes expired.
   * DEV-853: null when it was never recorded; such a lot is never expired.
   */
  expiresAt: Date | null;
  receivedAt: Date | null;
  disposition:
    'AVAILABLE' | 'QUARANTINE' | 'DAMAGED' | 'DESTROYED' | 'IN_TRANSIT' | 'RETURN_TO_SUPPLIER';
  batchState: 'ACTIVE' | 'RECALLED' | 'QUARANTINED';
  onHandUnits: number;
  /** Units held by RESERVED INV-09 supplier claims against this lot. */
  reservedUnits: number;
  /** The deadline on an open supplier claim, when the lot has one. */
  returnWindowEndsAt: Date | null;
  medicineColdChain: boolean;
  locationColdChain: boolean;
  /** An OPEN recall notice covering this lot's batch or medicine. */
  recallReference: string | null;
  /**
   * True when an unapproved count or an unresolved discrepancy touches this lot.
   * The on-hand number is then still in dispute, which is the only thing that
   * lowers a signal's confidence.
   */
  unsettled: boolean;
};

/** An approved replenishment threshold. Absent means no stock-level signal. */
export type SafetyStockFact = {
  medicineId: string;
  safetyStockUnits: number;
  /** Deterministic expiry-depletion horizon in days. Not a forecast horizon. */
  coverageDays: number;
  approvedAt: Date;
};

/** Approved, not-yet-received quantity heading for this branch. */
export type InboundFact = {
  medicineId: string;
  units: number;
  source: 'PURCHASE_ORDER' | 'TRANSFER';
  reference: string;
};

export type CountVarianceFact = {
  inventoryLotId: string;
  medicineId: string;
  stockLocationId: string;
  varianceUnits: number;
  varianceThreshold: number;
  observedAt: Date;
};

export type SignalPolicy = {
  nearExpiryDays: number;
  returnWindowDays: number;
  /** How long a computed signal stays trustworthy, in seconds. */
  freshnessSeconds: number;
  /** How far back the evaluator read the ledger, in days. */
  dataWindowDays: number;
  /** Acknowledgement SLA per kind, in hours. */
  slaHoursByKind: Readonly<Record<StockSignalKind, number>>;
  /** The role/user accountable for each kind — the role dashboard's spine. */
  ownerByKind: Readonly<Record<StockSignalKind, string>>;
};

export type SignalFacts = {
  organizationId: string;
  branchId: string;
  at: Date;
  /** The newest ledger fact read for this branch; `at` when the branch is empty. */
  sourceObservedAt: Date;
  lots: readonly LotFact[];
  safetyStocks: readonly SafetyStockFact[];
  inbound: readonly InboundFact[];
  countVariances: readonly CountVarianceFact[];
};

export type DraftSignal = {
  kind: StockSignalKind;
  dedupKey: string;
  medicineId: string;
  stockLocationId: string | null;
  inventoryLotId: string | null;
  cause: string;
  ownerUserId: string;
  dueAt: Date;
  explanation: string;
  dataWindowStart: Date;
  dataWindowEnd: Date;
  sourceObservedAt: Date;
  freshnessSeconds: number;
  confidence: StockSignalConfidence;
  neededUnits: number;
  onHandUnits: number;
  inboundUnits: number;
  computedAt: Date;
};

export const DEFAULT_SIGNAL_POLICY: SignalPolicy = {
  nearExpiryDays: 90,
  returnWindowDays: 30,
  freshnessSeconds: 6 * 60 * 60,
  dataWindowDays: 90,
  slaHoursByKind: {
    LOW_STOCK: 48,
    STOCKOUT: 4,
    PROJECTED_STOCKOUT: 72,
    INBOUND_COVERAGE: 72,
    NEAR_EXPIRY: 168,
    RETURN_WINDOW: 48,
    RECALL: 2,
    QUARANTINE: 24,
    COLD_CHAIN: 2,
    COUNT_VARIANCE: 24,
  },
  ownerByKind: {
    LOW_STOCK: 'role:purchasing',
    STOCKOUT: 'role:purchasing',
    PROJECTED_STOCKOUT: 'role:purchasing',
    INBOUND_COVERAGE: 'role:purchasing',
    NEAR_EXPIRY: 'role:inventory',
    RETURN_WINDOW: 'role:purchasing',
    RECALL: 'role:pharmacist-in-charge',
    QUARANTINE: 'role:inventory',
    COLD_CHAIN: 'role:pharmacist-in-charge',
    COUNT_VARIANCE: 'role:inventory',
  },
};

function assertPolicy(policy: SignalPolicy): void {
  const positive = [
    policy.nearExpiryDays,
    policy.returnWindowDays,
    policy.freshnessSeconds,
    policy.dataWindowDays,
  ];
  if (!positive.every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new PharmacyStockSignalError('INVALID_POLICY');
  }
}

function assertUnits(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PharmacyStockSignalError('INVALID_UNITS');
  }
}

/** `at + days`, kept in UTC milliseconds so no case depends on a local zone. */
function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * DAY_MS);
}

function addHours(at: Date, hours: number): Date {
  return new Date(at.getTime() + hours * 3_600_000);
}

export function dedupKeyFor(input: {
  kind: StockSignalKind;
  medicineId: string;
  stockLocationId: string | null;
  cause: string;
}): string {
  return `${input.kind}:${input.medicineId}:${input.stockLocationId ?? '-'}:${input.cause}`;
}

/** Units of a lot that could actually be sold right now, per INV-03 + INV-09. */
function saleableUnits(lot: LotFact, at: Date): number {
  if (lot.disposition !== 'AVAILABLE') return 0;
  if (lot.batchState !== 'ACTIVE') return 0;
  if (lot.recallReference !== null) return 0;
  if (lot.receivedAt === null || lot.receivedAt.getTime() > at.getTime()) return 0;
  if (lot.expiresAt !== null && lot.expiresAt.getTime() <= at.getTime()) return 0;
  return Math.max(0, lot.onHandUnits - lot.reservedUnits);
}

function confidenceFor(lots: readonly LotFact[]): StockSignalConfidence {
  return lots.some((lot) => lot.unsettled) ? 'PARTIAL' : 'EXACT';
}

type Builder = {
  facts: SignalFacts;
  policy: SignalPolicy;
  dataWindowStart: Date;
};

function build(
  context: Builder,
  input: {
    kind: StockSignalKind;
    medicineId: string;
    stockLocationId: string | null;
    inventoryLotId: string | null;
    cause: string;
    explanation: string;
    confidence: StockSignalConfidence;
    neededUnits: number;
    onHandUnits: number;
    inboundUnits: number;
  }
): DraftSignal {
  const { facts, policy } = context;
  return {
    kind: input.kind,
    dedupKey: dedupKeyFor(input),
    medicineId: input.medicineId,
    stockLocationId: input.stockLocationId,
    inventoryLotId: input.inventoryLotId,
    cause: input.cause,
    ownerUserId: policy.ownerByKind[input.kind],
    dueAt: addHours(facts.at, policy.slaHoursByKind[input.kind]),
    explanation: input.explanation,
    dataWindowStart: context.dataWindowStart,
    dataWindowEnd: facts.at,
    sourceObservedAt: facts.sourceObservedAt,
    freshnessSeconds: policy.freshnessSeconds,
    confidence: input.confidence,
    neededUnits: input.neededUnits,
    onHandUnits: input.onHandUnits,
    inboundUnits: input.inboundUnits,
    computedAt: facts.at,
  };
}

/**
 * Evaluate every deterministic signal for one branch at one instant.
 *
 * The stock-level rules are mutually exclusive by construction, in this order:
 *
 *   - the need is met and no expiry erodes it → nothing;
 *   - the need is met now but stock expiring inside `coverageDays` drops it
 *     below the threshold, and approved inbound does not make that up →
 *     PROJECTED_STOCKOUT (deterministic depletion by printed expiry, not a
 *     demand forecast);
 *   - the need is unmet but on-hand plus approved inbound covers it →
 *     INBOUND_COVERAGE, and no shortfall signal. This is exactly the PUR-07
 *     acceptance "closes when on-hand plus approved inbound covers the need":
 *     the shortfall signal stops being produced, so the persisted one closes on
 *     the next evaluation.
 *   - the need is unmet and inbound does not cover it → STOCKOUT when nothing is
 *     saleable at all, otherwise LOW_STOCK.
 *
 * Results are sorted by dedup key so two runs over the same facts are
 * byte-identical.
 */
export function evaluateStockSignals(
  facts: SignalFacts,
  policy: SignalPolicy = DEFAULT_SIGNAL_POLICY
): DraftSignal[] {
  assertPolicy(policy);
  for (const lot of facts.lots) {
    assertUnits(lot.onHandUnits);
    assertUnits(lot.reservedUnits);
  }

  const context: Builder = {
    facts,
    policy,
    dataWindowStart: addDays(facts.at, -policy.dataWindowDays),
  };
  const signals: DraftSignal[] = [];
  const { at } = facts;

  // ── Product-level: measured against an approved threshold ────────────────
  for (const safety of facts.safetyStocks) {
    if (!Number.isSafeInteger(safety.safetyStockUnits) || safety.safetyStockUnits < 0) {
      throw new PharmacyStockSignalError('INVALID_UNITS');
    }
    if (!Number.isSafeInteger(safety.coverageDays) || safety.coverageDays <= 0) {
      throw new PharmacyStockSignalError('INVALID_POLICY');
    }
    const lots = facts.lots.filter((lot) => lot.medicineId === safety.medicineId);
    const available = lots.reduce((total, lot) => total + saleableUnits(lot, at), 0);
    const inboundUnits = facts.inbound
      .filter((row) => row.medicineId === safety.medicineId)
      .reduce((total, row) => total + row.units, 0);
    const need = safety.safetyStockUnits;
    const confidence = confidenceFor(lots);
    if (need === 0) continue;

    if (available >= need) {
      const horizon = addDays(at, safety.coverageDays);
      const expiring = lots.reduce(
        (total, lot) =>
          lot.expiresAt !== null && lot.expiresAt.getTime() <= horizon.getTime()
            ? total + saleableUnits(lot, at)
            : total,
        0
      );
      const afterExpiry = available - expiring;
      if (expiring > 0 && afterExpiry < need && afterExpiry + inboundUnits < need) {
        signals.push(
          build(context, {
            kind: 'PROJECTED_STOCKOUT',
            medicineId: safety.medicineId,
            stockLocationId: null,
            inventoryLotId: null,
            cause: 'EXPIRY_DEPLETION',
            confidence,
            neededUnits: need,
            onHandUnits: available,
            inboundUnits,
            explanation: `${available} units are on hand against an approved safety stock of ${need}, but ${expiring} of them expire within ${safety.coverageDays} days, leaving ${afterExpiry}. Approved inbound of ${inboundUnits} units does not make up the difference.`,
          })
        );
      }
      continue;
    }

    const shortfall = need - available;
    if (available + inboundUnits >= need) {
      signals.push(
        build(context, {
          kind: 'INBOUND_COVERAGE',
          medicineId: safety.medicineId,
          stockLocationId: null,
          inventoryLotId: null,
          cause: 'SHORTFALL_COVERED_BY_INBOUND',
          confidence,
          neededUnits: need,
          onHandUnits: available,
          inboundUnits,
          explanation: `${available} units are on hand against an approved safety stock of ${need}. Approved inbound of ${inboundUnits} units covers the shortfall of ${shortfall}; no new order is needed.`,
        })
      );
      continue;
    }

    const kind: StockSignalKind = available === 0 ? 'STOCKOUT' : 'LOW_STOCK';
    signals.push(
      build(context, {
        kind,
        medicineId: safety.medicineId,
        stockLocationId: null,
        inventoryLotId: null,
        cause: 'BELOW_SAFETY_STOCK',
        confidence,
        neededUnits: need,
        onHandUnits: available,
        inboundUnits,
        explanation:
          available === 0
            ? `Nothing saleable is on hand against an approved safety stock of ${need} units. Approved inbound of ${inboundUnits} units leaves a shortfall of ${need - inboundUnits}.`
            : `${available} units are on hand against an approved safety stock of ${need}. Approved inbound of ${inboundUnits} units leaves a shortfall of ${shortfall - inboundUnits}.`,
      })
    );
  }

  // ── Lot-level: each rule reads one bucket and nothing else ───────────────
  for (const lot of facts.lots) {
    const confidence = confidenceFor([lot]);
    const held = lot.onHandUnits;
    if (held <= 0) continue;

    if (lot.recallReference !== null) {
      signals.push(
        build(context, {
          kind: 'RECALL',
          medicineId: lot.medicineId,
          stockLocationId: lot.stockLocationId,
          inventoryLotId: lot.inventoryLotId,
          cause: `RECALL_${lot.recallReference}`,
          confidence,
          neededUnits: 0,
          onHandUnits: held,
          inboundUnits: 0,
          explanation: `${held} units of a batch under open recall ${lot.recallReference} are still held at this location. Quarantine and return them before anything else.`,
        })
      );
    }

    if (lot.disposition === 'QUARANTINE' || lot.disposition === 'DAMAGED') {
      signals.push(
        build(context, {
          kind: 'QUARANTINE',
          medicineId: lot.medicineId,
          stockLocationId: lot.stockLocationId,
          inventoryLotId: lot.inventoryLotId,
          cause: `HELD_${lot.disposition}`,
          confidence,
          neededUnits: 0,
          onHandUnits: held,
          inboundUnits: 0,
          explanation: `${held} units are held as ${lot.disposition} at this location and are not saleable. Decide between a supplier claim, a write-off and a release.`,
        })
      );
    }

    if (lot.medicineColdChain && !lot.locationColdChain && lot.disposition !== 'DESTROYED') {
      signals.push(
        build(context, {
          kind: 'COLD_CHAIN',
          medicineId: lot.medicineId,
          stockLocationId: lot.stockLocationId,
          inventoryLotId: lot.inventoryLotId,
          cause: 'NON_COLD_CHAIN_LOCATION',
          confidence,
          neededUnits: 0,
          onHandUnits: held,
          inboundUnits: 0,
          explanation: `${held} units of a cold-chain medicine are held at a location that is not a validated cold-chain zone.`,
        })
      );
    }

    const expiresAt = lot.expiresAt;
    if (
      lot.disposition === 'AVAILABLE' &&
      expiresAt !== null &&
      expiresAt.getTime() > at.getTime() &&
      expiresAt.getTime() <= addDays(at, policy.nearExpiryDays).getTime()
    ) {
      const days = Math.ceil((expiresAt.getTime() - at.getTime()) / DAY_MS);
      signals.push(
        build(context, {
          kind: 'NEAR_EXPIRY',
          medicineId: lot.medicineId,
          stockLocationId: lot.stockLocationId,
          inventoryLotId: lot.inventoryLotId,
          cause: 'WITHIN_NEAR_EXPIRY_WINDOW',
          confidence,
          neededUnits: 0,
          onHandUnits: held,
          inboundUnits: 0,
          explanation: `${held} units expire in ${days} days, inside the ${policy.nearExpiryDays}-day near-expiry window.`,
        })
      );
    }

    if (
      lot.returnWindowEndsAt !== null &&
      lot.returnWindowEndsAt.getTime() > at.getTime() &&
      lot.returnWindowEndsAt.getTime() <= addDays(at, policy.returnWindowDays).getTime()
    ) {
      const days = Math.ceil((lot.returnWindowEndsAt.getTime() - at.getTime()) / DAY_MS);
      signals.push(
        build(context, {
          kind: 'RETURN_WINDOW',
          medicineId: lot.medicineId,
          stockLocationId: lot.stockLocationId,
          inventoryLotId: lot.inventoryLotId,
          cause: 'WINDOW_CLOSING',
          confidence,
          neededUnits: 0,
          onHandUnits: held,
          inboundUnits: 0,
          explanation: `The supplier return window on this lot closes in ${days} days. Dispatch the claim before it lapses or the credit is lost.`,
        })
      );
    }
  }

  // ── Count variance: an approved count that missed its own threshold ──────
  for (const variance of facts.countVariances) {
    if (Math.abs(variance.varianceUnits) <= variance.varianceThreshold) continue;
    signals.push(
      build(context, {
        kind: 'COUNT_VARIANCE',
        medicineId: variance.medicineId,
        stockLocationId: variance.stockLocationId,
        inventoryLotId: variance.inventoryLotId,
        cause: 'ABOVE_VARIANCE_THRESHOLD',
        confidence: 'EXACT',
        neededUnits: variance.varianceThreshold,
        onHandUnits: Math.abs(variance.varianceUnits),
        inboundUnits: 0,
        explanation: `A counted variance of ${variance.varianceUnits} units exceeds the ${variance.varianceThreshold}-unit threshold agreed for this count.`,
      })
    );
  }

  return signals.sort((a, b) => a.dedupKey.localeCompare(b.dedupKey));
}

/**
 * PUR-07 acceptance: "stale source data marks the signal unusable". A signal is
 * a statement about a snapshot; once that snapshot is older than the freshness
 * policy that was in force when it was taken, the signal can no longer vouch for
 * its own numbers and must not be acted on until it is recomputed.
 *
 * The policy is read off the signal, not off today's configuration, so changing
 * the policy never retroactively rewrites whether a past signal was trustworthy.
 */
export function isStale(
  signal: { computedAt: Date; freshnessSeconds: number },
  now: Date
): boolean {
  return now.getTime() - signal.computedAt.getTime() > signal.freshnessSeconds * 1000;
}

/**
 * Whether a snoozed signal is due back in front of its owner. A snooze defers,
 * it never deletes: the reason is recorded and the signal returns on its own.
 */
export function isSnoozeExpired(
  signal: { status: StockSignalStatus; snoozedUntil: Date | null },
  now: Date
): boolean {
  return (
    signal.status === 'SNOOZED' &&
    signal.snoozedUntil !== null &&
    signal.snoozedUntil.getTime() <= now.getTime()
  );
}
