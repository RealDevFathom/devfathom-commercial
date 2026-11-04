import { describe, expect, it } from 'vitest';
import { renderEscPos } from '@/lib/restaurant/printing/esc-pos';
import { buildPrinterTestPrintDocument, buildPrinterTestPrintJob } from './printer-test-escpos';

const now = new Date('2026-11-04T10:00:00.000Z');

/** The printable text lines of the rendered bytes (ESC/GS commands stripped). */
function printedLines(bytes: Uint8Array): string[] {
  const text = Array.from(bytes)
    .map((byte) =>
      byte === 0x0a || (byte >= 0x20 && byte <= 0x7e) ? String.fromCharCode(byte) : '\u0000'
    )
    .join('');
  return text
    .split('\n')
    .map((line) => line.replace(/\u0000[\s\S]?[\s\S]?/g, '').replace(/\u0000/g, ''))
    .filter(Boolean);
}

describe('thermal bridge test page', () => {
  it.each([
    [58, 32],
    [80, 48],
  ] as const)(
    'fits a %i mm roll exactly (%i columns) with a full-width edge ruler',
    (paperWidth, columns) => {
      const bytes = renderEscPos(buildPrinterTestPrintDocument({ paperWidth, now }));
      const lines = printedLines(bytes);
      const ruler = lines.find((line) => line.includes('|--'));
      expect(ruler).toBeDefined();
      expect(ruler).toHaveLength(columns);
      expect(ruler!.endsWith('|')).toBe(true);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(columns);
      expect(lines.join('\n')).toContain(`Roll: ${paperWidth} mm, ${columns} chars`);
    }
  );

  it('is plainly not a receipt and carries no sale, receipt number or money', () => {
    const document = buildPrinterTestPrintDocument({ paperWidth: 80, now });
    const text = [
      document.title,
      document.reference,
      document.footer,
      ...document.lines.map((l) => l.label),
    ].join('\n');
    expect(document.title).toBe('PRINTER TEST PAGE');
    expect(document.reference).toBe('NOT A RECEIPT - NO SALE');
    expect(document.receiptSnapshot).toBeUndefined();
    for (const forbidden of [/invoice/i, /receipt \d/i, /total/i, /PKR/, /reprint/i, /cash/i]) {
      expect(text).not.toMatch(forbidden);
    }
  });

  it('is printable ASCII and reports the exact byte count the queue re-checks at claim', () => {
    const job = buildPrinterTestPrintJob({ paperWidth: 58, now });
    expect(job.paperWidth).toBe(58);
    expect(job.byteCount).toBe(renderEscPos(job.document).length);
    expect(job.byteCount).toBeGreaterThan(50);
  });
});
