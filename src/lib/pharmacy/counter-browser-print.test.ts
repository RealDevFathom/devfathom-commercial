import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCounterBrowserReceipt, printCounterBrowserReceipt } from './counter-browser-print';
import type { CounterReceipt, CounterReceiptLocale } from './counter-receipt';

const receipt: CounterReceipt = {
  saleId: 'sale-1',
  receiptNumber: 12,
  branchName: 'Branch <script>bad()</script>',
  completedAt: '2026-09-05T10:00:00Z',
  businessDate: '2026-09-05',
  currency: 'PKR',
  lines: [
    {
      saleLineId: 'line-1',
      medicineName: 'Medicine & name',
      strength: '500 mg',
      presentation: 'Tablet',
      batchNumber: 'Batch 1',
      expiresAt: '2027-01-01',
      saleUnit: 'UNIT',
      quantity: 2,
      canonicalUnits: 2,
      unitPriceMinor: 100,
      discountMinor: 0,
      lineTotalMinor: 179,
    },
  ],
  tenders: [{ tenderId: 'tender-1', type: 'CASH', amountMinor: 190, changeGivenMinor: 11 }],
  totals: {
    grossMinor: 200,
    discountMinor: 21,
    netMinor: 179,
    tenderedMinor: 190,
    changeMinor: 11,
  },
};

afterEach(() => vi.restoreAllMocks());

describe('isolated Pharmacy browser receipt', () => {
  it.each([
    ['THERMAL_58', '58mm'],
    ['THERMAL', '80mm'],
    ['A4', '190mm'],
  ] as const)('uses %s physical width', (format, width) => {
    expect(buildCounterBrowserReceipt(receipt, 'en', format)).toContain(`width: ${width}`);
  });

  it('preserves supplied amounts and source on reprint, without repricing', () => {
    const before = JSON.stringify(receipt);
    const html = buildCounterBrowserReceipt(receipt, 'en', 'THERMAL', true);
    expect(html).toContain('Amount: 1.79');
    expect(html).toContain('<dt>Total</dt><dd>1.79</dd>');
    expect(html).toContain('<dt>Change</dt><dd>0.11</dd>');
    expect(html).toContain('Receipt 12');
    expect(html).toContain('Reprint — not a new sale');
    expect(JSON.stringify(receipt)).toBe(before);
  });

  it('escapes markup, excludes patient, prescription, return and fiscal extras', () => {
    const source = {
      ...receipt,
      patientName: 'PRIVATE_PATIENT',
      prescription: 'PRIVATE_RX',
      fiscal: 'PRIVATE_FISCAL',
      returns: [{ refund: 'PRIVATE_RETURN' }],
    };
    const html = buildCounterBrowserReceipt(source, 'en', 'THERMAL');
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    expect(parsed.querySelector('script')).toBeNull();
    expect(parsed.body.textContent).toContain('Branch <script>bad()</script>');
    expect(html).not.toContain('PRIVATE_');
    expect(parsed.querySelector('img,iframe,link')).toBeNull();
  });

  it('supports Urdu direction without a lossy thermal byte encoding', () => {
    const html = buildCounterBrowserReceipt(receipt, 'ur', 'THERMAL_58');
    expect(html).toContain('lang="ur" dir="rtl"');
    expect(html).toContain('قابلِ ادائیگی');
  });

  it('refuses unsettled, empty, invalid amounts and unsupported input before opening a window', () => {
    const open = vi.spyOn(window, 'open');
    for (const source of [
      { ...receipt, receiptNumber: null },
      { ...receipt, lines: [] },
      { ...receipt, totals: { ...receipt.totals, netMinor: NaN } },
    ])
      expect(() => printCounterBrowserReceipt(source, 'en', 'A4')).toThrow();
    expect(() =>
      printCounterBrowserReceipt(receipt, 'bad' as CounterReceiptLocale, 'A4')
    ).toThrow();
    expect(open).not.toHaveBeenCalled();
  });

  it('reports blocked popups without printing the POS page', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    expect(() => printCounterBrowserReceipt(receipt, 'en', 'A4')).toThrow('Allow pop-ups');
    expect(print).not.toHaveBeenCalled();
  });

  it('prints the isolated document, disconnects opener and leaves receipt available', () => {
    const popup = {
      opener: window,
      document: { open: vi.fn(), write: vi.fn(), close: vi.fn() },
      focus: vi.fn(),
      print: vi.fn(),
      close: vi.fn(),
    };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    printCounterBrowserReceipt(receipt, 'en', 'THERMAL');
    expect(popup.opener).toBeNull();
    expect(popup.document.write).toHaveBeenCalledWith(
      buildCounterBrowserReceipt(receipt, 'en', 'THERMAL')
    );
    expect(popup.print).toHaveBeenCalledOnce();
    expect(popup.close).not.toHaveBeenCalled();
  });

  it('closes the isolated window on print failure and exposes retry guidance', () => {
    const popup = {
      opener: null,
      document: { open: vi.fn(), write: vi.fn(), close: vi.fn() },
      focus: vi.fn(),
      print: vi.fn(() => {
        throw new Error('unavailable');
      }),
      close: vi.fn(),
    };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    expect(() => printCounterBrowserReceipt(receipt, 'en', 'A4')).toThrow('Retry Print receipt');
    expect(popup.close).toHaveBeenCalledOnce();
  });
});
