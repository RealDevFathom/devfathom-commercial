import messages from '@/messages/en.json';

import { COUNTER_RECEIPT_STRINGS, type CounterReceipt } from './counter-receipt';

/** Minimal authorized label payload. No patient, consent, or actor identifiers. */
export type DispensingLabelSource = {
  saleId: string;
  saleLineId: string;
  rx: true;
  licenceNumber: string;
  pharmacistRegistration: string;
  pharmacistName?: string;
  directionsEnglish: string;
  directionsUrdu: string;
};

function text(value: string | null | undefined, field: string): string {
  if (
    !value?.trim() ||
    /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)
  ) {
    throw new Error(`Rx label requires valid ${field}.`);
  }
  return value;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!
  );
}

/** One 50 × 30 mm label per issued allocation; no financial or patient fields. */
export function buildDispensingLabels(
  receipt: CounterReceipt,
  sources: readonly DispensingLabelSource[]
): string {
  if (receipt.receiptNumber === null || !receipt.completedAt || sources.length === 0) {
    throw new Error(messages.CounterErrors.RX_LABEL_SOURCE);
  }
  const seen = new Set<string>();
  const labels = sources.flatMap((source) => {
    const matches = receipt.lines.filter((line) => line.saleLineId === source.saleLineId);
    if (source.saleId !== receipt.saleId || matches.length !== 1 || seen.has(source.saleLineId)) {
      throw new Error(messages.CounterErrors.RX_LABEL_MISMATCH);
    }
    seen.add(source.saleLineId);
    const line = matches[0]!;
    if (source.rx !== true || line.identityStatus !== 'ISSUED' || !line.allocations?.length) {
      throw new Error(messages.CounterErrors.RX_LABEL_IDENTITY);
    }
    const branch = escapeHtml(text(receipt.branchName, 'pharmacy name'));
    const medicine = escapeHtml(
      [
        text(line.medicineName, 'medicine name'),
        line.strength === null ? null : text(line.strength, 'medicine strength'),
        text(line.presentation, 'presentation'),
      ]
        .filter(Boolean)
        .join(' · ')
    );
    const licence = escapeHtml(text(source.licenceNumber, 'pharmacy licence number'));
    const registration = escapeHtml(text(source.pharmacistRegistration, 'pharmacist registration'));
    const pharmacist =
      source.pharmacistName === undefined
        ? ''
        : `${escapeHtml(text(source.pharmacistName, 'pharmacist name'))} · `;
    const english = escapeHtml(text(source.directionsEnglish, 'English directions'));
    const urdu = escapeHtml(text(source.directionsUrdu, 'Urdu directions'));
    return line.allocations.map((allocation) => {
      const expiry = text(allocation.expiresAt, 'batch expiry');
      const date = expiry.slice(0, 10);
      const parsed = new Date(expiry);
      if (
        !/^\d{4}-\d{2}-\d{2}(?:$|T)/u.test(expiry) ||
        Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== date
      ) {
        throw new Error(messages.CounterErrors.RX_LABEL_EXPIRY);
      }
      const batch = escapeHtml(text(allocation.batchNumber, 'batch number'));
      return `<section class="dispensing-label" aria-label="Rx dispensing label">
<div><strong>${branch}</strong> · Licence: <bdi>${licence}</bdi></div>
<div>Pharmacist: ${pharmacist}<bdi>${registration}</bdi></div>
<div><strong>${medicine}</strong></div>
<div lang="en" dir="ltr">${english}</div>
<div lang="ur" dir="rtl">${urdu}</div>
<div>Batch: <bdi>${batch}</bdi> · ${COUNTER_RECEIPT_STRINGS.en.expiry} / <span lang="ur" dir="rtl">${COUNTER_RECEIPT_STRINGS.ur.expiry}</span>: <bdi>${date}</bdi></div>
</section>`;
    });
  });
  // Match the existing isolated browser receipt's physical, monochrome styling.
  // Overflow is refused by the print helper, never clipped or silently shortened.
  return `<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><title>Rx dispensing labels</title>
<style>@page { size: 50mm 30mm; margin: 0; }
* { box-sizing: border-box; } body { margin: 0; width: 50mm; font: 7pt/1.2 monospace; color: black; background: white; }
.dispensing-label { width: 50mm; height: 30mm; padding: 1.5mm; break-inside: avoid; break-after: page; overflow-wrap: anywhere; }
.dispensing-label:last-child { break-after: auto; }
.dispensing-label div { white-space: pre-wrap; }
</style></head><body>${labels.join('\n')}</body></html>`;
}
