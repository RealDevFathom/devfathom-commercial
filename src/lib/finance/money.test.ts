import { describe, expect, it } from 'vitest';
import { multiplyMoney, roundMoney } from './money';

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
