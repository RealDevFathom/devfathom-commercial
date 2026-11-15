import { describe, expect, it } from 'vitest';

import {
  assertVoucherEligibleLine,
  DEFAULT_VOUCHER_ELIGIBLE_CATEGORIES,
  VOUCHER_MESSAGE_FOOTER,
  voucherCategoryFor,
  voucherEligibleCategories,
  VoucherScopeError,
  withVoucherFooter,
} from './voucher-scope';

const base = { rx: false, otc: false, restricted: false, controlled: false };
const rx = { ...base, rx: true, productFamily: 'PHARMACEUTICAL' };
const otcDrug = { ...base, otc: true, productFamily: 'PHARMACEUTICAL' };
const supplement = { ...base, productFamily: 'ALTERNATIVE' };
const device = { ...base, productFamily: 'DEVICE' };
const frontShop = { ...base, productFamily: 'FRONT_SHOP' };

describe('DEV-27 voucher category scoping', () => {
  it('classifies every product family into one voucher category', () => {
    expect(voucherCategoryFor(rx)).toBe('RX');
    expect(voucherCategoryFor({ ...frontShop, controlled: true })).toBe('RX');
    expect(voucherCategoryFor({ ...frontShop, restricted: true })).toBe('RX');
    expect(voucherCategoryFor(otcDrug)).toBe('OTC_DRUG');
    expect(voucherCategoryFor({ ...base, productFamily: 'BIOLOGICAL' })).toBe('OTC_DRUG');
    expect(voucherCategoryFor({ ...frontShop, otc: true })).toBe('OTC_DRUG');
    expect(voucherCategoryFor(supplement)).toBe('SUPPLEMENT');
    expect(voucherCategoryFor(device)).toBe('MEDICAL_DEVICE');
    expect(voucherCategoryFor(frontShop)).toBe('NON_DRUG');
  });

  it('defaults the allowlist to non-drug categories', () => {
    expect(DEFAULT_VOUCHER_ELIGIBLE_CATEGORIES).toEqual(['NON_DRUG']);
    expect(voucherEligibleCategories()).toEqual(['NON_DRUG']);
    expect(voucherEligibleCategories([])).toEqual(['NON_DRUG']);
  });

  it('never lets a drug category be allowlisted', () => {
    for (const category of ['RX', 'OTC_DRUG', 'SUPPLEMENT', 'MEDICAL_DEVICE']) {
      expect(() => voucherEligibleCategories(['NON_DRUG', category])).toThrow(
        new VoucherScopeError('VOUCHER_ALLOWLIST_INVALID')
      );
    }
  });

  it('refuses a voucher on Rx, OTC drug, supplement and medical-device lines', () => {
    for (const product of [rx, otcDrug, supplement, device]) {
      expect(() => assertVoucherEligibleLine(product)).toThrow(VoucherScopeError);
      expect(() => assertVoucherEligibleLine(product)).toThrow('VOUCHER_CATEGORY_REFUSED');
      expect(() => assertVoucherEligibleLine(product, ['NON_DRUG'])).toThrow(
        'VOUCHER_CATEGORY_REFUSED'
      );
    }
    expect(() => assertVoucherEligibleLine(frontShop)).not.toThrow();
  });

  it('adds the required footer to voucher messages exactly once', () => {
    expect(VOUCHER_MESSAGE_FOOTER).toBe('Medicines excluded / Adviyaat shamil nahin');
    const text = withVoucherFooter('10% off gift sets this week. Reply STOP to opt out.');
    expect(text.endsWith(`\n${VOUCHER_MESSAGE_FOOTER}`)).toBe(true);
    expect(withVoucherFooter(text)).toBe(text);
  });
});
