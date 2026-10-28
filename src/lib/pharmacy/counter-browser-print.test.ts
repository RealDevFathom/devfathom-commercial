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
    expect(html).toContain('Total: 1.79');
    expect(html).toContain('Change: 0.11');
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
    const html = buildCounterBrowserReceipt(source as unknown as CounterReceipt, 'en', 'THERMAL');
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

  it.each(['THERMAL_58', 'THERMAL', 'A4'] as const)(
    'renders every issued allocation with one amount in %s',
    (format) => {
      const source: CounterReceipt = {
        ...receipt,
        lines: [
          {
            ...receipt.lines[0]!,
            identityStatus: 'ISSUED',
            medicineName: 'دوا 👩‍⚕️',
            expiresAt: '',
            allocations: [
              {
                allocationId: 'a',
                inventoryLotId: 'a',
                batchNumber: '<img src=x>',
                expiresAt: '2027-01-01',
                canonicalUnits: 3,
              },
              {
                allocationId: 'b',
                inventoryLotId: 'b',
                batchNumber: 'بیچ ب',
                expiresAt: '2028-02-02',
                canonicalUnits: 7,
              },
            ],
          },
        ],
      };
      const before = JSON.stringify(source);
      const parsed = new DOMParser().parseFromString(
        buildCounterBrowserReceipt(source as unknown as CounterReceipt, 'en', format),
        'text/html'
      );
      expect(parsed.querySelector('img')).toBeNull();
      const text = parsed.body.textContent!.replace(/\s+/g, ' ');
      expect(text).toContain('دوا 👩‍⚕️');
      expect(text).toContain('Batch: <img src=x> · Expiry: 2027-01-01 · Canonical units: 3');
      expect(text).toContain('Batch: بیچ ب · Expiry: 2028-02-02 · Canonical units: 7');
      expect(text.match(/Amount: 1.79/g)).toHaveLength(1);
      expect(text).toContain('Total: 1.79');
      expect(JSON.stringify(source)).toBe(before);
    }
  );

  it.each(['en', 'ur'] as const)(
    'localizes unavailable identity without catalog fallback in %s',
    (locale) => {
      const source: CounterReceipt = {
        ...receipt,
        lines: [
          {
            ...receipt.lines[0]!,
            identityStatus: 'UNAVAILABLE',
            medicineName: 'LIVE_CATALOG',
            allocations: [
              {
                allocationId: 'a',
                inventoryLotId: 'a',
                batchNumber: null,
                expiresAt: null,
                canonicalUnits: 3,
              },
            ],
          },
        ],
      };
      const html = buildCounterBrowserReceipt(source as unknown as CounterReceipt, locale, 'A4');
      expect(html).toContain(
        locale === 'en' ? 'Historical identity unavailable' : 'تاریخی شناخت دستیاب نہیں'
      );
      expect(html).not.toContain('LIVE_CATALOG');
      expect(html).not.toContain('Batch 1');
      expect(html).not.toContain('2027-01-01');
    }
  );

  it('treats missing legacy identity status honestly and rejects shared-schema control input', () => {
    expect(buildCounterBrowserReceipt(receipt, 'en', 'A4')).toContain(
      'Historical identity unavailable'
    );
    expect(() =>
      buildCounterBrowserReceipt({ ...receipt, branchName: 'Bad\u001b' }, 'en', 'A4')
    ).toThrow();
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

describe('FBR sandbox receipt', () => {
  it.each(['THERMAL', 'THERMAL_58', 'A4'] as const)(
    'prints the persisted number and a local 7mm QR on %s',
    (format) => {
      const invoiceNumber = 'MOCK-FBR-0123456789abcdef01234567';
      const html = buildCounterBrowserReceipt(
        { ...receipt, fiscal: { status: 'SUBMITTED', mode: 'MOCK', invoiceNumber } },
        'en',
        format,
        true
      );
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      expect(parsed.body.textContent).toContain(invoiceNumber);
      expect(parsed.body.textContent).toContain('not valid for tax verification');
      const qr = parsed.querySelector('img')!;
      expect(qr.getAttribute('style')).toContain('width:7mm;height:7mm');
      expect(decodeURIComponent(qr.getAttribute('src')!)).toContain('<svg');
      expect(qr.getAttribute('src')).toMatch(/^data:image\/svg\+xml,/);
    }
  );
  it('shows pending status without claiming a fiscal number or printing a QR', () => {
    const html = buildCounterBrowserReceipt(
      { ...receipt, fiscal: { status: 'PENDING', mode: 'MOCK', invoiceNumber: null } },
      'ur',
      'THERMAL'
    );
    expect(html).toContain('submission pending');
    expect(new DOMParser().parseFromString(html, 'text/html').querySelector('img')).toBeNull();
  });
});
