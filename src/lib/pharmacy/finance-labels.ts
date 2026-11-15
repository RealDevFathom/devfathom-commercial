/**
 * Plain-language labels for pharmacy finance screens. Ledger rows store
 * database ids; owners need branch, batch, medicine and payment names instead.
 * Raw ids stay available as audit references, never as the primary label.
 */
import { COUNTER_RECEIPT_STRINGS } from './counter-receipt';

function sentenceCase(code: string) {
  const words = code.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Unknown';
}

/** Readable payment method, matching the counter receipt's English names. */
export function tenderTypeLabel(type: string): string {
  const names = COUNTER_RECEIPT_STRINGS.en.tenderName;
  return Object.hasOwn(names, type) ? names[type] : sentenceCase(type);
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
