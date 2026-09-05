import { describe, expect, it } from 'vitest';
import { DEFAULT_RECEIPT_LAYOUT, ReceiptLayoutSchema, readReceiptLayout } from './configuration';
import { buildReceiptPreview, receiptColumns, SAMPLE_RECEIPT, wrapReceiptText } from './preview';

describe('shared receipt design input', () => {
  it('defaults only absent storage and rejects corrupt or future settings', () => {
    expect(readReceiptLayout(null)).toEqual(DEFAULT_RECEIPT_LAYOUT);
    for (const value of [undefined, {}, { ...DEFAULT_RECEIPT_LAYOUT, version: 2 }]) {
      expect(() => readReceiptLayout(value)).toThrow();
    }
  });
  it.each([58, 80] as const)('wraps every preview line for %imm', (paperWidth) => {
    const layout = { ...DEFAULT_RECEIPT_LAYOUT, paperWidth, headerText: 'a'.repeat(100) };
    const preview = buildReceiptPreview(layout, SAMPLE_RECEIPT);
    expect(preview.split('\n').every((line) => line.length <= receiptColumns(layout))).toBe(true);
    expect(preview.replaceAll('\n', '')).toContain('a'.repeat(100));
  });
  it.each(['\x1b@', '\x1dV', '\x00', '\r', '<script>alert(1)</script>', '\u202e', '🙂'])(
    'rejects unsafe text %j',
    (footerText) => {
      expect(ReceiptLayoutSchema.safeParse({ ...DEFAULT_RECEIPT_LAYOUT, footerText }).success).toBe(
        false
      );
    }
  );
  it('rejects money-hiding fields, arbitrary widths and excessive input', () => {
    for (const patch of [{ showTax: false }, { paperWidth: 42 }, { headerText: 'a'.repeat(241) }]) {
      expect(ReceiptLayoutSchema.safeParse({ ...DEFAULT_RECEIPT_LAYOUT, ...patch }).success).toBe(
        false
      );
    }
  });
  it('keeps every mandatory fact unchanged with optional fields off', () => {
    const snapshot = {
      ...SAMPLE_RECEIPT,
      lines: ['Item 1.23'],
      taxLines: ['Tax 0.07'],
      totals: ['Total 1.30'],
      payments: ['Cash 2.00', 'Change 0.70'],
    };
    const preview = buildReceiptPreview(
      { ...DEFAULT_RECEIPT_LAYOUT, showOrderNumber: false, showChannel: false },
      snapshot
    );
    for (const line of [
      snapshot.businessName,
      snapshot.invoiceNumber,
      snapshot.issuedAt,
      ...snapshot.lines,
      ...snapshot.taxLines,
      ...snapshot.totals,
      ...snapshot.payments,
    ])
      expect(preview).toContain(line);
    expect(preview).not.toContain('Order:');
    expect(preview).not.toContain('Channel:');
  });
  it('preserves blank lines, wraps long words, rejects printer commands in facts', () => {
    expect(wrapReceiptText('abcdef\n\nword word', 4)).toEqual(['abcd', 'ef', '', 'word', 'word']);
    expect(() =>
      buildReceiptPreview(DEFAULT_RECEIPT_LAYOUT, { ...SAMPLE_RECEIPT, invoiceNumber: '\x1b@' })
    ).toThrow();
    expect(() => wrapReceiptText('test', 0)).toThrow();
  });
});
