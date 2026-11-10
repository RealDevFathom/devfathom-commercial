import { describe, expect, it } from 'vitest';
import {
  assertSaleable,
  canonicalUnits,
  deriveLooseUnitPrice,
  medicineDuplicateKey,
  normalizeMedicineText,
  parseDefaultPackSize,
  parseSimpleMedicineStrength,
} from './medicine';

describe('pharmacy medicine invariants', () => {
  it('structures only lossless scalar strengths', () => {
    expect(parseSimpleMedicineStrength('500 mg')).toEqual({ value: 500, unit: 'mg' });
    expect(parseSimpleMedicineStrength('2.5%')).toEqual({ value: 2.5, unit: '%' });
    expect(parseSimpleMedicineStrength('500 mg / 5 mL')).toBeNull();
    expect(parseSimpleMedicineStrength('500 mg + 125 mg')).toBeNull();
  });

  it.each([
    ['10 tablets', 'BOX', 10],
    ["10's", 'BOX', 10],
    ['Strip of 10', 'STRIP', 10],
    ['Tablet, 10 per strip', 'STRIP', 10],
    ['3 x 10', 'BOX', 30],
    ['2x10 capsules', 'BOX', 20],
    ['Carton 1 x 10 x 10', 'CARTON', 100],
    ['10 x 5ml ampoules', 'BOX', 10],
    ['100 ml bottle', 'UNIT', 1],
    ['100 g tube', 'UNIT', 1],
    ['2 x 100 g tubes', 'BOX', 2],
    ['60ml', 'UNIT', 1],
    ['1 tablet', 'UNIT', 1],
    ['Blister 10 x 10', 'BOX', 100],
    ['Strip 1 x 10', 'STRIP', 10],
  ])('structures the default pack for %s', (pack, level, unitsPerParent) => {
    expect(parseDefaultPackSize(pack)).toEqual({ level, unitsPerParent });
  });

  it.each([
    '',
    'Bottle',
    'Box of 3 strips of 10',
    '10 strips',
    'Box of 10 strips',
    '10 blisters',
    'Carton of 12 boxes',
    '2 x 10 strips',
    '2×10 blisters',
    '2 * 10 boxes',
    '2 x 10 cartons',
    '2 x 10 packs',
    '2 x 10 packets',
    '1 x 10 strip',
    '1 x 10 x 10 carton',
    '100 grams tube',
    '100 gram tube',
    '100 millilitres bottle',
    '100 milliliters bottle',
    '100 ounces tube',
    '100 cc bottle',
    '2 x 100 grams tubes',
    '10 x 5 millilitres ampoules',
    '0 tablets',
    '2.5 tablets',
    '99999999999 tablets',
  ])('refuses to guess a default pack for %j', (pack) => {
    expect(parseDefaultPackSize(pack)).toBeNull();
  });

  it('converts two cartons of 20 x 5 x 10 into 2,000 canonical units', () => {
    expect(canonicalUnits(2, [20, 5, 10])).toBe(2_000);
  });

  it.each([
    [1.5, [10]],
    [1, [0]],
    [1, [2.5]],
    [Number.MAX_SAFE_INTEGER, [2]],
  ])('rejects non-integer, non-positive, or overflowing conversions', (quantity, factors) =>
    expect(() => canonicalUnits(quantity, factors)).toThrow('INVALID_CONVERSION')
  );

  it('rounds down by the approved increment and never exceeds pro-rata', () => {
    expect(
      deriveLooseUnitPrice({
        printedMrpMinor: 1_000,
        canonicalUnitsInPack: 3,
        roundingIncrementMinor: 5,
      })
    ).toEqual({ unitPriceMinor: 330, proRataCeilingMinor: 333 });
  });

  it('rejects invalid price inputs', () => {
    expect(() =>
      deriveLooseUnitPrice({
        printedMrpMinor: 100,
        canonicalUnitsInPack: 0,
        roundingIncrementMinor: 1,
      })
    ).toThrow('INVALID_PRICE');
  });

  it('blocks a name-only regulated medicine from becoming saleable', () => {
    expect(() =>
      assertSaleable({
        productFamily: 'PHARMACEUTICAL',
        hasPresentation: false,
        hasStrength: false,
        hasRegistration: false,
        provenanceFields: new Set(),
      })
    ).toThrow('NOT_SALEABLE');
  });

  it('does not force front-shop items to invent strength or registration', () => {
    expect(() =>
      assertSaleable({
        productFamily: 'FRONT_SHOP',
        hasPresentation: true,
        hasStrength: false,
        hasRegistration: false,
        provenanceFields: new Set(),
      })
    ).not.toThrow();
  });

  it('normalizes scan codes and preserves Urdu letters in aliases', () => {
    expect(normalizeMedicineText(' 01-234 567 ')).toBe('01234567');
    expect(normalizeMedicineText('پیرا سیٹامول')).toBe('پیراسیٹامول');
  });

  it('groups exact normalized name, strength, and form without fuzzy merging', () => {
    const exact = medicineDuplicateKey({
      productName: 'Panadol',
      strengths: [{ value: 500, unit: 'mg' }],
      dosageForm: 'Tablet',
    });
    expect(
      medicineDuplicateKey({
        productName: ' PANADOL ',
        strengths: [{ value: '500', unit: 'MG' }],
        dosageForm: 'tablet',
      })
    ).toBe(exact);
    expect(
      medicineDuplicateKey({
        productName: 'Panadole',
        strengths: [{ value: 500, unit: 'mg' }],
        dosageForm: 'Tablet',
      })
    ).not.toBe(exact);
  });
});
