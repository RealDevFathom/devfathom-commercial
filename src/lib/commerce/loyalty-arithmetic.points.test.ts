import { describe, expect, it } from 'vitest';

import { categoryEarnPoints, LOYALTY_POINTS_MAX, redemptionFor } from './loyalty-arithmetic';

describe('pharmacy points defaults', () => {
  it('earns 1/Rs100 on medicine and 3/Rs100 on non-drug, flooring categories separately', () => {
    expect(categoryEarnPoints({ medicineMinor: 10_000, nonDrugMinor: 0 })).toBe(1);
    expect(categoryEarnPoints({ medicineMinor: 0, nonDrugMinor: 10_000 })).toBe(3);
    expect(categoryEarnPoints({ medicineMinor: 19_999, nonDrugMinor: 19_999 })).toBe(4);
    expect(categoryEarnPoints({ medicineMinor: 9_999, nonDrugMinor: 9_999 })).toBe(0);
  });

  it('applies the gold multiplier after category floors', () => {
    expect(
      categoryEarnPoints(
        { medicineMinor: 20_000, nonDrugMinor: 10_000 },
        {
          medicineEarnPoints: 1,
          nonDrugEarnPoints: 3,
          earnBlockMinor: 10_000,
          pointValueMinor: 100,
          minimumRedemptionPoints: 200,
          goldTierMultiplier: 2,
        }
      )
    ).toBe(10);
  });

  it('rejects below 200 and values each point at Rs1', () => {
    expect(() =>
      redemptionFor({
        requestedPoints: 199,
        availablePoints: 500,
        outstandingMinor: 50_000,
        minimumRedemptionPoints: 200,
      })
    ).toThrow('REDEMPTION_BELOW_MINIMUM');
    expect(
      redemptionFor({
        requestedPoints: 200,
        availablePoints: 200,
        outstandingMinor: 20_000,
        minimumRedemptionPoints: 200,
      })
    ).toEqual({
      points: 200,
      amountMinor: 20_000,
    });
  });

  it('refuses a valid request whose capped redemption falls below the minimum', () => {
    // 200 points requested and held, but a Rs 1 bill can take only 1 point.
    expect(() =>
      redemptionFor({
        requestedPoints: 200,
        availablePoints: 500,
        outstandingMinor: 100,
        minimumRedemptionPoints: 200,
      })
    ).toThrow('REDEMPTION_BELOW_MINIMUM');
    // One paisa short of 200 points of bill.
    expect(() =>
      redemptionFor({
        requestedPoints: 500,
        availablePoints: 500,
        outstandingMinor: 19_999,
        minimumRedemptionPoints: 200,
      })
    ).toThrow('REDEMPTION_BELOW_MINIMUM');
    // A configured point value caps too: Rs 3 points against Rs 500 leave 166 < 200.
    expect(() =>
      redemptionFor({
        requestedPoints: 300,
        availablePoints: 300,
        outstandingMinor: 50_000,
        pointValueMinor: 300,
        minimumRedemptionPoints: 200,
      })
    ).toThrow('REDEMPTION_BELOW_MINIMUM');
    expect(
      redemptionFor({
        requestedPoints: 500,
        availablePoints: 500,
        outstandingMinor: 20_050,
        minimumRedemptionPoints: 200,
      })
    ).toEqual({ points: 200, amountMinor: 20_000 });
  });

  it('refuses an award above the INTEGER points column instead of storing a wrong one', () => {
    const rules = {
      medicineEarnPoints: 1,
      nonDrugEarnPoints: 1,
      earnBlockMinor: 1,
      pointValueMinor: 100,
      minimumRedemptionPoints: 200,
      goldTierMultiplier: 1,
    };
    expect(categoryEarnPoints({ medicineMinor: LOYALTY_POINTS_MAX, nonDrugMinor: 0 }, rules)).toBe(
      LOYALTY_POINTS_MAX
    );
    expect(() =>
      categoryEarnPoints({ medicineMinor: LOYALTY_POINTS_MAX, nonDrugMinor: 1 }, rules)
    ).toThrow('LOYALTY_AWARD_OUT_OF_RANGE');
    expect(() =>
      categoryEarnPoints(
        { medicineMinor: 2_000_000_000, nonDrugMinor: 0 },
        { ...rules, goldTierMultiplier: 2 }
      )
    ).toThrow('LOYALTY_AWARD_OUT_OF_RANGE');
    // Safe-integer subtotals near 2^53 floor exactly in BigInt.
    expect(
      categoryEarnPoints(
        { medicineMinor: Number.MAX_SAFE_INTEGER, nonDrugMinor: 0 },
        { ...rules, earnBlockMinor: 10_000_000 }
      )
    ).toBe(900_719_925);
  });
});
