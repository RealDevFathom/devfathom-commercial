import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';

import {
  buildCounterBrowserReceipt,
  buildCounterBrowserZReport,
  printCounterBrowserReceipt,
} from './counter-browser-print';
import type { CounterReceipt, CounterReceiptLocale } from './counter-receipt';
import {
  buildPharmacyReceiptPrintDocument,
  readPharmacyReceiptTaxIdentity,
} from './receipt-print';

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
  it.each(['en', 'ur'] as const)('includes every split tender in %s receipt output', (locale) => {
    const split: CounterReceipt = {
      ...receipt,
      lines: [
        {
          ...receipt.lines[0]!,
          quantity: 1,
          canonicalUnits: 1,
          unitPriceMinor: 100000,
          lineTotalMinor: 100000,
        },
      ],
      tenders: [
        { tenderId: 'cash', type: 'CASH', amountMinor: 60000, changeGivenMinor: 0 },
        { tenderId: 'khata', type: 'CREDIT', amountMinor: 30000, changeGivenMinor: null },
        { tenderId: 'wallet', type: 'WALLET', amountMinor: 10000, changeGivenMinor: null },
      ],
      totals: {
        grossMinor: 100000,
        discountMinor: 0,
        netMinor: 100000,
        tenderedMinor: 100000,
        changeMinor: 0,
      },
    };
    for (const format of ['THERMAL_58', 'THERMAL', 'A4'] as const) {
      const html = buildCounterBrowserReceipt(split, locale, format);
      expect(html).toContain('CASH: 600.00');
      expect(html).toContain('CREDIT: 300.00');
      expect(html).toContain('WALLET: 100.00');
    }
    if (locale === 'en') {
      const thermal = buildPharmacyReceiptPrintDocument(split, locale, {
        layout: DEFAULT_RECEIPT_LAYOUT,
        taxIdentity: { ntn: null, strn: null },
        reprint: false,
      });
      expect(thermal.receiptSnapshot?.facts.payments).toEqual([
        'CASH: 600.00',
        'CREDIT: 300.00',
        'WALLET: 100.00',
      ]);
    }
  });

  it('reads and normalizes the profile in force at completion', async () => {
    const at = new Date('2026-09-05T10:00:00Z');
    const findFirst = vi.fn(async () => ({ ntn: ' NTN-HISTORICAL ', strn: '   ' }));

    await expect(
      readPharmacyReceiptTaxIdentity(
        { branchRegulatoryProfile: { findFirst } } as never,
        { organizationId: 'org-1', branchId: 'branch-1' },
        at
      )
    ).resolves.toEqual({ ntn: 'NTN-HISTORICAL', strn: null });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        branchId: 'branch-1',
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
      select: { ntn: true, strn: true },
    });
  });

  it('returns null identifiers when no profile was in force at completion', async () => {
    const findFirst = vi.fn(async () => null);

    await expect(
      readPharmacyReceiptTaxIdentity(
        { branchRegulatoryProfile: { findFirst } } as never,
        { organizationId: 'org-1', branchId: 'branch-1' },
        new Date('2026-09-05T10:00:00Z')
      )
    ).resolves.toEqual({ ntn: null, strn: null });
  });

  it.each([
    ['en', 'THERMAL_58'],
    ['en', 'THERMAL'],
    ['en', 'A4'],
    ['ur', 'THERMAL_58'],
    ['ur', 'THERMAL'],
    ['ur', 'A4'],
  ] as const)('matches the settled-sale tax identity in %s %s output', (locale, format) => {
    const settled = {
      ...receipt,
      taxIdentity: { ntn: 'NTN-HISTORICAL', strn: 'STRN-HISTORICAL' },
    };
    const html = buildCounterBrowserReceipt(settled, locale, format);
    expect(html).toContain('NTN: NTN-HISTORICAL');
    expect(html).toContain('STRN: STRN-HISTORICAL');
    expect(html.replace(/\s+/g, ' ')).toContain(
      locale === 'ur'
        ? 'رسید کے ماخذ میں ٹیکس کی تفصیل دستیاب نہیں'
        : 'Tax breakdown unavailable in receipt source'
    );
  });

  it('matches the settled-sale tax identity in raw thermal output', () => {
    const taxIdentity = { ntn: 'NTN-HISTORICAL', strn: 'STRN-HISTORICAL' };
    const thermal = buildPharmacyReceiptPrintDocument(
      { ...receipt, taxIdentity },
      'en',
      { layout: DEFAULT_RECEIPT_LAYOUT, taxIdentity, reprint: false }
    );
    expect(thermal.receiptSnapshot?.facts.taxLines).toEqual(
      expect.arrayContaining([
        'NTN: NTN-HISTORICAL',
        'STRN: STRN-HISTORICAL',
        'Tax breakdown unavailable in receipt source',
      ])
    );
  });

  it('omits blank identifiers and escapes regulatory identity in browser output', () => {
    const html = buildCounterBrowserReceipt(
      { ...receipt, taxIdentity: { ntn: '   ', strn: '<STRN & historical>' } },
      'en',
      'A4'
    );
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    expect(parsed.body.textContent).not.toContain('NTN:');
    expect(parsed.body.textContent).toContain('STRN: <STRN & historical>');
    expect(parsed.querySelector('strn')).toBeNull();
  });

  it.each([
    ['en', 'Expected cash: 100.00'],
    ['ur', 'متوقع نقد: 100.00'],
  ] as const)('renders the organization currency on a %s Z-report', (locale, expectedCash) => {
    const html = buildCounterBrowserZReport(
      {
        id: 'close-1',
        branchName: 'Main',
        businessDate: '2026-10-22',
        currency: 'USD',
        sequence: 1,
        grossSalesMinor: 10000,
        refundTotalMinor: 0,
        netSalesMinor: 10000,
        cashExpectedMinor: 10000,
        cashCountedMinor: 10000,
        cashVarianceMinor: 0,
        reason: null,
        isFinal: true,
      },
      locale
    );
    const text = new DOMParser().parseFromString(html, 'text/html').body.textContent;
    expect(text).toContain('USD');
    expect(text).toContain(expectedCash);
    expect(text).not.toContain('PKR');
  });

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

  it.each([
    ['en', 'THERMAL_58'],
    ['en', 'THERMAL'],
    ['en', 'A4'],
    ['ur', 'THERMAL_58'],
    ['ur', 'THERMAL'],
    ['ur', 'A4'],
  ] as const)('prints completion-time NTN/STRN in %s %s browser output', (locale, format) => {
    const settled = {
      ...receipt,
      taxIdentity: { ntn: 'HISTORICAL-NTN', strn: 'HISTORICAL-STRN' },
    };
    const html = buildCounterBrowserReceipt(settled, locale, format);
    expect(html).toContain('NTN: HISTORICAL-NTN');
    expect(html).toContain('STRN: HISTORICAL-STRN');
  });

  it('keeps browser and English ESC/POS regulatory identity in parity for one settled sale', () => {
    const taxIdentity = { ntn: 'HISTORICAL-NTN', strn: 'HISTORICAL-STRN' };
    const settled: CounterReceipt = { ...receipt, taxIdentity };
    const browser = buildCounterBrowserReceipt(settled, 'en', 'A4');
    const thermal = buildPharmacyReceiptPrintDocument(settled, 'en', {
      layout: DEFAULT_RECEIPT_LAYOUT,
      taxIdentity,
      reprint: false,
    });
    expect(thermal.receiptSnapshot?.facts.taxLines).toEqual([
      'NTN: HISTORICAL-NTN',
      'STRN: HISTORICAL-STRN',
      'Tax breakdown unavailable in receipt source',
    ]);
    for (const identity of thermal.receiptSnapshot!.facts.taxLines.slice(0, 2)) {
      expect(browser).toContain(identity);
    }
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
        buildCounterBrowserReceipt(source, 'en', format),
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
      const html = buildCounterBrowserReceipt(source, locale, 'A4');
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
