import { describe, expect, it } from 'vitest';
import { earnedPoints, LOYALTY_RATE_OPTIONS } from './loyalty-rate';
import { redemptionFor } from '@/lib/commerce/loyalty-arithmetic';

describe('DEV-746 exact, independent earning rules', () => {
  it('offers multiple owner choices without changing redemption', () => {
    expect(LOYALTY_RATE_OPTIONS).toHaveLength(3);
    expect(earnedPoints(100_000, LOYALTY_RATE_OPTIONS[0])).toBe(10);
    expect(earnedPoints(100_000, LOYALTY_RATE_OPTIONS[1])).toBe(20);
    expect(earnedPoints(100_000, LOYALTY_RATE_OPTIONS[2])).toBe(1);
    expect(
      redemptionFor({ requestedPoints: 10, availablePoints: 10, outstandingMinor: 100_000 })
    ).toEqual({ points: 10, amountMinor: 1_000 });
  });
  it('distinguishes full spend steps from proportional earning', () => {
    expect(earnedPoints(199_999, { mode: 'STEP', rewardPoints: 5, spendMinor: 100_000 })).toBe(5);
    expect(earnedPoints(199_999, { mode: 'PERCENT', rewardPoints: 5, spendMinor: 100_000 })).toBe(
      9
    );
  });
  it('does not round floating-point products near the safe-integer boundary', () => {
    const spend = Number.MAX_SAFE_INTEGER;
    const rate = { mode: 'PERCENT', rewardPoints: 999_983, spendMinor: 9_007_199_254_740 };
    expect(earnedPoints(spend, rate)).toBe(
      Number((BigInt(spend) * BigInt(999_983)) / BigInt(9_007_199_254_740))
    );
  });
  it.each([-1, NaN, Infinity, 1.5])('rejects invalid money %s', (amount) => {
    expect(() => earnedPoints(amount, LOYALTY_RATE_OPTIONS[0])).toThrow();
  });
  it('rejects an absent, zero, or excessive earning rate', () => {
    for (const rate of [
      { mode: 'PERCENT', rewardPoints: 0, spendMinor: 100 },
      { mode: 'PERCENT', rewardPoints: 2, spendMinor: 100 },
      { mode: 'unknown', rewardPoints: 1, spendMinor: 100 },
    ])
      expect(() => earnedPoints(100, rate)).toThrow('INVALID_LOYALTY_RATE');
  });
});
