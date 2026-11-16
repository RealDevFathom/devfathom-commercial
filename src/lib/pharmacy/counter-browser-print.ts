import { splitReceiptBidiText } from './counter-receipt-bidi';
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
  return splitReceiptBidiText(preview)
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
  const urduFont =
    locale === 'ur'
      ? `@font-face { font-family: 'Noto Nastaliq Urdu'; src: url('/fonts/noto-nastaliq-urdu.ttf') format('truetype'); font-weight: 400 700; font-display: swap; }
body { font-family: 'Noto Nastaliq Urdu', serif; line-height: 2.5; }`
      : '';
  // All receipt content is escaped inert text. Physical print styles only.
  return `<!doctype html><html lang="${locale}" dir="${COUNTER_RECEIPT_DIRECTION[locale]}"><head>
<meta charset="utf-8"><title>${escapeHtml(receiptTitle(receipt, locale))}</title>
<style>@page { size: ${format === 'A4' ? 'A4' : 'auto'}; margin: ${format === 'A4' ? '10mm' : '0'}; }
* { box-sizing: border-box; } body { margin: 0; width: ${width}; max-width: 100%; padding: 3mm; font: 12px monospace; color: black; background: white; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }${urduFont}</style>
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
): void | Promise<void> {
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
    if (locale === 'ur' && format !== 'LABEL_50x30') {
      return popup.document.fonts
        .load('12px "Noto Nastaliq Urdu"')
        .then((faces) => {
          if (faces.length === 0) throw new Error('Urdu receipt font unavailable.');
          popup.focus();
          popup.print();
        })
        .catch(() => {
          closePopup(popup);
          throw new Error(
            'The Urdu receipt font or print dialog could not load. Retry Print receipt.'
          );
        });
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
function printCounterDocument(html: string, retry = 'Print receipt'): void {
  const popup = window.open('', '_blank', 'popup,width=480,height=720');
  if (!popup) throw new Error(`Allow pop-ups for this site, then retry ${retry}.`);
  popup.opener = null;
  try {
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
    popup.focus();
    popup.print();
  } catch {
    closePopup(popup);
    throw new Error(`The browser print dialog could not open. Retry ${retry}.`);
  }
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
