import { describe, expect, it } from 'vitest';
import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';
import { buildReceiptPreview, SAMPLE_RECEIPT } from '@/lib/receipts/preview';
import { PrintDocumentSchema, type PrintDocument } from './contract';
import { renderEscPos } from './esc-pos';

const document: PrintDocument = {
  type: 'RECEIPT',
  reference: 'INV-1',
  title: 'Receipt',
  createdAt: '2026-09-05T12:00:00.000Z',
  lines: [{ quantity: 1, label: 'Legacy item' }],
};

describe('queued receipt snapshot', () => {
  it.each([58, 80] as const)(
    'prints the exact shared %s mm preview and mandatory facts',
    (paperWidth) => {
      const layout = {
        ...DEFAULT_RECEIPT_LAYOUT,
        paperWidth,
        showOrderNumber: false,
        showChannel: false,
      };
      const receiptSnapshot = { layout, facts: SAMPLE_RECEIPT };
      const bytes = renderEscPos({ ...document, receiptSnapshot });
      const body = new TextDecoder().decode(bytes.slice(8, -3));
      expect(body).toBe(`${buildReceiptPreview(layout, SAMPLE_RECEIPT)}\n\n\n\n`);
      expect(body).toContain('Total: PKR 1050.00');
      expect(body).toContain('Change: PKR 50.00');
      expect(body).not.toContain('Legacy item');
      expect(body.split('\n').every((line) => line.length <= (paperWidth === 58 ? 32 : 48))).toBe(
        true
      );
    }
  );

  it('captures layout and facts independently of subsequent mutations', () => {
    const layout = { ...DEFAULT_RECEIPT_LAYOUT };
    const facts = { ...SAMPLE_RECEIPT, totals: [...SAMPLE_RECEIPT.totals] };
    const queued = PrintDocumentSchema.parse({ ...document, receiptSnapshot: { layout, facts } });
    const before = renderEscPos(queued);
    layout.footerText = 'Changed later';
    facts.totals[0] = 'Changed later';
    expect(renderEscPos(queued)).toEqual(before);
  });

  it('keeps legacy ASCII documents supported', () => {
    expect(new TextDecoder().decode(renderEscPos(document))).toContain('1 x Legacy item');
  });

  it('rejects snapshots on kitchen tickets', () => {
    expect(() =>
      renderEscPos({
        ...document,
        type: 'KITCHEN_TICKET',
        receiptSnapshot: {
          layout: { ...DEFAULT_RECEIPT_LAYOUT },
          facts: SAMPLE_RECEIPT,
        },
      })
    ).toThrow();
  });

  it.each(['\u001b@', 'اردو'])('rejects unsafe or unsupported legacy text: %s', (label) => {
    expect(() => renderEscPos({ ...document, lines: [{ quantity: 1, label }] })).toThrow(
      'Use a browser/OS-rendered receipt'
    );
  });

  it('rejects missing monetary facts and injected commands in snapshots', () => {
    for (const facts of [
      { ...SAMPLE_RECEIPT, taxLines: [] },
      { ...SAMPLE_RECEIPT, businessName: '\u001b@' },
    ]) {
      expect(() =>
        renderEscPos({
          ...document,
          receiptSnapshot: { layout: { ...DEFAULT_RECEIPT_LAYOUT }, facts },
        })
      ).toThrow();
    }
  });
});
