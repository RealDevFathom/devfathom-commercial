import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';
import { buildReceiptPreview, SAMPLE_RECEIPT } from '@/lib/receipts/preview';
import {
  PrintDocumentSchema,
  RawPrintValidationError,
  validateRawPrintDocument,
  type PrintDocument,
} from './contract';
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

  it.each(['title', 'reference', 'footer', 'label'] as const)(
    'rejects raw Unicode in legacy %s with a usable fallback',
    (field) => {
      const input =
        field === 'label'
          ? { ...document, lines: [{ quantity: 1, label: 'چائے' }] }
          : { ...document, [field]: 'چائے' };
      expect(PrintDocumentSchema.safeParse(input).success).toBe(true);
      for (const run of [() => validateRawPrintDocument(input), () => renderEscPos(input)]) {
        expect(run).toThrow(RawPrintValidationError);
        try {
          run();
        } catch (error) {
          expect(error).toMatchObject({ code: 'UNSUPPORTED_PRINT_TEXT', fallback: 'BROWSER_OS' });
          expect((error as Error).message).not.toContain('چائے');
        }
      }
    }
  );

  it.each(['\u001b@', '\n\u001dV', '\rtitle', '\titem', '\u0085', '\ud800'])(
    'rejects commands/invalid text before trimming or rendering: %j',
    (value) => {
      for (const input of [
        { ...document, title: value },
        { ...document, lines: [{ quantity: 1, label: value }] },
        {
          ...document,
          receiptSnapshot: {
            layout: { ...DEFAULT_RECEIPT_LAYOUT },
            facts: { ...SAMPLE_RECEIPT, businessName: value },
          },
        },
      ]) {
        expect(() => validateRawPrintDocument(input)).toThrow(RawPrintValidationError);
        try {
          validateRawPrintDocument(input);
        } catch (error) {
          expect(error).toMatchObject({ code: 'INVALID_PRINT_DOCUMENT', fallback: null });
        }
      }
    }
  );

  it.each([58, 80] as const)(
    'shares complete Unicode facts with inert %smm browser output, never raw printing',
    (paperWidth) => {
      const text = 'چائے e\u0301 👩‍👩‍👧‍👦 '.repeat(6);
      const layout = {
        ...DEFAULT_RECEIPT_LAYOUT,
        paperWidth,
        headerText: 'خوش آمدید',
        footerText: text,
      };
      const facts = {
        ...SAMPLE_RECEIPT,
        businessName: 'دکان',
        lines: [text, '<img src=x onerror=alert(1)>'],
      };
      const parsed = PrintDocumentSchema.parse({ ...document, receiptSnapshot: { layout, facts } });
      const preview = buildReceiptPreview(
        parsed.receiptSnapshot!.layout,
        parsed.receiptSnapshot!.facts
      );
      expect(preview).toContain(text);
      expect(preview).toContain('Total: PKR 1050.00');
      expect(preview).toContain('Change: PKR 50.00');
      const html = renderToStaticMarkup(createElement('pre', null, preview));
      expect(html).toContain(text);
      expect(html).toContain('&lt;img');
      expect(html).not.toContain('<img');
      expect(() => validateRawPrintDocument(parsed)).toThrow('Use a browser/OS-rendered receipt');
      expect(() => renderEscPos(parsed)).toThrow('Use a browser/OS-rendered receipt');
    }
  );

  it('accepts complete ASCII snapshots through the explicit raw boundary', () => {
    const input = {
      ...document,
      receiptSnapshot: { layout: { ...DEFAULT_RECEIPT_LAYOUT }, facts: SAMPLE_RECEIPT },
    };
    expect(validateRawPrintDocument(input)).toEqual(input);
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

it('checks the optional invoice label at the raw ASCII boundary', () => {
  const input = {
    ...document,
    receiptSnapshot: {
      layout: DEFAULT_RECEIPT_LAYOUT,
      facts: { ...SAMPLE_RECEIPT, invoiceLabel: 'رسید' },
    },
  };
  expect(PrintDocumentSchema.safeParse(input).success).toBe(true);
  for (const run of [() => validateRawPrintDocument(input), () => renderEscPos(input)]) {
    expect(run).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_PRINT_TEXT', fallback: 'BROWSER_OS' })
    );
  }
});
