/**
 * #708 acceptance: a Sindh branch's receipt shows every r.18 field in the
 * thermal 80 mm, A4 and Urdu layouts (and the ESC/POS job); a Punjab branch's
 * receipt is unchanged; a reprint shows the same fields.
 *
 * Exact-line layout snapshots, written out so a change to the memo fails here
 * instead of silently rewriting a stored snapshot.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_RECEIPT_LAYOUT } from '@/lib/receipts/configuration';

import type { PharmacyCashMemo } from './cash-memo';
import { buildCounterBrowserReceipt } from './counter-browser-print';
import { counterReceiptTotals, type CounterReceipt } from './counter-receipt';
import { buildCounterReceiptPreview } from './counter-receipt-presentation';
import { buildPharmacyReceiptPrintDocument } from './receipt-print';

const memo: PharmacyCashMemo = {
  template: 'SINDH_CASH_MEMO',
  licenceNumber: 'DL-KHI-0042',
  licenceValidFrom: '2026-01-01T00:00:00.000Z',
  licenceValidTo: '2027-12-31T00:00:00.000Z',
  pharmacistRegistration: 'PPC-12345',
};

function standardReceipt(): CounterReceipt {
  const lines: CounterReceipt['lines'] = [
    {
      saleLineId: 'line-1',
      identityStatus: 'ISSUED',
      medicineName: 'Panadol',
      strength: '500 mg',
      manufacturer: 'GSK Pakistan',
      presentation: 'Tablet',
      allocations: [
        {
          allocationId: 'al-1',
          inventoryLotId: 'lot-1',
          batchNumber: 'B-2201',
          expiresAt: '2027-04-30T00:00:00.000Z',
          canonicalUnits: 20,
        },
      ],
      batchNumber: 'B-2201 (20 units)',
      expiresAt: '2027-04-30T00:00:00.000Z',
      saleUnit: 'STRIP',
      quantity: 2,
      canonicalUnits: 20,
      unitPriceMinor: 2_500,
      discountMinor: 0,
      lineTotalMinor: 5_000,
    },
  ];
  const tenders: CounterReceipt['tenders'] = [
    {
      tenderId: 't-1',
      type: 'CASH',
      amountMinor: 5_000,
      cashReceivedMinor: 5_000,
      changeGivenMinor: 0,
    },
  ];
  return {
    saleId: 'sale-708',
    receiptNumber: 41,
    branchName: 'Saddar Branch',
    businessDate: '2026-10-31',
    completedAt: '2026-10-31T09:30:00.000Z',
    currency: 'PKR',
    taxIdentity: { ntn: null, strn: null },
    buyerName: 'Ayesha Khan',
    lines,
    tenders,
    totals: counterReceiptTotals({ lines, tenders }),
  };
}

const sindh = (): CounterReceipt => ({ ...standardReceipt(), cashMemo: memo });

const EN_MEMO_HEADER = [
  'Cash memo - Sindh Drugs Rules r.18',
  'Drug sale licence: DL-KHI-0042',
  'Valid: 2026-01-01 to 2027-12-31',
  'Pharmacist reg.: PPC-12345',
  'Buyer: Ayesha Khan',
];
const EN_SIGNATURE = 'Signature of qualified person: ________________';

/** The standard 80 mm receipt; the Punjab branch must keep exactly this. */
const STANDARD_80 = [
  'Saddar Branch',
  'Invoice: Receipt 41',
  'Date: 2026-10-31',
  '-'.repeat(48),
  'Panadol · 500 mg · Tablet',
  '2 strip × 25.00',
  'Batch: B-2201 · Expiry: 2027-04-30 · Canonical units: 20',
  'Amount: 50.00',
  '-'.repeat(48),
  'Tax breakdown unavailable in receipt source',
  'PKR',
  'Gross: 50.00',
  'Discount: 0.00',
  'Total: 50.00',
  'Tendered: 50.00',
  'Change: 0.00',
  '-'.repeat(48),
  'CASH: 50.00',
];

const SINDH_80 = [
  'Saddar Branch',
  'Invoice: Receipt 41',
  'Date: 2026-10-31',
  ...EN_MEMO_HEADER,
  '-'.repeat(48),
  'Panadol · 500 mg · Tablet',
  'Strength: 500 mg · Manufacturer: GSK Pakistan',
  'Qty: 2 strip · Unit price: 25.00',
  'Batch: B-2201 · Expiry: 2027-04-30 · Canonical units: 20',
  'Amount: 50.00',
  '-'.repeat(48),
  'Tax breakdown unavailable in receipt source',
  'PKR',
  'Gross: 50.00',
  'Discount: 0.00',
  'Total: 50.00',
  'Tendered: 50.00',
  'Change: 0.00',
  '-'.repeat(48),
  'CASH: 50.00',
  EN_SIGNATURE,
];

describe('thermal 80 mm layout', () => {
  it('prints every r.18 field on a Sindh cash memo', () => {
    expect(buildCounterReceiptPreview(sindh(), 'en', 80).split('\n')).toEqual(SINDH_80);
  });

  it('leaves a Punjab receipt unchanged, buyer name or not', () => {
    const before = buildCounterReceiptPreview(standardReceipt(), 'en', 80);
    expect(before.split('\n')).toEqual(STANDARD_80);
    expect(buildCounterReceiptPreview({ ...standardReceipt(), cashMemo: null }, 'en', 80)).toBe(
      before
    );
    expect(before).not.toContain('Ayesha');
    expect(before).not.toContain('Signature');
    expect(before).not.toContain('GSK');
  });

  it('reprints from sale history with the same memo fields', () => {
    const reprint = buildCounterReceiptPreview(sindh(), 'en', 80, true).split('\n');
    expect(reprint).toEqual([...SINDH_80, 'Reprint — not a new sale']);
  });
});

describe('A4 layout', () => {
  it('prints every r.18 field on the A4 cash memo', () => {
    const html = buildCounterBrowserReceipt(sindh(), 'en', 'A4');
    expect(html).toContain('@page { size: A4; margin: 10mm; }');
    expect(html).toContain(`<pre>${SINDH_80.join('\n')}</pre>`);
  });

  it('keeps the Punjab A4 receipt unchanged', () => {
    const html = buildCounterBrowserReceipt(standardReceipt(), 'en', 'A4');
    expect(html).toContain(`<pre>${STANDARD_80.join('\n')}</pre>`);
  });
});

describe('Urdu layout', () => {
  it('prints every r.18 field on the Urdu cash memo', () => {
    expect(buildCounterReceiptPreview(sindh(), 'ur', 80).split('\n')).toEqual([
      'Saddar Branch',
      'Invoice: رسید 41',
      'تاریخ: 2026-10-31',
      'کیش میمو — سندھ ڈرگز رولز، قاعدہ 18',
      'ڈرگ سیل لائسنس: DL-KHI-0042',
      'مؤثر مدت: 2026-01-01 تا 2027-12-31',
      'فارماسسٹ رجسٹریشن: PPC-12345',
      'خریدار: Ayesha Khan',
      '-'.repeat(48),
      'Panadol · 500 mg · Tablet',
      'طاقت: 500 mg · تیار کنندہ: GSK Pakistan',
      'مقدار: 2 پتّا · فی یونٹ قیمت: 25.00',
      'بیچ: B-2201 · میعاد: 2027-04-30 · بنیادی اکائیاں: 20',
      'رقم: 50.00',
      '-'.repeat(48),
      'رسید کے ماخذ میں ٹیکس کی تفصیل دستیاب نہیں',
      'PKR',
      'کل رقم: 50.00',
      'رعایت: 0.00',
      'قابلِ ادائیگی: 50.00',
      'ادا شدہ: 50.00',
      'واپسی: 0.00',
      '-'.repeat(48),
      'CASH: 50.00',
      'مستند شخص کے دستخط: ________________',
    ]);
  });

  it('renders the Urdu A4 memo right to left', () => {
    const html = buildCounterBrowserReceipt(sindh(), 'ur', 'A4');
    expect(html).toContain('<html lang="ur" dir="rtl">');
    expect(html).toContain('مستند شخص کے دستخط');
    expect(html).toContain('تیار کنندہ: GSK Pakistan');
  });

  it('keeps the Punjab Urdu receipt free of memo fields', () => {
    const preview = buildCounterReceiptPreview(standardReceipt(), 'ur', 80);
    expect(preview).not.toContain('کیش میمو');
    expect(preview).not.toContain('مستند شخص');
    expect(preview).toContain('2 پتّا × 25.00');
  });
});

describe('ESC/POS thermal job', () => {
  const layout = DEFAULT_RECEIPT_LAYOUT;
  const taxIdentity = { ntn: null, strn: null };

  it('carries every r.18 field in printable ASCII', () => {
    const document = buildPharmacyReceiptPrintDocument(sindh(), 'en', {
      layout,
      taxIdentity,
      reprint: false,
    });
    expect(document.receiptSnapshot?.facts).toEqual({
      businessName: 'Saddar Branch',
      invoiceNumber: 'Receipt 41',
      issuedAt: ['Date: 2026-10-31', ...EN_MEMO_HEADER].join('\n'),
      lines: [
        [
          'Panadol - 500 mg - Tablet',
          'Strength: 500 mg | Manufacturer: GSK Pakistan',
          'Qty: 2 strip | Unit price: 25.00',
          'Batch: B-2201 | Expiry: 2027-04-30 | Units: 20',
          'Amount: 50.00',
        ].join('\n'),
      ],
      taxLines: ['Tax breakdown unavailable in receipt source'],
      totals: [
        'PKR',
        'Gross: 50.00',
        'Discount: 0.00',
        'Total: 50.00',
        'Tendered: 50.00',
        'Change: 0.00',
      ],
      payments: ['CASH: 50.00', EN_SIGNATURE],
    });
  });

  it('marks a reprint after the same memo header', () => {
    const document = buildPharmacyReceiptPrintDocument(sindh(), 'en', {
      layout,
      taxIdentity,
      reprint: true,
    });
    expect(document.receiptSnapshot?.facts.issuedAt).toBe(
      ['Date: 2026-10-31', ...EN_MEMO_HEADER, 'REPRINT - not a new sale'].join('\n')
    );
  });

  it('keeps the Punjab job facts unchanged', () => {
    const document = buildPharmacyReceiptPrintDocument(standardReceipt(), 'en', {
      layout,
      taxIdentity,
      reprint: false,
    });
    expect(document.receiptSnapshot?.facts).toMatchObject({
      issuedAt: 'Date: 2026-10-31',
      lines: [
        [
          'Panadol - 500 mg - Tablet',
          '2 strip x 25.00',
          'Batch: B-2201 | Expiry: 2027-04-30 | Units: 20',
          'Amount: 50.00',
        ].join('\n'),
      ],
      payments: ['CASH: 50.00'],
    });
  });
});
