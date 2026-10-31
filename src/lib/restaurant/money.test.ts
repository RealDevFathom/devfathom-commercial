import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

import {
  ZERO,
  add,
  allocate,
  compare,
  equals,
  formatMoney,
  isNegative,
  isZero,
  money,
  multiply,
  roundMoney,
  sub,
  sum,
} from './money';

// All money assertions are EXACT string equality — never toBeCloseTo (C2).
const cents = (decimals: Prisma.Decimal[]) => decimals.map((decimal) => decimal.toFixed(2));

describe('money constructor', () => {
  it('accepts Decimal, string, and integer inputs', () => {
    expect(money('10.00').toFixed(2)).toBe('10.00');
    expect(money(10).toFixed(2)).toBe('10.00');
    expect(money(new Prisma.Decimal('10')).toFixed(2)).toBe('10.00');
  });

  it('rejects non-finite values instead of silently propagating them', () => {
    expect(() => money(Number.NaN)).toThrow(RangeError);
    expect(() => money(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('add / sub / sum are exact', () => {
  it('adds and subtracts 2dp values exactly (no float drift)', () => {
    expect(add('0.10', '0.20').toFixed(2)).toBe('0.30');
    expect(sub('0.30', '0.10').toFixed(2)).toBe('0.20');
  });

  it('sums a list from zero', () => {
    expect(sum([]).toFixed(2)).toBe('0.00');
    expect(sum(['0.01', '0.02', '0.03']).toFixed(2)).toBe('0.06');
    expect(sum(['19.99', '0.01']).toFixed(2)).toBe('20.00');
  });

  it('exposes an exact zero', () => {
    expect(ZERO.toFixed(2)).toBe('0.00');
  });
});

describe('multiply', () => {
  it('money × integer quantity is exact at 2dp', () => {
    expect(multiply('3.33', 3).toFixed(2)).toBe('9.99');
    expect(multiply('12.50', 4).toFixed(2)).toBe('50.00');
  });
});

describe('roundMoney is ROUND_HALF_UP at 2dp', () => {
  it('rounds the classic float traps correctly', () => {
    expect(roundMoney('2.675').toFixed(2)).toBe('2.68');
    expect(roundMoney('100.005').toFixed(2)).toBe('100.01');
    expect(roundMoney('100.004').toFixed(2)).toBe('100.00');
  });

  it('rounds halves away from zero (HALF_UP), symmetric for negatives', () => {
    expect(roundMoney('0.005').toFixed(2)).toBe('0.01');
    expect(roundMoney('-0.005').toFixed(2)).toBe('-0.01');
  });
});

describe('formatMoney always renders 2dp', () => {
  it('pads whole and single-decimal amounts, including negatives and zero', () => {
    expect(formatMoney(new Prisma.Decimal('28'))).toBe('28.00');
    expect(formatMoney('-0.5')).toBe('-0.50');
    expect(formatMoney(ZERO)).toBe('0.00');
    expect(formatMoney('14.25')).toBe('14.25');
  });
});

describe('compare / equals / predicates use exact comparison', () => {
  it('compares numeric value, not string form', () => {
    expect(equals('0.10', '0.1')).toBe(true);
    expect(compare('0.10', '0.1')).toBe(0);
    expect(compare('1.00', '2.00')).toBe(-1);
    expect(compare('2.00', '1.00')).toBe(1);
  });

  it('classifies zero and negative', () => {
    expect(isZero('0.00')).toBe(true);
    expect(isZero('0.01')).toBe(false);
    expect(isNegative('-0.01')).toBe(true);
    expect(isNegative('0.00')).toBe(false);
  });
});

describe('allocate — largest-remainder, pinned tie-break (C4)', () => {
  it('100.00 ÷ 3 gives the first split the odd cent', () => {
    const shares = allocate('100.00', [1, 1, 1]);
    expect(cents(shares)).toEqual(['33.34', '33.33', '33.33']);
    expect(sum(shares).toFixed(2)).toBe('100.00');
  });

  it('0.01 ÷ 3 hands the single cent to split 0, zero to the rest', () => {
    const shares = allocate('0.01', [1, 1, 1]);
    expect(cents(shares)).toEqual(['0.01', '0.00', '0.00']);
    expect(sum(shares).toFixed(2)).toBe('0.01');
  });

  it('10.00 ÷ 7 (odd cents) — the last split absorbs the shortfall, Σ ≡ total', () => {
    const shares = allocate('10.00', [1, 1, 1, 1, 1, 1, 1]);
    expect(cents(shares)).toEqual(['1.43', '1.43', '1.43', '1.43', '1.43', '1.43', '1.42']);
    expect(sum(shares).toFixed(2)).toBe('10.00');
  });

  it('weighted ½/¼/¼ split of an odd total sums exactly', () => {
    const shares = allocate('10.01', [2, 1, 1]);
    expect(sum(shares).toFixed(2)).toBe('10.01');
    // ideal: 5.005, 2.5025, 2.5025 -> base 5.00/2.50/2.50 = 10.00; 1 leftover cent
    // remainders: 2 (·mod 4=2), 1, 1 -> split 0 (largest) takes it.
    expect(cents(shares)).toEqual(['5.01', '2.50', '2.50']);
  });

  it('is deterministic — identical input yields byte-identical shares', () => {
    const a = cents(allocate('100.00', [1, 1, 1]));
    const b = cents(allocate('100.00', [1, 1, 1]));
    expect(a).toEqual(b);
  });

  it('every adversarial remainder sums back to the total exactly', () => {
    const totals = ['0.01', '0.02', '0.05', '0.07', '1.00', '9.99', '100.00', '100.01'];
    const partitions = [2, 3, 4, 5, 6, 7];
    for (const total of totals) {
      for (const parts of partitions) {
        const shares = allocate(total, new Array(parts).fill(1));
        expect(sum(shares).toFixed(2)).toBe(money(total).toFixed(2));
        // no share is negative and each carries at most 2dp
        for (const share of shares) {
          expect(share.isNegative()).toBe(false);
          expect(share.decimalPlaces()).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('a single-share allocation returns the whole total', () => {
    expect(allocate('12.34', [1])[0]!.toFixed(2)).toBe('12.34');
  });

  it('a zero-weight share receives nothing; the rest still sum to total', () => {
    const shares = allocate('9.00', [0, 1, 1, 1]);
    expect(shares[0]!.toFixed(2)).toBe('0.00');
    expect(sum(shares).toFixed(2)).toBe('9.00');
  });

  it.each([[0], [0, 0]])('allocates zero across zero weights %j', (...weights) => {
    expect(allocate('0.00', weights).map(formatMoney)).toEqual(weights.map(() => '0.00'));
  });

  it('rejects empty, negative, non-integer, and all-zero weights', () => {
    expect(() => allocate('1.00', [])).toThrow(RangeError);
    expect(() => allocate('1.00', [-1, 2])).toThrow(RangeError);
    expect(() => allocate('1.00', [1.5, 1])).toThrow(RangeError);
    expect(() => allocate('1.00', [0, 0])).toThrow(RangeError);
  });
});
