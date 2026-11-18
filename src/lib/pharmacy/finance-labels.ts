/**
 * Plain-language labels for pharmacy finance screens. Ledger rows store
 * database ids; owners need branch, batch, medicine and payment names instead.
 * Raw ids stay available as audit references, never as the primary label.
 */
import { COUNTER_RECEIPT_STRINGS } from './counter-receipt';
import { batchPhrase } from './unrecorded-batch';

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

/**
 * "Panadol 500mg · batch B123", or whichever part is known. DEV-853: a batch
 * whose number was never recorded reads "Batch not recorded".
 */
export function batchLabel(batch: { batchNumber: string | null; medicineName?: string | null }) {
  return batch.medicineName
    ? `${batch.medicineName} · ${batchPhrase(batch.batchNumber, 'batch')}`
    : batchPhrase(batch.batchNumber);
}
