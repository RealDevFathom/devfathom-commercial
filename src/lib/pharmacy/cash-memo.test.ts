import { describe, expect, it, vi } from 'vitest';

import {
  assertCashMemoBuyerName,
  CASH_MEMO_STRINGS,
  cashMemoHeaderLines,
  cashMemoLineRows,
  cashMemoSignatureLine,
  normalizeBuyerName,
  PharmacyCashMemoError,
  readPharmacyCashMemo,
  readPharmacyCashMemoPolicy,
  resolveCompletionBuyerName,
  setPharmacySaleBuyerName,
  SINDH_PROVINCE_CODE,
  type PharmacyCashMemo,
} from './cash-memo';
import type { CounterReceiptLine } from './counter-receipt';

const scope = { organizationId: 'org-1', branchId: 'branch-1' };
const at = new Date('2026-10-31T09:30:00.000Z');

const memo: PharmacyCashMemo = {
  template: 'SINDH_CASH_MEMO',
  licenceNumber: 'DL-KHI-0042',
  licenceValidFrom: '2026-01-01T00:00:00.000Z',
  licenceValidTo: '2027-12-31T00:00:00.000Z',
  pharmacistRegistration: 'PPC-12345',
};

function line(overrides: Partial<CounterReceiptLine> = {}): CounterReceiptLine {
  return {
    saleLineId: 'line-1',
    identityStatus: 'ISSUED',
    medicineName: 'Panadol',
    strength: '500 mg',
    manufacturer: 'GSK Pakistan',
    presentation: 'Tablet',
    batchNumber: 'B-2201 (20 units)',
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

function profile(overrides: Record<string, unknown> = {}) {
  return {
    provinceCode: SINDH_PROVINCE_CODE,
    isPlaceholder: false,
    licenceNumber: ' DL-KHI-0042 ',
    licenceValidFrom: new Date('2026-01-01T00:00:00.000Z'),
    licenceValidTo: new Date('2027-12-31T00:00:00.000Z'),
    qualifiedPersonRegistration: 'PPC-12345',
    ...overrides,
  };
}

describe('strings', () => {
  it('ships every cash memo string in English and Urdu', () => {
    expect(Object.keys(CASH_MEMO_STRINGS.ur).sort()).toEqual(
      Object.keys(CASH_MEMO_STRINGS.en).sort()
    );
    for (const value of [
      ...Object.values(CASH_MEMO_STRINGS.en),
      ...Object.values(CASH_MEMO_STRINGS.ur),
    ])
      expect(value.trim()).not.toBe('');
  });

  it('keeps the English strings printable ASCII for the ESC/POS path', () => {
    for (const value of Object.values(CASH_MEMO_STRINGS.en))
      expect(value).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe('cashMemoHeaderLines', () => {
  it('prints title, licence, validity, pharmacist and buyer', () => {
    expect(cashMemoHeaderLines({ cashMemo: memo, buyerName: 'Ayesha Khan' }, 'en')).toEqual([
      'Cash memo - Sindh Drugs Rules r.18',
      'Drug sale licence: DL-KHI-0042',
      'Valid: 2026-01-01 to 2027-12-31',
      'Pharmacist reg.: PPC-12345',
      'Buyer: Ayesha Khan',
    ]);
  });

  it('leaves a blank buyer field for a nameless walk-in and omits a missing pharmacist', () => {
    expect(
      cashMemoHeaderLines(
        { cashMemo: { ...memo, pharmacistRegistration: null }, buyerName: null },
        'en'
      )
    ).toEqual([
      'Cash memo - Sindh Drugs Rules r.18',
      'Drug sale licence: DL-KHI-0042',
      'Valid: 2026-01-01 to 2027-12-31',
      'Buyer: ________________',
    ]);
  });

  it('never prints a licence it does not have', () => {
    expect(
      cashMemoHeaderLines(
        {
          cashMemo: {
            ...memo,
            licenceNumber: null,
            licenceValidFrom: null,
            licenceValidTo: null,
            pharmacistRegistration: null,
          },
          buyerName: 'Ayesha Khan',
        },
        'en'
      )
    ).toEqual([
      'Cash memo - Sindh Drugs Rules r.18',
      'Licence not on file',
      'Valid: Unavailable',
      'Buyer: Ayesha Khan',
    ]);
  });

  it('is empty for a receipt that is not a cash memo', () => {
    expect(cashMemoHeaderLines({ cashMemo: null, buyerName: 'Ayesha Khan' }, 'en')).toEqual([]);
    expect(cashMemoHeaderLines({ buyerName: 'Ayesha Khan' }, 'ur')).toEqual([]);
  });

  it('renders the Urdu header', () => {
    expect(cashMemoHeaderLines({ cashMemo: memo, buyerName: 'Ayesha Khan' }, 'ur')).toEqual([
      'کیش میمو — سندھ ڈرگز رولز، قاعدہ 18',
      'ڈرگ سیل لائسنس: DL-KHI-0042',
      'مؤثر مدت: 2026-01-01 تا 2027-12-31',
      'فارماسسٹ رجسٹریشن: PPC-12345',
      'خریدار: Ayesha Khan',
    ]);
  });
});

describe('cashMemoLineRows', () => {
  it('adds strength, manufacturer, labelled quantity and unit price', () => {
    expect(cashMemoLineRows(line(), 'en')).toEqual([
      'Strength: 500 mg · Manufacturer: GSK Pakistan',
      'Qty: 2 strip · Unit price: 25.00',
    ]);
    expect(cashMemoLineRows(line(), 'en', ' | ')).toEqual([
      'Strength: 500 mg | Manufacturer: GSK Pakistan',
      'Qty: 2 strip | Unit price: 25.00',
    ]);
  });

  it('shows a pre-#708 receipt manufacturer as unavailable, never a guess', () => {
    expect(
      cashMemoLineRows(line({ manufacturer: undefined, strength: null }), 'en', ' | ')
    ).toEqual(['Strength: - | Manufacturer: Unavailable', 'Qty: 2 strip | Unit price: 25.00']);
    expect(cashMemoLineRows(line({ identityStatus: 'UNAVAILABLE' }), 'en')[0]).toBe(
      'Strength: — · Manufacturer: Unavailable'
    );
  });

  it('renders Urdu line rows', () => {
    expect(cashMemoLineRows(line(), 'ur')).toEqual([
      'طاقت: 500 mg · تیار کنندہ: GSK Pakistan',
      'مقدار: 2 پتّا · فی یونٹ قیمت: 25.00',
    ]);
  });

  it('prints the qualified person signature line', () => {
    expect(cashMemoSignatureLine('en')).toBe('Signature of qualified person: ________________');
    expect(cashMemoSignatureLine('ur')).toBe('مستند شخص کے دستخط: ________________');
  });
});

describe('normalizeBuyerName', () => {
  it('trims and collapses whitespace, and treats blank as no name', () => {
    expect(normalizeBuyerName('  Ayesha   Khan ')).toBe('Ayesha Khan');
    expect(normalizeBuyerName('   ')).toBeNull();
    expect(normalizeBuyerName(null)).toBeNull();
    expect(normalizeBuyerName('عائشہ خان')).toBe('عائشہ خان');
  });

  it('refuses over-long names and printer control or bidi override characters', () => {
    expect(() => normalizeBuyerName('a'.repeat(121))).toThrow(PharmacyCashMemoError);
    expect(() => normalizeBuyerName('Ayesha\u001b@')).toThrow(PharmacyCashMemoError);
    expect(() => normalizeBuyerName('Ayesha\u202EKhan')).toThrow(PharmacyCashMemoError);
  });
});

describe('readPharmacyCashMemo', () => {
  it('reads the Sindh profile in force at completion', async () => {
    const findFirst = vi.fn(async () => profile());
    await expect(
      readPharmacyCashMemo({ branchRegulatoryProfile: { findFirst } } as never, scope, at)
    ).resolves.toEqual(memo);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        branchId: 'branch-1',
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
      select: {
        provinceCode: true,
        isPlaceholder: true,
        licenceNumber: true,
        licenceValidFrom: true,
        licenceValidTo: true,
        qualifiedPersonRegistration: true,
      },
    });
  });

  it('returns null for a Punjab branch, so its receipt is unchanged', async () => {
    const findFirst = vi.fn(async () => profile({ provinceCode: 'PK-PB' }));
    await expect(
      readPharmacyCashMemo({ branchRegulatoryProfile: { findFirst } } as never, scope, at)
    ).resolves.toBeNull();
  });

  it('returns null when no profile was in force', async () => {
    const findFirst = vi.fn(async () => null);
    await expect(
      readPharmacyCashMemo({ branchRegulatoryProfile: { findFirst } } as never, scope, at)
    ).resolves.toBeNull();
  });

  it('keeps the memo but withholds placeholder licence values', async () => {
    const findFirst = vi.fn(async () => profile({ isPlaceholder: true }));
    await expect(
      readPharmacyCashMemo({ branchRegulatoryProfile: { findFirst } } as never, scope, at)
    ).resolves.toEqual({
      template: 'SINDH_CASH_MEMO',
      licenceNumber: null,
      licenceValidFrom: null,
      licenceValidTo: null,
      pharmacistRegistration: null,
    });
  });
});

describe('owner buyer-name policy', () => {
  function db(options: { required: boolean | null; province?: string }) {
    return {
      pharmacyBranch: {
        findFirst: vi.fn(async () =>
          options.required === null ? null : { cashMemoBuyerNameRequired: options.required }
        ),
      },
      branchRegulatoryProfile: {
        findFirst: vi.fn(async () => profile({ provinceCode: options.province ?? 'PK-SD' })),
      },
      pharmacyCustomer: { findFirst: vi.fn(async () => ({ displayName: 'Ayesha' })) },
    };
  }

  it('reports the policy for the counter', async () => {
    await expect(
      readPharmacyCashMemoPolicy(db({ required: true }) as never, scope, at)
    ).resolves.toEqual({ cashMemo: true, buyerNameRequired: true });
    await expect(
      readPharmacyCashMemoPolicy(db({ required: null, province: 'PK-PB' }) as never, scope, at)
    ).resolves.toEqual({ cashMemo: false, buyerNameRequired: false });
  });

  it('allows a nameless walk-in by default', async () => {
    const fake = db({ required: false });
    await expect(
      assertCashMemoBuyerName(fake as never, scope, { buyerName: null, customerId: null }, at)
    ).resolves.toBeUndefined();
    expect(fake.branchRegulatoryProfile.findFirst).not.toHaveBeenCalled();
  });

  it('refuses a nameless sale on a Sindh branch whose owner requires a buyer name', async () => {
    await expect(
      assertCashMemoBuyerName(
        db({ required: true }) as never,
        scope,
        { buyerName: '  ', customerId: null },
        at
      )
    ).rejects.toMatchObject({ reason: 'BUYER_NAME_REQUIRED' });
  });

  it('does not apply the policy outside Sindh', async () => {
    await expect(
      assertCashMemoBuyerName(
        db({ required: true, province: 'PK-PB' }) as never,
        scope,
        { buyerName: null, customerId: null },
        at
      )
    ).resolves.toBeUndefined();
  });

  it('accepts a typed name or a printable linked customer without reading the policy', async () => {
    const fake = db({ required: true });
    const typed = { buyerName: 'Ayesha', customerId: null };
    const customer = { buyerName: null, customerId: 'c-1' };
    await assertCashMemoBuyerName(fake as never, scope, typed, at);
    await assertCashMemoBuyerName(fake as never, scope, customer, at);
    expect(fake.pharmacyBranch.findFirst).not.toHaveBeenCalled();
  });

  it.each([null, '', '   ', '\u202E'])(
    'refuses an unprintable linked name %j',
    async (displayName) => {
      const fake = db({ required: true });
      fake.pharmacyCustomer.findFirst.mockResolvedValueOnce({ displayName } as never);
      await expect(
        assertCashMemoBuyerName(fake as never, scope, { buyerName: null, customerId: 'c-1' }, at)
      ).rejects.toMatchObject({ reason: 'BUYER_NAME_REQUIRED' });
    }
  );

  it('refuses a missing linked customer when the owner requires a name', async () => {
    const fake = db({ required: true });
    fake.pharmacyCustomer.findFirst.mockResolvedValueOnce(null as never);
    await expect(
      assertCashMemoBuyerName(fake as never, scope, { buyerName: null, customerId: 'missing' }, at)
    ).rejects.toMatchObject({ reason: 'BUYER_NAME_REQUIRED' });
  });
});

describe('resolveCompletionBuyerName', () => {
  it('prefers the typed name, then the linked customer', async () => {
    const findFirst = vi.fn(async () => ({ displayName: '  Bilal   Ahmed ' }));
    const fake = { pharmacyCustomer: { findFirst } } as never;
    await expect(
      resolveCompletionBuyerName(fake, scope, { buyerName: 'Ayesha Khan', customerId: 'c-1' })
    ).resolves.toBe('Ayesha Khan');
    expect(findFirst).not.toHaveBeenCalled();
    await expect(
      resolveCompletionBuyerName(fake, scope, { buyerName: null, customerId: 'c-1' })
    ).resolves.toBe('Bilal Ahmed');
    expect(findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', id: 'c-1' },
      select: { displayName: true },
    });
  });

  it('is null for a nameless walk-in', async () => {
    const findFirst = vi.fn();
    await expect(
      resolveCompletionBuyerName({ pharmacyCustomer: { findFirst } } as never, scope, {
        buyerName: null,
        customerId: null,
      })
    ).resolves.toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe('setPharmacySaleBuyerName', () => {
  it('writes only an OPEN, unnumbered sale in scope', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    await expect(
      setPharmacySaleBuyerName({ pharmacySale: { updateMany } } as never, scope, {
        saleId: 'sale-1',
        buyerName: ' Ayesha  Khan ',
      })
    ).resolves.toEqual({ saleId: 'sale-1', buyerName: 'Ayesha Khan' });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'sale-1',
        organizationId: 'org-1',
        branchId: 'branch-1',
        status: 'OPEN',
        receiptNumber: null,
      },
      data: { buyerName: 'Ayesha Khan' },
    });
  });

  it('refuses an issued or foreign sale', async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    await expect(
      setPharmacySaleBuyerName({ pharmacySale: { updateMany } } as never, scope, {
        saleId: 'sale-1',
        buyerName: null,
      })
    ).rejects.toMatchObject({ reason: 'SALE_NOT_OPEN' });
  });
});
