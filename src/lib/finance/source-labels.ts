import type { FinanceSourceKind } from '@/generated/prisma/client';

const FINANCE_SOURCE_LABELS = {
  PHARMACY_GOODS_RECEIPT: 'Goods received',
  PHARMACY_SALE_LINE: 'Sale',
  PHARMACY_SALE_RETURN_LINE: 'Sale return',
  PHARMACY_UNIDENTIFIED_RETURN_HOLD: 'Return on hold',
  PHARMACY_STOCK_WRITE_OFF: 'Stock written off',
  PHARMACY_SUPPLIER_CLAIM: 'Supplier claim',
  PHARMACY_INTERBRANCH_TRANSFER_LINE: 'Branch transfer',
  PHARMACY_INVENTORY_COUNT_LINE: 'Inventory count',
  PHARMACY_TENDER: 'Payment received',
  PHARMACY_REFUND: 'Refund',
  PHARMACY_DAILY_CLOSE: 'Daily close',
  PHARMACY_OPENING_STOCK: 'Opening stock',
  PHARMACY_OPENING_LEDGER: 'Opening balance',
  PHARMACY_BOOKKEEPING_TRANSACTION: 'Bookkeeping transaction',
  PHARMACY_JOURNAL_VOUCHER: 'Journal voucher',
  PHARMACY_AP_INVOICE: 'Supplier expense invoice',
} as const satisfies Readonly<Record<FinanceSourceKind, string>>;

export function financeSourceLabel(code: string): string {
  return Object.hasOwn(FINANCE_SOURCE_LABELS, code)
    ? FINANCE_SOURCE_LABELS[code as FinanceSourceKind]
    : 'Other journal event';
}

// Tender and refund postings once stored the internal tender ID in their description.
const LEGACY_ID_DESCRIPTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Pharmacy tender \S+$/, 'Payment received'],
  [/^Refund of tender \S+$/, 'Refund'],
];

/** Display text for a journal description; legacy tender/refund IDs become plain labels. */
export function financeEntryDescription(description: string): string {
  const prefix = /^(?:Reversal of )*/.exec(description)![0];
  const body = description.slice(prefix.length);
  const legacy = LEGACY_ID_DESCRIPTIONS.find(([pattern]) => pattern.test(body));
  return legacy ? `${prefix}${legacy[1]}` : description;
}
