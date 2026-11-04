import { COUNTER_RECEIPT_DIRECTION, type CounterReceiptLocale } from './counter-receipt';

/**
 * DEV-742: a printer test page for the browser/OS print dialog.
 *
 * Not a receipt: no sale, receipt number, money or patient data, so it can never be
 * mistaken for (or reused as) an original or a reprint. It checks only what a test
 * page can check — paper width and printable edges, 100% scale, print darkness and
 * whether this computer can render Urdu. Opening the dialog never confirms paper
 * output; only the operator can see the paper.
 *
 * No ESC/POS, queue or bridge: direct thermal dispatch belongs to DEV-741.
 */
export const PRINTER_TEST_FORMATS = ['THERMAL', 'THERMAL_58', 'A4'] as const;
export type PrinterTestFormat = (typeof PRINTER_TEST_FORMATS)[number];

type TestPageStrings = {
  title: string;
  notReceipt: string;
  branch: string;
  paper: string;
  paperName: Record<PrinterTestFormat, string>;
  printedAt: string;
  edgeCheck: string;
  scaleCheck: string;
  englishSample: string;
  urduSample: string;
  urduHelp: string;
  end: string;
};

/** Both languages in one table so a new line cannot ship half-translated. */
export const PRINTER_TEST_STRINGS: Readonly<Record<CounterReceiptLocale, TestPageStrings>> = {
  en: {
    title: 'PRINTER TEST PAGE',
    notReceipt: 'Not a receipt. No sale, no receipt number, no money.',
    branch: 'Branch',
    paper: 'Paper',
    paperName: {
      THERMAL: 'Thermal roll, 80 mm',
      THERMAL_58: 'Thermal roll, 58 mm',
      A4: 'A4 sheet',
    },
    printedAt: 'Printed',
    edgeCheck:
      'Edge check: both arrows above must print in full. If one is cut off, pick this paper size and set margins to None or Default in the print dialog.',
    scaleCheck:
      'Scale check: the black bar should measure 40 mm and be solid. If it is shorter or longer, set scale to 100% (Actual size). Faded or streaky print means the paper or print head needs attention.',
    englishSample: 'English sample',
    urduSample: 'Urdu sample',
    urduHelp:
      'If the Urdu line shows boxes or question marks, this computer has no Urdu font for printing. Print Urdu receipts from a computer that has one.',
    end: '— End of test page —',
  },
  ur: {
    title: 'پرنٹر ٹیسٹ صفحہ',
    notReceipt: 'یہ رسید نہیں ہے۔ نہ کوئی فروخت، نہ رسید نمبر، نہ کوئی رقم۔',
    branch: 'برانچ',
    paper: 'کاغذ',
    paperName: {
      THERMAL: 'تھرمل رول، 80 ملی میٹر',
      THERMAL_58: 'تھرمل رول، 58 ملی میٹر',
      A4: 'A4 صفحہ',
    },
    printedAt: 'پرنٹ کا وقت',
    edgeCheck:
      'کناروں کی جانچ: اوپر دونوں تیر پورے پرنٹ ہونے چاہئیں۔ اگر کوئی کٹ جائے تو پرنٹ ڈائیلاگ میں یہی کاغذ منتخب کریں اور مارجن None یا Default رکھیں۔',
    scaleCheck:
      'سائز کی جانچ: کالی پٹی 40 ملی میٹر لمبی اور پوری سیاہ ہونی چاہیے۔ اگر چھوٹی یا بڑی ہو تو اسکیل 100% (Actual size) رکھیں۔ ہلکی یا دھاری دار پرنٹنگ کا مطلب ہے کہ کاغذ یا پرنٹ ہیڈ کو دیکھنا ہوگا۔',
    englishSample: 'انگریزی نمونہ',
    urduSample: 'اردو نمونہ',
    urduHelp:
      'اگر اردو سطر میں خانے یا سوالیہ نشان نظر آئیں تو اس کمپیوٹر میں پرنٹ کے لیے اردو فونٹ نہیں ہے۔ اردو رسیدیں ایسے کمپیوٹر سے پرنٹ کریں جس میں اردو فونٹ ہو۔',
    end: '— ٹیسٹ صفحہ ختم —',
  },
};

/** Fixed sample text, identical in both page languages so the font check is comparable. */
export const PRINTER_TEST_SAMPLES = Object.freeze({
  en: 'Paracetamol 500 mg | Batch AB-123 | Exp 01/2028 | 0123456789',
  ur: 'پیراسیٹامول 500 ملی گرام | بیچ AB-123 | میعاد 01/2028',
});

const WIDTH: Record<PrinterTestFormat, string> = {
  THERMAL: '80mm',
  THERMAL_58: '58mm',
  A4: '190mm',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
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

export type PrinterTestPageInput = {
  format: PrinterTestFormat;
  locale: CounterReceiptLocale;
  branchName: string;
  printedAt: Date;
  /** The workspace zone, so the printed time matches the counter's clock. */
  timeZone?: string;
};

function printedAtText(input: PrinterTestPageInput): string {
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
  try {
    return new Intl.DateTimeFormat(input.locale === 'ur' ? 'ur-PK' : 'en-PK', {
      ...options,
      timeZone: input.timeZone,
    }).format(input.printedAt);
  } catch {
    // An unknown stored zone must not stop a test print; fall back to the device clock.
    return new Intl.DateTimeFormat(input.locale === 'ur' ? 'ur-PK' : 'en-PK', options).format(
      input.printedAt
    );
  }
}

/** Every value is escaped inert text. Page styles mirror the counter receipt's paper. */
export function buildPrinterTestPage(input: PrinterTestPageInput): string {
  if (
    !PRINTER_TEST_FORMATS.includes(input.format) ||
    !['en', 'ur'].includes(input.locale) ||
    Number.isNaN(input.printedAt.getTime())
  ) {
    throw new Error('Choose a supported paper size and language.');
  }
  const t = PRINTER_TEST_STRINGS[input.locale];
  const a4 = input.format === 'A4';
  const line = (label: string, value: string) =>
    `<p><span class="label">${escapeHtml(label)}:</span> <bdi>${escapeHtml(value)}</bdi></p>`;
  return `<!doctype html><html lang="${input.locale}" dir="${COUNTER_RECEIPT_DIRECTION[input.locale]}"><head>
<meta charset="utf-8"><title>${escapeHtml(t.title)}</title>
<style>@page { size: ${a4 ? 'A4' : 'auto'}; margin: ${a4 ? '10mm' : '0'}; }
* { box-sizing: border-box; } body { margin: 0; width: ${WIDTH[input.format]}; max-width: 100%; padding: 3mm 3mm 12mm; font: 12px monospace; color: black; background: white; }
h1 { font-size: 14px; margin: 0 0 2mm; text-align: center; } p { margin: 0 0 2mm; white-space: pre-wrap; overflow-wrap: anywhere; }
.label { font-weight: bold; } .notice { border: 1px solid black; padding: 1mm; text-align: center; }
.edges { display: flex; justify-content: space-between; direction: ltr; font-size: 16px; line-height: 1; margin: 2mm 0 1mm; }
.bar { width: 40mm; height: 4mm; background: black; margin: 2mm 0 1mm; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.end { text-align: center; margin-top: 3mm; }</style>
</head><body>
<h1>${escapeHtml(t.title)}</h1>
<p class="notice">${escapeHtml(t.notReceipt)}</p>
${line(t.branch, input.branchName)}
${line(t.paper, t.paperName[input.format])}
${line(t.printedAt, printedAtText(input))}
<div class="edges" aria-hidden="true"><span>&#9664;</span><span>&#9654;</span></div>
<p>${escapeHtml(t.edgeCheck)}</p>
<div class="bar" aria-hidden="true"></div>
<p>${escapeHtml(t.scaleCheck)}</p>
<p><span class="label">${escapeHtml(t.englishSample)}:</span> <bdi lang="en" dir="ltr">${escapeHtml(PRINTER_TEST_SAMPLES.en)}</bdi></p>
<p><span class="label">${escapeHtml(t.urduSample)}:</span> <bdi lang="ur" dir="rtl">${escapeHtml(PRINTER_TEST_SAMPLES.ur)}</bdi></p>
<p>${escapeHtml(t.urduHelp)}</p>
<p class="end">${escapeHtml(t.end)}</p>
</body></html>`;
}

export type PrinterTestPrintErrorCode = 'POPUP_BLOCKED' | 'DIALOG_FAILED';

export class PrinterTestPrintError extends Error {
  constructor(readonly code: PrinterTestPrintErrorCode) {
    super(code === 'POPUP_BLOCKED' ? 'Print window blocked.' : 'Print dialog failed to open.');
    this.name = 'PrinterTestPrintError';
  }
}

/**
 * Call from the operator's click. Opens an isolated window and asks the browser for its
 * print dialog. Returning means the dialog was requested — not that paper came out,
 * and not that the operator pressed Print rather than Cancel. Browsers do not say.
 */
export function openPrinterTestPage(html: string): void {
  let popup: Window | null = null;
  try {
    popup = window.open('', '_blank', 'popup,width=480,height=720');
  } catch {
    popup = null;
  }
  if (!popup) throw new PrinterTestPrintError('POPUP_BLOCKED');
  try {
    popup.opener = null;
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
    popup.focus();
    popup.print();
  } catch {
    try {
      popup.close();
    } catch {
      // Cleanup must not hide the original failure.
    }
    throw new PrinterTestPrintError('DIALOG_FAILED');
  }
}
