import { describe, expect, it } from 'vitest';
import {
  assertSaleable,
  canonicalUnits,
  deriveLooseUnitPrice,
  medicineDuplicateKey,
  normalizeMedicineText,
  parseSimpleMedicineStrength,
  priceFromLot,
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

describe('#607 sale-unit MRP contract', () => {
  it.each([
    {
      printedMrpMinor: 1_003,
      canonicalUnitsInPack: 20,
      canonicalUnitsPerSaleUnit: 10,
      roundingIncrementMinor: 5,
      expectedPrice: 500,
      expectedCeiling: 501,
    },
    {
      printedMrpMinor: 1_003,
      canonicalUnitsInPack: 20,
      canonicalUnitsPerSaleUnit: 20,
      roundingIncrementMinor: 5,
      expectedPrice: 1_003,
      expectedCeiling: 1_003,
    },
    {
      printedMrpMinor: 1_003,
      canonicalUnitsInPack: 20,
      canonicalUnitsPerSaleUnit: 1,
      roundingIncrementMinor: 1,
      expectedPrice: 50,
      expectedCeiling: 50,
    },
    {
      printedMrpMinor: Number.MAX_SAFE_INTEGER,
      canonicalUnitsInPack: 3,
      canonicalUnitsPerSaleUnit: 2,
      roundingIncrementMinor: 1,
      expectedPrice: 6_004_799_503_160_660,
      expectedCeiling: 6_004_799_503_160_660,
    },
  ])(
    'preserves sale-unit pricing for remainder and large-integer cases: %j',
    ({ expectedPrice, expectedCeiling, ...input }) => {
      const price = priceFromLot(input);
      expect(price).toEqual({
        unitPriceMinor: expectedPrice,
        proRataCeilingMinor: expectedCeiling,
      });
      expect(BigInt(price.unitPriceMinor) * BigInt(input.canonicalUnitsInPack)).toBeLessThanOrEqual(
        BigInt(input.printedMrpMinor) * BigInt(input.canonicalUnitsPerSaleUnit)
      );
    }
  );

  it.each([
    // Aggregating canonical units across source packs is valid (#68 P2).
    { canonicalUnitsPerSaleUnit: 40, roundingIncrementMinor: 5, expected: 2_006, ceiling: 2_006 },
    { canonicalUnitsPerSaleUnit: 21, roundingIncrementMinor: 5, expected: 1_050, ceiling: 1_053 },
    { canonicalUnitsPerSaleUnit: 30, roundingIncrementMinor: 1, expected: 1_504, ceiling: 1_504 },
  ])(
    'prices a sale unit larger than one source pack: %j',
    ({ expected, ceiling, ...input }) => {
      const price = priceFromLot({ printedMrpMinor: 1_003, canonicalUnitsInPack: 20, ...input });
      expect(price).toEqual({ unitPriceMinor: expected, proRataCeilingMinor: ceiling });
    }
  );

  it('rejects a sale-unit price beyond the safe integer range', () => {
    expect(() =>
      priceFromLot({
        printedMrpMinor: Number.MAX_SAFE_INTEGER,
        canonicalUnitsInPack: 1,
        canonicalUnitsPerSaleUnit: 2,
      })
    ).toThrow('INVALID_PRICE');
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid sale-unit conversion %s',
    (canonicalUnitsPerSaleUnit) => {
      expect(() =>
        priceFromLot({
          printedMrpMinor: 1_003,
          canonicalUnitsInPack: 20,
          canonicalUnitsPerSaleUnit,
        })
      ).toThrow('INVALID_PRICE');
    }
  );
});
