/**
 * PH-PUR / PUR-06 — the pure kernel behind purchase returns, expiry claims,
 * debit notes and supplier-credit settlement (PRD §6.3 PUR-06; §8A invariants 9,
 * 15, 26, 27).
 *
 * Database-free and total, like `purchasing.ts` and `receiving.ts`. The rules
 * that matter here are arithmetic and state-machine rules, and keeping them
 * outside PostgreSQL is what lets the negative paths be enumerated exhaustively.
 *
 * TWO NUMBERS, NEVER ONE. `expectedCreditMinor` is what the pharmacy claimed;
 * the received figure is the sum of the credits a supplier actually allocated.
 * Nothing in this module ever writes one over the other — PUR-06's acceptance is
 * that the difference stays *visible*, which is impossible once they share a
 * column.
 *
 * MONEY IS MINOR UNITS, quantities are integer canonical base units (§8A
 * invariant 1). A non-integer, negative or unsafe value raises rather than
 * rounding.
 */

const dispatchRefusals = {
  PURCHASE_UNCLEAR:
    'The return must identify one controlled purchase from this supplier for the quantity being sent.',
  REGISTER_DISAGREES:
    'The controlled register and stock balance disagree. Reconcile this batch before dispatch.',
  REGISTER_REFUSED:
    'The register could not confirm this supplier return. Check the original dispatch and register before trying again.',
  ALREADY_DISPATCHED: 'This return has already been dispatched.',
  LATE_OWNER_REQUIRED: 'Only the pharmacy owner can record a late supplier return.',
  LATE_DISPATCH_UNAVAILABLE: 'This line has no unrecorded controlled supplier dispatch.',
  LATE_MOVEMENT_UNCLEAR:
    'The original stock movement could not be identified uniquely. The register was left unchanged.',
} as const;

export class PharmacySupplierReturnError extends Error {
  constructor(
    readonly reason:
      | 'INVALID_QUANTITY'
      | 'INVALID_MONEY'
      | 'INVALID_TRANSITION'
      | 'RETURN_WINDOW_CLOSED'
      | 'OVER_ALLOCATION'
      | keyof typeof dispatchRefusals
      | 'ALREADY_CLAIMED'
      | 'NOT_FOUND'
      | 'CROSS_TENANT_REFERENCE'
      | 'CROSS_BRANCH_REFERENCE'
      | 'SELF_APPROVAL'
  ) {
    super(
      Object.hasOwn(dispatchRefusals, reason)
        ? dispatchRefusals[reason as keyof typeof dispatchRefusals]
        : reason
    );
  }
}

function assertMoney(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PharmacySupplierReturnError('INVALID_MONEY');
  }
}

function assertPositiveUnits(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PharmacySupplierReturnError('INVALID_QUANTITY');
  }
}

// ── The return lifecycle ────────────────────────────────────────────────────

export type PurchaseReturnStatus = 'DRAFT' | 'SUBMITTED' | 'DISPATCHED' | 'SETTLED' | 'CANCELLED';

/**
 * DRAFT is deliberately inert — it neither reserves stock nor moves it — because
 * PUR-07's one-click claim action is only safe under §8A invariant 29 if the
 * document it produces cannot touch inventory. SUBMITTED is where the INV-09
 * reservation is taken and the quantity stops being saleable; DISPATCHED is
 * where the RETURN_TO_SUPPLIER movements post.
 *
 * Cancellation is available only before dispatch: once stock has physically left
 * on an append-only movement, the correction is a reversal, not a cancellation
 * (§8A invariant 8).
 */
const RETURN_TRANSITIONS: Record<PurchaseReturnStatus, readonly PurchaseReturnStatus[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: ['SETTLED'],
  SETTLED: [],
  CANCELLED: [],
};

export function assertPurchaseReturnTransition(
  from: PurchaseReturnStatus,
  to: PurchaseReturnStatus
): void {
  if (!RETURN_TRANSITIONS[from].includes(to)) {
    throw new PharmacySupplierReturnError('INVALID_TRANSITION');
  }
}

/**
 * A return line may only be submitted while the supplier's window is still open
 * (PUR-06: "supplier return window"). The comparison is exclusive at the
 * deadline: a window that ends at 09:00 is closed at 09:00.
 */
export function assertReturnWindowOpen(input: { returnWindowEndsAt: Date; at: Date }): void {
  if (input.at.getTime() >= input.returnWindowEndsAt.getTime()) {
    throw new PharmacySupplierReturnError('RETURN_WINDOW_CLOSED');
  }
}

/**
 * §8A invariant 26: the pharmacy actor who submits a return may not also be the
 * one who records the supplier's credit against it. The supplier cannot approve
 * its own settlement, and neither can one person on both sides of the claim.
 */
export function assertSettlementSegregation(input: {
  submittedByUserId: string;
  allocatedByUserId: string;
}): void {
  if (input.submittedByUserId === input.allocatedByUserId) {
    throw new PharmacySupplierReturnError('SELF_APPROVAL');
  }
}

// ── Claimable quantity (§8A invariant 9 / INV-09 reservations) ──────────────

export type ClaimableInput = {
  /** AVAILABLE on-hand for the lot, straight off the ledger projection. */
  onHandUnits: number;
  /** Units already held by RESERVED supplier claims against the same lot. */
  reservedUnits: number;
};

/**
 * How many units of a lot may still be claimed. The INV-09 reservation is the
 * single mechanism: a reserved unit is invisible to sale allocation *and*
 * unavailable to a second claim, so "cannot be sold" and "cannot be
 * double-claimed" are two readings of one number rather than two competing
 * counters that could disagree.
 */
export function claimableUnits(input: ClaimableInput): number {
  if (!Number.isSafeInteger(input.onHandUnits) || input.onHandUnits < 0) {
    throw new PharmacySupplierReturnError('INVALID_QUANTITY');
  }
  if (!Number.isSafeInteger(input.reservedUnits) || input.reservedUnits < 0) {
    throw new PharmacySupplierReturnError('INVALID_QUANTITY');
  }
  return Math.max(0, input.onHandUnits - input.reservedUnits);
}

/** Raises `ALREADY_CLAIMED` when `requestedUnits` exceeds what is still claimable. */
export function assertClaimable(input: ClaimableInput & { requestedUnits: number }): void {
  assertPositiveUnits(input.requestedUnits);
  if (input.requestedUnits > claimableUnits(input)) {
    throw new PharmacySupplierReturnError('ALREADY_CLAIMED');
  }
}

// ── Expected vs received credit ─────────────────────────────────────────────

export type DebitNoteStatus = 'OPEN' | 'PARTIALLY_SETTLED' | 'SETTLED' | 'CANCELLED';

export type CreditPosition = {
  expectedCreditMinor: number;
  receivedCreditMinor: number;
  /**
   * Expected minus received. Positive means the supplier still owes; negative
   * means it over-credited. Both are real outcomes and neither is clamped away.
   */
  varianceMinor: number;
  outstandingMinor: number;
  status: DebitNoteStatus;
};

/**
 * The expected/received position of one debit note. `status` is derived, never
 * stored independently, so a note cannot claim SETTLED while money is missing.
 */
export function creditPosition(input: {
  expectedCreditMinor: number;
  allocations: ReadonlyArray<{ amountMinor: number }>;
  cancelled?: boolean;
}): CreditPosition {
  assertMoney(input.expectedCreditMinor);
  let receivedCreditMinor = 0;
  for (const allocation of input.allocations) {
    assertMoney(allocation.amountMinor);
    receivedCreditMinor += allocation.amountMinor;
  }
  const varianceMinor = input.expectedCreditMinor - receivedCreditMinor;
  const outstandingMinor = Math.max(0, varianceMinor);
  const status: DebitNoteStatus = input.cancelled
    ? 'CANCELLED'
    : receivedCreditMinor === 0
      ? 'OPEN'
      : outstandingMinor === 0
        ? 'SETTLED'
        : 'PARTIALLY_SETTLED';
  return {
    expectedCreditMinor: input.expectedCreditMinor,
    receivedCreditMinor,
    varianceMinor,
    outstandingMinor,
    status,
  };
}

/** The expected credit a debit note freezes: the sum of its return lines. */
export function expectedCreditForLines(
  lines: ReadonlyArray<{ expectedCreditMinor: number }>
): number {
  let total = 0;
  for (const line of lines) {
    assertMoney(line.expectedCreditMinor);
    total += line.expectedCreditMinor;
  }
  return total;
}

/**
 * A credit may not be allocated twice. Both ceilings are checked because either
 * one alone lets money be invented: the credit's own unallocated remainder, and
 * the debit note's outstanding balance.
 *
 * Over-crediting by the supplier is a real event, but it is recorded as a
 * separate credit with nothing left to allocate — never as an allocation larger
 * than the note it settles.
 */
export function assertAllocatable(input: {
  amountMinor: number;
  creditAmountMinor: number;
  creditAlreadyAllocatedMinor: number;
  noteExpectedCreditMinor: number;
  noteAlreadyReceivedMinor: number;
}): void {
  assertMoney(input.creditAmountMinor);
  assertMoney(input.creditAlreadyAllocatedMinor);
  assertMoney(input.noteExpectedCreditMinor);
  assertMoney(input.noteAlreadyReceivedMinor);
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new PharmacySupplierReturnError('INVALID_MONEY');
  }
  const creditRemaining = input.creditAmountMinor - input.creditAlreadyAllocatedMinor;
  const noteOutstanding = input.noteExpectedCreditMinor - input.noteAlreadyReceivedMinor;
  if (input.amountMinor > creditRemaining || input.amountMinor > noteOutstanding) {
    throw new PharmacySupplierReturnError('OVER_ALLOCATION');
  }
}
