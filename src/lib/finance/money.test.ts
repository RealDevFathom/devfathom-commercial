import { describe, expect, it } from 'vitest';
import { multiplyMoney, roundMoney, sumMoney } from './money';

describe('money arithmetic', () => {
  it('rounds exact half-cents up', () => {
    expect(roundMoney(1.005)).toBe(1.01);
    expect(multiplyMoney(1, 1.005)).toBe(1.01);
  });

  it('keeps ordinary cent rounding and decimal addition behavior', () => {
    expect(multiplyMoney(2.5, 4.2)).toBe(10.5);
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
  });

  it('handles fractional quantities and the maximum supported money value', () => {
    expect(multiplyMoney(0.1, 0.2)).toBe(0.02);
    expect(multiplyMoney(1, 9_999_999_999.99)).toBe(9_999_999_999.99);
  });
});
