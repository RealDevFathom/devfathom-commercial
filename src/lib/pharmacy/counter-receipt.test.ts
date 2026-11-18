import { describe, expect, it } from 'vitest';

import {
  buildCounterReceiptDocument,
  COUNTER_RECEIPT_STRINGS,
  counterReceiptTotals,
  formatMinor,
  formatReceiptExpiry,
  formatShortExpiry,
  localizeReceiptNumber,
  PharmacyCounterReceiptError,
  receiptLineLabel,
  receiptPromotionLabel,
  receiptTitle,
  type CounterReceipt,
  type CounterReceiptLine,
} from './counter-receipt';
import { PrintDocumentSchema } from '@/lib/restaurant/printing/contract';
import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';
import {
  buildCounterReceiptPreview,
  exactReceiptPriceBreakdown,
} from './counter-receipt-presentation';
import { buildPharmacyReceiptPrintDocument } from './receipt-print';
import { hostedReceiptView } from './hosted-receipt-view';

function receiptLine(overrides: Partial<CounterReceiptLine> = {}): CounterReceiptLine {
  return {
    saleLineId: 'line-1',
    medicineName: 'Panadol',
    strength: '500 mg',
    presentation: 'Tablet',
    batchNumber: 'B-2201',
    expiresAt: '2027-04-30T00:00:00.000Z',
    saleUnit: 'STRIP',
    quantity: 2,
    canonicalUnits: 20,
    unitPriceMinor: 2_500,
    discountMinor: 0,
    lineTotalMinor: 5_000,
    ...overrides,
  };
}

function receipt(overrides: Partial<CounterReceipt> = {}): CounterReceipt {
  const lines = overrides.lines ?? [receiptLine()];
  const tenders = overrides.tenders ?? [
    { tenderId: 't-1', type: 'CASH', amountMinor: 5_000, changeGivenMinor: 0 },
  ];
  return {
    saleId: 'sale-1',
    receiptNumber: 12,
    branchName: 'Gulberg Branch',
    businessDate: '2026-09-02',
    completedAt: '2026-09-02T09:00:00.000Z',
    currency: 'PKR',
    lines,
    tenders,
    totals: counterReceiptTotals({ lines, tenders }),
    ...overrides,
  };
}

describe('formatMinor', () => {
  it('renders minor units exactly, without floating point', () => {
    expect(formatMinor(0)).toBe('0.00');
    expect(formatMinor(5)).toBe('0.05');
    expect(formatMinor(2_500)).toBe('25.00');
    expect(formatMinor(123_456)).toBe('1234.56');
    expect(formatMinor(-250)).toBe('-2.50');
  });

  it('does not accumulate drift over a long ledger', () => {
    // 1000 × 0.01 must be exactly 10.00, which is what a float would lose.
    const total = Array.from({ length: 1_000 }, () => 1).reduce((sum, value) => sum + value, 0);
    expect(formatMinor(total)).toBe('10.00');
  });

  it('keeps English (and the default) on ASCII digits', () => {
    expect(formatMinor(123_456, 'en')).toBe('1234.56');
    expect(formatMinor(123_456)).toBe(formatMinor(123_456, 'en'));
  });

  it('renders Urdu amounts in Extended Arabic-Indic digits with the Arabic decimal separator', () => {
    expect(formatMinor(0, 'ur')).toBe('۰٫۰۰');
    expect(formatMinor(5, 'ur')).toBe('۰٫۰۵');
    expect(formatMinor(2_500, 'ur')).toBe('۲۵٫۰۰');
    expect(formatMinor(123_456, 'ur')).toBe('۱۲۳۴٫۵۶');
    expect(formatMinor(-250, 'ur')).toBe('-۲٫۵۰');
    expect(formatMinor(Number.NaN, 'ur')).toBe('۰٫۰۰');
    expect(formatMinor(123_456, 'ur')).not.toMatch(/[0-9]/);
  });

  it('localizes the same integer-computed value, never a re-rounded one', () => {
    for (const amount of [1, 99, 100, 7_919, 1_000_001, -42]) {
      expect(formatMinor(amount, 'ur')).toBe(localizeReceiptNumber(formatMinor(amount), 'ur'));
    }
    expect(localizeReceiptNumber('1234.56', 'en')).toBe('1234.56');
  });
});

describe('mixed-lot receipt arithmetic', () => {
  const mixedLotLine = receiptLine({
    quantity: 3,
    canonicalUnits: 3,
    unitPriceMinor: 100,
    discountMinor: 0,
    lineTotalMinor: 301,
    allocations: [
      {
        allocationId: 'cheap',
        inventoryLotId: 'cheap',
        batchNumber: null,
        expiresAt: null,
        canonicalUnits: 2,
        grossMinor: 200,
      },
      {
        allocationId: 'dear',
        inventoryLotId: 'dear',
        batchNumber: null,
        expiresAt: null,
        canonicalUnits: 1,
        grossMinor: 101,
      },
    ],
  });

  it('presents an exact unit-price allocation in the browser receipt', () => {
    expect(exactReceiptPriceBreakdown(3, 301)).toBe('3 · 3.01');
    const preview = buildCounterReceiptPreview(receipt({ lines: [mixedLotLine] }), 'en', 80);
    expect(preview).toContain('2 × 1.00 + 1 × 1.01');
    expect(preview).not.toContain('3 STRIP × 1.00');
  });

  it('formats the Urdu browser receipt allocation in Urdu digits', () => {
    expect(exactReceiptPriceBreakdown(3, 301, '×', 'ur')).toBe('3 · ۳٫۰۱');
    const preview = buildCounterReceiptPreview(receipt({ lines: [mixedLotLine] }), 'ur', 80);
    expect(preview).toContain('2 × ۱٫۰۰ + 1 × ۱٫۰۱');
    expect(preview).not.toContain('1.01');
  });

  it('prints the same exact allocation on the ESC/POS receipt', () => {
    const document = buildPharmacyReceiptPrintDocument(receipt({ lines: [mixedLotLine] }), 'en', {
      layout: DEFAULT_RECEIPT_LAYOUT,
      taxIdentity: { ntn: null, strn: null },
      reprint: false,
    });
    expect(document.receiptSnapshot?.facts.lines[0]).toContain('2 x 1.00 + 1 x 1.01');
    expect(document.receiptSnapshot?.facts.lines[0]).not.toContain('3 STRIP x 1.00');
  });
});

describe('counterReceiptTotals', () => {
  it('prints cash received as tendered while keeping change separate', () => {
    const lines = [
      receiptLine({ unitPriceMinor: 2_500, quantity: 2, discountMinor: 0, lineTotalMinor: 5_000 }),
      receiptLine({
        saleLineId: 'line-2',
        unitPriceMinor: 1_000,
        quantity: 3,
        discountMinor: 200,
        lineTotalMinor: 2_800,
      }),
    ];
    const totals = counterReceiptTotals({
      lines,
      tenders: [
        { type: 'CASH', amountMinor: 7_800, cashReceivedMinor: 8_000, changeGivenMinor: 200 },
      ],
    });
    expect(totals.grossMinor).toBe(8_000);
    expect(totals.discountMinor).toBe(200);
    expect(totals.netMinor).toBe(7_800);
    expect(totals.tenderedMinor).toBe(8_000);
    expect(totals.changeMinor).toBe(200);
    expect(totals.tenderedMinor - totals.changeMinor).toBe(totals.netMinor);
  });

  it.each([null, undefined])(
    'uses the applied amount for legacy cash tenders with cash received set to %s',
    (cashReceivedMinor) => {
      const totals = counterReceiptTotals({
        lines: [],
        tenders: [{ type: 'CASH', amountMinor: 4_800, cashReceivedMinor, changeGivenMinor: null }],
      });

      expect(totals.tenderedMinor).toBe(4_800);
      expect(totals.changeMinor).toBe(0);
    }
  );

  it('ignores cash received on non-cash tenders', () => {
    const totals = counterReceiptTotals({
      lines: [],
      tenders: [
        { type: 'CARD', amountMinor: 3_000, cashReceivedMinor: 9_000, changeGivenMinor: null },
      ],
    });

    expect(totals.tenderedMinor).toBe(3_000);
    expect(totals.changeMinor).toBe(0);
  });

  it('adds cash received and non-cash applied amounts for split tenders', () => {
    const totals = counterReceiptTotals({
      lines: [],
      tenders: [
        { type: 'CASH', amountMinor: 2_800, cashReceivedMinor: 3_000, changeGivenMinor: 200 },
        { type: 'CARD', amountMinor: 5_000, cashReceivedMinor: null, changeGivenMinor: null },
      ],
    });

    expect(totals.tenderedMinor).toBe(8_000);
    expect(totals.changeMinor).toBe(200);
  });
});

describe('no-expiry items (QA-3)', () => {
  // A non-drug lot stocked without an expiry: printed 9998-12-31, expiry instant
  // 9998-12-31T19:00Z (the end of that Karachi day).
  const noExpiry = '9998-12-31T19:00:00.000Z';

  it('prints "No expiry" on the receipt line, never 9998-12-31', () => {
    const label = receiptLineLabel(receiptLine({ expiresAt: noExpiry }), 'en');
    expect(label).toContain('No expiry');
    expect(label).not.toContain('9998');
    const urdu = receiptLineLabel(receiptLine({ expiresAt: noExpiry }), 'ur');
    expect(urdu).toContain(COUNTER_RECEIPT_STRINGS.ur.noExpiry);
    expect(urdu).not.toContain('9998');
  });

  it('formats a no-expiry lot as no expiry and a real expiry as its date', () => {
    expect(formatReceiptExpiry(noExpiry)).toBe('No expiry');
    expect(formatReceiptExpiry(noExpiry, 'ur')).toBe(COUNTER_RECEIPT_STRINGS.ur.noExpiry);
    expect(formatReceiptExpiry('2027-04-30T19:00:00.000Z')).toBe('2027-04-30');
    expect(formatShortExpiry(noExpiry)).toBe('No expiry');
    expect(formatShortExpiry('2027-04-30T19:00:00.000Z')).toBe('Exp 2027-04-30');
  });
});

describe('receiptLineLabel (POS-08 label fields)', () => {
  it('carries medicine, strength, batch and expiry', () => {
    const label = receiptLineLabel(receiptLine(), 'en');
    expect(label).toContain('Panadol');
    expect(label).toContain('500 mg');
    expect(label).toContain('B-2201');
    expect(label).toContain('2027-04-30');
  });

  it('keeps batch and expiry even when the label must be shortened', () => {
    const label = receiptLineLabel(
      receiptLine({ medicineName: 'M'.repeat(120), presentation: 'P'.repeat(60) }),
      'en'
    );
    expect(label.length).toBeLessThanOrEqual(160);
    expect(label).toContain('B-2201');
    expect(label).toContain('2027-04-30');
  });

  it('renders the Urdu label with Urdu field names', () => {
    const label = receiptLineLabel(receiptLine(), 'ur');
    expect(label).toContain(COUNTER_RECEIPT_STRINGS.ur.batch);
    expect(label).toContain(COUNTER_RECEIPT_STRINGS.ur.expiry);
    expect(label).toContain('B-2201');
  });

  it('prints the Urdu line amount in Urdu digits', () => {
    const label = receiptLineLabel(receiptLine(), 'ur');
    expect(label).toContain('۵۰٫۰۰');
    expect(label).not.toContain('50.00');
    expect(receiptLineLabel(receiptLine(), 'en')).toContain('50.00');
  });
});

describe('buildCounterReceiptDocument (printing seam)', () => {
  it('produces a valid RECEIPT document for the shared seam', () => {
    const document = buildCounterReceiptDocument(receipt(), 'en');
    expect(document.type).toBe('RECEIPT');
    expect(PrintDocumentSchema.safeParse(document).success).toBe(true);
    expect(document.reference).toBe('receipt:12');
    expect(document.lines).toHaveLength(1);
    expect(document.lines[0]!.quantity).toBe(2);
  });

  it('states totals in the footer', () => {
    const document = buildCounterReceiptDocument(receipt(), 'en');
    expect(document.footer).toContain('Total 50.00');
    expect(document.footer).toContain('Tendered 50.00');
  });

  it('omits fiscal fields when integration is off', () => {
    const source = { ...receipt(), fiscal: undefined } as CounterReceipt & { fiscal?: unknown };
    expect(JSON.stringify(buildCounterReceiptDocument(source, 'en'))).not.toContain('fiscal');
  });

  it('never prints a sandbox identifier or presents it as an FBR reference', () => {
    const source = {
      ...receipt(),
      fiscal: { mode: 'SANDBOX', externalReference: 'SANDBOX-LOCAL-42', externalQr: null },
    } as CounterReceipt & { fiscal: unknown };
    const printed = JSON.stringify(buildCounterReceiptDocument(source, 'en'));
    expect(printed).not.toContain('SANDBOX-LOCAL-42');
    expect(printed).not.toContain('FBR');
  });

  it('marks a reprint without touching the receipt number', () => {
    const source = receipt();
    const first = buildCounterReceiptDocument(source, 'en');
    const second = buildCounterReceiptDocument(source, 'en', { reprint: true });
    expect(second.reference).toBe(first.reference);
    expect(first.footer).not.toContain(COUNTER_RECEIPT_STRINGS.en.reprint);
    expect(second.footer).toContain(COUNTER_RECEIPT_STRINGS.en.reprint);
  });

  it('never invents a receipt number for an unsettled bill', () => {
    const document = buildCounterReceiptDocument(receipt({ receiptNumber: null }), 'en');
    expect(document.reference).toBe('sale:sale-1');
    expect(document.title).toContain(COUNTER_RECEIPT_STRINGS.en.unissued);
    expect(document.footer).toContain(COUNTER_RECEIPT_STRINGS.en.noReceiptNumber);
  });

  it('renders the Urdu document with Urdu strings', () => {
    const document = buildCounterReceiptDocument(receipt(), 'ur');
    expect(document.title).toContain(COUNTER_RECEIPT_STRINGS.ur.receipt);
    expect(document.footer).toContain(COUNTER_RECEIPT_STRINGS.ur.net);
  });

  it('formats every Urdu footer amount with the selected locale', () => {
    const document = buildCounterReceiptDocument(receipt(), 'ur');
    expect(document.footer).toContain(`${COUNTER_RECEIPT_STRINGS.ur.net} ۵۰٫۰۰`);
    expect(document.footer).toContain(`${COUNTER_RECEIPT_STRINGS.ur.tendered} ۵۰٫۰۰`);
    expect(document.footer).toContain(`${COUNTER_RECEIPT_STRINGS.ur.change} ۰٫۰۰`);
    expect(document.footer).not.toMatch(/\d\.\d\d/);
  });

  it('refuses an empty receipt rather than printing a blank slip', () => {
    expect(() => buildCounterReceiptDocument(receipt({ lines: [] }), 'en')).toThrowError(
      PharmacyCounterReceiptError
    );
  });

  it('refuses a bill longer than the seam can carry instead of truncating it', () => {
    const lines = Array.from({ length: 201 }, (_unused, index) =>
      receiptLine({ saleLineId: `line-${index}` })
    );
    expect(() => buildCounterReceiptDocument(receipt({ lines }), 'en')).toThrowError(
      PharmacyCounterReceiptError
    );
  });
});

describe('promotion receipt line (#727)', () => {
  const promoted = receiptLine({
    quantity: 1,
    unitPriceMinor: 1_000,
    discountMinor: 100,
    lineTotalMinor: 900,
    promotionName: 'Winter week',
  });

  it('names the issued promotion and its saving, in English and Urdu', () => {
    expect(receiptPromotionLabel(promoted, 'en')).toBe('Promotion: Winter week (-1.00)');
    expect(receiptPromotionLabel(promoted, 'ur')).toBe(
      `${COUNTER_RECEIPT_STRINGS.ur.promotion}: Winter week (-${formatMinor(100, 'ur')})`
    );
  });

  it('prints nothing for a line without a promotion or saving', () => {
    expect(receiptPromotionLabel(receiptLine(), 'en')).toBeNull();
    expect(receiptPromotionLabel({ ...promoted, discountMinor: 0 }, 'en')).toBeNull();
    expect(receiptPromotionLabel({ ...promoted, promotionName: null }, 'en')).toBeNull();
  });

  it('adds the promotion under its line on the thermal and raw-print documents, counted once', () => {
    const source = receipt({ lines: [promoted] });
    expect(source.totals).toMatchObject({ grossMinor: 1_000, discountMinor: 100, netMinor: 900 });

    const document = buildCounterReceiptDocument(source, 'en');
    expect(document.lines.map((line) => line.label)).toEqual([
      receiptLineLabel(promoted, 'en'),
      'Promotion: Winter week (-1.00)',
    ]);
    expect(PrintDocumentSchema.safeParse(document).success).toBe(true);

    const raw = buildPharmacyReceiptPrintDocument(source, 'en', {
      layout: DEFAULT_RECEIPT_LAYOUT,
      taxIdentity: { ntn: null, strn: null },
      reprint: false,
    });
    expect(raw.receiptSnapshot?.facts.lines[0]).toContain('Promotion: Winter week (-1.00)');
  });

  it('keeps the promotion on browser-printed thermal and A4 receipts, in both languages', () => {
    const source = receipt({ lines: [promoted] });
    expect(buildCounterReceiptPreview(source, 'en', 80)).toContain(
      'Promotion: Winter week (-1.00)'
    );
    expect(buildCounterReceiptPreview(source, 'en', 58)).toContain('Winter week');
    expect(buildCounterReceiptPreview(source, 'ur', 80)).toContain(
      COUNTER_RECEIPT_STRINGS.ur.promotion
    );
    expect(buildCounterReceiptPreview(receipt(), 'en', 80)).not.toContain('Promotion:');
  });
});

describe('DEV-637 issuing counter and offline reference on every receipt form', () => {
  const issued = () =>
    receipt({ counterLabel: 'Front till', offlineReference: 7, receiptNumber: 1043 });
  const printJob = (source: CounterReceipt, reprint = false) =>
    buildPharmacyReceiptPrintDocument(source, 'en', {
      layout: DEFAULT_RECEIPT_LAYOUT,
      taxIdentity: { ntn: null, strn: null },
      reprint,
    }).receiptSnapshot!.facts.issuedAt;

  it('prints the counter on the ESC/POS job sent to the print bridge, original and reprint', () => {
    expect(printJob(receipt({ counterLabel: 'Front till' }))).toContain('\nFront till');
    expect(printJob(receipt({ counterLabel: 'Front till' }), true)).toContain('\nFront till');
    expect(printJob(receipt())).not.toContain('Front till');
  });

  it('prints the number printed offline on the ESC/POS job and browser receipt', () => {
    expect(printJob(issued(), true)).toContain('Printed offline as receipt 7');
    expect(buildCounterReceiptPreview(issued(), 'en', 80)).toContain(
      'Printed offline as receipt 7'
    );
    expect(buildCounterReceiptPreview(issued(), 'ur', 80)).toContain(
      `${COUNTER_RECEIPT_STRINGS.ur.offlineReference} ${localizeReceiptNumber('7', 'ur')}`
    );
    expect(printJob(receipt())).not.toContain('Printed offline');
    expect(buildCounterReceiptPreview(receipt(), 'en', 80)).not.toContain('Printed offline');
  });

  it('carries the counter and offline reference to the hosted receipt', () => {
    expect(hostedReceiptView(issued())).toMatchObject({
      receiptNumber: 1043,
      counterLabel: 'Front till',
      offlineReference: 'Printed offline as receipt 7',
    });
    expect(hostedReceiptView(receipt())).toMatchObject({
      counterLabel: null,
      offlineReference: null,
    });
  });
});

describe('receiptTitle', () => {
  it('names the issuing counter', () => {
    expect(receiptTitle({ ...receipt(), counterLabel: 'Front till' }, 'en')).toBe(
      'Receipt 12 · Front till'
    );
  });

  it('names the number when settled and says so when not', () => {
    expect(receiptTitle(receipt(), 'en')).toBe('Receipt 12');
    expect(receiptTitle(receipt({ receiptNumber: null }), 'en')).toBe(
      COUNTER_RECEIPT_STRINGS.en.unissued
    );
  });
});

describe('bilingual string table', () => {
  it('defines the same keys in both languages', () => {
    const en = Object.keys(COUNTER_RECEIPT_STRINGS.en).sort();
    const ur = Object.keys(COUNTER_RECEIPT_STRINGS.ur).sort();
    expect(ur).toEqual(en);
  });

  it('never leaves an Urdu string as its English default', () => {
    for (const key of Object.keys(COUNTER_RECEIPT_STRINGS.en) as Array<
      keyof typeof COUNTER_RECEIPT_STRINGS.en
    >) {
      if (key === 'saleUnit') continue;
      expect(COUNTER_RECEIPT_STRINGS.ur[key], key).not.toBe(COUNTER_RECEIPT_STRINGS.en[key]);
    }
  });
});
