import { describe, expect, it } from 'vitest';

import {
  buildCounterReceiptDocument,
  COUNTER_RECEIPT_STRINGS,
  counterReceiptTotals,
  formatMinor,
  PharmacyCounterReceiptError,
  receiptLineLabel,
  receiptTitle,
  type CounterReceipt,
  type CounterReceiptLine,
} from './counter-receipt';
import { buildCounterReceiptPreview } from './counter-receipt-presentation';
import { buildCounterBrowserReceipt } from './counter-browser-print';
import { buildPharmacyReceiptPrintDocument } from './receipt-print';
import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';
import { PrintDocumentSchema } from '@/lib/restaurant/printing/contract';

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
});

describe('counterReceiptTotals', () => {
  it('prints cash received as tendered while keeping change separate', () => {
    const lines = [
      receiptLine({ unitPriceMinor: 2_500, quantity: 2, discountMinor: 0 }),
      receiptLine({ saleLineId: 'line-2', unitPriceMinor: 1_000, quantity: 3, discountMinor: 200 }),
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

describe('receiptTitle', () => {
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

describe('#727 promotion receipt savings', () => {
  it.each(['en', 'ur'] as const)(
    'prints the issued promotion and discount once in %s with unchanged net',
    (locale) => {
      const line = receiptLine({
        promotionName: 'Nov offer',
        discountMinor: 101,
        lineTotalMinor: 4899,
      });
      const model = receipt({ lines: [line] });
      const document = buildCounterReceiptDocument(model, locale);
      expect(document.lines).toHaveLength(2);
      expect(document.lines[1]!.label).toContain('Nov offer (-1.01)');
      expect(document.lines[1]!.label).toContain(COUNTER_RECEIPT_STRINGS[locale].promotion);
      const preview = buildCounterReceiptPreview(model, locale, 58, true);
      expect(preview).toContain('Nov offer (-1.01)');
      expect(preview).toContain('48.99');
      expect(buildCounterBrowserReceipt(model, locale, 'A4', true)).toContain('Nov offer (-1.01)');
      expect(model.totals).toMatchObject({ grossMinor: 5000, discountMinor: 101, netMinor: 4899 });
      expect(buildCounterReceiptDocument(model, locale, { reprint: true }).lines).toEqual(
        document.lines
      );
    }
  );
  it('includes savings in the raw thermal facts and escapes promotion text in browser paper', () => {
    const model = receipt({
      lines: [
        receiptLine({
          promotionName: '<Offer>',
          discountMinor: 100,
          lineTotalMinor: 4900,
        }),
      ],
    });
    const document = buildPharmacyReceiptPrintDocument(model, 'en', {
      layout: DEFAULT_RECEIPT_LAYOUT,
      taxIdentity: { ntn: null, strn: null },
      reprint: true,
    });
    expect(document.receiptSnapshot?.facts.lines[0]).toContain('Promotion: <Offer> (-1.00)');
    const html = buildCounterBrowserReceipt(model, 'en', 'THERMAL');
    expect(html).toContain('&lt;Offer&gt;');
    expect(html).not.toContain('<Offer>');
  });
});
