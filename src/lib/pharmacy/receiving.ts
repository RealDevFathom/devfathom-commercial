/**
 * PH-PUR — PRD §6.3 PUR-02 (the receiving half), PUR-04 (three-way match) and
 * PUR-05 (direct purchase). The pure kernel: total, synchronous, database-free.
 *
 * Two decisions live here, and both are the reason receiving cannot be a thin
 * insert.
 *
 * FAIL CLOSED ON EVIDENCE. PUR-02's acceptance is that stock is not saleable
 * until batch, expiry, invoice/warranty, pack conversion, printed MRP and an
 * authorized supplier are *all* present. `assertSaleableOnReceipt` therefore
 * refuses on the first missing one and names it, rather than posting stock that
 * the counter would later have to refuse to sell for an unexplained reason. The
 * supplier half reuses PUR-01's `assertSupplierEligible`, so authorization and
 * licensing are decided in exactly one place in this lane.
 *
 * THE MATCH IS A REPORT, NOT A GATE. `matchReceiptLine` compares the order, the
 * invoice and the goods and returns the discrepancies as exceptions. It never
 * refuses a receipt: goods that physically arrived have to be accounted for, so
 * a shortage or an overage is recorded and stays visible until a human resolves
 * it (PUR-04). What the exception list does not do is change a quantity — the
 * accepted/rejected split posted to the ledger is what was counted at the door.
 *
 * INTEGER CANONICAL UNITS (§8A invariant 1). Every quantity crossing this
 * module is a safe integer count of canonical base units. Packs are an input;
 * canonical units are their projection, never an independently supplied number.
 */
import {
  allocateByWeight,
  assertSupplierEligible,
  PharmacyPurchasingError,
  type SupplierCompliancePolicy,
  type SupplierLicenceEvidence,
} from './purchasing';

export class PharmacyReceivingError extends Error {
  constructor(
    readonly reason:
      | 'MISSING_BATCH'
      | 'MISSING_EXPIRY'
      | 'MISSING_INVOICE_EVIDENCE'
      | 'MISSING_WARRANTY_EVIDENCE'
      | 'MISSING_PACK_CONVERSION'
      | 'MISSING_MRP'
      | 'SUPPLIER_NOT_AUTHORIZED'
      | 'SUPPLIER_LICENCE_EXPIRED'
      | 'INVALID_QUANTITY'
      | 'INVALID_MONEY'
      | 'INVALID_TRANSITION'
      | 'BYPASS_EVIDENCE_MISSING'
      | 'SELF_APPROVAL'
      | 'BATCH_EXPIRY_CONFLICT'
      | 'OCR_CONFIRMATION_REQUIRED'
      | 'NOT_FOUND'
      | 'CROSS_TENANT_REFERENCE'
      | 'CROSS_BRANCH_REFERENCE'
      | 'CONTROLLED_WITNESS_REQUIRED'
      | 'DUPLICATE_SERIAL'
      | 'GS1_INVALID'
      | 'GTIN_MEDICINE_MISMATCH'
      | 'PURCHASE_ORDER_LINE_ITEM_MISMATCH'
      | 'EXPIRED_PACK'
      | 'SERIALIZED_PACK_QUANTITY'
      /** Reversal refused: received units have since been sold, moved or written off. */
      | 'REVERSAL_STOCK_MOVED'
      /** Reversal refused: the units are still here, but sealed packs were opened. */
      | 'REVERSAL_PACKS_OPENED'
  ) {
    super(reason);
  }
}

/** Basis-point denominator, as in PUR-03. */
const BPS = 10_000;

function divideRoundHalfUp(numerator: number, denominator: number): number {
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

function assertUnits(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PharmacyReceivingError('INVALID_QUANTITY');
  }
}

function assertMoney(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PharmacyReceivingError('INVALID_MONEY');
  }
}

// ---------------------------------------------------------------------------
// PUR-02 — the evidence without which received stock is not saleable
// ---------------------------------------------------------------------------

export type SaleableEvidence = {
  /** The manufacturer's batch number as printed on the pack. */
  batchNumber: string;
  /** Printed expiry; `null` when the receiver could not read one off the pack. */
  printedExpiry: Date | null;
  /** The supplier's invoice this delivery arrived against. */
  supplierInvoiceRef: string;
  /** Warranty / source-invoice evidence reference (PUR-02, §6.3). */
  warrantyEvidenceRef: string;
  /** Canonical base units in one pack, resolved from the MED-02 conversion. */
  canonicalUnitsPerPack: number;
  /** Printed maximum retail price in minor units. Zero is a missing MRP. */
  printedMrpMinor: number;
  /**
   * The supplier as the tenant-scoped client returned it. `null` means the id
   * named a row this tenant cannot see, which fails on authorization rather
   * than being quietly treated as unlicensed.
   */
  supplier: { authorized: boolean; licences: readonly SupplierLicenceEvidence[] } | null;
  /**
   * DEV-753: the owner's supplier-compliance policy in force at posting. With the
   * checks off, supplier licence and trade authorization stop being refusal reasons;
   * every other field above is still required.
   */
  supplierCompliance: SupplierCompliancePolicy;
  at: Date;
};

/**
 * PUR-02 acceptance, fail closed: refuse to make stock saleable until every
 * named field is present, and say which one is missing.
 *
 * Order matters only for the message a caller sees; each field is checked
 * independently, so a receipt missing two of them is refused for the first and
 * remains refused for the second.
 */
export function assertSaleableOnReceipt(evidence: SaleableEvidence): void {
  if (evidence.batchNumber.trim().length === 0) {
    throw new PharmacyReceivingError('MISSING_BATCH');
  }
  if (evidence.printedExpiry === null || Number.isNaN(evidence.printedExpiry.getTime())) {
    throw new PharmacyReceivingError('MISSING_EXPIRY');
  }
  if (evidence.supplierInvoiceRef.trim().length === 0) {
    throw new PharmacyReceivingError('MISSING_INVOICE_EVIDENCE');
  }
  if (evidence.warrantyEvidenceRef.trim().length === 0) {
    throw new PharmacyReceivingError('MISSING_WARRANTY_EVIDENCE');
  }
  if (
    !Number.isSafeInteger(evidence.canonicalUnitsPerPack) ||
    evidence.canonicalUnitsPerPack <= 0
  ) {
    throw new PharmacyReceivingError('MISSING_PACK_CONVERSION');
  }
  if (!Number.isSafeInteger(evidence.printedMrpMinor) || evidence.printedMrpMinor <= 0) {
    throw new PharmacyReceivingError('MISSING_MRP');
  }
  // PUR-01 decides supplier eligibility for the whole lane; receiving asks it
  // again here because authorization can lapse between order and delivery. A
  // supplier the tenant cannot see is refused whatever the owner policy says.
  if (!evidence.supplier) throw new PharmacyReceivingError('SUPPLIER_NOT_AUTHORIZED');
  try {
    assertSupplierEligible({
      authorized: evidence.supplier.authorized,
      licences: evidence.supplier.licences,
      at: evidence.at,
      policy: evidence.supplierCompliance,
    });
  } catch (error) {
    if (error instanceof PharmacyPurchasingError) {
      throw new PharmacyReceivingError(
        error.reason === 'SUPPLIER_LICENCE_EXPIRED'
          ? 'SUPPLIER_LICENCE_EXPIRED'
          : 'SUPPLIER_NOT_AUTHORIZED'
      );
    }
    throw error;
  }
}

/**
 * PUR-05: the direct purchase path is excused the purchase order and nothing
 * else. It still needs a named reason and a second approver, except when the
 * server boundary has PIN-reauthenticated an eligible solo owner.
 */
export function assertDirectPurchaseAuthorized(input: {
  bypassReason: string;
  bypassApprovedByUserId: string;
  receivedByUserId: string;
  soloOwnerReauthenticated?: boolean;
}): void {
  if (input.bypassReason.trim().length === 0 || input.bypassApprovedByUserId.trim().length === 0) {
    throw new PharmacyReceivingError('BYPASS_EVIDENCE_MISSING');
  }
  if (input.bypassApprovedByUserId === input.receivedByUserId && !input.soloOwnerReauthenticated) {
    throw new PharmacyReceivingError('SELF_APPROVAL');
  }
}

// ---------------------------------------------------------------------------
// PUR-02 / PUR-03 — quantity and cost projections
// ---------------------------------------------------------------------------

export type ReceiptLineQuantityInput = {
  receivedPacks: number;
  bonusPacks: number;
  canonicalUnitsPerPack: number;
  /** Canonical units refused at the door: damaged, short-dated, wrong goods. */
  rejectedCanonicalUnits: number;
};

export type ReceiptLineQuantities = {
  receivedCanonicalUnits: number;
  bonusCanonicalUnits: number;
  /** Everything that physically arrived, paid for and free alike. */
  arrivedCanonicalUnits: number;
  /** What goes to AVAILABLE. */
  acceptedCanonicalUnits: number;
  /** What goes to QUARANTINE or RETURNS, and never to AVAILABLE (PUR-04). */
  rejectedCanonicalUnits: number;
};

/**
 * Canonical units are the projection of packs on both the paid and the free
 * side (§8A invariant 1, PUR-03), and every arrived unit is either accepted or
 * rejected — the split can never lose or invent a unit.
 */
export function receiptLineQuantities(input: ReceiptLineQuantityInput): ReceiptLineQuantities {
  assertUnits(input.receivedPacks);
  assertUnits(input.bonusPacks);
  assertUnits(input.rejectedCanonicalUnits);
  if (!Number.isSafeInteger(input.canonicalUnitsPerPack) || input.canonicalUnitsPerPack <= 0) {
    throw new PharmacyReceivingError('MISSING_PACK_CONVERSION');
  }

  const receivedCanonicalUnits = input.receivedPacks * input.canonicalUnitsPerPack;
  const bonusCanonicalUnits = input.bonusPacks * input.canonicalUnitsPerPack;
  const arrivedCanonicalUnits = receivedCanonicalUnits + bonusCanonicalUnits;
  assertUnits(arrivedCanonicalUnits);
  if (arrivedCanonicalUnits === 0) throw new PharmacyReceivingError('INVALID_QUANTITY');
  if (input.rejectedCanonicalUnits > arrivedCanonicalUnits) {
    throw new PharmacyReceivingError('INVALID_QUANTITY');
  }

  return {
    receivedCanonicalUnits,
    bonusCanonicalUnits,
    arrivedCanonicalUnits,
    acceptedCanonicalUnits: arrivedCanonicalUnits - input.rejectedCanonicalUnits,
    rejectedCanonicalUnits: input.rejectedCanonicalUnits,
  };
}

export type ReceiptLineCostInput = {
  receivedPacks: number;
  bonusPacks: number;
  canonicalUnitsPerPack: number;
  invoicedPricePerPackMinor: number;
  discountBps?: number;
  /** The ordered line's supplier rebate off the discounted net (PUR-03). */
  rebateBps?: number;
  taxBps?: number;
  /** A creditable input tax is recovered from the authority, so it is not cost. */
  taxCreditable?: boolean;
  /**
   * This line's share of the charges carried into its lots: the freight the
   * supplier billed on the invoice (DEV-77) or, when the invoice bills none,
   * its share of the purchase order's freight and other charges (DEV-161).
   * Money only: it is spread over the same received + bonus units.
   */
  allocatedChargeMinor?: number;
};

/**
 * The money one receipt line puts into stock before any charge, in the same
 * order as the purchase order's landed cost: invoiced packs less discount,
 * less the order-line rebate, plus a non-creditable tax on what remains.
 * Bonus packs never appear here — they are quantity only.
 */
function receiptLineCost(input: ReceiptLineCostInput): {
  costMinor: number;
  canonicalUnits: number;
} {
  const {
    receivedPacks,
    bonusPacks,
    canonicalUnitsPerPack,
    invoicedPricePerPackMinor,
    discountBps = 0,
    rebateBps = 0,
    taxBps = 0,
    taxCreditable = false,
  } = input;

  assertUnits(receivedPacks);
  assertUnits(bonusPacks);
  assertMoney(invoicedPricePerPackMinor);
  if (
    !Number.isSafeInteger(discountBps) ||
    discountBps < 0 ||
    discountBps > BPS ||
    !Number.isSafeInteger(rebateBps) ||
    rebateBps < 0 ||
    rebateBps > BPS ||
    !Number.isSafeInteger(taxBps) ||
    taxBps < 0 ||
    taxBps > BPS
  ) {
    throw new PharmacyReceivingError('INVALID_MONEY');
  }
  if (!Number.isSafeInteger(canonicalUnitsPerPack) || canonicalUnitsPerPack <= 0) {
    throw new PharmacyReceivingError('MISSING_PACK_CONVERSION');
  }

  const canonicalUnits = (receivedPacks + bonusPacks) * canonicalUnitsPerPack;
  assertUnits(canonicalUnits);
  if (canonicalUnits === 0) throw new PharmacyReceivingError('INVALID_QUANTITY');
  // A delivery that is entirely free costs nothing of its own. There is no
  // paid quantity to spread, so there is nothing to divide.
  if (receivedPacks === 0) return { costMinor: 0, canonicalUnits };

  const grossMinor = receivedPacks * invoicedPricePerPackMinor;
  assertMoney(grossMinor);
  const netMinor = grossMinor - divideRoundHalfUp(grossMinor * discountBps, BPS);
  const taxableMinor = netMinor - divideRoundHalfUp(netMinor * rebateBps, BPS);
  const taxMinor = divideRoundHalfUp(taxableMinor * taxBps, BPS);
  return { costMinor: taxableMinor + (taxCreditable ? 0 : taxMinor), canonicalUnits };
}

/**
 * PUR-03 on the receiving side: the landed cost of one canonical unit, as it
 * is stamped onto the inventory lot.
 *
 * Bonus packs appear only in the divisor, so free goods always lower the unit
 * cost and never add money — a 10+1 scheme costs paid/11 per unit, and an
 * all-bonus line costs nothing per unit beyond any charge it carries.
 */
export function receiptLineUnitCostMinor(input: ReceiptLineCostInput): number {
  const allocatedChargeMinor = input.allocatedChargeMinor ?? 0;
  assertMoney(allocatedChargeMinor);
  const { costMinor, canonicalUnits } = receiptLineCost(input);
  const landedMinor = costMinor + allocatedChargeMinor;
  assertMoney(landedMinor);
  return divideRoundHalfUp(landedMinor, canonicalUnits);
}

export type ReceiptLandedCost = {
  /** This line's share of the receipt freight, in whole minor units. */
  allocatedFreightMinor: number;
  /** Landed cost of one canonical unit, carried onto the lot. */
  unitCostMinor: number;
};

/**
 * DEV-77: the landed cost per lot for a whole receipt. Freight billed on the
 * supplier invoice is treated like a non-creditable tax: owed on the invoice
 * and part of stock cost. It is spread across the lines by each line's own
 * cost (largest remainder, so the parts sum to the freight exactly), then
 * every line's money — invoice net, non-creditable tax and freight share — is
 * divided over its received AND bonus units. A receipt with no freight costs
 * exactly as it always did.
 *
 * DEV-161: a line may also carry `allocatedChargeMinor` of its own — its share
 * of the purchase order's freight and other charges — which is added to its
 * invoice-freight share. The caller passes an order share only when the
 * receipt bills no freight of its own, so the two never overlap.
 */
export function receiptLandedCosts(input: {
  lines: readonly ReceiptLineCostInput[];
  freightMinor?: number;
}): readonly ReceiptLandedCost[] {
  const freightMinor = input.freightMinor ?? 0;
  assertMoney(freightMinor);
  if (input.lines.length === 0) throw new PharmacyReceivingError('INVALID_QUANTITY');
  const costs = input.lines.map((line) => receiptLineCost(line).costMinor);
  const shares = allocateByWeight(freightMinor, costs);
  return input.lines.map((line, index) => ({
    allocatedFreightMinor: shares[index]!,
    unitCostMinor: receiptLineUnitCostMinor({
      ...line,
      allocatedChargeMinor: shares[index]! + (line.allocatedChargeMinor ?? 0),
    }),
  }));
}

/**
 * PUR-03: the share of an order line's allocated freight and other charges that
 * one delivery carries. It is prorated by paid canonical units, so a delivery in
 * a different pack size than ordered still carries the share of what arrived,
 * and it is cumulative: the charge already capitalised by earlier receipts and
 * earlier lots of the same order line is subtracted, and the running total is
 * capped at the ordered quantity. However the order line is split or
 * over-delivered, its lots together never carry more than the whole allocation.
 */
export function receiptLineAllocatedChargeMinor(input: {
  orderLineAllocatedChargeMinor: number;
  /** Paid (non-bonus) canonical units the order line was placed for. */
  orderedPaidCanonicalUnits: number;
  /** Paid canonical units already received against the order line elsewhere. */
  previouslyReceivedPaidCanonicalUnits: number;
  /** Paid canonical units this delivery brings. */
  receivedPaidCanonicalUnits: number;
}): number {
  const {
    orderLineAllocatedChargeMinor,
    orderedPaidCanonicalUnits,
    previouslyReceivedPaidCanonicalUnits,
    receivedPaidCanonicalUnits,
  } = input;
  assertMoney(orderLineAllocatedChargeMinor);
  assertUnits(previouslyReceivedPaidCanonicalUnits);
  assertUnits(receivedPaidCanonicalUnits);
  if (!Number.isSafeInteger(orderedPaidCanonicalUnits) || orderedPaidCanonicalUnits <= 0) {
    throw new PharmacyReceivingError('INVALID_QUANTITY');
  }
  const allocatedThrough = (units: number) =>
    divideRoundHalfUp(
      orderLineAllocatedChargeMinor * Math.min(units, orderedPaidCanonicalUnits),
      orderedPaidCanonicalUnits
    );
  return (
    allocatedThrough(previouslyReceivedPaidCanonicalUnits + receivedPaidCanonicalUnits) -
    allocatedThrough(previouslyReceivedPaidCanonicalUnits)
  );
}

// ---------------------------------------------------------------------------
// PUR-04 — the three-way match
// ---------------------------------------------------------------------------

export type ReceivingExceptionKind =
  | 'SHORTAGE'
  | 'OVERAGE'
  | 'DAMAGE'
  | 'PRICE_CONFLICT'
  | 'PACK_CONFLICT'
  | 'BONUS_SHORTAGE'
  | 'SCHEME_EXPIRED';

export type MatchException = {
  kind: ReceivingExceptionKind;
  detail: string;
  expectedUnits: number | null;
  observedUnits: number | null;
  expectedMinor: number | null;
  observedMinor: number | null;
};

/** The order side of the match. Absent on the PUR-05 direct path. */
export type OrderedTerms = {
  canonicalUnitsPerPack: number;
  /** Ordered plus scheme units: what the supplier undertook to deliver. */
  orderedCanonicalUnits: number;
  bonusCanonicalUnits: number;
  listPricePerPackMinor: number;
  /** Canonical units already booked against this order line by earlier receipts. */
  previouslyReceivedUnits: number;
  /**
   * DEV-690: scheme (free) units already booked against this order line by
   * earlier receipts. Present only when the bonus leg is being checked.
   */
  previouslyReceivedBonusUnits?: number;
  /** DEV-690: last day the distributor's scheme on this order line is honoured. */
  schemeValidUntil?: Date | null;
};

/** The goods-and-invoice side of the match. */
export type ReceivedTerms = {
  canonicalUnitsPerPack: number;
  arrivedCanonicalUnits: number;
  rejectedCanonicalUnits: number;
  rejectionReason: string | null;
  invoicedPricePerPackMinor: number;
  /** DEV-690: the free units within `arrivedCanonicalUnits`. */
  bonusCanonicalUnits?: number;
  /** DEV-690: when the goods arrived, judged against the scheme's validity. */
  receivedAt?: Date;
};

/**
 * PUR-04: compare the purchase order, the supplier invoice and the goods, and
 * return every discrepancy as an exception.
 *
 * Returns a report, never a refusal. Exceptions are ordered by kind so that a
 * given receipt always produces the same list, and quantities are compared in
 * canonical units — which is the only common denominator when the delivered
 * pack size is itself one of the things that disagrees.
 *
 * With no `ordered` terms — the PUR-05 direct path, or a line received against
 * an invoice with no ordered counterpart — there is nothing to match a quantity
 * or a price against, so only damage is reportable. That is parity, not a gap:
 * the same validation and the same postings run either way, and the direct path
 * simply has no third leg to compare.
 */
export function matchReceiptLine(input: {
  ordered: OrderedTerms | null;
  received: ReceivedTerms;
}): readonly MatchException[] {
  const { ordered, received } = input;
  assertUnits(received.arrivedCanonicalUnits);
  assertUnits(received.rejectedCanonicalUnits);

  const exceptions: MatchException[] = [];

  if (ordered) {
    assertUnits(ordered.previouslyReceivedUnits);
    const expected = ordered.orderedCanonicalUnits + ordered.bonusCanonicalUnits;
    // Cumulative, so a second delivery closing a short first one clears rather
    // than compounding the shortage.
    const observed = ordered.previouslyReceivedUnits + received.arrivedCanonicalUnits;

    if (observed < expected) {
      exceptions.push({
        kind: 'SHORTAGE',
        detail: `Ordered ${expected} canonical units; ${observed} received so far, short by ${expected - observed}.`,
        expectedUnits: expected,
        observedUnits: observed,
        expectedMinor: null,
        observedMinor: null,
      });
    } else if (observed > expected) {
      exceptions.push({
        kind: 'OVERAGE',
        detail: `Ordered ${expected} canonical units; ${observed} received so far, over by ${observed - expected}.`,
        expectedUnits: expected,
        observedUnits: observed,
        expectedMinor: null,
        observedMinor: null,
      });
    }
  }

  // DEV-690: the scheme leg. The total above already counts free units, so a
  // supplier shipping extra paid packs in place of the bonus would match on
  // quantity alone; the free units are checked on their own.
  if (ordered && ordered.bonusCanonicalUnits > 0) {
    if (received.bonusCanonicalUnits !== undefined) {
      assertUnits(received.bonusCanonicalUnits);
      const previousBonus = ordered.previouslyReceivedBonusUnits ?? 0;
      assertUnits(previousBonus);
      const bonusObserved = previousBonus + received.bonusCanonicalUnits;
      if (bonusObserved < ordered.bonusCanonicalUnits) {
        exceptions.push({
          kind: 'BONUS_SHORTAGE',
          detail:
            `Scheme promised ${ordered.bonusCanonicalUnits} free canonical units; ` +
            `${bonusObserved} received so far, short by ${ordered.bonusCanonicalUnits - bonusObserved}.`,
          expectedUnits: ordered.bonusCanonicalUnits,
          observedUnits: bonusObserved,
          expectedMinor: null,
          observedMinor: null,
        });
      }
    }
    if (
      ordered.schemeValidUntil &&
      received.receivedAt &&
      received.receivedAt.getTime() > ordered.schemeValidUntil.getTime()
    ) {
      exceptions.push({
        kind: 'SCHEME_EXPIRED',
        detail:
          `Scheme of ${ordered.bonusCanonicalUnits} free canonical units was valid until ` +
          `${ordered.schemeValidUntil.toISOString().slice(0, 10)}; goods arrived ` +
          `${received.receivedAt.toISOString().slice(0, 10)}. Confirm the distributor still honours it.`,
        expectedUnits: null,
        observedUnits: null,
        expectedMinor: null,
        observedMinor: null,
      });
    }
  }

  if (received.rejectedCanonicalUnits > 0) {
    exceptions.push({
      kind: 'DAMAGE',
      detail:
        `${received.rejectedCanonicalUnits} of ${received.arrivedCanonicalUnits} canonical units rejected at receipt` +
        `${received.rejectionReason ? `: ${received.rejectionReason}` : '.'}`,
      expectedUnits: received.arrivedCanonicalUnits,
      observedUnits: received.rejectedCanonicalUnits,
      expectedMinor: null,
      observedMinor: null,
    });
  }

  if (ordered && received.invoicedPricePerPackMinor !== ordered.listPricePerPackMinor) {
    exceptions.push({
      kind: 'PRICE_CONFLICT',
      detail: `Ordered at ${ordered.listPricePerPackMinor} per pack; invoiced at ${received.invoicedPricePerPackMinor}.`,
      expectedUnits: null,
      observedUnits: null,
      expectedMinor: ordered.listPricePerPackMinor,
      observedMinor: received.invoicedPricePerPackMinor,
    });
  }

  if (ordered && received.canonicalUnitsPerPack !== ordered.canonicalUnitsPerPack) {
    exceptions.push({
      kind: 'PACK_CONFLICT',
      detail: `Ordered in packs of ${ordered.canonicalUnitsPerPack} canonical units; delivered in packs of ${received.canonicalUnitsPerPack}.`,
      expectedUnits: ordered.canonicalUnitsPerPack,
      observedUnits: received.canonicalUnitsPerPack,
      expectedMinor: null,
      observedMinor: null,
    });
  }

  return exceptions;
}

/** DRAFT → POSTED → REVERSED; a posted receipt is corrected by reversal only. */
export type GoodsReceiptStatus = 'DRAFT' | 'POSTED' | 'REVERSED' | 'CANCELLED';

const GOODS_RECEIPT_TRANSITIONS: Record<GoodsReceiptStatus, readonly GoodsReceiptStatus[]> = {
  DRAFT: ['POSTED', 'CANCELLED'],
  POSTED: ['REVERSED'],
  REVERSED: [],
  CANCELLED: [],
};

export function assertGoodsReceiptTransition(
  from: GoodsReceiptStatus,
  to: GoodsReceiptStatus
): void {
  if (!GOODS_RECEIPT_TRANSITIONS[from].includes(to)) {
    throw new PharmacyReceivingError('INVALID_TRANSITION');
  }
}
