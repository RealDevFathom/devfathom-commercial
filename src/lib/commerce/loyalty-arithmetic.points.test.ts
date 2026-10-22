import { describe, expect, it } from 'vitest';

import { categoryEarnPoints, redemptionFor } from './loyalty-arithmetic';

describe('pharmacy points defaults', () => {
  it('earns 1/Rs100 on medicine and 3/Rs100 on non-drug, flooring categories separately', () => {
    expect(categoryEarnPoints({ medicineMinor: 10_000, nonDrugMinor: 0 })).toBe(1);
    expect(categoryEarnPoints({ medicineMinor: 0, nonDrugMinor: 10_000 })).toBe(3);
    expect(categoryEarnPoints({ medicineMinor: 19_999, nonDrugMinor: 19_999 })).toBe(4);
    expect(categoryEarnPoints({ medicineMinor: 9_999, nonDrugMinor: 9_999 })).toBe(0);
  });

  it('applies the gold multiplier after category floors', () => {
    expect(categoryEarnPoints(
      { medicineMinor: 20_000, nonDrugMinor: 10_000 },
      { medicineEarnPoints: 1, nonDrugEarnPoints: 3, earnBlockMinor: 10_000,
        pointValueMinor: 100, minimumRedemptionPoints: 200, goldTierMultiplier: 2 }
    )).toBe(10);
  });

  it('rejects below 200 and values each point at Rs1', () => {
    expect(() => redemptionFor({ requestedPoints: 199, availablePoints: 500,
      outstandingMinor: 50_000, minimumRedemptionPoints: 200 })).toThrow('REDEMPTION_BELOW_MINIMUM');
    expect(redemptionFor({ requestedPoints: 200, availablePoints: 200,
      outstandingMinor: 20_000, minimumRedemptionPoints: 200 })).toEqual({
      points: 200, amountMinor: 20_000,
    });
  });
});
