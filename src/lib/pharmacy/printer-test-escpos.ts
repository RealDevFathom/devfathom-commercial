import { validateRawPrintDocument, type PrintDocument } from '@/lib/restaurant/printing/contract';
import { renderEscPos } from '@/lib/restaurant/printing/esc-pos';

/**
 * DEV-742 — the thermal bridge test page (ESC/POS, printable ASCII only).
 *
 * Server-built and fixed: the caller supplies only the paper width, never text.
 * It has no sale, receipt number, money or patient data, so it can never pass
 * as an original or a reprint (DEV-195). The edge ruler is sized to the roll's
 * column count, so a cut-off right edge shows a wrong roll or driver setting.
 * Urdu is deliberately absent: the raw baseline cannot print it, and Urdu
 * receipts use the browser/OS path (the browser test page checks that font).
 *
 * The shared renderer prefixes every line with "1 x "; labels are sized so
 * each printed line, prefix included, fits the roll exactly.
 */
const COLUMNS = { 58: 32, 80: 48 } as const;
const LINE_PREFIX = '1 x '.length;

export function buildPrinterTestPrintDocument(input: {
  paperWidth: 58 | 80;
  now: Date;
}): PrintDocument {
  const columns = COLUMNS[input.paperWidth];
  const ruler = `|${'-'.repeat(columns - LINE_PREFIX - 2)}|`;
  const label = (text: string) => ({ quantity: 1, label: text });
  return validateRawPrintDocument({
    type: 'RECEIPT',
    title: 'PRINTER TEST PAGE',
    reference: 'NOT A RECEIPT - NO SALE',
    createdAt: input.now.toISOString(),
    lines: [
      label(`Roll: ${input.paperWidth} mm, ${columns} chars`),
      label(ruler),
      label('Both | marks must print'),
      label('0123456789'),
      label('ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
      label('abcdefghijklmnopqrstuvwxyz'),
    ],
    footer: 'End of test page. No money.',
  });
}

/** The document plus the exact byte count the queue stores and re-checks at claim. */
export function buildPrinterTestPrintJob(input: { paperWidth: 58 | 80; now: Date }) {
  const document = buildPrinterTestPrintDocument(input);
  return { document, byteCount: renderEscPos(document).length, paperWidth: input.paperWidth };
}
