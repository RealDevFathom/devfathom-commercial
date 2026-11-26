import {
  RawPrintValidationError,
  validateRawStoredPrintDocument,
  type PrintDocument,
} from '@/lib/restaurant/printing/contract';
import { renderEscPos } from '@/lib/restaurant/printing/esc-pos';
import { wrapReceiptText } from '@/lib/receipts/preview';
import { encodeQr } from '@/lib/qr/qr-code';
import { ReceiptDesignSchema, type ReceiptDesign } from './receipt-layout';
import { receiptBlocks } from './receipt-blocks';

export type PharmacyPrintDocument = PrintDocument & { pharmacyDesign?: ReceiptDesign };

/** Fixed monochrome raster command. The input is the server's QR matrix, never supplied bytes. */
function thermalQr(url: string) {
  const matrix = encodeQr(url),
    scale = 3,
    size = (matrix.length + 8) * scale,
    stride = Math.ceil(size / 8);
  const pixels = new Uint8Array(size * stride);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      if (matrix[Math.floor(y / scale) - 4]?.[Math.floor(x / scale) - 4])
        pixels[y * stride + (x >> 3)]! |= 0x80 >> (x % 8);
    }
  return [29, 118, 48, 0, stride, 0, size, 0, ...pixels];
}

/** Revalidate both the optional settings and the historic document on queue replay. */
export function renderPharmacyThermal(input: unknown): Uint8Array {
  if (!input || typeof input !== 'object' || !('pharmacyDesign' in input))
    return renderEscPos(validateRawStoredPrintDocument(input));
  const { pharmacyDesign, ...base } = input;
  const result = ReceiptDesignSchema.safeParse(pharmacyDesign);
  const document = validateRawStoredPrintDocument(base);
  if (!result.success || !document.receiptSnapshot)
    throw new RawPrintValidationError('INVALID_PRINT_DOCUMENT');
  const layout = result.data;
  if (layout.locale !== 'en') throw new RawPrintValidationError('UNSUPPORTED_PRINT_TEXT');
  const { facts } = document.receiptSnapshot;
  const blocks = receiptBlocks(
    layout,
    facts,
    document.title.endsWith(' (reprint)') ? 'REPRINT - not a new sale' : 'Original',
    layout.paperWidth
  );
  const out = [27, 64];
  const append = (s: string) => {
    if (!/^[\x20-\x7e\n]*$/.test(s)) throw new RawPrintValidationError('UNSUPPORTED_PRINT_TEXT');
    for (const char of s) out.push(char.charCodeAt(0));
    out.push(10);
  };
  for (const block of blocks) {
    if (block.kind === 'website') {
      out.push(...thermalQr(block.url));
      append(wrapReceiptText(block.caption, layout.paperWidth === 58 ? 32 : 48).join('\n'));
      continue;
    }
    // The protected branch name is the text fallback for an unsupported raster logo.
    if (block.kind === 'logo') continue;
    if (block.kind === 'facts') {
      append(block.text);
      continue;
    }
    const large = block.emphasis === 'large';
    out.push(
      27,
      97,
      { start: 0, center: 1, end: 2 }[block.alignment],
      27,
      69,
      block.emphasis === 'bold' ? 1 : 0,
      29,
      33,
      large ? 17 : 0
    );
    append(
      wrapReceiptText(block.text, (layout.paperWidth === 58 ? 32 : 48) / (large ? 2 : 1)).join('\n')
    );
    out.push(27, 97, 0, 27, 69, 0, 29, 33, 0);
  }
  return Uint8Array.from([...out, 10, 10, 10, 29, 86, 0]);
}
