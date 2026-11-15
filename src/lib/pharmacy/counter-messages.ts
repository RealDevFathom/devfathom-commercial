/**
 * PH-POS / UX rule 11 — the counter never shows the operator a raw reason code.
 *
 * The pharmacy aggregates raise typed errors whose `reason` IS the message the
 * router forwards, so an unmapped failure reaches the counter as
 * `INVALID_ARRANGEMENT` or `DRAWER_NOT_OPEN` — a symbol that names neither the
 * problem nor the fix. Every reason a counter action can actually raise is given
 * the sentence a pharmacist can act on.
 *
 * Pure and database-free so the mapping is testable on its own; the console
 * imports `counterErrorMessage` and never formats a failure itself.
 */

export const COUNTER_ERROR_MESSAGES: Record<string, string> = {
  // Inventory (INV) — arrangement, stock and safety.
  // Raised in BOTH directions — too few loose units for a strip sale, and a
  // pack sale whose remainder after the loose pool is not a whole pack — so the
  // sentence names both remedies rather than misdirecting the operator to
  // Inventory when the fix is to sell the open units first.
  INVALID_ARRANGEMENT:
    'This quantity does not match how the batch sits on the shelf. Sell the open loose units first, or break a pack in Inventory before selling strips or loose units.',
  INSUFFICIENT_STOCK: 'There is not enough safe stock on hand for this quantity.',
  BLOCKED_STOCK:
    'This batch cannot be dispensed — it is expired, quarantined or recalled. Choose another batch.',
  // #659: a batch on the bill changed after its line was added; payment is refused.
  SALE_BATCH_RECALLED:
    'A batch on this bill was recalled after it was added, so it cannot be sold. Void the bill and sell from a safe batch.',
  SALE_BATCH_QUARANTINED:
    'A batch on this bill was quarantined after it was added, so it cannot be sold. Void the bill and sell from a safe batch.',
  SALE_BATCH_EXPIRED:
    'A batch on this bill has expired since it was added, so it cannot be sold. Void the bill and sell from a safe batch.',
  SALE_BATCH_BLOCKED:
    'A batch on this bill can no longer be sold. Void the bill and sell from a safe batch.',
  OVERRIDE_EVIDENCE_MISSING: 'Dispensing this batch needs a recorded override reason.',
  COAUTH_REQUIRED: 'This action needs a second authorised pharmacist to countersign.',
  INVALID_UNITS: 'That quantity is not a whole number of units.',
  INVALID_QUANTITY: 'Enter a whole quantity of at least one.',
  // Sale aggregate (POS).
  PRICE_ABOVE_MRP: 'That price is above the printed MRP, which is not allowed.',
  MARGIN_GUARDRAIL: 'That discount falls below the permitted margin.',
  APPROVAL_REQUIRED: 'A supervisor must approve this discount before it can be applied.',
  REGULATED_DISCOUNT_REFUSED: 'Regulated medicines cannot be discounted.',
  UNSAFE_STOCK: 'This batch cannot return to saleable stock. Choose quarantine instead.',
  RETURN_EXCEEDS_SOLD: 'The return is larger than the quantity originally sold.',
  CONSENT_REQUIRED: 'Recorded patient consent is required before dispensing this medicine.',
  LOYALTY_CONSENT_REQUIRED:
    'Loyalty consent is required before linking this customer or redeeming loyalty points.',
  INVALID_STATE: 'This bill has already moved on. Refresh the counter and try again.',
  // Scope and lookup.
  NOT_FOUND: 'That record is no longer available. Refresh the counter and try again.',
  CROSS_BRANCH_REFERENCE: 'That record belongs to a different branch.',
  CROSS_TENANT_REFERENCE: 'That record belongs to a different organization.',
  INVALID_QUERY: 'Type at least two characters to search.',
  // Tenders and the cash drawer (POS-07) — every reason
  // `PharmacySettlementError` can raise, because these are the failures a
  // cashier hits mid-bill rather than during setup.
  DAY_CLOSED:
    'This business day is closed. New payments and drawer changes are blocked. Use an open business day.',
  DRAWER_NOT_OPEN: 'Open the cash drawer for this counter before taking a payment.',
  OPEN_DRAWER: 'A drawer is already open on this counter. Close it before opening another.',
  SALE_NOT_OPEN: 'This bill is no longer open for payment. Refresh the counter and try again.',
  INVALID_AMOUNT: 'Enter a payment amount greater than zero.',
  OVER_TENDER: 'That payment is more than the amount still due on this bill.',
  REFUND_EXCEEDS_TENDER: 'That refund is larger than the amount taken on this bill.',
  IDEMPOTENCY_CONFLICT:
    'That payment was already recorded with different details. Refresh the counter and check the bill.',
  UNCERTIFIED_PROVIDER:
    'This card terminal is not certified for live payments. Take another tender.',
  MOCK_PROVIDER_IN_RELEASE:
    'Card payments are not configured on this deployment. Take another tender.',
  REOPEN_REASON_REQUIRED: 'Reopening a closed drawer needs a recorded reason.',
  // Khata repayments (K4, DEV-731).
  PAYMENT_EXCEEDS_BALANCE:
    'That payment is more than the khata balance still owed. Enter the amount owed or less.',
  ACCOUNT_NOT_FOUND: 'That khata account is not active on this branch. Search again.',
  REFERENCE_REQUIRED: 'Enter the transfer or wallet reference for a non-cash payment.',
  PERIOD_CLOSED: 'The accounting period for today is closed. Ask the owner to reopen it.',
};

/**
 * A reason code as the aggregates raise it: SCREAMING_SNAKE_CASE, no spaces.
 * Anything of this shape is an internal symbol, never operator copy.
 */
const RAW_REASON_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

/** Shown when a reason is unmapped, so no code can reach the counter. */
export const COUNTER_UNKNOWN_ERROR_MESSAGE =
  'That action could not be completed at the counter. Refresh and try again, or ask a supervisor.';

/** Shown when the failure carries nothing usable at all. */
export const COUNTER_GENERIC_ERROR_MESSAGE = 'Request failed.';

/**
 * Turn a thrown counter failure into a sentence the operator can act on.
 *
 * UX rule 11 is unconditional, so an UNMAPPED reason must still not surface as
 * a code — falling through to the raw message is what leaked `DRAWER_NOT_OPEN`
 * onto the counter during the POS browser run. The shape is therefore checked
 * rather than trusted, and only prose is ever passed through.
 */
export function counterErrorMessage(error: unknown): string {
  if (!(error instanceof Error) || !error.message) return COUNTER_GENERIC_ERROR_MESSAGE;
  const mapped = COUNTER_ERROR_MESSAGES[error.message];
  if (mapped) return mapped;
  if (RAW_REASON_CODE.test(error.message)) return COUNTER_UNKNOWN_ERROR_MESSAGE;
  return error.message;
}
