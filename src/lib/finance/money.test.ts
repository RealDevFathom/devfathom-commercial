import { describe, expect, it } from 'vitest';
import { isPersistableMoney, multiplyMoney, roundMoney, sumMoney } from './money';

describe('money arithmetic', () => {
  it('rounds exact half-cents up', () => {
    expect(roundMoney(1.005)).toBe(1.01);
    expect(multiplyMoney(1, 1.005)).toBe(1.01);
    expect(multiplyMoney(3, 0.335)).toBe(1.01);
  });

  it('keeps ordinary cent rounding and decimal addition behavior', () => {
    expect(multiplyMoney(2.5, 4.2)).toBe(10.5);
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
  });

  it('handles fractional quantities and the maximum supported money value', () => {
    expect(multiplyMoney(0.1, 0.2)).toBe(0.02);
    expect(multiplyMoney(1, 9_999_999_999.99)).toBe(9_999_999_999.99);
  });

  it('identifies values outside the database money range', () => {
    expect(isPersistableMoney(0)).toBe(true);
    expect(isPersistableMoney(9_999_999_999.99)).toBe(true);
    expect(isPersistableMoney(-0.01)).toBe(false);
    expect(isPersistableMoney(10_000_000_000)).toBe(false);
    expect(isPersistableMoney(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('invoice money rounding', () => {
  it.each([
    [1.005, 1.01],
    [2.675, 2.68],
    [1.004, 1],
    [0.0001, 0],
  ])('rounds %s to %s with decimal half-up semantics', (value, expected) => {
    expect(roundMoney(value)).toBe(expected);
  });

  it('multiplies line quantity and rate as decimals before rounding', () => {
    expect(multiplyMoney(1, 1.005)).toBe(1.01);
    expect(multiplyMoney(3, 0.335)).toBe(1.01);
  });

  it('supports numeric values represented with exponents', () => {
    expect(multiplyMoney(1e3, 1.005e-3)).toBe(1.01);
  });
});
