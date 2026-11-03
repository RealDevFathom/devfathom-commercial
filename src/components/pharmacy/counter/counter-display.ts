/**
 * Plain-language display helpers for the pharmacy counter.
 *
 * Each "disabled reason" helper mirrors the exact condition that disables its
 * button, so the cashier always sees why an action is unavailable. A helper
 * returns null when the button is enabled, or when another visible message on
 * screen already explains the state (for example while the counter is busy).
 */
import { formatReceiptDate } from '@/lib/pharmacy/counter-receipt';

export type AddToCartReasonInput = {
  busy: boolean;
  row: {
    onHandUnits: number;
    saleUnitCount: number;
    priced: boolean;
  } | null;
  unitSelected: boolean;
  preview: { sufficient: boolean; availableUnits: number } | null;
};

/** Why "Add to cart" is disabled. Mirrors `busy || !activeRow || !preview?.sufficient`. */
export function addToCartDisabledReason({
  busy,
  row,
  unitSelected,
  preview,
}: AddToCartReasonInput): string | null {
  if (busy) return null;
  if (!row) return 'Select a medicine from the search results first.';
  if (preview?.sufficient) return null;
  if (row.onHandUnits <= 0) return 'Out of stock. Record it as unmet demand instead.';
  if (row.saleUnitCount === 0) {
    return 'This medicine cannot be sold yet. Ask your manager to check its pack sizes.';
  }
  if (!unitSelected) return 'Choose pack, strip or unit first.';
  if (!row.priced || !preview) return 'This medicine has no price yet. Ask your manager to set it.';
  return `Only ${preview.availableUnits} units in stock. Lower the quantity.`;
}

/** Why "Find receipt" is disabled. Mirrors `locked || !isSafeInteger(n) || n < 1`. */
export function findReceiptDisabledReason({
  locked,
  value,
}: {
  locked: boolean;
  value: string;
}): string | null {
  if (locked) return null;
  if (value.trim() === '') return 'Enter a receipt number.';
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    return 'Enter the receipt number as printed, for example 1042.';
  }
  return null;
}

export type TenderReasonInput = {
  state: 'idle' | 'loading' | 'ready' | 'settled' | 'stale' | 'error' | 'unavailable';
  balanceMinor: number | null;
  disabled: boolean;
  takingPayment: boolean;
  unknownOutcome: boolean;
  blocked: boolean;
  amountValid: boolean;
  cashProblem: boolean;
  manual: boolean;
  manualLoading: boolean;
  manualReady: boolean;
  manualDetailsValid: boolean;
  khata: boolean;
  khataLoading: boolean;
  khataAccountChosen: boolean;
  khataOverLimitUnapproved: boolean;
};

/**
 * Why "Take payment" is disabled. Follows the same checks as the tender
 * panel's `submittable` flag, in the order a cashier can act on them.
 *
 * Bill states other than ready and settled return null: the tender status line
 * directly above the button already says what to do (add an item, refresh the
 * bill, check the payment outcome).
 */
export function tenderDisabledReason(input: TenderReasonInput): string | null {
  if (input.takingPayment || input.unknownOutcome) return null;
  if (input.state === 'settled') return 'This bill is fully paid.';
  if (input.state !== 'ready' || input.balanceMinor === null) return null;
  if (input.disabled) return null;
  if (input.blocked) return 'Clear the safety block on this bill first.';
  if (input.balanceMinor <= 0) return 'Nothing is left to pay on this bill.';
  if (!input.amountValid) return 'Enter an amount up to the balance due.';
  if (input.cashProblem) return 'Check the cash received.';
  if (input.manual) {
    if (input.manualLoading) return 'Loading payment details…';
    if (!input.manualReady) return 'Payment details for this method are not set up.';
    if (!input.manualDetailsValid) return 'Enter the payer name and payment reference.';
  }
  if (input.khata) {
    if (input.khataLoading) return 'Loading khata accounts…';
    if (!input.khataAccountChosen) return 'Choose a khata account.';
    if (input.khataOverLimitUnapproved) {
      return 'This goes over the credit limit. The owner must approve it.';
    }
  }
  return null;
}

/**
 * The stock line under a search result. A medicine with nothing on hand reads
 * "Out of stock" rather than an empty batch and expiry.
 */
export function counterSearchStockText(row: {
  presentation: string;
  dosageForm: string | null;
  batchNumber: string | null;
  nearestSafeExpiry: string | null;
  onHandUnits: number;
  sellable: boolean;
  notes: readonly string[];
}): string {
  const parts = [row.presentation];
  if (row.dosageForm) parts.push(row.dosageForm);
  if (row.onHandUnits <= 0) {
    parts.push('Out of stock');
  } else {
    if (row.batchNumber) parts.push(`Batch ${row.batchNumber}`);
    if (row.nearestSafeExpiry) parts.push(`Exp ${formatReceiptDate(row.nearestSafeExpiry)}`);
    parts.push(`${row.onHandUnits} units`);
    if (!row.sellable) parts.push('Cannot be sold yet');
  }
  parts.push(...row.notes);
  return parts.join(' · ');
}

const CUSTODY_LABEL: Record<string, string> = {
  NOT_HELD: 'Patient kept original',
  HELD_AT_PHARMACY: 'Original kept here',
  RETURNED_TO_PATIENT: 'Original returned to patient',
  TRANSFERRED: 'Original transferred',
};

/** Plain words for where the original paper prescription is. */
export function prescriptionCustodyLabel(state: string): string {
  return CUSTODY_LABEL[state] ?? state.replaceAll('_', ' ').toLowerCase();
}
