import {
  closePrintWindow,
  isPrintWindowOpen,
  openPrintWindow,
  printContentOverflows,
  printInWindow,
  sendToPrintWindow,
  type PrintWindow,
} from '@/lib/browser-print/print-window';
import type { ReceiptLayout } from '@/lib/receipts/configuration';

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

/**
 * DEV-742: the branch's saved paper preference as the counter's starting
 * format. The cashier can still change it for the session.
 */
export function counterFormatFromLayout(
  layout: Pick<ReceiptLayout, 'paperWidth' | 'browserPaper'> | null | undefined
): CounterReceiptFormat {
  if (!layout) return 'THERMAL';
  if (layout.browserPaper === 'A4') return 'A4';
  return layout.paperWidth === 58 ? 'THERMAL_58' : 'THERMAL';
}

/** A one-use, session-only window reserved during an operator gesture. */
export type CounterBrowserPrintReservation = { cancel: () => void };

const COUNTER_PRINT_WINDOW = 'popup,width=480,height=720';

const reservations = new WeakMap<
  CounterBrowserPrintReservation,
  { handle: PrintWindow | null; unsupported: string | null; consumed: boolean }
>();

/**
 * Call synchronously from an enabled operator gesture, before awaiting settlement.
 * DEV-973: the window is the isolated print page, which prints itself; this page
 * only hands it the receipt and is never paused by its print dialog.
 */
export function reserveCounterBrowserPrint(): CounterBrowserPrintReservation {
  let handle: PrintWindow | null = null;
  let unsupported: string | null = null;
  try {
    handle = openPrintWindow(COUNTER_PRINT_WINDOW);
  } catch (error) {
    unsupported = error instanceof Error ? error.message : 'Print window unavailable.';
  }
  const state = { handle, unsupported, consumed: false };
  const reservation: CounterBrowserPrintReservation = {
    cancel: () => {
      if (state.consumed) return;
      state.consumed = true;
      if (state.handle) closePrintWindow(state.handle);
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
  if (reserved.unsupported) throw new Error(reserved.unsupported);
  if (!reserved.handle) {
    throw new Error('Allow pop-ups for this site, then retry Print receipt.');
  }
  if (!isPrintWindowOpen(reserved.handle)) {
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
  const handle = reserved.handle!;
  try {
    if (format === 'LABEL_50x30' && printContentOverflows(html, '.dispensing-label')) {
      throw new Error(
        'Rx label content exceeds 50 × 30 mm. Review directions or use larger paper.'
      );
    }
    // The print window prints itself; this page never calls print() on it.
    sendToPrintWindow(handle, html);
  } catch (error) {
    closePrintWindow(handle);
    if (error instanceof Error && error.message.startsWith('Rx label content exceeds')) throw error;
    throw new Error('The browser print dialog could not open. Retry Print receipt.');
  }
}

/**
 * F3 Z-report transport: opened directly from the operator's click (no settlement await,
 * so no reserved window is needed). Receipts keep the reserved-window path above.
 */
function printCounterDocument(html: string, retry = 'Print receipt'): void {
  printInWindow(html, {
    features: COUNTER_PRINT_WINDOW,
    blockedMessage: `Allow pop-ups for this site, then retry ${retry}.`,
    failedMessage: `The browser print dialog could not open. Retry ${retry}.`,
  });
}

export type PrinterTestFormat = Exclude<CounterReceiptFormat, 'LABEL_50x30'>;

const PRINTER_TEST_STRINGS = {
  en: {
    title: 'Printer test page',
    paper: { THERMAL: 'Thermal 80 mm', THERMAL_58: 'Thermal 58 mm', A4: 'A4 sheet' },
    branch: 'Branch',
    ruler: 'The line below should fit on one line without wrapping:',
    sample: 'Sample text: English 0123456789',
    urdu: 'Urdu sample:',
    notReceipt: 'Test only. This is not a receipt: no sale, no receipt number, no amount.',
  },
  ur: {
    title: 'پرنٹر ٹیسٹ صفحہ',
    paper: { THERMAL: 'تھرمل 80 ملی میٹر', THERMAL_58: 'تھرمل 58 ملی میٹر', A4: 'اے 4 صفحہ' },
    branch: 'برانچ',
    ruler: 'نیچے والی لائن ایک ہی لائن میں آنی چاہیے:',
    sample: 'نمونہ متن: English 0123456789',
    urdu: 'اردو نمونہ:',
    notReceipt: 'صرف ٹیسٹ۔ یہ رسید نہیں ہے: کوئی فروخت، رسید نمبر یا رقم نہیں۔',
  },
} as const;

/**
 * DEV-742: a printer test page for the browser/OS route. It carries no sale,
 * receipt number or amount, so it can never be mistaken for a receipt.
 */
export function buildPrinterTestPage(
  format: PrinterTestFormat,
  locale: CounterReceiptLocale,
  branchName: string
): string {
  if (!['en', 'ur'].includes(locale) || !['THERMAL', 'THERMAL_58', 'A4'].includes(format)) {
    throw new Error('Choose a supported test language and paper size.');
  }
  const strings = PRINTER_TEST_STRINGS[locale];
  const width = format === 'THERMAL_58' ? '58mm' : format === 'THERMAL' ? '80mm' : '190mm';
  // Same column counts as the receipt preview: 32 at 58 mm, 48 at 80 mm.
  const columns = format === 'THERMAL_58' ? 32 : format === 'THERMAL' ? 48 : 90;
  const ruler = `|${'-'.repeat(columns - 2)}|`;
  const lines = [
    strings.title,
    `${strings.paper[format]}`,
    `${strings.branch}: ${branchName}`,
    '',
    strings.ruler,
    ruler,
    strings.sample,
    `${strings.urdu} اردو متن کی جانچ`,
    '',
    strings.notReceipt,
  ];
  return `<!doctype html><html lang="${locale}" dir="${COUNTER_RECEIPT_DIRECTION[locale]}"><head>
<meta charset="utf-8"><title>${escapeHtml(strings.title)}</title>
<style>@page { size: ${format === 'A4' ? 'A4' : 'auto'}; margin: ${format === 'A4' ? '10mm' : '0'}; }
* { box-sizing: border-box; } body { margin: 0; width: ${width}; max-width: 100%; padding: 3mm; font: 12px monospace; color: black; background: white; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }</style>
</head><body><pre>${receiptHtmlText(lines.join('\n'), locale)}</pre></body></html>`;
}

/** Opens the browser/OS print dialog. Returning does not confirm physical printing. */
export function printPrinterTestPage(
  format: PrinterTestFormat,
  locale: CounterReceiptLocale,
  branchName: string
): void {
  printCounterDocument(buildPrinterTestPage(format, locale, branchName), 'Print test page');
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
