import { describe, expect, it } from 'vitest';
import {
  assertPromotableProducts,
  isValidEan13,
  NON_DRUG_NO_EXPIRY,
  PharmacyProductClassError,
  productClassForFamily,
  resolveReceiptBatchIdentity,
  resolveReceiptRetailPrice,
  validateRetailFields,
} from './product-class';

describe('pharmacy product class (#718)', () => {
  it('derives NON_DRUG_RETAIL only from FRONT_SHOP and fails closed to MEDICINE', () => {
    expect(productClassForFamily('FRONT_SHOP')).toBe('NON_DRUG_RETAIL');
    for (const family of ['PHARMACEUTICAL', 'BIOLOGICAL', 'DEVICE', 'ALTERNATIVE', '', null])
      expect(productClassForFamily(family)).toBe('MEDICINE');
  });

  it('validates EAN-13 check digits', () => {
    expect(isValidEan13('4006381333931')).toBe(true);
    expect(isValidEan13('4006381333932')).toBe(false);
    expect(isValidEan13('400638133393')).toBe(false);
  });

  it('accepts retail fields only on non-drug items', () => {
    expect(
      validateRetailFields({
        productFamily: 'FRONT_SHOP',
        retailPriceMinor: 45000,
        retailCategory: '  Baby   care ',
        ean13: '4006381333931',
      })
    ).toEqual({ retailPriceMinor: 45000, retailCategory: 'Baby care', ean13: '4006381333931' });
    expect(() =>
      validateRetailFields({ productFamily: 'PHARMACEUTICAL', retailPriceMinor: 100 })
    ).toThrow(PharmacyProductClassError);
    expect(() =>
      validateRetailFields({ productFamily: 'FRONT_SHOP', ean13: '4006381333932' })
    ).toThrow('INVALID_EAN13');
    expect(() =>
      validateRetailFields({ productFamily: 'FRONT_SHOP', retailPriceMinor: 0 })
    ).toThrow('INVALID_RETAIL_PRICE');
  });

  it('lets a non-drug receipt line arrive without batch or expiry', () => {
    expect(
      resolveReceiptBatchIdentity({ productFamily: 'FRONT_SHOP', expiryPrecision: 'MONTH' })
    ).toEqual({
      ok: true,
      batchNumber: 'RETAIL-NOEXP',
      printedExpiry: NON_DRUG_NO_EXPIRY,
      expiryPrecision: 'DAY',
    });
    const expiry = new Date('2027-06-01T00:00:00.000Z');
    expect(
      resolveReceiptBatchIdentity({
        productFamily: 'FRONT_SHOP',
        printedExpiry: expiry,
        expiryPrecision: 'MONTH',
      })
    ).toEqual({
      ok: true,
      batchNumber: 'RETAIL-2027-06-01-M',
      printedExpiry: expiry,
      expiryPrecision: 'MONTH',
    });
  });

  it('keeps batch and expiry mandatory for medicines', () => {
    expect(
      resolveReceiptBatchIdentity({
        productFamily: 'PHARMACEUTICAL',
        printedExpiry: new Date('2027-06-01'),
        expiryPrecision: 'DAY',
      })
    ).toEqual({ ok: false, reason: 'MISSING_BATCH' });
    expect(
      resolveReceiptBatchIdentity({
        productFamily: 'DEVICE',
        batchNumber: 'B1',
        expiryPrecision: 'DAY',
      })
    ).toEqual({ ok: false, reason: 'MISSING_EXPIRY' });
  });

  it('prices a non-drug lot at the shop retail price but never a medicine lot', () => {
    expect(resolveReceiptRetailPrice({ productFamily: 'FRONT_SHOP', retailPriceMinor: 900 })).toBe(
      900
    );
    expect(
      resolveReceiptRetailPrice({ productFamily: 'PHARMACEUTICAL', retailPriceMinor: 900 })
    ).toBeNull();
    expect(
      resolveReceiptRetailPrice({ productFamily: 'PHARMACEUTICAL', printedMrpMinor: 1200 })
    ).toBe(1200);
  });

  it('refuses promotion of any medicine SKU', () => {
    const base = { rx: false, restricted: false, controlled: false };
    const products = [
      { id: 'soap', productFamily: 'FRONT_SHOP', ...base },
      { id: 'syrup', productFamily: 'PHARMACEUTICAL', ...base },
    ];
    expect(() => assertPromotableProducts(['soap'], products)).not.toThrow();
    expect(() => assertPromotableProducts(['soap', 'syrup'], products)).toThrow(
      'MEDICINE_NOT_PROMOTABLE'
    );
    expect(() => assertPromotableProducts(['ghost'], products)).toThrow('PROMOTED_ITEM_NOT_FOUND');
  });
});
