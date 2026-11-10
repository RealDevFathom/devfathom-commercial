import { buildDispensingLabels, type DispensingLabelSource } from './dispensing-label';
import {
  buildCounterZReportPreview,
  type CounterZReport,
  buildCounterReceiptPreview,
} from './counter-receipt-presentation';
import {
  COUNTER_RECEIPT_DIRECTION,
  receiptTitle,
  type CounterReceipt,
  type CounterReceiptLocale,
} from './counter-receipt';

// Transient browser paper choice, not a second saved designer/settings schema.
export type CounterReceiptFormat = 'THERMAL' | 'THERMAL_58' | 'A4' | 'LABEL_50x30';

/** A one-use, session-only window reserved during an operator gesture. */
export type CounterBrowserPrintReservation = { cancel: () => void };

const reservations = new WeakMap<
  CounterBrowserPrintReservation,
  { popup: Window | null; consumed: boolean }
>();

function closePopup(popup: Window | null): void {
  try {
    popup?.close();
  } catch {
    // Window cleanup must never interrupt payment or reconciliation handling.
  }
}

/** Call synchronously from an enabled operator gesture, before awaiting settlement. */
export function reserveCounterBrowserPrint(): CounterBrowserPrintReservation {
  let popup: Window | null = null;
  try {
    popup = window.open('', '_blank', 'popup,width=480,height=720');
    if (popup) popup.opener = null;
  } catch {
    closePopup(popup);
    popup = null;
  }
  const state = { popup, consumed: false };
  const reservation: CounterBrowserPrintReservation = {
    cancel: () => {
      if (state.consumed) return;
      state.consumed = true;
      closePopup(state.popup);
    },
  };
  reservations.set(reservation, state);
  return reservation;
}

/** Check known failures before asking the server to allocate a receipt copy. */
export function assertCounterBrowserPrintReady(reservation: CounterBrowserPrintReservation): void {
  const reserved = reservations.get(reservation);
  if (!reserved || reserved.consumed) {
    throw new Error('This print window is no longer available. Retry Print receipt.');
  }
  if (!reserved.popup) {
    throw new Error('Allow pop-ups for this site, then retry Print receipt.');
  }
  try {
    if (
      reserved.popup.closed ||
      typeof reserved.popup.document.open !== 'function' ||
      typeof reserved.popup.document.write !== 'function' ||
      typeof reserved.popup.document.close !== 'function' ||
      typeof reserved.popup.focus !== 'function' ||
      typeof reserved.popup.print !== 'function'
    ) {
      throw new Error('Print window unavailable.');
    }
  } catch {
    throw new Error('The print window is no longer available. Retry Print receipt.');
  }
}

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

/** Keep ASCII identifiers/phone/date groups readable inside Urdu paper. Text
 * stays escaped; bidi controls from source data remain subject to validation. */
function receiptHtmlText(preview: string, locale: CounterReceiptLocale): string {
  if (locale !== 'ur') return escapeHtml(preview);
  return preview
    .split(/([A-Za-z0-9][\x20-\x7e]*)/g)
    .map((part, index) =>
      index % 2 ? `<bdi dir="ltr">${escapeHtml(part)}</bdi>` : escapeHtml(part)
    )
    .join('');
}

/** Allowlisted receipt fields only: never copy the POS DOM or patient panel. */
export function buildCounterBrowserReceipt(
  receipt: CounterReceipt,
  locale: CounterReceiptLocale,
  format: CounterReceiptFormat,
  reprint = false,
  labelSources: readonly DispensingLabelSource[] = []
): string {
  if (
    !['en', 'ur'].includes(locale) ||
    !['THERMAL', 'THERMAL_58', 'A4', 'LABEL_50x30'].includes(format)
  ) {
    throw new Error('Choose a supported receipt language and paper size.');
  }
  if (
    !Number.isSafeInteger(receipt.receiptNumber) ||
    (receipt.receiptNumber ?? 0) <= 0 ||
    !receipt.completedAt ||
    receipt.lines.length === 0
  ) {
    throw new Error('Load a settled receipt before printing.');
  }
  if (format === 'LABEL_50x30') return buildDispensingLabels(receipt, labelSources);
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
</head><body><pre>${receiptHtmlText(preview, locale)}</pre></body></html>`;
}

/** Opens only an isolated receipt. Returning does not confirm physical printing. */
export function printCounterBrowserReceipt(
  receipt: CounterReceipt,
  locale: CounterReceiptLocale,
  format: CounterReceiptFormat,
  reprint = false,
  reservation?: CounterBrowserPrintReservation,
  labelSources: readonly DispensingLabelSource[] = []
): void {
  const html = buildCounterBrowserReceipt(receipt, locale, format, reprint, labelSources);
  const printReservation = reservation ?? reserveCounterBrowserPrint();
  assertCounterBrowserPrintReady(printReservation);
  const reserved = reservations.get(printReservation)!;
  reserved.consumed = true;
  const popup = reserved.popup!;
  try {
    if (popup.closed) throw new Error('Print window closed.');
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
    if (format === 'LABEL_50x30') {
      const labels = popup.document.querySelectorAll<HTMLElement>('.dispensing-label');
      if (
        Array.from(labels).some(
          (label) =>
            label.scrollHeight > label.clientHeight || label.scrollWidth > label.clientWidth
        )
      ) {
        throw new Error(
          'Rx label content exceeds 50 × 30 mm. Review directions or use larger paper.'
        );
      }
    }
    popup.focus();
    popup.print();
  } catch (error) {
    closePopup(popup);
    if (error instanceof Error && error.message.startsWith('Rx label content exceeds')) throw error;
    throw new Error('The browser print dialog could not open. Retry Print receipt.');
  }
}

/**
 * F3 Z-report transport: opened directly from the operator's click (no settlement await,
 * so no reserved window is needed). Receipts keep the reserved-window path above.
 */
function printCounterDocument(html: string): void {
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
    closePopup(popup);
    throw new Error('The browser print dialog could not open. Retry Print receipt.');
  }
}

/** Z_REPORT is separate from settled-sale paper formats, sharing the isolated print transport. */
export function buildCounterBrowserZReport(
  report: CounterZReport,
  locale: CounterReceiptLocale,
  format: 'Z_REPORT' = 'Z_REPORT'
): string {
  if (format !== 'Z_REPORT' || !['en', 'ur'].includes(locale))
    throw new Error('Choose a supported report format and language.');
  return `<!doctype html><html lang="${locale}" dir="${COUNTER_RECEIPT_DIRECTION[locale]}"><head><meta charset="utf-8"><title>Z-report</title><style>@page{size:A4;margin:10mm}body{font:14px monospace;color:black;background:white}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><pre>${escapeHtml(buildCounterZReportPreview(report, locale))}</pre></body></html>`;
}

export function printCounterBrowserZReport(
  report: CounterZReport,
  locale: CounterReceiptLocale
): void {
  printCounterDocument(buildCounterBrowserZReport(report, locale, 'Z_REPORT'));
}
