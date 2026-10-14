import {
  RawPrintValidationError,
  validateRawStoredPrintDocument,
  type StoredPrintDocument,
} from './contract';
import { buildReceiptPreview, wrapReceiptText } from '@/lib/receipts/preview';

const ESC = 0x1b;
const GS = 0x1d;
const encoder = new TextEncoder();

function text(value: string): number[] {
  if (!/^[\x20-\x7e\n]*$/.test(value)) throw new RawPrintValidationError('UNSUPPORTED_PRINT_TEXT');
  return [...encoder.encode(value)];
}

/** Vendor-neutral ESC/POS baseline: initialize, centered bold header, left-aligned body, cut. */
export function renderEscPos(document: StoredPrintDocument): Uint8Array {
  document = validateRawStoredPrintDocument(document);
  if (document.receiptSnapshot) {
    const { layout, facts } = document.receiptSnapshot;
    const body = buildReceiptPreview(layout, facts);
    return Uint8Array.from([
      ESC,
      0x40,
      ESC,
      0x61,
      0x00,
      ESC,
      0x45,
      0x00,
      ...text(`${body}\n\n\n\n`),
      GS,
      0x56,
      0x00,
    ]);
  }
  // No snapshot means exact historical bytes, including unwrapped legacy lines.
  const columns = document.ticketPrintSnapshot
    ? document.ticketPrintSnapshot.paperWidthMm === 58
      ? 32
      : 48
    : undefined;
  const lineText = (value: string) =>
    columns ? wrapReceiptText(value, columns).join('\n') : value;
  const divider = '-'.repeat(columns ?? 32);
  const out: number[] = [ESC, 0x40, ESC, 0x61, 0x01, ESC, 0x45, 0x01];
  out.push(...text(`${lineText(document.title)}\n${lineText(document.reference)}\n`));
  out.push(ESC, 0x45, 0x00, ESC, 0x61, 0x00, ...text(`${divider}\n`));
  for (const line of document.lines)
    out.push(...text(`${lineText(`${line.quantity} x ${line.label}`)}\n`));
  if (document.footer) out.push(...text(`${divider}\n${lineText(document.footer)}\n`));
  out.push(...text('\n\n\n'), GS, 0x56, 0x00);
  return Uint8Array.from(out);
}
