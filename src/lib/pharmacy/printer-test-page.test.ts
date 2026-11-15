import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildPrinterTestPage,
  counterFormatFromLayout,
  printPrinterTestPage,
} from './counter-browser-print';
import { DEFAULT_RECEIPT_LAYOUT, ReceiptLayoutSchema } from '@/lib/receipts/configuration';

afterEach(() => vi.restoreAllMocks());

describe('DEV-742 branch paper as the counter default', () => {
  it('stores only the supported browser paper preferences in the branch layout', () => {
    for (const browserPaper of ['THERMAL', 'A4'])
      expect(
        ReceiptLayoutSchema.safeParse({ ...DEFAULT_RECEIPT_LAYOUT, browserPaper }).success
      ).toBe(true);
    for (const browserPaper of ['LETTER', 'LABEL_50x30', ''])
      expect(
        ReceiptLayoutSchema.safeParse({ ...DEFAULT_RECEIPT_LAYOUT, browserPaper }).success
      ).toBe(false);
  });

  it('maps the saved layout to a counter format and defaults absent settings to 80 mm', () => {
    expect(counterFormatFromLayout(undefined)).toBe('THERMAL');
    expect(counterFormatFromLayout({ paperWidth: 80 })).toBe('THERMAL');
    expect(counterFormatFromLayout({ paperWidth: 58 })).toBe('THERMAL_58');
    expect(counterFormatFromLayout({ paperWidth: 58, browserPaper: 'THERMAL' })).toBe('THERMAL_58');
    expect(counterFormatFromLayout({ paperWidth: 58, browserPaper: 'A4' })).toBe('A4');
  });
});

describe('DEV-742 printer test page', () => {
  it.each([
    ['THERMAL_58', '58mm', 32],
    ['THERMAL', '80mm', 48],
  ] as const)(
    'sizes %s to the roll and draws a ruler of the receipt columns',
    (format, width, columns) => {
      const html = buildPrinterTestPage(format, 'en', 'Main branch');
      expect(html).toContain(`width: ${width}`);
      expect(html).toContain('@page { size: auto; margin: 0; }');
      expect(html).toContain(`|${'-'.repeat(columns - 2)}|`);
    }
  );

  it('uses an A4 sheet for the ordinary printer route', () => {
    const html = buildPrinterTestPage('A4', 'en', 'Main branch');
    expect(html).toContain('@page { size: A4; margin: 10mm; }');
    expect(html).toContain('A4 sheet');
  });

  it('is never a receipt and escapes the branch name', () => {
    const html = buildPrinterTestPage('THERMAL', 'en', '<b>Branch</b>');
    expect(html).toContain('This is not a receipt');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;Branch&lt;/b&gt;');
    expect(html).not.toMatch(/Invoice|PKR/);
  });

  it('renders Urdu right-to-left with an Urdu title', () => {
    const html = buildPrinterTestPage('THERMAL_58', 'ur', 'شاخ');
    expect(html).toContain('lang="ur" dir="rtl"');
    expect(html).toContain('پرنٹر ٹیسٹ صفحہ');
  });

  it('refuses unsupported paper or language', () => {
    expect(() => buildPrinterTestPage('LETTER' as never, 'en', 'B')).toThrow(/supported/);
    expect(() => buildPrinterTestPage('A4', 'fr' as never, 'B')).toThrow(/supported/);
  });

  it('asks to allow pop-ups when the browser blocks the print window', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(() => printPrinterTestPage('A4', 'en', 'B')).toThrow(
      'Allow pop-ups for this site, then retry Print test page.'
    );
  });

  it('opens the browser/OS dialog with the test page and closes the window on failure', () => {
    const write = vi.fn();
    const print = vi.fn();
    const popup = {
      opener: {},
      document: { open: vi.fn(), write, close: vi.fn() },
      focus: vi.fn(),
      print,
      close: vi.fn(),
    };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    printPrinterTestPage('THERMAL', 'en', 'Main');
    expect(popup.opener).toBeNull();
    expect(write.mock.calls[0]![0]).toContain('Printer test page');
    expect(print).toHaveBeenCalledOnce();

    print.mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => printPrinterTestPage('THERMAL', 'en', 'Main')).toThrow(
      'The browser print dialog could not open. Retry Print test page.'
    );
    expect(popup.close).toHaveBeenCalled();
  });
});
