import { buildCounterReceiptPreview } from './counter-receipt-presentation';
import {
  COUNTER_RECEIPT_DIRECTION,
  receiptTitle,
  type CounterReceipt,
  type CounterReceiptLocale,
} from './counter-receipt';

// Transient browser paper choice, not a second saved designer/settings schema.
export type CounterReceiptFormat = 'THERMAL' | 'THERMAL_58' | 'A4';

function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character]!;
  });
}

/** Allowlisted receipt fields only: never copy the POS DOM or patient panel. */
export function buildCounterBrowserReceipt(
  receipt: CounterReceipt,
  locale: CounterReceiptLocale,
  format: CounterReceiptFormat,
  reprint = false
): string {
  if (!['en', 'ur'].includes(locale) || !['THERMAL', 'THERMAL_58', 'A4'].includes(format)) {
    throw new Error('Choose a supported receipt language and paper size.');
  }
  if (receipt.receiptNumber === null || !receipt.completedAt || receipt.lines.length === 0) {
    throw new Error('Load a settled receipt before printing.');
  }
  const width = format === 'THERMAL_58' ? '58mm' : format === 'THERMAL' ? '80mm' : '190mm';
  const preview = buildCounterReceiptPreview(
    receipt,
    locale,
    format === 'THERMAL_58' ? 58 : 80,
    reprint
  );
  // All receipt content is escaped inert text. Physical print styles only.
  return `<!doctype html><html lang="${locale}" dir="${COUNTER_RECEIPT_DIRECTION[locale]}"><head>
<meta charset="utf-8"><title>${escapeHtml(receiptTitle(receipt, locale))}</title>
<style>@page { size: ${format === 'A4' ? 'A4' : 'auto'}; margin: ${format === 'A4' ? '10mm' : '0'}; }
* { box-sizing: border-box; } body { margin: 0; width: ${width}; max-width: 100%; padding: 3mm; font: 12px monospace; color: black; background: white; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }</style>
</head><body><pre>${escapeHtml(preview)}</pre></body></html>`;
}

/** Opens only an isolated receipt. Returning does not confirm physical printing. */
export function printCounterBrowserReceipt(
  receipt: CounterReceipt,
  locale: CounterReceiptLocale,
  format: CounterReceiptFormat,
  reprint = false
): void {
  const html = buildCounterBrowserReceipt(receipt, locale, format, reprint);
  const popup = window.open('', '_blank', 'popup,width=480,height=720');
  if (!popup) throw new Error('Allow pop-ups for this site, then retry Print receipt.');
  popup.opener = null;
  try {
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
    popup.focus();
    popup.print();
  } catch {
    popup.close();
    throw new Error('The browser print dialog could not open. Retry Print receipt.');
  }
}
