import { describe, expect, it } from 'vitest';
import {
  discountPolicySchema,
  estimateDiscountElasticity,
  maxDiscountMinorFor,
  minimumPriceForMargin,
  parseDiscountPolicy,
  suggestDiscount,
  type DiscountDemandObservation,
} from './smart-discount';

const otc = { rx: false, restricted: false, controlled: false };
const policy = parseDiscountPolicy({ minMarginBps: 2_000 });

function days(count: number, units: number, unitNetMinor: number, discounted: boolean) {
  return Array.from({ length: count }, (_, i): DiscountDemandObservation => ({
    day: `${discounted ? 'd' : 'f'}-${i}`,
    units,
    netMinor: units * unitNetMinor,
    discounted,
  }));
}

describe('DEV-66 discount policy', () => {
  it('defaults keep the existing never-below-cost floor', () => {
    const defaults = parseDiscountPolicy(null);
    expect(defaults.minMarginBps).toBe(0);
    expect(minimumPriceForMargin(800, defaults.minMarginBps)).toBe(800);
  });

  it('is configurable and bounded', () => {
    expect(parseDiscountPolicy({ minMarginBps: 1_234 }).minMarginBps).toBe(1_234);
    expect(discountPolicySchema.safeParse({ minMarginBps: 10_000 }).success).toBe(false);
    expect(discountPolicySchema.safeParse({ lookbackDays: 1 }).success).toBe(false);
    // The deepest discount is the owner's organization-wide maximum, never a branch number.
    expect(discountPolicySchema.safeParse({ maxSuggestedDiscountBps: 1_500 }).success).toBe(false);
    // A corrupt stored value falls back to the safe defaults rather than throwing.
    expect(parseDiscountPolicy({ minMarginBps: 'x' }).minMarginBps).toBe(0);
  });

  it("caps a discount at the owner's maximum, rounded down, and fails closed", () => {
    expect(maxDiscountMinorFor(1_199, 1_000)).toBe(119);
    expect(maxDiscountMinorFor(1_000, 10_000)).toBe(1_000);
    expect(maxDiscountMinorFor(1_000, 0)).toBe(0);
    expect(maxDiscountMinorFor(1_000, Number.NaN)).toBe(0);
  });

  it('computes the margin floor on the selling price, rounded up', () => {
    expect(minimumPriceForMargin(800, 2_000)).toBe(1_000);
    expect(minimumPriceForMargin(801, 2_000)).toBe(1_002);
  });
});

describe('DEV-66 elasticity estimate', () => {
  it('needs enough evidence on both sides', () => {
    const rows = [...days(3, 10, 100, false), ...days(10, 15, 90, true)];
    expect(estimateDiscountElasticity(rows, 7)).toBeNull();
  });

  it('estimates an arc elasticity from discounted and full-price days', () => {
    const rows = [...days(10, 10, 100, false), ...days(10, 15, 90, true)];
    const estimate = estimateDiscountElasticity(rows, 7);
    expect(estimate).not.toBeNull();
    expect(estimate!.elasticity).toBeLessThan(-1);
    expect(estimate!.fullPriceDays).toBe(10);
    expect(estimate!.discountedDays).toBe(10);
  });
});

describe('DEV-66 discount suggestions', () => {
  const base = {
    medicine: otc,
    mrpMinor: 1_200,
    unitPriceMinor: 1_200,
    unitCostMinor: 800,
    policy,
    // The owner allows up to 15% off.
    maxDiscountBps: 1_500,
    elasticity: null,
    lowestCompetitorPriceMinor: null,
  };

  it('never suggests a discount for Rx-only, restricted or controlled stock', () => {
    for (const flag of ['rx', 'restricted', 'controlled'] as const) {
      expect(
        suggestDiscount({
          ...base,
          medicine: { ...otc, [flag]: true },
          elasticity: -3,
          lowestCompetitorPriceMinor: 1_000,
        })
      ).toEqual({ kind: 'EXCLUDED', reason: 'REGULATED' });
    }
  });

  it('matches a cheaper competitor but never below the minimum-margin floor', () => {
    const matched = suggestDiscount({ ...base, lowestCompetitorPriceMinor: 1_100 });
    expect(matched).toMatchObject({
      kind: 'SUGGEST',
      basis: 'COMPETITOR',
      suggestedPriceMinor: 1_100,
    });
    const floored = suggestDiscount({ ...base, lowestCompetitorPriceMinor: 500 });
    expect(floored).toMatchObject({ kind: 'SUGGEST', suggestedPriceMinor: 1_020 });
    if (floored.kind !== 'SUGGEST') throw new Error('expected a suggestion');
    expect(floored.suggestedPriceMinor).toBeGreaterThanOrEqual(floored.floorPriceMinor);
    expect(floored.floorPriceMinor).toBe(1_000);
  });

  it('never suggests a price above MRP', () => {
    const result = suggestDiscount({ ...base, unitPriceMinor: 1_500, elasticity: -2 });
    expect(result).toMatchObject({ kind: 'SUGGEST', ceilingPriceMinor: 1_200 });
    if (result.kind !== 'SUGGEST') throw new Error('expected a suggestion');
    expect(result.suggestedPriceMinor).toBeLessThanOrEqual(1_200);
    expect(suggestDiscount({ ...base, lowestCompetitorPriceMinor: 1_400 })).toMatchObject({
      kind: 'NONE',
      reason: 'NO_EVIDENCE',
    });
  });

  it('suggests the configured depth only for elastic items', () => {
    expect(suggestDiscount({ ...base, elasticity: -2 })).toMatchObject({
      kind: 'SUGGEST',
      basis: 'ELASTICITY',
      suggestedPriceMinor: 1_020,
      discountMinor: 180,
      // Midpoint basis, like the arc elasticity: 2 x 180 / ((1200 + 1020) / 2).
      estimatedUnitUpliftBps: 3_243,
    });
    expect(suggestDiscount({ ...base, elasticity: -0.5 })).toMatchObject({
      kind: 'NONE',
      reason: 'INELASTIC',
    });
  });

  it("never suggests deeper than the owner's maximum, and nothing when it is zero", () => {
    expect(
      suggestDiscount({ ...base, unitCostMinor: 100, maxDiscountBps: 500, elasticity: -2 })
    ).toMatchObject({ kind: 'SUGGEST', suggestedPriceMinor: 1_140, discountMinor: 60 });
    expect(
      suggestDiscount({
        ...base,
        unitCostMinor: 100,
        maxDiscountBps: 500,
        lowestCompetitorPriceMinor: 900,
      })
    ).toMatchObject({ kind: 'SUGGEST', basis: 'COMPETITOR', suggestedPriceMinor: 1_140 });
    expect(suggestDiscount({ ...base, maxDiscountBps: 0, elasticity: -2 })).toMatchObject({
      kind: 'NONE',
    });
  });

  it('offers nothing when the margin floor already reaches MRP', () => {
    expect(
      suggestDiscount({ ...base, unitCostMinor: 1_000, lowestCompetitorPriceMinor: 900 })
    ).toMatchObject({ kind: 'NONE', reason: 'AT_MARGIN_FLOOR' });
  });
});
