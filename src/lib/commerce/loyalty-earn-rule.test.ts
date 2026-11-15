import { describe, expect, it } from 'vitest';

import {
  assertLoyaltyEarnRule,
  describeLoyaltyEarnRule,
  earnedPointsFor,
  earnedPointsForTranche,
  redemptionFor,
} from './loyalty-arithmetic';

const percent = (basisPoints: number) => ({
  earnMode: 'PERCENT_OF_SPEND',
  earnPoints: basisPoints,
  perSpendMinor: 1_000_000,
});
const step = (points: number, rupees: number) => ({
  earnMode: 'POINTS_PER_SPEND_STEP',
  earnPoints: points,
  perSpendMinor: rupees * 100,
});

describe('DEV-746 owner-set earning rule', () => {
  it('earns a percentage of spend in whole points, never rounding up', () => {
    expect(earnedPointsFor(100_000, percent(100))).toBe(10); // 1% of PKR 1,000
    expect(earnedPointsFor(99_999, percent(100))).toBe(9);
    expect(earnedPointsFor(250_000, percent(150))).toBe(37); // 1.5% of PKR 2,500 = 37.5
    expect(earnedPointsFor(0, percent(500))).toBe(0);
  });

  it('earns per complete spend step', () => {
    expect(earnedPointsFor(99_999, step(1, 1_000))).toBe(0);
    expect(earnedPointsFor(250_000, step(1, 1_000))).toBe(2);
    expect(earnedPointsFor(250_000, step(3, 1_000))).toBe(6);
  });

  it('stays exact for large spends', () => {
    expect(earnedPointsFor(2_000_000_000, percent(3_333))).toBe(6_666_000);
    expect(earnedPointsFor(Number.MAX_SAFE_INTEGER, step(1, 20_000_000))).toBe(4_503_599);
  });

  it('prices an instalment on top of what was already collected', () => {
    const rule = step(1, 1_000);
    expect(earnedPointsForTranche(0, 60_000, rule)).toBe(0);
    expect(earnedPointsForTranche(60_000, 60_000, rule)).toBe(1);
    expect(earnedPointsForTranche(120_000, 130_000, rule)).toBe(1);
  });

  it('refuses a rule that pays back more than was spent, or none at all', () => {
    expect(() => assertLoyaltyEarnRule(percent(10_000))).not.toThrow(); // 100%
    expect(() => assertLoyaltyEarnRule(percent(10_001))).toThrow('INVALID_EARN_RULE');
    expect(() => assertLoyaltyEarnRule(step(2, 1))).toThrow('INVALID_EARN_RULE');
    expect(() => assertLoyaltyEarnRule(percent(0))).toThrow('INVALID_EARN_RULE');
    expect(() => assertLoyaltyEarnRule({ ...percent(100), earnMode: 'BONUS' })).toThrow(
      'INVALID_EARN_RULE'
    );
    expect(() => earnedPointsFor(-1, percent(100))).toThrow('INVALID_MONEY');
  });

  it('keeps redemption at PKR 1 per point whatever the earning rate', () => {
    expect(
      redemptionFor({ requestedPoints: 10, availablePoints: 10, outstandingMinor: 5_000 })
    ).toEqual({ points: 10, amountMinor: 1_000 });
  });

  it('describes each rule in plain words', () => {
    expect(describeLoyaltyEarnRule(percent(150))).toBe('1.5% of spend');
    expect(describeLoyaltyEarnRule(step(1, 1_000))).toBe('1 point for every PKR 1,000 spent');
    expect(describeLoyaltyEarnRule(step(5, 100))).toBe('5 points for every PKR 100 spent');
  });
});
