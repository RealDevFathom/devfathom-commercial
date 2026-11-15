/**
 * Plain-language labels for pharmacy finance screens. Ledger rows store
 * database ids; owners need branch, batch, medicine and payment names instead.
 * Raw ids stay available as audit references, never as the primary label.
 */
import { COUNTER_RECEIPT_STRINGS } from './counter-receipt';

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  PHARMACY_GOODS_RECEIPT: 'Goods received',
  PHARMACY_SALE_LINE: 'Sale',
  PHARMACY_SALE_RETURN_LINE: 'Sale return',
  PHARMACY_UNIDENTIFIED_RETURN_HOLD: 'Return not yet matched to a batch',
  PHARMACY_STOCK_WRITE_OFF: 'Stock write-off',
  PHARMACY_SUPPLIER_CLAIM: 'Supplier claim',
  PHARMACY_INTERBRANCH_TRANSFER_LINE: 'Branch transfer',
  PHARMACY_INVENTORY_COUNT_LINE: 'Stock count adjustment',
  PHARMACY_TENDER: 'Payment',
  PHARMACY_REFUND: 'Refund',
  PHARMACY_DAILY_CLOSE: 'Daily close',
  PHARMACY_OPENING_STOCK: 'Opening stock',
  PHARMACY_OPENING_LEDGER: 'Opening balance',
  PHARMACY_BOOKKEEPING_TRANSACTION: 'Bookkeeping entry',
};

function sentenceCase(code: string) {
  const words = code.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Unknown';
}

/** Readable name for a journal entry's source kind. */
export function financeSourceLabel(sourceKind: string): string {
  return Object.hasOwn(SOURCE_LABELS, sourceKind)
    ? SOURCE_LABELS[sourceKind]
    : sentenceCase(sourceKind.replace(/^PHARMACY_/, ''));
}

/** Readable payment method, matching the counter receipt's English names. */
export function tenderTypeLabel(type: string): string {
  const names = COUNTER_RECEIPT_STRINGS.en.tenderName;
  return Object.hasOwn(names, type) ? names[type] : sentenceCase(type);
}

// cuid / cuid2 ids embedded in stored descriptions, e.g. "Refund of tender cmvz…".
const RAW_ID = /\bc[a-z0-9]{20,}\b/;

/**
 * Title for a journal entry. Payments and refunds name the payment method;
 * any other stored description that only identifies its source by raw id falls
 * back to the readable source kind.
 */
export function journalEntryTitle(entry: {
  sourceKind: string;
  description: string;
  tenderType?: string | null;
}): string {
  const source = financeSourceLabel(entry.sourceKind);
  if (
    entry.tenderType &&
    (entry.sourceKind === 'PHARMACY_REFUND' || entry.sourceKind === 'PHARMACY_TENDER')
  ) {
    return `${source} · ${tenderTypeLabel(entry.tenderType)}`;
  }
  return RAW_ID.test(entry.description) ? source : entry.description;
}

export type LedgerLabels = {
  branches: Record<string, string>;
  lots: Record<string, string>;
  batches: Record<string, string>;
  medicines: Record<string, string>;
  locations: Record<string, string>;
};

export const EMPTY_LEDGER_LABELS: LedgerLabels = {
  branches: {},
  lots: {},
  batches: {},
  medicines: {},
  locations: {},
};

/** "Panadol 500mg · batch B123", or whichever part is known. */
export function batchLabel(batch: { batchNumber: string; medicineName?: string | null }) {
  return batch.medicineName
    ? `${batch.medicineName} · batch ${batch.batchNumber}`
    : `Batch ${batch.batchNumber}`;
}
