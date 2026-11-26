import { afterEach, describe, expect, it, vi } from 'vitest';

import { PRINT_WINDOW_READY_TIMEOUT_MS } from '@/lib/browser-print/print-window';
import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';
import { FakeBroadcastChannel, installFakePrintWindows } from '@/lib/testing/print-window';

import {
  allocateWhileCounterPrintWindowOpen,
  assertCounterBrowserPrintReady,
  buildCounterBrowserReceipt,
  buildCounterBrowserZReport,
  printCounterBrowserReceipt,
  reserveCounterBrowserPrint,
} from './counter-browser-print';
import type { CounterReceipt, CounterReceiptLocale } from './counter-receipt';
import { buildPharmacyReceiptPrintDocument, readPharmacyReceiptTaxIdentity } from './receipt-print';

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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('isolated Pharmacy browser receipt', () => {
  it('reads and normalizes the profile in force at completion', async () => {
    const at = new Date('2026-09-05T10:00:00Z');
    const findFirst = vi.fn(async () => ({
      premises: { addressLine: ' 12 Mall Road ', city: ' Lahore ', phone: ' 042-1234567 ' },
      licenceNumber: ' DSL-42 ',
      ntn: ' NTN-HISTORICAL ',
      strn: '   ',
      provinceCode: ' PK-PB ',
      licenceValidFrom: new Date('2026-01-01T00:00:00Z'),
      licenceValidTo: new Date('2027-12-31T00:00:00Z'),
      qualifiedPersonRegistration: ' PCP-9001 ',
    }));

    await expect(
      readPharmacyReceiptTaxIdentity(
        { branchRegulatoryProfile: { findFirst } } as never,
        { organizationId: 'org-1', branchId: 'branch-1' },
        at
      )
    ).resolves.toEqual({
      address: '12 Mall Road, Lahore',
      phone: '042-1234567',
      licenceNumber: 'DSL-42',
      ntn: 'NTN-HISTORICAL',
      strn: null,
      provinceCode: 'PK-PB',
      licenceValidFrom: '2026-01-01T00:00:00.000Z',
      licenceValidTo: '2027-12-31T00:00:00.000Z',
      pharmacistRegistration: 'PCP-9001',
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        branchId: 'branch-1',
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
      select: {
        premises: true,
        licenceNumber: true,
        ntn: true,
        strn: true,
        provinceCode: true,
        licenceValidFrom: true,
        licenceValidTo: true,
        qualifiedPersonRegistration: true,
      },
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
    ).resolves.toEqual({
      address: null,
      phone: null,
      licenceNumber: null,
      ntn: null,
      strn: null,
      provinceCode: null,
      licenceValidFrom: null,
      licenceValidTo: null,
      pharmacistRegistration: null,
    });
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
    expect(html).not.toContain('Tax breakdown unavailable');
  });

  it('matches the settled-sale tax identity in raw thermal output', () => {
    const taxIdentity = {
      address: '12 Mall Road, Lahore',
      phone: '042-1234567',
      licenceNumber: 'DSL-42',
      ntn: 'NTN-HISTORICAL',
      strn: 'STRN-HISTORICAL',
    };
    const thermal = buildPharmacyReceiptPrintDocument({ ...receipt, taxIdentity }, 'en', {
      layout: DEFAULT_RECEIPT_LAYOUT,
      taxIdentity,
      reprint: false,
    });
    expect(thermal.receiptSnapshot?.facts.taxLines).toEqual(
      expect.arrayContaining([
        '12 Mall Road, Lahore',
        'Phone: 042-1234567',
        'Drug-sale licence: DSL-42',
        'NTN: NTN-HISTORICAL',
        'STRN: STRN-HISTORICAL',
      ])
    );
  });

  it('prints recorded cash received before change without including other tenders', () => {
    const source = {
      ...receipt,
      totals: { ...receipt.totals, netMinor: 1000, tenderedMinor: 1100, changeMinor: 100 },
      tenders: [
        {
          tenderId: 'cash-1',
          type: 'CASH',
          amountMinor: 500,
          cashReceivedMinor: 600,
          changeGivenMinor: 100,
        },
        {
          tenderId: 'cash-2',
          type: 'CASH',
          amountMinor: 200,
          cashReceivedMinor: 200,
          changeGivenMinor: 0,
        },
        { tenderId: 'wallet', type: 'WALLET', amountMinor: 300, changeGivenMinor: 0 },
      ],
    };
    const facts = buildPharmacyReceiptPrintDocument(source, 'en', {
      layout: DEFAULT_RECEIPT_LAYOUT,
      taxIdentity: { ntn: null, strn: null },
      reprint: false,
    }).receiptSnapshot!.facts;
    const cashIndex = facts.totals.indexOf('Cash received: 8.00');
    expect(cashIndex).toBeGreaterThanOrEqual(0);
    expect(facts.totals[cashIndex + 1]).toBe('Change: 1.00');
    const browser = buildCounterBrowserReceipt(source, 'en', 'THERMAL');
    expect(browser).toContain('Cash received: 8.00');
    expect(browser.indexOf('Cash received: 8.00')).toBeLessThan(browser.indexOf('Change: 1.00'));
    const urdu = buildCounterBrowserReceipt(source, 'ur', 'THERMAL');
    expect(urdu).toContain('نقد ادا شدہ: ۸٫۰۰');
    expect(urdu).not.toContain('Cash received:');
  });

  it('does not invent cash received for legacy or non-cash receipts', () => {
    for (const tenders of [receipt.tenders, [{ ...receipt.tenders[0], type: 'CARD' }]]) {
      const facts = buildPharmacyReceiptPrintDocument({ ...receipt, tenders }, 'en', {
        layout: DEFAULT_RECEIPT_LAYOUT,
        taxIdentity: { ntn: null, strn: null },
        reprint: false,
      }).receiptSnapshot!.facts;
      expect(facts.totals.some((line) => line.startsWith('Cash received:'))).toBe(false);
    }
  });

  it('prints the completion time, cashier and localized receipt/payment labels', () => {
    const source = { ...receipt, cashierName: 'Ayesha Khan' };
    const english = buildCounterBrowserReceipt(source, 'en', 'THERMAL');
    const urdu = new DOMParser().parseFromString(
      buildCounterBrowserReceipt(source, 'ur', 'THERMAL'),
      'text/html'
    ).body.textContent!;

    expect(english).toContain('Receipt: 12');
    expect(english).toContain('Date: 2026-09-05 15:00 PKT');
    expect(english).toContain('Cashier: Ayesha Khan');
    expect(english).toContain('Cash: 1.90');
    expect(urdu).toContain('رسید: 12');
    expect(urdu).toContain('کیشیئر: Ayesha Khan');
    expect(urdu).toContain('نقد: ۱٫۹۰');
    expect(urdu).not.toContain('Invoice:');
    expect(urdu).not.toContain('CASH:');
  });

  it('prints PKT across UTC midnight consistently in browser and raw thermal receipts', () => {
    const source = { ...receipt, completedAt: '2026-09-05T20:12:00Z', cashierName: 'Ayesha' };
    const browser = buildCounterBrowserReceipt(source, 'en', 'THERMAL');
    const raw = buildPharmacyReceiptPrintDocument(source, 'en', {
      layout: DEFAULT_RECEIPT_LAYOUT,
      taxIdentity: { ntn: null, strn: null },
      reprint: false,
    });
    expect(browser).toContain('Date: 2026-09-06 01:12 PKT');
    expect(raw.receiptSnapshot?.facts.issuedAt).toContain('Date: 2026-09-06 01:12 PKT');
    expect(raw.receiptSnapshot?.facts.issuedAt).toContain('Cashier: Ayesha');
  });
  it.each([
    ['WALLET', 'والٹ'],
    ['RAAST', 'راست'],
    ['JAZZCASH', 'جاز کیش'],
    ['EASYPAISA', 'ایزی پیسہ'],
    ['CREDIT', 'کھاتہ'],
    ['LOYALTY', 'وفاداری پوائنٹس'],
  ])('localizes %s and PKR in Urdu', (type, label) => {
    const source = { ...receipt, tenders: [{ ...receipt.tenders[0], type }] };
    const html = buildCounterBrowserReceipt(source, 'ur', 'THERMAL');
    expect(html).toContain(label + ':');
    expect(html).toContain('پاکستانی روپے');
    expect(html).not.toContain(type + ':');
  });
  it.each([
    ['CARD', 'No slip details'],
    ['BANK_TRANSFER', 'No transfer details'],
  ])(
    'prints missing %s evidence on browser receipts, raw receipts and the day close',
    (type, label) => {
      const source = {
        ...receipt,
        tenders: [{ ...receipt.tenders[0]!, type, paymentDetails: label }],
      };
      expect(buildCounterBrowserReceipt(source, 'en', 'A4')).toContain(label);
      const raw = buildPharmacyReceiptPrintDocument(source, 'en', {
        layout: DEFAULT_RECEIPT_LAYOUT,
        taxIdentity: { ntn: null, strn: null },
        reprint: false,
      });
      expect(raw.receiptSnapshot?.facts.payments.join(' ')).toContain(label);
      const report = buildCounterBrowserZReport(
        {
          id: 'close',
          branchName: 'Test',
          businessDate: '2026-10-22',
          currency: 'PKR',
          sequence: 1,
          grossSalesMinor: 190,
          refundTotalMinor: 0,
          netSalesMinor: 190,
          cashExpectedMinor: 0,
          cashCountedMinor: 0,
          cashVarianceMinor: 0,
          reason: null,
          isFinal: true,
          tenderTotals: [
            {
              type,
              amountMinor: 190,
              refundMinor: 0,
              netMinor: 190,
              details: [{ id: 'private-tender-id', label, amountMinor: 190 }],
            },
          ],
        },
        'en'
      );
      expect(report).toContain(label);
      expect(report).not.toContain('private-tender-id');
    }
  );
  it('prints loyalty points in English browser and raw thermal receipts', () => {
    const source = {
      ...receipt,
      tenders: [{ ...receipt.tenders[0]!, type: 'LOYALTY' }],
    };
    const html = buildCounterBrowserReceipt(source, 'en', 'THERMAL');
    expect(html).toContain('Loyalty points: 1.90');
    expect(html).not.toContain('LOYALTY:');
    const raw = buildPharmacyReceiptPrintDocument(source, 'en', {
      layout: DEFAULT_RECEIPT_LAYOUT,
      taxIdentity: { ntn: null, strn: null },
      reprint: false,
    });
    expect(raw.receiptSnapshot?.facts.payments).toEqual(['Loyalty points: 1.90']);
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
    ['ur', 'متوقع نقد: ۱۰۰٫۰۰'],
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

  it.each(['THERMAL_58', 'THERMAL', 'A4'] as const)(
    'formats Urdu %s amounts in Urdu digits',
    (format) => {
      const html = buildCounterBrowserReceipt(receipt, 'ur', format);
      const text = new DOMParser()
        .parseFromString(html, 'text/html')
        .body.textContent!.replace(/\s+/g, ' ');
      expect(text).toContain('مقدار: 2 یونٹ · کل رقم: ۱٫۷۹');
      expect(text).toContain('رقم: ۱٫۷۹');
      expect(text).toContain('کل رقم: ۲٫۰۰');
      expect(text).toContain('رعایت: ۰٫۲۱');
      expect(text).toContain('قابلِ ادائیگی: ۱٫۷۹');
      expect(text).toContain('ادا شدہ: ۱٫۹۰');
      expect(text).toContain('واپسی: ۰٫۱۱');
      expect(text).toContain('نقد: ۱٫۹۰');
      expect(text).not.toMatch(/\b1\.79\b|\b0\.11\b|\b1\.90\b/);
    }
  );

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
      expect(text).toContain('Batch: <img src=x> · Expiry: 2027-01-01 · Tablets/units: 3');
      expect(text).toContain('Batch: بیچ ب · Expiry: 2028-02-02 · Tablets/units: 7');
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
        locale === 'en' ? 'Original item details unavailable' : 'اصل آئٹم کی تفصیل دستیاب نہیں'
      );
      expect(html).not.toContain('LIVE_CATALOG');
      expect(html).not.toContain('Batch 1');
      expect(html).not.toContain('2027-01-01');
    }
  );

  it('treats missing legacy identity status honestly and rejects shared-schema control input', () => {
    expect(buildCounterBrowserReceipt(receipt, 'en', 'A4')).toContain(
      'Original item details unavailable'
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

  it('reports blocked popups without printing the POS page', async () => {
    vi.useFakeTimers();
    installFakePrintWindows({ blocked: true });
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    const printing = printCounterBrowserReceipt(receipt, 'en', 'A4');
    const outcome = expect(printing).rejects.toThrow('Allow pop-ups');
    await vi.advanceTimersByTimeAsync(PRINT_WINDOW_READY_TIMEOUT_MS);
    await outcome;
    expect(print).not.toHaveBeenCalled();
  });

  it('releases copy allocation when the popup closes before allocation finishes', async () => {
    const windows = installFakePrintWindows();
    const reservation = reserveCounterBrowserPrint();
    const copy = Promise.withResolvers<number>();
    await assertCounterBrowserPrintReady(reservation);
    const outcome = expect(
      allocateWhileCounterPrintWindowOpen(reservation, () => copy.promise)
    ).rejects.toThrow('Retry Print receipt');
    windows.last().closeByOperator();
    await outcome;
    copy.resolve(1);
  });

  it('rejects a blocked reservation before a server copy can be requested', async () => {
    vi.useFakeTimers();
    installFakePrintWindows({ blocked: true });
    const reservation = reserveCounterBrowserPrint();
    const ready = assertCounterBrowserPrintReady(reservation);
    const outcome = expect(ready).rejects.toThrow('Allow pop-ups');
    await vi.advanceTimersByTimeAsync(PRINT_WINDOW_READY_TIMEOUT_MS);
    await outcome;
    reservation.cancel();
  });

  it('rejects a closed or cancelled reservation before allocating a receipt', async () => {
    const windows = installFakePrintWindows();
    const reservation = reserveCounterBrowserPrint();
    const popup = windows.last();
    await expect(assertCounterBrowserPrintReady(reservation)).resolves.toBeUndefined();
    expect(popup.html()).toBeUndefined();
    expect(popup.printRequests()).toBe(0);
    expect(popup.proxy.print).not.toHaveBeenCalled();
    popup.closeByOperator();
    await expect(assertCounterBrowserPrintReady(reservation)).rejects.toThrow(
      'no longer available'
    );
    reservation.cancel();
    await expect(assertCounterBrowserPrintReady(reservation)).rejects.toThrow(
      'no longer available'
    );
  });

  it('rejects a reserved window whose print page never loaded', async () => {
    vi.useFakeTimers();
    installFakePrintWindows({ ready: false });
    const reservation = reserveCounterBrowserPrint();
    const ready = assertCounterBrowserPrintReady(reservation);
    const outcome = expect(ready).rejects.toThrow('Allow pop-ups');
    await vi.advanceTimersByTimeAsync(PRINT_WINDOW_READY_TIMEOUT_MS);
    await outcome;
    reservation.cancel();
  });

  it('prints the isolated document, disconnects opener and leaves receipt available', async () => {
    const windows = installFakePrintWindows();
    await printCounterBrowserReceipt(receipt, 'en', 'THERMAL');
    const popup = windows.last();
    // noopener: the print window has no reference back to the counter.
    expect(popup.features).toBe('noopener,popup,width=480,height=720');
    expect(popup.html()).toBe(buildCounterBrowserReceipt(receipt, 'en', 'THERMAL'));
    expect(popup.printRequests()).toBe(1);
    expect(popup.proxy.close).not.toHaveBeenCalled();
    windows.closeAll();
  });

  it('DEV-973: never calls print() from this page, so the print dialog cannot freeze it', async () => {
    const windows = installFakePrintWindows({ ready: false });
    const pagePrint = vi.spyOn(window, 'print').mockImplementation(() => {});
    const reservation = reserveCounterBrowserPrint();
    const popup = windows.last();
    // The isolated print page, by URL only: no receipt data in the address.
    expect(popup.url).toMatch(/^\/pharmacy\/counter\/print-window\.html#[0-9a-f-]{36}$/);
    const printing = printCounterBrowserReceipt(receipt, 'en', 'A4', true, reservation);
    // Settled before the print page loaded: held until it announces itself.
    await Promise.resolve();
    expect(popup.printRequests()).toBe(0);
    popup.ready();
    await printing;
    expect(popup.html()).toBe(buildCounterBrowserReceipt(receipt, 'en', 'A4', true));
    expect(popup.printRequests()).toBe(1);
    expect(popup.proxy.print).not.toHaveBeenCalled();
    expect(pagePrint).not.toHaveBeenCalled();
    windows.closeAll();
  });

  it('closes the isolated window on print failure and exposes retry guidance', async () => {
    const windows = installFakePrintWindows();
    const reservation = reserveCounterBrowserPrint();
    const deliver = FakeBroadcastChannel.prototype.postMessage;
    vi.spyOn(FakeBroadcastChannel.prototype, 'postMessage').mockImplementation(function (
      this: FakeBroadcastChannel,
      data: unknown
    ) {
      if ((data as { type?: string }).type === 'print') throw new Error('unavailable');
      deliver.call(this, data);
    });
    await expect(
      printCounterBrowserReceipt(receipt, 'en', 'A4', false, reservation)
    ).rejects.toThrow('Retry Print receipt');
    expect(windows.last().proxy.close).toHaveBeenCalledOnce();
  });
});

it('isolates phone, licence and PKT date identifiers on RTL paper without permitting markup', () => {
  const html = buildCounterBrowserReceipt(
    {
      ...receipt,
      taxIdentity: {
        ntn: 'NTN-SYNTHETIC',
        strn: null,
        phone: '042-0000000',
        licenceNumber: 'DSL-42',
      },
    },
    'ur',
    'THERMAL'
  );
  const dom = new DOMParser().parseFromString(html, 'text/html');
  const isolated = [...dom.querySelectorAll('bdi[dir="ltr"]')].map((element) =>
    element.textContent!.trim()
  );
  expect(isolated).toEqual(
    expect.arrayContaining(['042-0000000', 'DSL-42', '2026-09-05 15:00 PKT'])
  );
  expect(dom.querySelector('script')).toBeNull();
  expect(dom.querySelector('img')).toBeNull();
});

describe('receipt tax identity on a profile start day (DEV-298)', () => {
  const dayStart = new Date('2026-10-21T00:00:00.000Z');
  it.each([
    ['00:30 PKT on the start day', new Date('2026-10-20T19:30:00.000Z'), dayStart],
    [
      '23:59 PKT the day before',
      new Date('2026-10-20T18:59:00.000Z'),
      new Date('2026-10-20T18:59:00.000Z'),
    ],
  ])('selects the version in force on the workspace day at %s', async (_label, at, asOf) => {
    const findFirst = vi.fn(async () => null);
    await readPharmacyReceiptTaxIdentity(
      { branchRegulatoryProfile: { findFirst } } as never,
      { organizationId: 'org-1', branchId: 'branch-1' },
      at,
      'Asia/Karachi'
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-1',
          branchId: 'branch-1',
          effectiveFrom: { lte: asOf },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
        },
      })
    );
  });
});
