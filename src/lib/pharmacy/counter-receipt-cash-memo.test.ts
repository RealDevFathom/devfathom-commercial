/**
 * #708 — Sindh Drugs Rules r.18 cash memo on the counter receipt.
 *
 * A Sindh branch's receipt carries every r.18 fact (medicine, strength,
 * manufacturer, batch, expiry, quantity, unit price, total; licence and its
 * validity, buyer name, qualified person's signature) on the thermal 80 mm, A4
 * and Urdu layouts; a Punjab branch's receipt is byte-for-byte unchanged.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';

import { buildCounterBrowserReceipt } from './counter-browser-print';
import {
  counterReceiptCashMemo,
  isSindhCashMemoProvince,
  type CounterReceipt,
  type PharmacyReceiptTaxIdentity,
} from './counter-receipt';
import { buildCounterReceiptPreview } from './counter-receipt-presentation';
import { buildPharmacyReceiptPrintDocument } from './receipt-print';

const base: CounterReceipt = {
  saleId: 'sale-1',
  receiptNumber: 42,
  branchName: 'Saddar Branch',
  completedAt: '2026-11-14T09:30:00.000Z',
  businessDate: '2026-11-14',
  cashierName: 'Cashier One',
  buyerName: 'Ayesha Khan',
  currency: 'PKR',
  lines: [
    {
      saleLineId: 'line-1',
      identityStatus: 'ISSUED',
      medicineName: 'Paracetamol',
      manufacturer: 'GSK Pakistan',
      strength: '500 mg',
      presentation: 'Tablet',
      allocations: [
        {
          allocationId: 'al-1',
          inventoryLotId: 'lot-1',
          batchNumber: 'B-001',
          expiresAt: '2027-06-30T00:00:00.000Z',
          canonicalUnits: 20,
          grossMinor: 4000,
        },
      ],
      batchNumber: 'B-001 (20 units)',
      expiresAt: '2027-06-30T00:00:00.000Z',
      saleUnit: 'STRIP',
      quantity: 2,
      canonicalUnits: 20,
      unitPriceMinor: 2000,
      discountMinor: 0,
      lineTotalMinor: 4000,
    },
  ],
  tenders: [
    {
      tenderId: 'tender-1',
      type: 'CASH',
      amountMinor: 4000,
      cashReceivedMinor: 5000,
      changeGivenMinor: 1000,
    },
  ],
  totals: {
    grossMinor: 4000,
    discountMinor: 0,
    netMinor: 4000,
    tenderedMinor: 5000,
    changeMinor: 1000,
  },
};

const punjab: PharmacyReceiptTaxIdentity = {
  address: '12 Mall Road, Lahore',
  phone: '042-1234567',
  licenceNumber: 'DSL-PB-42',
  ntn: 'NTN-1',
  strn: null,
  provinceCode: 'PK-PB',
  licenceValidFrom: '2026-01-01T00:00:00.000Z',
  licenceValidTo: '2027-12-31T00:00:00.000Z',
  pharmacistRegistration: 'PCP-9001',
};
const sindh: PharmacyReceiptTaxIdentity = {
  ...punjab,
  address: '7 Zaibunnisa Street, Karachi',
  licenceNumber: 'DSL-SD-77',
  provinceCode: 'PK-SD',
};

/** Thermal output wraps at the paper's columns; facts are compared across wraps. */
const flat = (value: string) => value.replace(/\s+/g, ' ');

const R18_EN = [
  'Cash memo: 42',
  'Sindh Drugs Rules 1979, r.18',
  'Paracetamol · 500 mg · Tablet',
  'Manufacturer: GSK Pakistan',
  'Qty × Unit price: strip: 2 × 20.00',
  'Batch: B-001',
  'Expiry: 2027-06-30',
  'Amount: 40.00',
  'Drug-sale licence: DSL-SD-77 (valid 2026-01-01 to 2027-12-31)',
  'Pharmacist registration: PCP-9001',
  'Buyer: Ayesha Khan',
  'Signature of qualified person: ________________',
];

describe('#708 Sindh cash memo mode', () => {
  it('turns on only for a Sindh regulatory profile, whatever the code spelling', () => {
    expect(['PK-SD', 'SD', ' pk-sd '].map(isSindhCashMemoProvince)).toEqual([true, true, true]);
    expect(['PK-PB', 'PB', 'PK-KP', '', null, undefined].map(isSindhCashMemoProvince)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(counterReceiptCashMemo(base, punjab, 'en')).toBeNull();
    expect(counterReceiptCashMemo(base, undefined, 'en')).toBeNull();
    expect(counterReceiptCashMemo(base, sindh, 'en')).not.toBeNull();
  });

  it('prints every r.18 field on the Sindh thermal 80 mm receipt', () => {
    const preview = buildCounterReceiptPreview({ ...base, taxIdentity: sindh }, 'en', 80);
    for (const fact of R18_EN) expect(flat(preview)).toContain(fact);
    expect(preview).toMatchSnapshot();
  });

  it('prints every r.18 field on the Sindh A4 receipt', () => {
    const html = buildCounterBrowserReceipt({ ...base, taxIdentity: sindh }, 'en', 'A4');
    expect(html).toContain('size: A4');
    for (const fact of R18_EN) expect(flat(html)).toContain(fact);
    expect(html).toMatchSnapshot();
  });

  it('prints every r.18 field on the Sindh Urdu receipt', () => {
    const preview = buildCounterReceiptPreview({ ...base, taxIdentity: sindh }, 'ur', 80);
    for (const fact of [
      'کیش میمو: 42',
      'سندھ ڈرگ رولز ۱۹۷۹، قاعدہ ۱۸',
      'تیار کنندہ: GSK Pakistan',
      'بیچ: B-001',
      'میعاد: 2027-06-30',
      'ادویات فروشی لائسنس: DSL-SD-77 (کارآمد 2026-01-01 تا 2027-12-31)',
      'فارماسسٹ رجسٹریشن: PCP-9001',
      'خریدار: Ayesha Khan',
      'مستند شخص کے دستخط: ________________',
    ])
      expect(flat(preview)).toContain(fact);
    expect(preview).toMatchSnapshot();
  });

  it('prints every r.18 field on the Sindh ESC/POS thermal job', () => {
    const document = buildPharmacyReceiptPrintDocument({ ...base, taxIdentity: sindh }, 'en', {
      layout: DEFAULT_RECEIPT_LAYOUT,
      taxIdentity: sindh,
      reprint: true,
    });
    const facts = document.receiptSnapshot!.facts;
    const text = flat(
      [
        `${facts.invoiceLabel}: ${facts.invoiceNumber}`,
        facts.issuedAt,
        ...facts.lines,
        ...facts.taxLines,
        ...facts.payments,
      ].join('\n')
    );
    for (const fact of R18_EN)
      expect(text).toContain(fact.replaceAll(' · ', ' - ').replaceAll('×', 'x'));
    expect(facts.issuedAt).toContain('REPRINT - not a new sale');
    expect(facts).toMatchSnapshot();
  });

  it('leaves blanks for an unnamed walk-in and an unrecorded manufacturer, never invented facts', () => {
    const walkIn: CounterReceipt = {
      ...base,
      buyerName: null,
      lines: [{ ...base.lines[0]!, manufacturer: null }],
      taxIdentity: { ...sindh, pharmacistRegistration: null, licenceValidFrom: null },
    };
    const preview = buildCounterReceiptPreview(walkIn, 'en', 80);
    expect(flat(preview)).toContain('Buyer: ________________');
    expect(flat(preview)).toContain('Manufacturer: Not recorded');
    expect(flat(preview)).toContain('Drug-sale licence: DSL-SD-77 (valid to 2027-12-31)');
    expect(preview).not.toContain('Pharmacist registration');
  });

  it("does not print a historical line's manufacturer when its identity is unavailable", () => {
    const legacy: CounterReceipt = {
      ...base,
      lines: [{ ...base.lines[0]!, identityStatus: 'UNAVAILABLE' }],
      taxIdentity: sindh,
    };
    expect(buildCounterReceiptPreview(legacy, 'en', 80)).toContain('Manufacturer: Not recorded');
  });

  it.each([
    ['en', 'THERMAL'],
    ['en', 'A4'],
    ['ur', 'THERMAL'],
  ] as const)('leaves the Punjab %s %s receipt unchanged', (locale, format) => {
    const withCashMemoFacts = buildCounterBrowserReceipt(
      { ...base, taxIdentity: punjab },
      locale,
      format
    );
    // The same receipt with none of the #708 facts on it is the pre-#708 output.
    const legacyReceipt: CounterReceipt = { ...base };
    delete legacyReceipt.buyerName;
    const legacy = buildCounterBrowserReceipt(
      {
        ...legacyReceipt,
        lines: base.lines.map((line) => {
          const legacyLine = { ...line };
          delete legacyLine.manufacturer;
          return legacyLine;
        }),
        taxIdentity: {
          address: punjab.address,
          phone: punjab.phone,
          licenceNumber: punjab.licenceNumber,
          ntn: punjab.ntn,
          strn: punjab.strn,
        },
      },
      locale,
      format
    );
    expect(withCashMemoFacts).toBe(legacy);
    expect(withCashMemoFacts).not.toContain('GSK Pakistan');
    expect(withCashMemoFacts).not.toContain('Ayesha Khan');
    expect(withCashMemoFacts).not.toContain('Signature');
  });

  it('leaves the Punjab ESC/POS thermal job unchanged', () => {
    const job = (taxIdentity: PharmacyReceiptTaxIdentity) =>
      buildPharmacyReceiptPrintDocument({ ...base, taxIdentity }, 'en', {
        layout: DEFAULT_RECEIPT_LAYOUT,
        taxIdentity,
        reprint: false,
      });
    const facts = job(punjab).receiptSnapshot!.facts;
    expect(facts.invoiceLabel).toBe('Receipt');
    expect(facts.taxLines).toContain('Drug-sale licence: DSL-PB-42');
    expect(JSON.stringify(facts)).not.toMatch(/Manufacturer|Buyer|Signature/);
  });
});
