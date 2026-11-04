import { z } from 'zod';
import {
  DEFAULT_RECEIPT_LAYOUT,
  readReceiptLayout,
  SaveReceiptLayoutSchema,
  type ReceiptLayout,
} from '@/lib/receipts/configuration';
import type { CounterReceiptFormat } from './counter-browser-print';

/**
 * DEV-742: the branch's saved printer settings.
 *
 * The thermal roll width is the shared `ReceiptLayout.paperWidth` (WHA-1354), which the
 * ESC/POS job already reads. Pharmacy adds exactly one key beside it in the same
 * `pharmacy_branches.receiptLayout` JSON: which paper the counter preselects. A4 has no
 * restaurant meaning, so it stays out of the shared, strict restaurant layout schema.
 *
 * Settings only. Device binding, queues, acknowledgement and retries belong to the
 * thermal transport (DEV-741) and are not stored here.
 */
export const PharmacyReceiptOutputSchema = z.enum(['THERMAL', 'A4']);
export type PharmacyReceiptOutput = z.infer<typeof PharmacyReceiptOutputSchema>;
export const DEFAULT_PHARMACY_RECEIPT_OUTPUT: PharmacyReceiptOutput = 'THERMAL';

export type PharmacyPrinterSettings = {
  layout: ReceiptLayout;
  output: PharmacyReceiptOutput;
};

/** Optional so an older caller that only knows the shared layout keeps the stored paper. */
export const SavePharmacyReceiptFormatSchema = SaveReceiptLayoutSchema.extend({
  output: PharmacyReceiptOutputSchema.optional(),
}).strict();
export type SavePharmacyReceiptFormatInput = z.infer<typeof SavePharmacyReceiptFormatSchema>;

/**
 * Split stored JSON into the shared layout and the pharmacy output. Only an absent value
 * receives defaults; a corrupt layout or an unknown output fails closed, like the shared reader.
 */
export function readPharmacyPrinterSettings(value: unknown): PharmacyPrinterSettings {
  if (value === null || value === undefined) {
    return { layout: readReceiptLayout(null), output: DEFAULT_PHARMACY_RECEIPT_OUTPUT };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    // Let the shared reader raise its usual validation error.
    return { layout: readReceiptLayout(value), output: DEFAULT_PHARMACY_RECEIPT_OUTPUT };
  }
  const { output, ...layout } = value as Record<string, unknown>;
  return {
    layout: readReceiptLayout(layout),
    output:
      output === undefined
        ? DEFAULT_PHARMACY_RECEIPT_OUTPUT
        : PharmacyReceiptOutputSchema.parse(output),
  };
}

/**
 * The JSON written to `pharmacy_branches.receiptLayout`. The default (thermal) writes the plain
 * shared layout, byte-compatible with builds before DEV-742. Only an A4 branch carries `output`;
 * a build that predates DEV-742 reads that key as corrupt and fails closed. Before rolling back
 * past DEV-742, run:
 *   UPDATE pharmacy_branches SET "receiptLayout" = "receiptLayout" - 'output'
 *   WHERE "receiptLayout" ? 'output';
 */
export function storedPharmacyPrinterSettings(
  settings: PharmacyPrinterSettings
): ReceiptLayout | (ReceiptLayout & { output: 'A4' }) {
  return settings.output === 'A4' ? { ...settings.layout, output: 'A4' } : { ...settings.layout };
}

/** The counter's paper choice that a branch's saved settings preselect. */
export function counterFormatForSettings(
  settings: Pick<PharmacyPrinterSettings, 'output'> & {
    layout: Pick<ReceiptLayout, 'paperWidth'>;
  }
): Extract<CounterReceiptFormat, 'THERMAL' | 'THERMAL_58' | 'A4'> {
  if (settings.output === 'A4') return 'A4';
  return settings.layout.paperWidth === 58 ? 'THERMAL_58' : 'THERMAL';
}

export const DEFAULT_PHARMACY_PRINTER_SETTINGS: Readonly<PharmacyPrinterSettings> = Object.freeze({
  layout: DEFAULT_RECEIPT_LAYOUT,
  output: DEFAULT_PHARMACY_RECEIPT_OUTPUT,
});
