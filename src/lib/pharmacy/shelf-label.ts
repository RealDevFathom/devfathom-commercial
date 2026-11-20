/**
 * DEV-90 — shelf and price stickers for stock without a usable barcode
 * (legacy packs without a DataMatrix, loose strips).
 *
 * One sticker names the medicine and strength, the MRP per pack and per strip,
 * the expiry, and an internal Code128 that resolves to the exact lot at the
 * counter. Distinct from the patient-direction dispensing label
 * (`dispensing-label.ts`): no patient, prescriber or directions ever appear here.
 *
 * Every price and identity on the sticker comes from the server
 * (`shelf-label-source.ts`); the operator only chooses how many to print and the
 * paper. Pure and client safe apart from `printShelfLabels`, which needs a window.
 */

import {
  closePrintWindow,
  openPrintWindow,
  printContentOverflows,
  sendToPrintWindow,
  type PrintWindow,
} from '@/lib/browser-print/print-window';
import { formatMinor } from './counter-receipt';
import { parseShelfLabelCode, shelfLabelBarcodeSvg } from './shelf-label-code';
import { BATCH_NOT_RECORDED, EXPIRY_NOT_RECORDED } from './unrecorded-batch';

export type ShelfLabelFormat = '38x25' | '50x25' | 'A4';
export const SHELF_LABEL_FORMATS: ReadonlyArray<{ value: ShelfLabelFormat; label: string }> = [
  { value: '38x25', label: '38 × 25 mm thermal label' },
  { value: '50x25', label: '50 × 25 mm thermal label' },
  { value: 'A4', label: 'A4 sheet (3 × 11 labels)' },
];
/** One print request. A larger receipt is printed in parts. */
export const MAX_SHELF_LABELS_PER_PRINT = 1000;

/** One lot's sticker content, as the server resolved it. */
export type ShelfLabelRow = {
  inventoryLotId: string;
  /** Sixteen-digit internal lot code (`shelf-label-code.ts`). */
  code: string;
  name: string;
  strength: string | null;
  /** The current price of one sealed pack: the lot's printed MRP, as the counter charges it. */
  packMrpMinor: number;
  /** The counter's price for one strip of this lot; null when the pack has no strip level. */
  stripMrpMinor: number | null;
  /**
   * `YYYY-MM` for a month-precision expiry, otherwise `YYYY-MM-DD`. DEV-853:
   * null when the expiry was never recorded; the label says so in plain words.
   */
  expiry: string | null;
  /** DEV-853: null when the batch number was never recorded. */
  batchNumber: string | null;
  /** Suggested count: one per received pack for a goods receipt, otherwise one. */
  defaultCount: number;
  /** Set when the lot must not be labelled for sale (expired, recalled, quarantined, empty). */
  unavailableReason: string | null;
};

export type ShelfLabelSelection = { row: ShelfLabelRow; count: number };

export class ShelfLabelError extends Error {}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!
  );

const EXPIRY = /^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/;
// Control and bidi-override characters could reorder or hide printed text.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/u;

function text(value: string, field: string): string {
  if (!value.trim() || UNSAFE_TEXT.test(value)) {
    throw new ShelfLabelError(`The label ${field} is missing or invalid.`);
  }
  return escapeHtml(value.trim());
}

function money(minor: number, field: string): string {
  if (!Number.isSafeInteger(minor) || minor < 0) {
    throw new ShelfLabelError(`The label ${field} is invalid.`);
  }
  return `Rs ${formatMinor(minor)}`;
}

/** Total stickers a selection prints. */
export function shelfLabelTotal(selection: readonly ShelfLabelSelection[]): number {
  return selection.reduce((sum, item) => sum + item.count, 0);
}

function labelHtml(row: ShelfLabelRow, format: ShelfLabelFormat): string {
  if (parseShelfLabelCode(row.code) === null) {
    throw new ShelfLabelError('The label lot code is invalid.');
  }
  if (row.expiry !== null && !EXPIRY.test(row.expiry)) {
    throw new ShelfLabelError('The label expiry is invalid.');
  }
  const name = text(row.name, 'medicine name');
  const strength = row.strength === null ? null : text(row.strength, 'strength');
  const expiry = row.expiry === null ? EXPIRY_NOT_RECORDED : `EXP <strong>${row.expiry}</strong>`;
  const batch =
    row.batchNumber === null
      ? BATCH_NOT_RECORDED
      : `B <bdi>${text(row.batchNumber, 'batch number')}</bdi>`;
  const pack = money(row.packMrpMinor, 'pack MRP');
  const strip = row.stripMrpMinor === null ? null : money(row.stripMrpMinor, 'strip MRP');
  const barcodeWidth = format === '38x25' ? 34 : 44;
  return `<section class="shelf-label" aria-label="Shelf price label">
<div class="name"><strong>${name}</strong>${strength ? ` ${strength}` : ''}</div>
<div>MRP/pack <strong class="price">${pack}</strong>${strip ? ` · strip <strong class="price">${strip}</strong>` : ''}</div>
<div>${expiry} · ${batch}</div>
${shelfLabelBarcodeSvg(row.code, barcodeWidth, format === '38x25' ? 5 : 6)}
<div class="code">${row.code}</div>
</section>`;
}

/**
 * The isolated, monochrome print document for a selection. Refuses an
 * unavailable lot, an empty selection, or more than one print request holds;
 * a lot with a count of zero is skipped.
 */
export function buildShelfLabelSheet(
  selection: readonly ShelfLabelSelection[],
  format: ShelfLabelFormat
): string {
  if (!SHELF_LABEL_FORMATS.some((entry) => entry.value === format)) {
    throw new ShelfLabelError('Choose a supported label size.');
  }
  for (const { row, count } of selection) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new ShelfLabelError('Each label count must be a whole number.');
    }
    if (count > 0 && row.unavailableReason) {
      const batch = row.batchNumber === null ? BATCH_NOT_RECORDED : `Batch ${row.batchNumber}`;
      throw new ShelfLabelError(`${batch}: ${row.unavailableReason}`);
    }
  }
  const total = shelfLabelTotal(selection);
  if (total < 1 || total > MAX_SHELF_LABELS_PER_PRINT) {
    throw new ShelfLabelError(
      `Choose between 1 and ${MAX_SHELF_LABELS_PER_PRINT.toLocaleString('en')} labels to print.`
    );
  }
  const labels = selection.flatMap(({ row, count }) => {
    if (count === 0) return [];
    const html = labelHtml(row, format);
    return Array.from({ length: count }, () => html);
  });
  const width = format === '38x25' ? 38 : 50;
  const sheet = format === 'A4';
  // Physical paper only: black on white, no product theme, like the receipt.
  return `<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><title>Shelf and price labels</title>
<style>@page { size: ${sheet ? 'A4' : `${width}mm 25mm`}; margin: ${sheet ? '10mm' : '0'}; }
* { box-sizing: border-box; }
body { margin: 0; color: black; background: white; font: ${format === '38x25' ? '6pt/1.1' : '6.5pt/1.15'} monospace; ${sheet ? 'width: 190mm; display: grid; grid-template-columns: repeat(3, 50mm); column-gap: 10mm; align-content: start;' : `width: ${width}mm;`} }
.shelf-label { width: ${width}mm; height: 25mm; padding: 1mm 1.5mm; overflow: hidden; break-inside: avoid; ${sheet ? '' : 'break-after: page;'} }
.shelf-label:last-child { break-after: auto; }
.shelf-label div { overflow-wrap: anywhere; }
.shelf-label .price { white-space: nowrap; }
.shelf-label svg { display: block; margin-top: 0.5mm; }
.shelf-label .code { font-size: 5.5pt; letter-spacing: 0.04em; }
</style></head><body>${labels.join('\n')}</body></html>`;
}

/**
 * Opens the sheet in an isolated window and asks the browser to print it.
 * Call from the operator's click. Content that does not fit the chosen size is
 * refused rather than clipped: a sticker with a hidden price is worse than none.
 */
export function printShelfLabels(
  selection: readonly ShelfLabelSelection[],
  format: ShelfLabelFormat
): Promise<void> {
  const html = buildShelfLabelSheet(selection, format);
  // DEV-973: an isolated window that prints itself, so this page never freezes.
  let popup: PrintWindow;
  try {
    popup = openPrintWindow('popup,width=720,height=800');
  } catch (error) {
    throw new ShelfLabelError(error instanceof Error ? error.message : 'Print window unavailable.');
  }
  let overflowing: boolean;
  try {
    // Laid out in this page, never printed here.
    overflowing = printContentOverflows(html, '.shelf-label');
  } catch {
    closePrintWindow(popup);
    throw new ShelfLabelError('The print window could not open. Retry printing.');
  }
  if (overflowing) {
    closePrintWindow(popup);
    throw new ShelfLabelError(
      'A label does not fit the selected size. Choose 50 × 25 mm or the A4 sheet.'
    );
  }
  return sendToPrintWindow(popup, html, {
    blockedMessage: 'Allow pop-ups for this site, then retry printing.',
    failedMessage: 'The print window could not open. Retry printing.',
  }).catch((error: unknown) => {
    throw new ShelfLabelError(error instanceof Error ? error.message : 'Print window unavailable.');
  });
}
