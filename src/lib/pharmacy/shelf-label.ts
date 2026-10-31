import { formatMinor } from './counter-receipt';
import { shelfLabelBarcodeSvg } from './shelf-label-code';

export type ShelfLabelFormat = '38x25' | '50x25' | 'A4';
export const SHELF_LABEL_FORMATS: readonly ShelfLabelFormat[] = ['38x25', '50x25', 'A4'];
/** Per print request; a large GRN is printed page by page. */
export const MAX_SHELF_LABELS = 5000;

export type ShelfLabelSource = {
  inventoryLotId: string;
  code: string;
  /** An unavailable lot stays visible but must not be selected for printing. */
  unavailableReason?: string | null;
  name: string;
  strength: string | null;
  packMrpMinor: number;
  stripMrpMinor: number | null;
  /** A current pack-price record that disagrees with the lot MRP; never printed. */
  priceRecordMrpMinor?: number | null;
  expiry: string;
  batchNumber: string;
  count: number;
};

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
));

/** Isolated monochrome paper, separate from patient-direction dispensing labels. */
export function buildShelfLabels(rows: readonly ShelfLabelSource[], format: ShelfLabelFormat): string {
  if (!SHELF_LABEL_FORMATS.includes(format)) throw new Error('Choose a supported label size.');
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (!rows.length || !Number.isSafeInteger(total) || total < 1 || total > MAX_SHELF_LABELS) {
    throw new Error('Choose between 1 and 5,000 labels.');
  }
  const width = format === '38x25' ? 38 : 50;
  const labels = rows.flatMap((row) => {
    if (row.count > 0 && row.unavailableReason) throw new Error(row.unavailableReason);
    if (!Number.isSafeInteger(row.count) || row.count < 0 || row.count > MAX_SHELF_LABELS ||
        !Number.isSafeInteger(row.packMrpMinor) || row.packMrpMinor < 0 ||
        (row.stripMrpMinor !== null && (!Number.isSafeInteger(row.stripMrpMinor) || row.stripMrpMinor < 0)) ||
        !row.name.trim() || !/^\d{4}-\d{2}(?:-\d{2})?$/.test(row.expiry)) {
      throw new Error('Label identity, count, price or expiry is invalid.');
    }
    const html = `<section class="shelf-label" aria-label="Shelf price label">
<strong>${escapeHtml(row.name)}</strong><div>${escapeHtml(row.strength ?? 'Strength: not applicable')}</div>
<div>MRP/pack: PKR ${escapeHtml(formatMinor(row.packMrpMinor))}</div>
<div>MRP/strip: ${row.stripMrpMinor === null ? 'N/A' : `PKR ${escapeHtml(formatMinor(row.stripMrpMinor))}`}</div>
<div>EXP ${escapeHtml(row.expiry)}</div>
${shelfLabelBarcodeSvg(row.code)}<div class="lot-code">${escapeHtml(row.code)}</div></section>`;
    return Array.from({ length: row.count }, () => html);
  });
  // Physical print stock is intentionally monochrome, matching receipt printing.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shelf and price labels</title>
<style>@page { size: ${format === 'A4' ? 'A4' : `${width}mm 25mm`}; margin: ${format === 'A4' ? '10mm' : '0'}; }
* { box-sizing: border-box; } body { margin: 0; color: black; background: white; font: 6.5pt/1.1 monospace; ${format === 'A4' ? 'width: 190mm; display: grid; grid-template-columns: repeat(3, 50mm); gap: 0 10mm; align-content: start;' : `width: ${width}mm;`} }
.shelf-label { width: ${width}mm; height: 25mm; padding: 1mm; break-inside: avoid; ${format === 'A4' ? '' : 'break-after: page;'} }
.shelf-label:last-child { break-after: auto; } .shelf-label strong { display: block; } .shelf-label div, .shelf-label strong { overflow-wrap: anywhere; }
.shelf-label svg { display: block; max-width: none; } .lot-code { font-size: 5pt; }
</style></head><body>${labels.join('\n')}</body></html>`;
}

/** Reserve during the click, then fill with fresh authorized server data. */
export function reserveShelfLabelPrint(): { print: (html: string) => void; cancel: () => void } {
  const popup = window.open('', '_blank', 'popup,width=720,height=800');
  if (!popup) throw new Error('Allow pop-ups for this site, then retry printing.');
  popup.opener = null;
  return {
    cancel: () => popup.close(),
    print: (html) => {
      try {
        if (popup.closed) throw new Error('The print window was closed. Retry printing.');
        popup.document.open();
        popup.document.write(html);
        popup.document.close();
        const labels = popup.document.querySelectorAll<HTMLElement>('.shelf-label');
        if (Array.from(labels).some((label) => label.scrollHeight > label.clientHeight || label.scrollWidth > label.clientWidth)) {
          throw new Error('Label content exceeds the selected size. Choose 50 × 25 mm or A4, or shorten the catalogue name.');
        }
        popup.focus();
        popup.print();
      } catch (error) {
        popup.close();
        throw error;
      }
    },
  };
}
