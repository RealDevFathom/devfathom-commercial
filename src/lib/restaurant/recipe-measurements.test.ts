import { describe, expect, it } from 'vitest';

import { parseRecipeMeasurement, RECIPE_MEASUREMENT_SPECS } from './recipe-measurements';

describe('shared recipe measurement validation', () => {
  it.each([
    ['conversionFactor', '999999999999.999999', '1000000000000', '0.0000001'],
    ['yieldQuantity', '999999999.999', '1000000000', '0.0001'],
    ['lineQuantity', '99999999.9999', '100000000', '0.00001'],
    ['referenceCost', '99999999.9999', '100000000', '0.00001'],
  ] as const)(
    'enforces the storage precision and scale for %s',
    (key, max, overflow, underflow) => {
      const spec = RECIPE_MEASUREMENT_SPECS[key];
      expect(parseRecipeMeasurement(max, spec).toString()).toBe(max);
      expect(() => parseRecipeMeasurement(overflow, spec)).toThrow();
      expect(() => parseRecipeMeasurement(underflow, spec)).toThrow();
      expect(() => parseRecipeMeasurement('-1', spec)).toThrow();
    }
  );

  it.each(['conversionFactor', 'yieldQuantity', 'lineQuantity'] as const)(
    'rejects zero for %s',
    (key) => {
      expect(() => parseRecipeMeasurement('0', RECIPE_MEASUREMENT_SPECS[key])).toThrow();
    }
  );

  it('allows zero reference cost', () => {
    expect(parseRecipeMeasurement('0', RECIPE_MEASUREMENT_SPECS.referenceCost).toString()).toBe(
      '0'
    );
  });

  it.each(['', 'NaN', 'Infinity', '1e1', ' 1', '1'.repeat(257)])(
    'rejects invalid decimal input %s',
    (value) => {
      expect(() =>
        parseRecipeMeasurement(value, RECIPE_MEASUREMENT_SPECS.conversionFactor)
      ).toThrow('Unit conversion factor must be a valid decimal.');
    }
  );

  it('preserves leading zeroes and insignificant trailing fractional zeroes', () => {
    expect(
      parseRecipeMeasurement(
        `${'0'.repeat(250)}1.000`,
        RECIPE_MEASUREMENT_SPECS.yieldQuantity
      ).toString()
    ).toBe('1');
  });
});
