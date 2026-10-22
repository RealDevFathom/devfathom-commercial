import { describe, expect, it } from 'vitest';

import { multiplyMoney, roundMoney } from './money-rounding';

describe('agency money rounding', () => {
  it('rounds decimal half-cents up instead of following binary float drift', () => {
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(2.675)).toBe(2.68);
    expect(roundMoney(1.004)).toBe(1);
  });

  it('multiplies invoice quantity and rate before applying HALF_UP', () => {
    expect(multiplyMoney(1, 1.005)).toBe(1.01);
    expect(multiplyMoney(3, 0.335)).toBe(1.01);
    expect(multiplyMoney(0.1, 0.2)).toBe(0.02);
  });

  it('rounds negative halves away from zero', () => {
    expect(roundMoney(-1.005)).toBe(-1.01);
  });
});
