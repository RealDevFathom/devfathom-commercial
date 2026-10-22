import { describe, expect, it } from 'vitest';

import { categoryEarnPoints, redemptionFor } from './loyalty-arithmetic';

describe('pharmacy points defaults', () => {
  it.each([
    [-1, 0],
    [1.5, 0],
    [Number.MAX_SAFE_INTEGER + 1, 0],
    [0, -1],
    [0, 1.5],
  ])('rejects non-paisa category money (%s, %s)', (medicineMinor, nonDrugMinor) => {
    expect(() => categoryEarnPoints({ medicineMinor, nonDrugMinor })).toThrow(
      'INVALID_LOYALTY_RULES'
    );
  });

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

  it('never produces fractional paisa or spends more points than are available', () => {
    for (let outstandingMinor = 100; outstandingMinor <= 20_001; outstandingMinor += 137) {
      const availablePoints = 500;
      const result = redemptionFor({
        requestedPoints: availablePoints,
        availablePoints,
        outstandingMinor,
        pointValueMinor: 100,
      });
      expect(Number.isSafeInteger(result.amountMinor)).toBe(true);
      expect(result.amountMinor).toBe(result.points * 100);
      expect(result.amountMinor).toBeLessThanOrEqual(outstandingMinor);
      expect(result.points).toBeLessThanOrEqual(availablePoints);
    }
  });

  it.each([
    { requestedPoints: 1.5, availablePoints: 10, outstandingMinor: 1_000 },
    { requestedPoints: 1, availablePoints: -1, outstandingMinor: 1_000 },
    { requestedPoints: 1, availablePoints: 10, outstandingMinor: -1 },
    { requestedPoints: 1, availablePoints: 10, outstandingMinor: 1.5 },
  ])('rejects invalid redemption money and balances: $requestedPoints', (input) => {
    expect(() => redemptionFor(input)).toThrow('INVALID_REDEMPTION');
  });
});
