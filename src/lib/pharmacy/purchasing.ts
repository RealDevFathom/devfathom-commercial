/**
 * PH-PUR — PRD §6.3 PUR-01 (licensed suppliers), PUR-02 (requisition → quotes →
 * PO → approval) and PUR-03 (schemes, bonus units, discounts, rebates, freight
 * and landed-cost allocation).
 *
 * Everything here is a pure function over integers. Money is minor units; the
 * per-canonical-unit landed cost is returned in **micro-minor** units (minor ×
 * 1e6) so a cost that does not divide evenly stays exact enough to allocate and
 * to assert on, instead of being silently truncated to a whole paisa.
 *
 * The PUR-03 invariant that the arithmetic exists to protect: **bonus units
 * raise the received quantity and lower the per-unit cost, and never create
 * revenue.** A free pack costs nothing, so it is absent from every money term
 * below and present in every quantity term.
 */

export class PharmacyPurchasingError extends Error {
  constructor(
    readonly reason:
      | 'INVALID_QUANTITY'
      | 'INVALID_MONEY'
      | 'INVALID_RATE'
      | 'INVALID_TRANSITION'
      | 'SUPPLIER_NOT_AUTHORIZED'
      | 'SUPPLIER_LICENCE_EXPIRED'
      | 'SELF_APPROVAL'
      | 'NOT_FOUND'
      | 'CROSS_TENANT_REFERENCE'
  ) {
    super(reason);
  }
}

/** Rate denominator: rates are basis points, so 10_000 bps = 100%. */
const BPS = 10_000;
/** Sub-minor resolution of a per-canonical-unit cost. */
export const MICRO = 1_000_000;

function assertCount(value: number, reason: 'INVALID_QUANTITY' | 'INVALID_MONEY') {
  if (!Number.isSafeInteger(value) || value < 0) throw new PharmacyPurchasingError(reason);
}

function assertBps(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > BPS) {
    throw new PharmacyPurchasingError('INVALID_RATE');
  }
}

/** Round half-up on non-negative integers; `Math.round` is half-up already but is unsafe on floats. */
function divideRoundHalfUp(numerator: number, denominator: number): number {
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

// ---------------------------------------------------------------------------
// PUR-01 — supplier eligibility
// ---------------------------------------------------------------------------

export type SupplierLicenceEvidence = {
  /** Exclusive: a licence that expires today is still valid for the whole of today. */
  expiresAt: Date;
  /** A superseded or unverified filing is evidence of paperwork, not of a licence. */
  verified: boolean;
};

/**
 * PUR-01: an unauthorized supplier, or one with no unexpired verified licence
 * evidence, cannot be ordered from. Called before a PO is created and again
 * before it is sent, because authorization can lapse between the two.
 */
export function assertSupplierEligible(input: {
  authorized: boolean;
  licences: readonly SupplierLicenceEvidence[];
  at: Date;
}): void {
  if (!input.authorized) throw new PharmacyPurchasingError('SUPPLIER_NOT_AUTHORIZED');
  const valid = input.licences.some(
    (licence) => licence.verified && licence.expiresAt.getTime() >= input.at.getTime()
  );
  if (!valid) throw new PharmacyPurchasingError('SUPPLIER_LICENCE_EXPIRED');
}

// ---------------------------------------------------------------------------
// PUR-02 — status machine and approval policy
// ---------------------------------------------------------------------------

export type PurchaseOrderStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'SENT'
  | 'RECEIVING'
  | 'CANCELLED';

/**
 * DRAFT → SUBMITTED → APPROVED → SENT → RECEIVING, with cancellation available
 * until the order leaves the building. RECEIVING is the terminal state of this
 * lane; the receipt itself lands with the PH-INV ledger.
 */
const PURCHASE_ORDER_TRANSITIONS: Record<PurchaseOrderStatus, readonly PurchaseOrderStatus[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['SENT', 'CANCELLED'],
  SENT: ['RECEIVING', 'CANCELLED'],
  RECEIVING: [],
  CANCELLED: [],
};

export function assertPurchaseOrderTransition(
  from: PurchaseOrderStatus,
  to: PurchaseOrderStatus
): void {
  if (!PURCHASE_ORDER_TRANSITIONS[from].includes(to)) {
    throw new PharmacyPurchasingError('INVALID_TRANSITION');
  }
}

export type RequisitionStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'CANCELLED';

const REQUISITION_TRANSITIONS: Record<RequisitionStatus, readonly RequisitionStatus[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['CANCELLED'],
  CANCELLED: [],
};

export function assertRequisitionTransition(from: RequisitionStatus, to: RequisitionStatus): void {
  if (!REQUISITION_TRANSITIONS[from].includes(to)) {
    throw new PharmacyPurchasingError('INVALID_TRANSITION');
  }
}

/**
 * PUR-02: segregation of duties. Whoever raised the demand or drafted the order
 * cannot be the person who approves the spend.
 */
export const SEGREGATION_OF_DUTIES_POLICY = 'PUR-02:SEGREGATION_OF_DUTIES';

export function assertApprovalAllowed(input: {
  approverId: string;
  requestedById: string | null;
  createdById: string;
}): void {
  if (input.approverId === input.createdById || input.approverId === input.requestedById) {
    throw new PharmacyPurchasingError('SELF_APPROVAL');
  }
}

// ---------------------------------------------------------------------------
// PUR-03 — schemes, bonus units, discounts, rebates, freight, landed cost
// ---------------------------------------------------------------------------

export type PurchaseOrderLineCost = {
  /** Packs actually paid for. */
  orderedPacks: number;
  /** Scheme/bonus packs supplied free. Quantity only — never a money term. */
  bonusPacks: number;
  /** Canonical (smallest sellable) units in one pack of this pack level. */
  canonicalUnitsPerPack: number;
  listPricePerPackMinor: number;
  /** Trade/scheme discount off list, in basis points. */
  discountBps?: number;
  /** Supplier rebate off the discounted net, in basis points. */
  rebateBps?: number;
  /** Purchase tax rate in basis points. */
  taxBps?: number;
  /**
   * A creditable (input-claimable) tax is recovered from the authority and so is
   * not part of the cost of the stock. A non-creditable tax is.
   */
  taxCreditable?: boolean;
};

export type LineCost = {
  grossMinor: number;
  discountMinor: number;
  netMinor: number;
  rebateMinor: number;
  taxMinor: number;
  /** Line cost before any allocated charge. Excludes creditable tax. */
  netCostMinor: number;
  /** Ordered + bonus, in canonical units. */
  canonicalUnits: number;
};

/**
 * Line arithmetic in strict order: list → discount → rebate → tax. Each step
 * rounds half-up to whole minor units at the point it is applied, so a stored
 * line and a recomputed line always agree.
 */
export function costPurchaseOrderLine(line: PurchaseOrderLineCost): LineCost {
  const {
    orderedPacks,
    bonusPacks,
    canonicalUnitsPerPack,
    listPricePerPackMinor,
    discountBps = 0,
    rebateBps = 0,
    taxBps = 0,
    taxCreditable = false,
  } = line;

  assertCount(orderedPacks, 'INVALID_QUANTITY');
  assertCount(bonusPacks, 'INVALID_QUANTITY');
  assertCount(listPricePerPackMinor, 'INVALID_MONEY');
  if (!Number.isSafeInteger(canonicalUnitsPerPack) || canonicalUnitsPerPack <= 0) {
    throw new PharmacyPurchasingError('INVALID_QUANTITY');
  }
  if (orderedPacks === 0) throw new PharmacyPurchasingError('INVALID_QUANTITY');
  assertBps(discountBps);
  assertBps(rebateBps);
  assertBps(taxBps);

  const grossMinor = orderedPacks * listPricePerPackMinor;
  assertCount(grossMinor, 'INVALID_MONEY');
  const discountMinor = divideRoundHalfUp(grossMinor * discountBps, BPS);
  const netMinor = grossMinor - discountMinor;
  const rebateMinor = divideRoundHalfUp(netMinor * rebateBps, BPS);
  const taxableMinor = netMinor - rebateMinor;
  const taxMinor = divideRoundHalfUp(taxableMinor * taxBps, BPS);

  const canonicalUnits = (orderedPacks + bonusPacks) * canonicalUnitsPerPack;
  assertCount(canonicalUnits, 'INVALID_QUANTITY');

  return {
    grossMinor,
    discountMinor,
    netMinor,
    rebateMinor,
    taxMinor,
    netCostMinor: taxableMinor + (taxCreditable ? 0 : taxMinor),
    canonicalUnits,
  };
}

/**
 * Split `amountMinor` across `weights` by the largest-remainder method, so the
 * parts sum to the whole exactly — no paisa is invented or lost by rounding.
 * Ties go to the earlier line, which keeps allocation deterministic for a given
 * line order. With no weight at all the charge is spread evenly.
 */
export function allocateByWeight(
  amountMinor: number,
  weights: readonly number[]
): readonly number[] {
  assertCount(amountMinor, 'INVALID_MONEY');
  if (weights.length === 0) throw new PharmacyPurchasingError('INVALID_QUANTITY');
  for (const weight of weights) assertCount(weight, 'INVALID_MONEY');

  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const basis = total > 0 ? weights : weights.map(() => 1);
  const basisTotal = total > 0 ? total : weights.length;

  const floors = basis.map((weight) => Math.floor((amountMinor * weight) / basisTotal));
  let remainder = amountMinor - floors.reduce((sum, part) => sum + part, 0);

  const order = basis
    .map((weight, index) => ({
      index,
      remainder: amountMinor * weight - floors[index]! * basisTotal,
    }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  const allocated = [...floors];
  for (const { index } of order) {
    if (remainder <= 0) break;
    allocated[index] = allocated[index]! + 1;
    remainder -= 1;
  }
  return allocated;
}

export type LandedCostLine = LineCost & {
  /** This line's share of the order-level freight and other charges. */
  allocatedChargeMinor: number;
  /** Line cost including its allocated charge. */
  landedCostMinor: number;
  /** Landed cost per canonical unit, in minor units × 1e6. */
  landedCostPerCanonicalUnitMicroMinor: number;
};

export type LandedCost = {
  lines: readonly LandedCostLine[];
  netCostMinor: number;
  chargesMinor: number;
  taxMinor: number;
  landedCostMinor: number;
  canonicalUnits: number;
  /** Payable to the supplier: net of discount and rebate, plus tax and charges. */
  payableMinor: number;
};

/**
 * PUR-03: cost the lines, allocate freight and other order-level charges across
 * them by net value, and express the result per canonical unit. Bonus packs
 * appear only in `canonicalUnits`, so they always divide the same money over
 * more units — quantity up, unit cost down, revenue untouched.
 */
export function landedCost(input: {
  lines: readonly PurchaseOrderLineCost[];
  freightMinor?: number;
  otherChargesMinor?: number;
}): LandedCost {
  const { lines, freightMinor = 0, otherChargesMinor = 0 } = input;
  if (lines.length === 0) throw new PharmacyPurchasingError('INVALID_QUANTITY');
  assertCount(freightMinor, 'INVALID_MONEY');
  assertCount(otherChargesMinor, 'INVALID_MONEY');

  const costed = lines.map(costPurchaseOrderLine);
  const chargesMinor = freightMinor + otherChargesMinor;
  const allocations = allocateByWeight(
    chargesMinor,
    costed.map((line) => line.netCostMinor)
  );

  const landedLines = costed.map((line, index) => {
    const allocatedChargeMinor = allocations[index]!;
    const landedCostMinor = line.netCostMinor + allocatedChargeMinor;
    return {
      ...line,
      allocatedChargeMinor,
      landedCostMinor,
      landedCostPerCanonicalUnitMicroMinor: divideRoundHalfUp(
        landedCostMinor * MICRO,
        line.canonicalUnits
      ),
    };
  });

  const sum = (pick: (line: LandedCostLine) => number) =>
    landedLines.reduce((total, line) => total + pick(line), 0);

  return {
    lines: landedLines,
    netCostMinor: sum((line) => line.netCostMinor),
    chargesMinor,
    taxMinor: sum((line) => line.taxMinor),
    landedCostMinor: sum((line) => line.landedCostMinor),
    canonicalUnits: sum((line) => line.canonicalUnits),
    payableMinor: sum((line) => line.netMinor - line.rebateMinor + line.taxMinor) + chargesMinor,
  };
}

// ---------------------------------------------------------------------------
// PUR-02 — quote comparison (ranked and explained; never auto-awarded)
// ---------------------------------------------------------------------------

export type QuoteCandidate = {
  quoteId: string;
  supplierId: string;
  supplierName: string;
  supplierAuthorized: boolean;
  supplierLicences: readonly SupplierLicenceEvidence[];
  /** Quote validity; a lapsed quote is still listed, but never as comparable. */
  validUntil: Date;
  pricePerPackMinor: number;
  canonicalUnitsPerPack: number;
  /** Buy `schemeBuyPacks`, get `schemeFreePacks` free. Both zero = no scheme. */
  schemeBuyPacks?: number;
  schemeFreePacks?: number;
  discountBps?: number;
  moqPacks: number;
  leadTimeDays: number;
  /** Shortest remaining shelf life the supplier will ship, in days. */
  minimumExpiryDays: number;
  /**
   * Operator-configured forecast of packs that will sell before the offered
   * shelf life ends. `null` means none was recorded (quotes captured before the
   * forecast existed): the comparison then assumes every pack sells, so legacy
   * quotes keep their original ranking instead of being silently penalised.
   */
  forecastSellThroughPacks: number | null;
};

export type QuoteComparisonRow = {
  quoteId: string;
  supplierId: string;
  supplierName: string;
  pricePerPackMinor: number;
  /** 1-based, best first. Non-comparable quotes rank last, in input order. */
  rank: number;
  comparable: boolean;
  /** Effective landed cost per canonical unit for one MOQ-satisfying buy. */
  effectiveUnitCostMicroMinor: number | null;
  /** Cost divided only by stock forecast to sell before expiry. */
  effectiveSellableUnitCostMicroMinor: number | null;
  /** The recorded forecast, or `null` when none was recorded and all packs are assumed to sell. */
  forecastSellThroughPacks: number | null;
  /** Free packs the forecast does not sell before expiry. Zero when not comparable. */
  atRiskBonusPacks: number;
  /** Paid packs the forecast does not sell before expiry. Zero when not comparable. */
  atRiskPaidPacks: number;
  packsForRequirement: number;
  bonusPacks: number;
  leadTimeDays: number;
  minimumExpiryDays: number;
  moqPacks: number;
  /** Plain-language reasons — the operator awards, the comparison does not. */
  reasons: readonly string[];
};

function scheduleForRequirement(
  requiredPacks: number,
  candidate: QuoteCandidate
): { paidPacks: number; bonusPacks: number } {
  const buy = candidate.schemeBuyPacks ?? 0;
  const free = candidate.schemeFreePacks ?? 0;
  const paidPacks = Math.max(requiredPacks, candidate.moqPacks);
  if (buy <= 0 || free <= 0) return { paidPacks, bonusPacks: 0 };
  return { paidPacks, bonusPacks: Math.floor(paidPacks / buy) * free };
}

/**
 * Cost per unit expected to remain sellable. Paid stock is consumed first, so a
 * bonus lowers cost only to the extent the configured forecast also consumes it.
 */
export function effectiveCostPerSellableUnit(input: {
  costMinor: number;
  paidPacks: number;
  bonusPacks: number;
  canonicalUnitsPerPack: number;
  forecastSellThroughPacks: number;
}): {
  effectiveUnitCostMicroMinor: number;
  sellablePacks: number;
  atRiskBonusPacks: number;
  atRiskPaidPacks: number;
} {
  const { costMinor, paidPacks, bonusPacks, canonicalUnitsPerPack, forecastSellThroughPacks } =
    input;
  assertCount(costMinor, 'INVALID_MONEY');
  [paidPacks, bonusPacks, forecastSellThroughPacks].forEach((value) =>
    assertCount(value, 'INVALID_QUANTITY')
  );
  if (!Number.isSafeInteger(canonicalUnitsPerPack) || canonicalUnitsPerPack <= 0) {
    throw new PharmacyPurchasingError('INVALID_QUANTITY');
  }
  const totalPacks = paidPacks + bonusPacks;
  const sellablePacks = Math.min(totalPacks, forecastSellThroughPacks);
  if (sellablePacks <= 0) throw new PharmacyPurchasingError('INVALID_QUANTITY');
  const sellableBonusPacks = Math.max(0, sellablePacks - paidPacks);
  return {
    effectiveUnitCostMicroMinor: divideRoundHalfUp(
      costMinor * MICRO,
      sellablePacks * canonicalUnitsPerPack
    ),
    sellablePacks,
    atRiskBonusPacks: bonusPacks - sellableBonusPacks,
    atRiskPaidPacks: paidPacks - Math.min(paidPacks, sellablePacks),
  };
}

/**
 * PUR-02: rank the quotes for one requisition line and explain every position.
 * Returns a list, not a winner — awarding stays a human decision. Ranking is by
 * effective landed cost per canonical unit, then lead time, then remaining
 * shelf life, then quote id, so the order is total and stable.
 */
export function compareQuotes(input: {
  requiredPacks: number;
  candidates: readonly QuoteCandidate[];
  at: Date;
}): readonly QuoteComparisonRow[] {
  const { requiredPacks, candidates, at } = input;
  if (!Number.isSafeInteger(requiredPacks) || requiredPacks <= 0) {
    throw new PharmacyPurchasingError('INVALID_QUANTITY');
  }

  const rows = candidates.map((candidate) => {
    const reasons: string[] = [];
    let comparable = true;

    try {
      assertSupplierEligible({
        authorized: candidate.supplierAuthorized,
        licences: candidate.supplierLicences,
        at,
      });
    } catch (error) {
      comparable = false;
      reasons.push(
        error instanceof PharmacyPurchasingError && error.reason === 'SUPPLIER_NOT_AUTHORIZED'
          ? 'Supplier is not authorized to supply this pharmacy.'
          : 'Supplier has no unexpired verified licence on file.'
      );
    }
    if (candidate.validUntil.getTime() < at.getTime()) {
      comparable = false;
      reasons.push('Quote validity has lapsed.');
    }

    const { paidPacks, bonusPacks } = scheduleForRequirement(requiredPacks, candidate);
    let effectiveUnitCostMicroMinor: number | null = null;
    let effectiveSellableUnitCostMicroMinor: number | null = null;
    // A non-comparable quote is never risk-assessed, so it reports no packs at risk.
    let atRiskBonusPacks = 0;
    let atRiskPaidPacks = 0;
    const forecast = candidate.forecastSellThroughPacks ?? null;
    const forecastRecorded = forecast !== null;
    if (comparable) {
      const [line] = landedCost({
        lines: [
          {
            orderedPacks: paidPacks,
            bonusPacks,
            canonicalUnitsPerPack: candidate.canonicalUnitsPerPack,
            listPricePerPackMinor: candidate.pricePerPackMinor,
            discountBps: candidate.discountBps ?? 0,
          },
        ],
      }).lines;
      effectiveUnitCostMicroMinor = line!.landedCostPerCanonicalUnitMicroMinor;
      const riskAdjusted = effectiveCostPerSellableUnit({
        costMinor: line!.landedCostMinor,
        paidPacks,
        bonusPacks,
        canonicalUnitsPerPack: candidate.canonicalUnitsPerPack,
        forecastSellThroughPacks: forecast ?? paidPacks + bonusPacks,
      });
      effectiveSellableUnitCostMicroMinor = riskAdjusted.effectiveUnitCostMicroMinor;
      atRiskBonusPacks = riskAdjusted.atRiskBonusPacks;
      atRiskPaidPacks = riskAdjusted.atRiskPaidPacks;
    }

    if (candidate.moqPacks > requiredPacks) {
      reasons.push(
        `Minimum order quantity ${candidate.moqPacks} packs exceeds the ${requiredPacks} packs required.`
      );
    }
    if (bonusPacks > 0) {
      reasons.push(
        !comparable
          ? `Scheme adds ${bonusPacks} free packs.`
          : !forecastRecorded
            ? `Scheme adds ${bonusPacks} free packs; no sell-through forecast is recorded, so all are assumed to sell.`
            : atRiskBonusPacks > 0
              ? `Scheme adds ${bonusPacks} free packs; ${atRiskBonusPacks} are at expiry risk under the configured sell-through forecast.`
              : `Scheme adds ${bonusPacks} free packs and the configured forecast sells all before expiry.`
      );
    }
    if (atRiskPaidPacks > 0) {
      reasons.push(
        `${atRiskPaidPacks} paid packs are at expiry risk under the configured sell-through forecast.`
      );
    }
    if ((candidate.discountBps ?? 0) > 0) {
      reasons.push(`Trade discount of ${(candidate.discountBps! / 100).toFixed(2)}% off list.`);
    }
    reasons.push(
      `Lead time ${candidate.leadTimeDays} days; shortest shelf life offered ${candidate.minimumExpiryDays} days.`
    );

    return {
      quoteId: candidate.quoteId,
      supplierId: candidate.supplierId,
      supplierName: candidate.supplierName,
      pricePerPackMinor: candidate.pricePerPackMinor,
      rank: 0,
      comparable,
      effectiveUnitCostMicroMinor,
      effectiveSellableUnitCostMicroMinor,
      forecastSellThroughPacks: forecast,
      atRiskBonusPacks,
      atRiskPaidPacks,
      packsForRequirement: paidPacks,
      bonusPacks,
      leadTimeDays: candidate.leadTimeDays,
      minimumExpiryDays: candidate.minimumExpiryDays,
      moqPacks: candidate.moqPacks,
      reasons,
    };
  });

  rows.sort((a, b) => {
    if (a.comparable !== b.comparable) return a.comparable ? -1 : 1;
    // Non-comparable quotes have no cost to rank by; `Array#sort` is stable, so
    // returning 0 keeps them in the caller's input order.
    if (!a.comparable) return 0;
    return (
      a.effectiveSellableUnitCostMicroMinor! - b.effectiveSellableUnitCostMicroMinor! ||
      a.leadTimeDays - b.leadTimeDays ||
      b.minimumExpiryDays - a.minimumExpiryDays ||
      a.quoteId.localeCompare(b.quoteId)
    );
  });

  return rows.map((row, position) => ({ ...row, rank: position + 1 }));
}
