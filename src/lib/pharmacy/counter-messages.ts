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

import { capabilityMatches } from '@/lib/abac/capabilities';
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';

/** The refusal the server sends when the actor may not sell a prescription-only line. */
const RX_SALE_DENIED_SERVER_MESSAGE =
  'Selling a prescription-only or restricted medicine needs the pharmacist dispensing permission.';

/**
 * DEV-622: the shipped pharmacy roles that can finish a prescription sale alone. They hold
 * both the exact `pharmacy:dispense` grant the Rx sale gate checks and `pharmacy:counter`
 * for payment, matched by the same rule the server uses. Wildcards never reach the
 * dispensing grant, so the plain Owner (`pharmacy:*`) and the workspace administrator
 * (`*`) are not named: they cannot sell a prescription line either.
 */
export const RX_SALE_COMPLETING_ROLE_NAMES: readonly string[] = PHARMACY_ROLE_TEMPLATES.filter(
  (role) =>
    (['pharmacy:dispense', 'pharmacy:counter'] as const).every((action) =>
      role.capabilities.some((grant) => capabilityMatches(grant, action))
    )
).map((role) => role.name);

function whoCanCompleteSale(names: readonly string[]): string {
  const quoted = names.map((name) => `“${name}”`);
  const list =
    quoted.length <= 2
      ? quoted.join(' or ')
      : `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`;
  return `Someone with the ${list} role can complete this sale.`;
}

/** DEV-622: shown when someone without the dispensing grant reaches a prescription line. */
export const COUNTER_RX_NEEDS_PHARMACIST_MESSAGE = `Only a pharmacist can sell a prescription-only or restricted medicine. ${whoCanCompleteSale(RX_SALE_COMPLETING_ROLE_NAMES)}`;

/** DEV-622: shown when someone without counter (payment) access tries to take payment. */
export const COUNTER_PAYMENT_NEEDS_COUNTER_ACCESS_MESSAGE = `Your role does not take payments or open the cash drawer. ${whoCanCompleteSale(RX_SALE_COMPLETING_ROLE_NAMES)}`;

/** The server's generic capability refusal (no `pharmacy:counter` for payment and drawer). */
const NO_PERMISSION_SERVER_MESSAGE = 'You do not have permission for this action.';

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
  // DEV-830: the chosen pack, strip or loose unit does not match the stored pack setup.
  INVALID_SALE_UNIT:
    'That unit does not match how this item is packed. Search for it again and choose the unit from the list.',
  // Sale aggregate (POS).
  PRICE_ABOVE_MRP: 'That price is above the printed MRP, which is not allowed.',
  MARGIN_GUARDRAIL: 'That discount falls below the permitted margin.',
  APPROVAL_REQUIRED: 'A supervisor must approve this discount before it can be applied.',
  REGULATED_DISCOUNT_REFUSED: 'Regulated medicines cannot be discounted.',
  VOUCHER_CATEGORY_REFUSED:
    'Vouchers apply to non-medicine items only. Remove the voucher from this line.',
  VOUCHER_INVALID: 'That voucher is not valid at this branch. Check the voucher and try again.',
  VOUCHER_PIN_REQUIRED: 'Enter your own PIN to redeem this voucher.',
  UNSAFE_STOCK: 'This batch cannot return to saleable stock. Choose quarantine instead.',
  RETURN_EXCEEDS_SOLD: 'The return is larger than the quantity originally sold.',
  CONSENT_REQUIRED: 'Recorded patient consent is required before dispensing this medicine.',
  LOYALTY_CONSENT_REQUIRED:
    'Loyalty consent is required before linking this customer or redeeming loyalty points.',
  // DEV-712: the bill was paid, voided or held. A scan opens the next bill by
  // itself, so the sentence never sends the operator to refresh.
  INVALID_STATE:
    'That bill is no longer open: it was paid, voided or put on hold. Resume it if it is on hold, or start the next bill.',
  // DEV-623: money taken on a bill comes back through a refund, never a void.
  BILL_HAS_PAYMENTS:
    'Payment has already been taken on this bill. A manager or owner must refund it before the bill can be voided.',
  // DEV-821: a void releases stock, so it stays with the bill's cashier.
  NOT_BILL_OWNER:
    'Another cashier opened this bill. Only that cashier or a manager or owner can void it.',
  // DEV-92: a serialized pack (2D code on the bottle, tube or box) is sold once.
  SERIAL_ALREADY_SOLD:
    'This pack’s serial is already on a sale. Do not sell it again; set the pack aside and check it with the pharmacist.',
  SERIAL_MEDICINE_MISMATCH: 'This 2D code is not the barcode of the medicine being sold.',
  SERIAL_NOT_READABLE:
    'This 2D code has no readable pack serial. Search the medicine by name instead.',
  SERIAL_LOT_UNAVAILABLE:
    'The batch this pack came from cannot be sold from this counter. Check the pack against stock in Inventory.',
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
  // DEV-630: the server books money on today in the workspace zone only.
  BUSINESS_DATE_NOT_CURRENT:
    'Payments, refunds and drawers use today’s business date only. Refresh the counter and try again.',
  // #1338: only cash needs the drawer. Shared by cash payments, cash refunds
  // and drawer counts/close, so it names cash in or out, not one operation.
  DRAWER_NOT_OPEN:
    'The cash drawer for this counter is not open. Open it before taking or paying out cash.',
  OPEN_DRAWER: 'A drawer is already open on this counter. Close it before opening another.',
  // DEV-821: cash goes only into a till the signed-in user runs.
  DRAWER_NOT_YOURS:
    'Another cashier runs the cash drawer on this counter. Ask a manager or owner to hand it over to you, then take the cash.',
  CASHIER_NOT_ASSIGNED:
    'That person is not an active member of this branch. Choose a cashier assigned to this branch.',
  SALE_REDEEMED_BY_OTHER_CUSTOMER:
    'Another customer redeemed loyalty points on this bill. Open Khata for that customer or start a new bill.',
  PATIENT_AMBIGUOUS:
    'More than one patient has this name and phone. Select the patient on the counter, then open Khata.',
  PHONE_REQUIRED: 'Enter the customer’s phone number to open a Khata account.',
  PATIENT_NOT_FOUND: 'That patient is not available in this workspace. Select the patient again.',
  PRESCRIPTION_PATIENT_MISMATCH:
    'This bill carries a prescription for a different patient. Link that patient instead.',
  SALE_NOT_OPEN:
    'That bill is no longer open for payment: it was paid, voided or put on hold. Resume it if it is on hold, or start the next bill.',
  INVALID_AMOUNT: 'Enter a payment amount greater than zero.',
  OVER_TENDER: 'That payment is more than the amount still due on this bill.',
  REFUND_EXCEEDS_TENDER: 'That refund is larger than the amount taken on this bill.',
  IDEMPOTENCY_CONFLICT:
    'That payment was already recorded with different details. Refresh the counter and check the bill.',
  UNCERTIFIED_PROVIDER: 'This tender needs a connected provider. Take another tender.',
  INVALID_MANUAL_CAPTURE:
    'Check the payment reference and approval code, or confirm this tender is enabled at this branch.',
  // DEV-863: prepaid money goes back to the customer's prepaid balance, never as cash.
  PREPAID_REFUND_RESTORES_BALANCE:
    'This payment came from the customer’s prepaid balance. The refund goes back to that balance; do not give cash.',
  MOCK_PROVIDER_IN_RELEASE:
    'Card payments are not configured on this deployment. Take another tender.',
  REOPEN_REASON_REQUIRED: 'Reopening a closed drawer needs a recorded reason.',
  INVALID_RECEIPT_LEASE:
    "This counter's offline receipt numbers are out of date. Reconnect the counter so it can renew them, then try again.",
  LEASE_REQUIRES_SETTLEMENT:
    'An offline bill must be paid in full in one payment. Enter the full amount due.',
  // Khata repayments (K4, DEV-731).
  PAYMENT_EXCEEDS_BALANCE:
    'That payment is more than the khata balance still owed. Enter the amount owed or less.',
  ACCOUNT_NOT_FOUND: 'That khata account is not active on this branch. Search again.',
  REFERENCE_REQUIRED: 'Enter the transfer or wallet reference for a non-cash payment.',
  PERIOD_CLOSED: 'The accounting period for today is closed. Ask the owner to reopen it.',
  // DEV-622: the server's Rx sale refusal (a default Cashier on a prescription line, at
  // add-line or at payment) names who can finish the bill.
  [RX_SALE_DENIED_SERVER_MESSAGE]: COUNTER_RX_NEEDS_PHARMACIST_MESSAGE,
};

/**
 * DEV-712: how loudly a refusal is shown. Routine state — a bill that already
 * moved on, a drawer still closed, a short search — is a neutral `info` notice.
 * `danger` is kept for what the operator must not miss: controlled-drug blocks
 * and a payment whose outcome is in doubt.
 * Any other mapped reason is a `warning` the operator can correct. A failure
 * this module does not know stays `danger`: it may be a safety refusal raised
 * as prose (a controlled-medicine denial), which must not be quietened.
 */
export type CounterNoticeTone = 'info' | 'warning' | 'danger';

const COUNTER_INFO_REASONS = new Set([
  'INVALID_STATE',
  'SALE_NOT_OPEN',
  'NOT_FOUND',
  'DRAWER_NOT_OPEN',
  'OPEN_DRAWER',
  'DAY_CLOSED',
  'INVALID_QUERY',
  'INVALID_QUANTITY',
  'INVALID_UNITS',
  'INVALID_AMOUNT',
  'INVALID_RECEIPT_LEASE',
  'LEASE_REQUIRES_SETTLEMENT',
]);

const COUNTER_DANGER_REASONS = new Set([
  // Controlled-drug blocks.
  'COAUTH_REQUIRED',
  'CONSENT_REQUIRED',
  // A payment recorded with different details: its outcome is in doubt.
  'IDEMPOTENCY_CONFLICT',
]);

export function counterErrorTone(error: unknown): CounterNoticeTone {
  const reason = error instanceof Error ? error.message : '';
  if (COUNTER_INFO_REASONS.has(reason)) return 'info';
  if (COUNTER_DANGER_REASONS.has(reason)) return 'danger';
  return COUNTER_ERROR_MESSAGES[reason] ? 'warning' : 'danger';
}

/**
 * DEV-712: the refusal a write gets when its bill was already settled, voided or
 * held. The counter answers it by re-reading the bill and opening a fresh one.
 */
export function counterBillMovedOn(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'INVALID_STATE' || error.message === 'SALE_NOT_OPEN')
  );
}

/**
 * A reason code as the aggregates raise it: SCREAMING_SNAKE_CASE, no spaces.
 * Anything of this shape is an internal symbol, never operator copy.
 */
const RAW_REASON_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

/** Shown when a reason is unmapped, so no code can reach the counter. */
/**
 * #1338: shown on the Cash tender button while this counter's drawer is closed.
 * Payment-specific, so it may say the other tenders still work.
 */
export const COUNTER_CASH_DRAWER_CLOSED_MESSAGE =
  'Open the cash drawer to take cash. Other tenders do not need the drawer.';

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

function isForbidden(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('data' in error)) return false;
  const data = (error as { data?: unknown }).data;
  return (
    typeof data === 'object' && data !== null && (data as { code?: unknown }).code === 'FORBIDDEN'
  );
}

/**
 * DEV-622: payment and drawer actions need `pharmacy:counter`. A default Pharmacist is
 * refused with the server's generic sentence; at those two actions it means the operator's
 * role does not take payments, so the counter says who can finish the bill instead.
 */
export function counterPaymentErrorMessage(error: unknown): string {
  if (
    isForbidden(error) &&
    error instanceof Error &&
    error.message === NO_PERMISSION_SERVER_MESSAGE
  )
    return COUNTER_PAYMENT_NEEDS_COUNTER_ACCESS_MESSAGE;
  return counterErrorMessage(error);
}
