import { describe, expect, it } from 'vitest';
import { assertSaleable, canonicalUnits, deriveLooseUnitPrice } from './medicine';

describe('pharmacy medicine invariants', () => {
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
});
