/**
 * Display-only wording and number formatting for the staged import review list.
 * Nothing here changes stored values, hashes or import logic; raw spellings stay in row detail.
 */

export const STAGED_LIST_INTRO =
  'These rows come from your old system and are waiting for review. They are not in the medicine catalogue or in stock yet, so they cannot be sold. Next: open a medicine to check its name, quantity and prices against your old records. Approval for the catalogue is not available on this screen yet.';

export const STAGED_COLUMN_HEADINGS = [
  'Medicine',
  'Quantity in old system',
  'MRP',
  'Purchase price (from distributor)',
  'Price per unit',
  'Units per pack',
  'Quantity counted for review',
  'Status',
] as const;

export const STAGED_NOT_SUPPLIED = 'Not supplied';
const NOT_SUPPLIED_AS_TEXT = 'Not supplied as text';
export const STAGED_STATUS_LABEL = 'Not reviewed yet';

const EXCEPTION_LABELS: Record<string, string> = {
  MISSING_BATCH: 'No batch or expiry recorded',
  MISSING_EXPIRY: 'No batch or expiry recorded',
  EXPIRED_STOCK: 'Expiry has passed',
  MISSING_MRP: 'MRP not confirmed',
  UNIT_AMBIGUOUS: 'Pack or unit not clear',
  DUPLICATE_PRODUCT: 'Same name as another medicine',
  PARTY_UNMATCHED: 'Supplier not matched',
  BALANCE_MISMATCH: 'Balance does not match',
};

export function plainExceptionLabel(bucket: string): string {
  return EXCEPTION_LABELS[bucket] ?? 'Needs review';
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

/** Money to two decimals (display only). Non-numeric text is returned unchanged. */
export function formatStagedPrice(value: string | null | undefined): string {
  const text = value?.trim();
  if (!text) return NOT_SUPPLIED_AS_TEXT;
  return NUMERIC.test(text) ? Number(text).toFixed(2) : text;
}

/** Quantity without trailing zeros, e.g. 1.0000 -> 1, 2.5000 -> 2.5. */
export function formatStagedQuantity(value: string | null | undefined): string {
  const text = value?.trim();
  if (!text) return NOT_SUPPLIED_AS_TEXT;
  return NUMERIC.test(text) ? text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : text;
}
