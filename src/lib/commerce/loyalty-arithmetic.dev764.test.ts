import { describe, expect, it } from 'vitest';

import {
  assertLoyaltyEarnRule,
  describeLoyaltyEarnRule,
  describeRedemptionValue,
  earnedPointsFor,
  loyaltyExpiresAt,
  loyaltyLiabilityMinor,
  pointsForRedeemedMoney,
  redemptionFor,
} from './loyalty-arithmetic';

describe('DEV-764 owner-set redemption value', () => {
  it('redeems at the owner value and keeps PKR 1 per point as the default', () => {
    expect(
      redemptionFor({ requestedPoints: 50, availablePoints: 50, outstandingMinor: 1_275 })
    ).toEqual({ points: 12, amountMinor: 1_200 });
    expect(
      redemptionFor({
        requestedPoints: 50,
        availablePoints: 50,
        outstandingMinor: 1_275,
        pointValueMinor: 50,
      })
    ).toEqual({ points: 25, amountMinor: 1_250 });
    expect(
      redemptionFor({
        requestedPoints: 3,
        availablePoints: 3,
        outstandingMinor: 10_000,
        pointValueMinor: 250,
      })
    ).toEqual({ points: 3, amountMinor: 750 });
  });

  it.each([0, -1, 1.5, 100_001])('refuses a point value of %s', (pointValueMinor) => {
    expect(() =>
      redemptionFor({
        requestedPoints: 1,
        availablePoints: 1,
        outstandingMinor: 1_000,
        pointValueMinor,
      })
    ).toThrow('INVALID_POINT_VALUE');
  });

  it('never lets a rule pay back more than was spent at its own point value', () => {
    // 2 points per PKR 100 is 2% at PKR 1 per point, but 200% at PKR 100 per point.
    const rule = { earnMode: 'POINTS_PER_SPEND_STEP', earnPoints: 2, perSpendMinor: 10_000 };
    expect(() => assertLoyaltyEarnRule(rule)).not.toThrow();
    expect(() => assertLoyaltyEarnRule({ ...rule, redemptionValueMinor: 10_000 })).toThrow(
      'INVALID_EARN_RULE'
    );
    expect(() => assertLoyaltyEarnRule({ ...rule, redemptionValueMinor: 5_000 })).not.toThrow();
  });

  it('describes a percentage rule at its own point value', () => {
    // 2% at PKR 2 per point: 200 points per PKR 20,000 of spend.
    const rule = {
      earnMode: 'PERCENT_OF_SPEND',
      earnPoints: 200,
      perSpendMinor: 2_000_000,
      redemptionValueMinor: 200,
    };
    expect(describeLoyaltyEarnRule(rule)).toBe('2% of spend');
    expect(earnedPointsFor(100_000, rule)).toBe(10);
    expect(describeRedemptionValue(100)).toBe('1 point = PKR 1');
    expect(describeRedemptionValue(250)).toBe('1 point = PKR 2.50');
  });

  it('gives back points at the value they were redeemed at, never more than redeemed', () => {
    // 20 points redeemed at PKR 1 each (2,000 minor); a later PKR 2 value changes nothing.
    expect(
      pointsForRedeemedMoney({ releasedMinor: 2_000, tenderMinor: 2_000, redeemedPoints: 20 })
    ).toBe(20);
    expect(
      pointsForRedeemedMoney({ releasedMinor: 1_050, tenderMinor: 2_000, redeemedPoints: 20 })
    ).toBe(10);
    // 10 points redeemed at PKR 2.50 each.
    expect(
      pointsForRedeemedMoney({ releasedMinor: 1_000, tenderMinor: 2_500, redeemedPoints: 10 })
    ).toBe(4);
    expect(
      pointsForRedeemedMoney({ releasedMinor: 9_999, tenderMinor: 2_500, redeemedPoints: 10 })
    ).toBe(10);
  });

  it('values unredeemed points as a liability and ignores a negative balance', () => {
    expect(loyaltyLiabilityMinor(1_234, 100)).toBe(123_400);
    expect(loyaltyLiabilityMinor(10, 250)).toBe(2_500);
    expect(loyaltyLiabilityMinor(-5, 100)).toBe(0);
  });

  it('dates a lot expiry from when it was earned, or never', () => {
    const at = new Date('2026-11-15T10:00:00.000Z');
    expect(loyaltyExpiresAt(at, null)).toBeNull();
    expect(loyaltyExpiresAt(at, undefined)).toBeNull();
    expect(loyaltyExpiresAt(at, 30)?.toISOString()).toBe('2026-12-15T10:00:00.000Z');
    expect(() => loyaltyExpiresAt(at, 0)).toThrow('INVALID_EXPIRY');
  });
});
