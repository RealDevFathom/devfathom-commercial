import { describe, expect, it } from 'vitest';
import {
  assertPromotableProducts,
  isNonDrugRetail,
  isValidEan13,
  NON_DRUG_NO_EXPIRY,
  normalizeRetailCategory,
  PharmacyProductClassError,
  productClassForFamily,
  resolveReceiptBatchIdentity,
  resolveReceiptRetailPrice,
  validateRetailFields,
} from './product-class';

const reasonOf = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    if (error instanceof PharmacyProductClassError) return error.reason;
    throw error;
  }
  return null;
};

describe('#718 product class', () => {
  it('derives NON_DRUG_RETAIL only from the existing FRONT_SHOP family and fails closed', () => {
    expect(productClassForFamily('FRONT_SHOP')).toBe('NON_DRUG_RETAIL');
    for (const family of ['PHARMACEUTICAL', 'BIOLOGICAL', 'DEVICE', 'ALTERNATIVE', '', null])
      expect(productClassForFamily(family)).toBe('MEDICINE');
    expect(isNonDrugRetail('front_shop')).toBe(false);
  });

  it('validates EAN-13 check digits', () => {
    expect(isValidEan13('4006381333931')).toBe(true);
    expect(isValidEan13('4006381333932')).toBe(false);
    expect(isValidEan13('400638133393')).toBe(false);
    expect(isValidEan13('400638133393a')).toBe(false);
  });

  it('normalizes retail categories and rejects oversize ones', () => {
    expect(normalizeRetailCategory('  Baby   care ')).toBe('Baby care');
    expect(normalizeRetailCategory('   ')).toBeNull();
    expect(normalizeRetailCategory(undefined)).toBeNull();
    expect(reasonOf(() => normalizeRetailCategory('x'.repeat(81)))).toBe(
      'INVALID_RETAIL_CATEGORY'
    );
  });

  it('accepts retail fields on non-drug items only', () => {
    expect(
      validateRetailFields({
        productFamily: 'FRONT_SHOP',
        retailPriceMinor: 45000,
        retailCategory: 'Cosmetics',
        ean13: '4006381333931',
      })
    ).toEqual({ retailPriceMinor: 45000, retailCategory: 'Cosmetics', ean13: '4006381333931' });
    expect(validateRetailFields({ productFamily: 'PHARMACEUTICAL' })).toEqual({
      retailPriceMinor: null,
      retailCategory: null,
      ean13: null,
    });
    expect(
      reasonOf(() => validateRetailFields({ productFamily: 'PHARMACEUTICAL', retailPriceMinor: 1 }))
    ).toBe('RETAIL_FIELDS_MEDICINE');
    expect(
      reasonOf(() => validateRetailFields({ productFamily: 'DEVICE', retailCategory: 'FMCG' }))
    ).toBe('RETAIL_FIELDS_MEDICINE');
    expect(
      reasonOf(() => validateRetailFields({ productFamily: 'FRONT_SHOP', retailPriceMinor: 0 }))
    ).toBe('INVALID_RETAIL_PRICE');
    expect(
      reasonOf(() => validateRetailFields({ productFamily: 'FRONT_SHOP', retailPriceMinor: 1.5 }))
    ).toBe('INVALID_RETAIL_PRICE');
    expect(
      reasonOf(() => validateRetailFields({ productFamily: 'FRONT_SHOP', ean13: '1234567890123' }))
    ).toBe('INVALID_EAN13');
  });

  it('keeps PUR-02 batch and expiry mandatory for medicines', () => {
    const expiry = new Date('2027-06-30T00:00:00Z');
    expect(
      resolveReceiptBatchIdentity({ productFamily: 'PHARMACEUTICAL', expiryPrecision: 'DAY' })
    ).toEqual({ ok: false, reason: 'MISSING_BATCH' });
    expect(
      resolveReceiptBatchIdentity({
        productFamily: 'BIOLOGICAL',
        batchNumber: 'B1',
        expiryPrecision: 'DAY',
      })
    ).toEqual({ ok: false, reason: 'MISSING_EXPIRY' });
    expect(
      resolveReceiptBatchIdentity({
        productFamily: 'PHARMACEUTICAL',
        batchNumber: ' B1 ',
        printedExpiry: expiry,
        expiryPrecision: 'MONTH',
      })
    ).toEqual({ ok: true, batchNumber: 'B1', printedExpiry: expiry, expiryPrecision: 'MONTH' });
  });

  it('lets a non-drug line arrive without a batch, with an optional expiry', () => {
    expect(
      resolveReceiptBatchIdentity({ productFamily: 'FRONT_SHOP', expiryPrecision: 'MONTH' })
    ).toEqual({
      ok: true,
      batchNumber: 'RETAIL-NOEXP',
      printedExpiry: NON_DRUG_NO_EXPIRY,
      expiryPrecision: 'DAY',
    });
    const expiry = new Date('2027-06-30T00:00:00Z');
    expect(
      resolveReceiptBatchIdentity({
        productFamily: 'FRONT_SHOP',
        printedExpiry: expiry,
        expiryPrecision: 'MONTH',
      })
    ).toEqual({
      ok: true,
      batchNumber: 'RETAIL-2027-06-30-M',
      printedExpiry: expiry,
      expiryPrecision: 'MONTH',
    });
    expect(
      resolveReceiptBatchIdentity({
        productFamily: 'FRONT_SHOP',
        batchNumber: 'LOT9',
        expiryPrecision: 'DAY',
      })
    ).toMatchObject({ ok: true, batchNumber: 'LOT9' });
    // The no-expiry sentinel stays a four-digit-year ISO instant.
    expect(NON_DRUG_NO_EXPIRY.toISOString()).toBe('9998-12-31T00:00:00.000Z');
  });

  it('prices a non-drug lot at the shop retail price; a medicine needs its printed MRP', () => {
    expect(resolveReceiptRetailPrice({ productFamily: 'FRONT_SHOP', retailPriceMinor: 500 })).toBe(
      500
    );
    expect(
      resolveReceiptRetailPrice({
        productFamily: 'FRONT_SHOP',
        printedMrpMinor: 650,
        retailPriceMinor: 500,
      })
    ).toBe(650);
    expect(resolveReceiptRetailPrice({ productFamily: 'FRONT_SHOP' })).toBeNull();
    expect(
      resolveReceiptRetailPrice({ productFamily: 'PHARMACEUTICAL', retailPriceMinor: 500 })
    ).toBeNull();
    expect(
      resolveReceiptRetailPrice({ productFamily: 'PHARMACEUTICAL', printedMrpMinor: 900 })
    ).toBe(900);
  });

  it('refuses to promote any medicine, flagged or unknown item', () => {
    const retail = {
      id: 'shampoo',
      productFamily: 'FRONT_SHOP',
      rx: false,
      restricted: false,
      controlled: false,
    };
    expect(() => assertPromotableProducts(['shampoo'], [retail])).not.toThrow();
    expect(
      reasonOf(() =>
        assertPromotableProducts(
          ['shampoo', 'panadol'],
          [retail, { ...retail, id: 'panadol', productFamily: 'PHARMACEUTICAL' }]
        )
      )
    ).toBe('MEDICINE_NOT_PROMOTABLE');
    for (const flag of ['rx', 'restricted', 'controlled'] as const)
      expect(
        reasonOf(() => assertPromotableProducts(['x'], [{ ...retail, id: 'x', [flag]: true }]))
      ).toBe('MEDICINE_NOT_PROMOTABLE');
    expect(reasonOf(() => assertPromotableProducts(['foreign'], [retail]))).toBe(
      'PROMOTED_ITEM_NOT_FOUND'
    );
  });
});
