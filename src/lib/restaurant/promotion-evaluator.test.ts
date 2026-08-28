/**
 * WHA-288 / promotions Lane A — the evaluator table and the stacking battery.
 *
 * The arithmetic cases are the spec's OWN numerical owner examples (§12.1-§12.11
 * and §12.13's ordering half). They are transcribed rather than invented, so a
 * disagreement between this file and the spec is a real defect in one of them,
 * not a difference of opinion about what a promotion should be worth.
 *
 * Covers the named acceptance tests (§13):
 *   - promotion_percent_obeys_minimum_and_rounds_once
 *   - promotion_amount_and_fixed_price_never_make_line_negative
 *   - promotion_bxgy_selects_canonical_units
 *   - promotion_bundle_allocates_largest_remainder_by_stable_unit_key
 *   - promotion_item_category_order_targets_use_frozen_ancestry
 *   - promotion_branch_channel_customer_and_per_order_limits_fail_closed
 *   - promotion_stacking_priority_group_exclusive_stop_and_ties_are_total
 *   - promotion_comp_discount_and_bill_identity_reconcile (the promotion half;
 *     the bill identity itself belongs to the tax/loyalty lane)
 *   - promotion_combo_components_do_not_become_independent_discount_lines
 *
 * Money is asserted with `toFixed(2)` throughout: `Decimal.toString()`
 * normalises trailing zeros, so `'3.00'` would otherwise never match `'3'`.
 */

import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import {
  PROMOTION_REASON,
  type PromotionEvaluationContext,
  type PromotionInputLine,
  type PromotionRule,
  type PromotionUnitKey,
} from '@/lib/restaurant/promotion-contracts';
import { evaluatePromotions, expandUnits } from '@/lib/restaurant/promotion-evaluator';

const d = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);

/** A published, always-in-force, order-targeted rule. Tests override only the
 * field under test, so an unrelated default can never silently carry a case. */
function rule(
  overrides: Partial<PromotionRule> & Pick<PromotionRule, 'versionId' | 'benefitKind'>
): PromotionRule {
  return {
    promotionId: `promo-${overrides.versionId}`,
    promotionCode: `CODE-${overrides.versionId}`,
    versionNumber: 1,
    status: 'PUBLISHED',
    effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
    effectiveTo: null,
    timezone: 'UTC',
    dayMask: 127,
    startMinute: null,
    endMinute: null,
    activationMode: 'AUTOMATIC',
    couponCodeHash: null,
    requiresCoAuthorization: false,
    targetKind: 'ORDER',
    targetProductIds: [],
    targetVariantIds: [],
    targetCategoryIds: [],
    includeDescendants: false,
    componentTargeting: false,
    allowedBranchIds: [],
    allowedChannels: [],
    customerSegmentRef: null,
    minimumQuantity: null,
    minimumAmount: null,
    benefitBasisPoints: null,
    benefitAmount: null,
    buyQuantity: null,
    getQuantity: null,
    applicationBasis: 'ORDER',
    maxBenefitAmount: null,
    currency: 'USD',
    components: [],
    priority: 0,
    stackingGroup: '',
    stackingMode: 'STACKABLE',
    stopFurtherProcessing: false,
    maxApplicationsPerOrder: null,
    perOrderCap: null,
    globalCap: null,
    perCustomerCap: null,
    budgetAmount: null,
    offlinePolicy: 'ONLINE_ONLY',
    ruleHash: `hash-${overrides.versionId}`,
    ...overrides,
  };
}

function line(
  orderItemId: string,
  unitPrice: string,
  overrides: Partial<PromotionInputLine> = {}
): PromotionInputLine {
  return {
    orderItemId,
    productId: `product-${orderItemId}`,
    variantId: null,
    categoryAncestry: [],
    quantity: 1,
    unitPrice: d(unitPrice),
    modifierDeltas: [],
    compAllocation: d(0),
    ...overrides,
  };
}

function context(overrides: Partial<PromotionEvaluationContext> = {}): PromotionEvaluationContext {
  return {
    evaluatedAt: new Date('2026-03-04T12:00:00.000Z'),
    branchId: 'branch-1',
    channel: 'DINE_IN',
    currency: 'USD',
    customerId: null,
    customerSegments: [],
    couponFingerprints: [],
    authorityActorId: null,
    online: true,
    ...overrides,
  };
}

/** Σ of the charge left on every unit — the payable merchandise. */
function netMerchandise(units: readonly { remainingCharge: Prisma.Decimal }[]): string {
  return units.reduce((total, unit) => total.plus(unit.remainingCharge), d(0)).toFixed(2);
}

function allocationFor(
  result: ReturnType<typeof evaluatePromotions>,
  key: PromotionUnitKey
): string {
  const total = result.applications
    .flatMap((application) => application.allocations)
    .filter(
      (allocation) =>
        allocation.orderItemId === key.orderItemId && allocation.unitOrdinal === key.unitOrdinal
    )
    .reduce((sum, allocation) => sum.plus(allocation.allocatedAmount), d(0));
  return total.toFixed(2);
}

describe('promotion evaluator — §12 numerical owner examples', () => {
  it('§12.1 percent obeys the minimum and rounds once', () => {
    const rules = [
      rule({
        versionId: 'v-percent',
        benefitKind: 'PERCENT_OFF',
        benefitBasisPoints: 1500,
        minimumAmount: d('20.00'),
      }),
    ];
    const met = evaluatePromotions({
      context: context(),
      lines: [line('item-a', '12.00'), line('item-b', '8.00')],
      rules,
    });
    expect(met.discountTotal.toFixed(2)).toBe('3.00');
    expect(netMerchandise(met.units)).toBe('17.00');

    // The same rule against a single 12.00 meal: below the minimum, so the
    // candidate is INELIGIBLE rather than discounted at a smaller basis.
    const notMet = evaluatePromotions({
      context: context(),
      lines: [line('item-a', '12.00')],
      rules,
    });
    expect(notMet.discountTotal.toFixed(2)).toBe('0.00');
    expect(notMet.candidates[0]?.reasonCode).toBe(PROMOTION_REASON.MINIMUM_AMOUNT_NOT_MET);
    expect(notMet.candidates[0]?.outcome).toBe('REJECTED');
  });

  it('§12.2 an amount benefit is capped at the eligible charge and never credits', () => {
    const result = evaluatePromotions({
      context: context(),
      lines: [line('item-a', '7.50')],
      rules: [
        rule({ versionId: 'v-amount', benefitKind: 'AMOUNT_OFF', benefitAmount: d('10.00') }),
      ],
    });
    expect(result.discountTotal.toFixed(2)).toBe('7.50');
    expect(netMerchandise(result.units)).toBe('0.00');
  });

  it('§12.3 fixed price reduces to the stated total and never surcharges', () => {
    const fixedPrice = rule({
      versionId: 'v-fixed',
      benefitKind: 'FIXED_PRICE',
      benefitAmount: d('14.00'),
    });
    const above = evaluatePromotions({
      context: context(),
      lines: [line('item-a', '6.00', { quantity: 3 })],
      rules: [fixedPrice],
    });
    expect(above.discountTotal.toFixed(2)).toBe('4.00');
    expect(netMerchandise(above.units)).toBe('14.00');

    // Already cheaper than the fixed price: zero, not a negative benefit.
    const below = evaluatePromotions({
      context: context(),
      lines: [line('item-a', '4.00', { quantity: 3 })],
      rules: [fixedPrice],
    });
    expect(below.discountTotal.toFixed(2)).toBe('0.00');
    expect(below.candidates[0]?.outcome).toBe('REJECTED');
  });

  it('§12.4 buy two get one 50% discounts the canonical cheapest unit', () => {
    const result = evaluatePromotions({
      context: context(),
      lines: [line('item-a', '5.00'), line('item-b', '7.00'), line('item-c', '9.00')],
      rules: [
        rule({
          versionId: 'v-bogo',
          benefitKind: 'BUY_X_GET_Y_PERCENT',
          buyQuantity: 2,
          getQuantity: 1,
          benefitBasisPoints: 5000,
        }),
      ],
    });
    expect(result.discountTotal.toFixed(2)).toBe('2.50');
    expect(netMerchandise(result.units)).toBe('18.50');
    // The 5.00 unit is the one discounted — not the 9.00 unit.
    expect(allocationFor(result, { orderItemId: 'item-a', unitOrdinal: 0 })).toBe('2.50');
    expect(allocationFor(result, { orderItemId: 'item-c', unitOrdinal: 0 })).toBe('0.00');
  });

  it('§12.5 buy one get one amount caps the per-unit discount at that unit', () => {
    const result = evaluatePromotions({
      context: context(),
      lines: [line('item-a', '3.00', { quantity: 2 })],
      rules: [
        rule({
          versionId: 'v-bogo-amount',
          benefitKind: 'BUY_X_GET_Y_AMOUNT',
          buyQuantity: 1,
          getQuantity: 1,
          benefitAmount: d('5.00'),
        }),
      ],
    });
    // min(5.00, 3.00) = 3.00 — never 5.00, which would credit the guest 2.00.
    expect(result.discountTotal.toFixed(2)).toBe('3.00');
    expect(netMerchandise(result.units)).toBe('3.00');
  });

  it('§12.6 buy two get one free discounts the cheapest unit of the set', () => {
    const result = evaluatePromotions({
      context: context(),
      lines: [line('item-a', '4.00'), line('item-b', '6.00'), line('item-c', '8.00')],
      rules: [
        rule({
          versionId: 'v-free',
          benefitKind: 'BUY_X_GET_Y_FREE',
          buyQuantity: 2,
          getQuantity: 1,
        }),
      ],
    });
    expect(result.discountTotal.toFixed(2)).toBe('4.00');
    expect(netMerchandise(result.units)).toBe('14.00');
  });

  it('a quantity benefit consumes its BUY units, so four units are one set', () => {
    // The regression this guards: if only the discounted unit were consumed,
    // four units would yield TWO buy-two-get-one sets instead of one.
    const result = evaluatePromotions({
      context: context(),
      lines: [
        line('item-a', '5.00'),
        line('item-b', '6.00'),
        line('item-c', '7.00'),
        line('item-d', '8.00'),
      ],
      rules: [
        rule({
          versionId: 'v-free',
          benefitKind: 'BUY_X_GET_Y_FREE',
          buyQuantity: 2,
          getQuantity: 1,
        }),
      ],
    });
    expect(result.applications).toHaveLength(1);
    expect(result.discountTotal.toFixed(2)).toBe('5.00');

    // Six units DO support two sets, each discounting the cheapest unit left.
    const twoSets = evaluatePromotions({
      context: context(),
      lines: [
        line('item-a', '5.00'),
        line('item-b', '6.00'),
        line('item-c', '7.00'),
        line('item-d', '8.00'),
        line('item-e', '9.00'),
        line('item-f', '10.00'),
      ],
      rules: [
        rule({
          versionId: 'v-free',
          benefitKind: 'BUY_X_GET_Y_FREE',
          buyQuantity: 2,
          getQuantity: 1,
        }),
      ],
    });
    expect(twoSets.applications).toHaveLength(2);
    // First set retires 5/6/7 discounting 5.00; the second retires 8/9/10
    // discounting 8.00.
    expect(twoSets.discountTotal.toFixed(2)).toBe('13.00');
  });

  it('§12.7 a bundle allocates proportionally to gross by largest remainder', () => {
    const result = evaluatePromotions({
      context: context(),
      lines: [
        line('item-burger', '9.00', { productId: 'burger' }),
        line('item-fries', '4.00', { productId: 'fries' }),
        line('item-drink', '3.00', { productId: 'drink' }),
      ],
      rules: [
        rule({
          versionId: 'v-bundle',
          benefitKind: 'BUNDLE_PRICE',
          benefitAmount: d('12.00'),
          components: [
            { ordinal: 0, productIds: ['burger'], categoryIds: [], quantity: 1 },
            { ordinal: 1, productIds: ['fries'], categoryIds: [], quantity: 1 },
            { ordinal: 2, productIds: ['drink'], categoryIds: [], quantity: 1 },
          ],
        }),
      ],
    });
    expect(result.discountTotal.toFixed(2)).toBe('4.00');
    expect(allocationFor(result, { orderItemId: 'item-burger', unitOrdinal: 0 })).toBe('2.25');
    expect(allocationFor(result, { orderItemId: 'item-fries', unitOrdinal: 0 })).toBe('1.00');
    expect(allocationFor(result, { orderItemId: 'item-drink', unitOrdinal: 0 })).toBe('0.75');
  });

  it('§12.8 an indivisible cent goes to the lowest (orderItemId, unitOrdinal)', () => {
    const result = evaluatePromotions({
      context: context(),
      lines: [line('item-a', '10.00'), line('item-b', '10.00'), line('item-c', '10.00')],
      rules: [rule({ versionId: 'v-amount', benefitKind: 'AMOUNT_OFF', benefitAmount: d('1.00') })],
    });
    expect(result.discountTotal.toFixed(2)).toBe('1.00');
    expect(allocationFor(result, { orderItemId: 'item-a', unitOrdinal: 0 })).toBe('0.34');
    expect(allocationFor(result, { orderItemId: 'item-b', unitOrdinal: 0 })).toBe('0.33');
    expect(allocationFor(result, { orderItemId: 'item-c', unitOrdinal: 0 })).toBe('0.33');
  });

  it('§12.11 a promotion applies to the remainder after a comp, not the gross', () => {
    const result = evaluatePromotions({
      context: context(),
      lines: [line('item-a', '40.00', { compAllocation: d('10.00') })],
      rules: [
        rule({ versionId: 'v-quarter', benefitKind: 'PERCENT_OFF', benefitBasisPoints: 2500 }),
      ],
    });
    // 25% of the uncomped 30.00 remainder, not of the 40.00 gross.
    expect(result.discountTotal.toFixed(2)).toBe('7.50');
    expect(netMerchandise(result.units)).toBe('22.50');
  });
});

describe('promotion evaluator — §4.2 stacking is total', () => {
  const hundred = [line('item-a', '100.00')];
  const tenPercent = rule({
    versionId: 'v-percent',
    benefitKind: 'PERCENT_OFF',
    benefitBasisPoints: 1000,
    priority: 20,
  });
  const flatFive = rule({
    versionId: 'v-amount',
    benefitKind: 'AMOUNT_OFF',
    benefitAmount: d('5.00'),
    priority: 10,
  });

  it('§12.9 two stackable rules apply in priority order and total 15.00', () => {
    const result = evaluatePromotions({
      context: context(),
      lines: hundred,
      rules: [flatFive, tenPercent], // deliberately out of canonical order
    });
    // 10% of 100.00 = 10.00 first, then a FLAT 5.00 — not 10% then 10% of 90.
    expect(result.discountTotal.toFixed(2)).toBe('15.00');
    expect(result.candidates.map((candidate) => candidate.promotionVersionId)).toEqual([
      'v-percent',
      'v-amount',
    ]);
  });

  it('§12.9 group exclusivity admits only the highest-priority rule in the group', () => {
    const result = evaluatePromotions({
      context: context(),
      lines: hundred,
      rules: [
        { ...tenPercent, stackingMode: 'GROUP_EXCLUSIVE', stackingGroup: 'meal' },
        { ...flatFive, stackingMode: 'GROUP_EXCLUSIVE', stackingGroup: 'meal' },
      ],
    });
    expect(result.discountTotal.toFixed(2)).toBe('10.00');
    expect(result.candidates[1]?.reasonCode).toBe(PROMOTION_REASON.EXCLUDED_BY_STACKING_GROUP);
  });

  it('an EXCLUSIVE acceptance rejects every other candidate', () => {
    const result = evaluatePromotions({
      context: context(),
      lines: hundred,
      rules: [{ ...tenPercent, stackingMode: 'EXCLUSIVE' }, flatFive],
    });
    expect(result.discountTotal.toFixed(2)).toBe('10.00');
    expect(result.candidates[1]?.reasonCode).toBe(PROMOTION_REASON.EXCLUDED_BY_EXCLUSIVE);
  });

  it('stopFurtherProcessing ends the visit but still records what was skipped', () => {
    const result = evaluatePromotions({
      context: context(),
      lines: hundred,
      rules: [{ ...tenPercent, stopFurtherProcessing: true }, flatFive],
    });
    expect(result.discountTotal.toFixed(2)).toBe('10.00');
    // §5.1: the skipped candidate is retained with a stable reason, so an
    // auditor can see it was never considered rather than found ineligible.
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[1]?.reasonCode).toBe(PROMOTION_REASON.PROCESSING_STOPPED);
  });

  it('canonical order is independent of input order and of equal priorities', () => {
    const a = rule({
      versionId: 'v-b',
      benefitKind: 'AMOUNT_OFF',
      benefitAmount: d('1.00'),
      priority: 5,
    });
    const b = rule({
      versionId: 'v-a',
      benefitKind: 'AMOUNT_OFF',
      benefitAmount: d('1.00'),
      priority: 5,
    });
    const forward = evaluatePromotions({ context: context(), lines: hundred, rules: [a, b] });
    const reversed = evaluatePromotions({ context: context(), lines: hundred, rules: [b, a] });
    // Equal priority falls through to promotion id ascending, so both orders
    // produce the same visit sequence — ties never depend on row order.
    expect(forward.candidates.map((c) => c.promotionVersionId)).toEqual(
      reversed.candidates.map((c) => c.promotionVersionId)
    );
    expect(forward.candidates[0]?.promotionVersionId).toBe('v-a');
  });
});

describe('promotion evaluator — §3.3 targets and filters fail closed', () => {
  const lines = [
    line('item-a', '10.00', {
      productId: 'coffee',
      variantId: 'large',
      categoryAncestry: ['drinks', 'beverages'],
    }),
    line('item-b', '20.00', { productId: 'steak', categoryAncestry: ['mains', 'food'] }),
  ];

  it('an ITEM target matches only the named products', () => {
    const result = evaluatePromotions({
      context: context(),
      lines,
      rules: [
        rule({
          versionId: 'v-item',
          benefitKind: 'PERCENT_OFF',
          benefitBasisPoints: 1000,
          targetKind: 'ITEM',
          targetProductIds: ['coffee'],
        }),
      ],
    });
    expect(result.discountTotal.toFixed(2)).toBe('1.00'); // 10% of the coffee only
  });

  it('an ITEM target with variants narrows to those variants', () => {
    const result = evaluatePromotions({
      context: context(),
      lines,
      rules: [
        rule({
          versionId: 'v-item',
          benefitKind: 'PERCENT_OFF',
          benefitBasisPoints: 1000,
          targetKind: 'ITEM',
          targetProductIds: ['coffee'],
          targetVariantIds: ['small'],
        }),
      ],
    });
    expect(result.candidates[0]?.reasonCode).toBe(PROMOTION_REASON.NO_ELIGIBLE_UNITS);
  });

  it('a CATEGORY target reads the FROZEN ancestry, and descendants are opt-in', () => {
    const ancestorOnly = rule({
      versionId: 'v-cat',
      benefitKind: 'PERCENT_OFF',
      benefitBasisPoints: 1000,
      targetKind: 'CATEGORY',
      targetCategoryIds: ['beverages'], // an ANCESTOR of the coffee's own category
    });
    // Without includeDescendants only the item's own (nearest) category counts.
    const strict = evaluatePromotions({ context: context(), lines, rules: [ancestorOnly] });
    expect(strict.candidates[0]?.reasonCode).toBe(PROMOTION_REASON.NO_ELIGIBLE_UNITS);

    const permissive = evaluatePromotions({
      context: context(),
      lines,
      rules: [{ ...ancestorOnly, includeDescendants: true }],
    });
    expect(permissive.discountTotal.toFixed(2)).toBe('1.00');
  });

  it('branch, channel, segment, currency and authority each fail closed', () => {
    const base = rule({
      versionId: 'v-filter',
      benefitKind: 'AMOUNT_OFF',
      benefitAmount: d('1.00'),
    });
    const cases: [Partial<PromotionRule>, Partial<PromotionEvaluationContext>, string][] = [
      [{ allowedBranchIds: ['other-branch'] }, {}, PROMOTION_REASON.BRANCH_EXCLUDED],
      [{ allowedChannels: ['DELIVERY'] }, {}, PROMOTION_REASON.CHANNEL_EXCLUDED],
      [{ customerSegmentRef: 'vip' }, {}, PROMOTION_REASON.SEGMENT_EXCLUDED],
      [{ currency: 'EUR' }, {}, PROMOTION_REASON.CURRENCY_MISMATCH],
      [{ activationMode: 'MANAGER' }, {}, PROMOTION_REASON.AUTHORITY_REQUIRED],
      [
        { activationMode: 'COUPON_CODE', couponCodeHash: 'fingerprint-x' },
        {},
        PROMOTION_REASON.COUPON_NOT_PRESENTED,
      ],
      [{ offlinePolicy: 'ONLINE_ONLY' }, { online: false }, PROMOTION_REASON.ONLINE_REQUIRED],
      [{ status: 'SUPERSEDED' }, {}, PROMOTION_REASON.NOT_PUBLISHED],
    ];
    for (const [ruleOverride, contextOverride, expected] of cases) {
      const result = evaluatePromotions({
        context: context(contextOverride),
        lines: [line('item-a', '10.00')],
        rules: [{ ...base, ...ruleOverride }],
      });
      expect(result.candidates[0]?.reasonCode, JSON.stringify(ruleOverride)).toBe(expected);
      expect(result.discountTotal.toFixed(2)).toBe('0.00');
    }
  });

  it('a presented coupon admits its exact candidate without reordering', () => {
    const result = evaluatePromotions({
      context: context({ couponFingerprints: ['fingerprint-x'] }),
      lines: [line('item-a', '10.00')],
      rules: [
        rule({
          versionId: 'v-coupon',
          benefitKind: 'AMOUNT_OFF',
          benefitAmount: d('1.00'),
          activationMode: 'COUPON_CODE',
          couponCodeHash: 'fingerprint-x',
        }),
      ],
    });
    expect(result.discountTotal.toFixed(2)).toBe('1.00');
  });

  it('the per-order cap and maxApplicationsPerOrder both bound repeats', () => {
    const six = Array.from({ length: 6 }, (_, index) =>
      line(`item-${index}`, '5.00', { productId: 'same' })
    );
    const bogo = rule({
      versionId: 'v-free',
      benefitKind: 'BUY_X_GET_Y_FREE',
      buyQuantity: 2,
      getQuantity: 1,
    });
    const uncapped = evaluatePromotions({ context: context(), lines: six, rules: [bogo] });
    expect(uncapped.applications).toHaveLength(2);

    const capped = evaluatePromotions({
      context: context(),
      lines: six,
      rules: [{ ...bogo, perOrderCap: 1 }],
    });
    expect(capped.applications).toHaveLength(1);

    const limited = evaluatePromotions({
      context: context(),
      lines: six,
      rules: [{ ...bogo, maxApplicationsPerOrder: 1 }],
    });
    expect(limited.applications).toHaveLength(1);
  });

  it('maxBenefitAmount caps the total a rule may give across its applications', () => {
    const result = evaluatePromotions({
      context: context(),
      lines: [line('item-a', '100.00')],
      rules: [
        rule({
          versionId: 'v-capped',
          benefitKind: 'PERCENT_OFF',
          benefitBasisPoints: 5000,
          maxBenefitAmount: d('12.00'),
        }),
      ],
    });
    expect(result.discountTotal.toFixed(2)).toBe('12.00');
  });

  it('§8 a sold combo line is one unit, so its components never discount separately', () => {
    // The combo arrives as ONE priced order line. A rule targeting a component
    // product finds nothing, because the component is not an independently sold
    // unit in the order snapshot.
    const result = evaluatePromotions({
      context: context(),
      lines: [line('item-combo', '16.00', { productId: 'combo-meal' })],
      rules: [
        rule({
          versionId: 'v-component',
          benefitKind: 'PERCENT_OFF',
          benefitBasisPoints: 5000,
          targetKind: 'ITEM',
          targetProductIds: ['fries'], // a component of the combo
        }),
      ],
    });
    expect(result.discountTotal.toFixed(2)).toBe('0.00');
    expect(result.candidates[0]?.reasonCode).toBe(PROMOTION_REASON.NO_ELIGIBLE_UNITS);
  });
});

describe('promotion evaluator — §4.1 unit expansion', () => {
  it('a unit charge is the unit price plus its snapshotted modifier deltas', () => {
    const units = expandUnits([
      line('item-a', '10.00', { quantity: 2, modifierDeltas: [d('1.50'), d('0.50')] }),
    ]);
    expect(units).toHaveLength(2);
    expect(units[0]?.grossCharge.toFixed(2)).toBe('12.00');
    expect(units.map((unit) => unit.unitOrdinal)).toEqual([0, 1]);
  });

  it('a line comp is split across units exactly, with no lost cent', () => {
    const units = expandUnits([
      line('item-a', '10.00', { quantity: 3, compAllocation: d('10.00') }),
    ]);
    const shares = units.map((unit) => unit.compShare.toFixed(2));
    expect(shares).toEqual(['3.34', '3.33', '3.33']);
    const total = units.reduce((sum, unit) => sum.plus(unit.compShare), d(0));
    expect(total.toFixed(2)).toBe('10.00');
  });

  it('a comp covering the whole unit leaves zero eligible charge, never a credit', () => {
    const units = expandUnits([line('item-a', '10.00', { compAllocation: d('12.00') })]);
    expect(units[0]?.eligibleCharge.toFixed(2)).toBe('0.00');
  });
});
