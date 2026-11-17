import { describe, expect, it } from 'vitest';

import {
  evaluatePharmacyPromotion,
  pharmacyPromotionInput,
  type PharmacyPromotionRule,
} from './promotions';

const FROM = new Date('2026-11-01T00:00:00.000Z');
const TO = new Date('2026-11-08T00:00:00.000Z');

function promotion(overrides: Partial<PharmacyPromotionRule> = {}): PharmacyPromotionRule {
  return {
    id: 'promo-a',
    organizationId: 'org-a',
    branchId: 'branch-a',
    name: 'Winter week',
    medicineId: null,
    effectiveFrom: FROM,
    effectiveTo: TO,
    benefitBasisPoints: 1_000,
    benefitMinor: null,
    priority: 0,
    active: true,
    createdByUserId: 'manager-a',
    ...overrides,
  };
}

function evaluate(
  promotions: PharmacyPromotionRule[],
  overrides: Partial<Parameters<typeof evaluatePharmacyPromotion>[0]> = {}
) {
  return evaluatePharmacyPromotion({
    organizationId: 'org-a',
    branchId: 'branch-a',
    medicineId: 'medicine-a',
    regulated: false,
    grossMinor: 1_000,
    costMinor: 500,
    at: new Date('2026-11-03T10:00:00.000Z'),
    promotions,
    ...overrides,
  });
}

describe('evaluatePharmacyPromotion (#727 date-based counter promotions)', () => {
  it('applies a percentage promotion inside its window', () => {
    expect(evaluate([promotion()])).toMatchObject({
      discountMinor: 100,
      promotion: { id: 'promo-a' },
    });
  });

  it('uses a half-open window: on at the start instant, off at the end instant', () => {
    expect(evaluate([promotion()], { at: FROM })?.discountMinor).toBe(100);
    expect(evaluate([promotion()], { at: new Date(FROM.getTime() - 1) })).toBeNull();
    expect(evaluate([promotion()], { at: TO })).toBeNull();
    expect(evaluate([promotion()], { at: new Date(TO.getTime() - 1) })?.discountMinor).toBe(100);
  });

  it('ignores a disabled promotion', () => {
    expect(evaluate([promotion({ active: false })])).toBeNull();
  });

  it('rounds a percentage once on the line, half up', () => {
    // 12.5% of 10.05 = 1.25625 -> 1.26
    expect(
      evaluate([promotion({ benefitBasisPoints: 1_250 })], { grossMinor: 1_005 })
    ).toMatchObject({ discountMinor: 126 });
  });

  it('applies a fixed amount once per line, never above the line gross', () => {
    expect(
      evaluate([promotion({ benefitBasisPoints: null, benefitMinor: 250 })])?.discountMinor
    ).toBe(250);
    expect(
      evaluate([promotion({ benefitBasisPoints: null, benefitMinor: 5_000 })], { costMinor: 0 })
        ?.discountMinor
    ).toBe(1_000);
  });

  it('targets only its own medicine, branch and organization', () => {
    expect(evaluate([promotion({ medicineId: 'medicine-b' })])).toBeNull();
    expect(evaluate([promotion({ medicineId: 'medicine-a' })])?.discountMinor).toBe(100);
    expect(evaluate([promotion({ branchId: 'branch-b' })])).toBeNull();
    expect(evaluate([promotion({ organizationId: 'org-b' })])).toBeNull();
  });

  it('never discounts an Rx, restricted or controlled medicine', () => {
    expect(evaluate([promotion()], { regulated: true })).toBeNull();
  });

  it('skips an offer priced between cost and the minimum-margin floor', () => {
    // Cost 500 with a 20% minimum margin: the floor is 625, so a 40% offer (net 600) is
    // above cost but below the floor and must not be selected.
    const deep = promotion({ id: 'promo-deep', benefitBasisPoints: 4_000 });
    expect(evaluate([deep], { minMarginBps: 2_000 })).toBeNull();
    const safe = promotion({ id: 'promo-safe', benefitBasisPoints: 3_000 });
    expect(evaluate([deep, safe], { minMarginBps: 2_000 })).toMatchObject({
      promotion: { id: 'promo-safe' },
    });
  });

  it('picks the highest priority, then the lowest id, and never stacks', () => {
    const low = promotion({ id: 'promo-low', benefitBasisPoints: 3_000, priority: 1 });
    const high = promotion({ id: 'promo-high', benefitBasisPoints: 500, priority: 5 });
    expect(evaluate([low, high])).toMatchObject({
      promotion: { id: 'promo-high' },
      discountMinor: 50,
    });
    const tieB = promotion({ id: 'promo-b', benefitBasisPoints: 2_000 });
    const tieA = promotion({ id: 'promo-a', benefitBasisPoints: 1_000 });
    expect(evaluate([tieB, tieA])?.promotion.id).toBe('promo-a');
  });

  it('skips an offer that would sell below cost and falls through to the next', () => {
    const deep = promotion({ id: 'promo-deep', benefitBasisPoints: 6_000, priority: 9 });
    const safe = promotion({ id: 'promo-safe', benefitBasisPoints: 2_000 });
    expect(evaluate([deep, safe])).toMatchObject({
      promotion: { id: 'promo-safe' },
      discountMinor: 200,
    });
    expect(evaluate([deep])).toBeNull();
  });

  it('refuses invalid money', () => {
    expect(() => evaluate([promotion()], { grossMinor: 1.5 })).toThrow(RangeError);
    expect(() => evaluate([promotion()], { costMinor: -1 })).toThrow(RangeError);
  });
});

describe('pharmacyPromotionInput', () => {
  const base = {
    branchId: 'branch-a',
    name: 'Winter week',
    effectiveFrom: FROM.toISOString(),
    effectiveTo: TO.toISOString(),
    benefitBasisPoints: 1_000,
  };

  it('accepts a dated percentage promotion', () => {
    expect(pharmacyPromotionInput.parse(base)).toMatchObject({
      effectiveFrom: FROM,
      effectiveTo: TO,
      priority: 0,
    });
  });

  it('requires the window to end after it starts', () => {
    expect(
      pharmacyPromotionInput.safeParse({ ...base, effectiveTo: base.effectiveFrom }).success
    ).toBe(false);
  });

  it('requires exactly one benefit', () => {
    expect(pharmacyPromotionInput.safeParse({ ...base, benefitMinor: 100 }).success).toBe(false);
    expect(
      pharmacyPromotionInput.safeParse({ ...base, benefitBasisPoints: undefined }).success
    ).toBe(false);
    expect(pharmacyPromotionInput.safeParse({ ...base, benefitBasisPoints: 10_001 }).success).toBe(
      false
    );
  });

  it('refuses a name with control characters', () => {
    expect(pharmacyPromotionInput.safeParse({ ...base, name: 'Sale\u001b[1m' }).success).toBe(
      false
    );
    expect(pharmacyPromotionInput.safeParse({ ...base, name: '   ' }).success).toBe(false);
  });
});
