import { describe, expect, it } from 'vitest';
import {
  assertSaleable,
  canonicalUnits,
  deriveLooseUnitPrice,
  medicineDuplicateKey,
  normalizeMedicineText,
  parseSimpleMedicineStrength,
} from './medicine';

describe('pharmacy medicine invariants', () => {
  it('structures only lossless scalar strengths', () => {
    expect(parseSimpleMedicineStrength('500 mg')).toEqual({ value: 500, unit: 'mg' });
    expect(parseSimpleMedicineStrength('2.5%')).toEqual({ value: 2.5, unit: '%' });
    expect(parseSimpleMedicineStrength('500 mg / 5 mL')).toBeNull();
    expect(parseSimpleMedicineStrength('500 mg + 125 mg')).toBeNull();
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

  it('holds a NARCOTICS catalogue candidate until a controlled decision is published', () => {
    const complete = {
      productFamily: 'PHARMACEUTICAL' as const,
      hasPresentation: true,
      hasStrength: true,
      hasRegistration: true,
      provenanceFields: new Set(['drapRegistrationNumber']),
      controlledCandidate: true,
    };
    expect(() => assertSaleable(complete)).toThrow('NOT_SALEABLE');
    // Even a front-shop item cannot sidestep the review.
    expect(() =>
      assertSaleable({ ...complete, productFamily: 'FRONT_SHOP', provenanceFields: new Set() })
    ).toThrow('NOT_SALEABLE');
    expect(() =>
      assertSaleable({
        ...complete,
        provenanceFields: new Set(['drapRegistrationNumber', 'controlled']),
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
