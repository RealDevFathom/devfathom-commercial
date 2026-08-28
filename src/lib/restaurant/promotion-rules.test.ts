import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

import {
  evaluateEligibility,
  evaluatePromotions,
  isDayAllowed,
  isWithinDailyWindow,
  localWindowParts,
  matchItems,
  PromotionRuleError,
  subtotalOf,
  type PromotionCheckoutContext,
  type PromotionIneligibilityReason,
  type PromotionOrderItem,
  type PromotionRule,
} from './promotion-rules';

/**
 * WHA-288 — the promotion EVALUATOR TABLE.
 *
 * Every window, target, benefit, minimum, scope and stacking interaction the
 * lane promises gets a row here with an exact expected Decimal. Amounts are
 * compared as exact Decimal strings, never `toBeCloseTo`.
 */

const D = (value: string | number) => new Prisma.Decimal(value);

// Asia/Karachi is UTC+5 with no DST, so a local wall clock is exactly UTC+5 all
// year — the windows below stay readable without DST caveats.
const TZ = 'Asia/Karachi';
// 2026-08-28T09:00:00Z = Friday 2026-08-28 14:00 local. Friday = weekday 5.
const FRIDAY_1400 = new Date('2026-08-28T09:00:00Z');
const FRIDAY = 5;
const SATURDAY = 6;
const ALL_DAYS = 127;

const BRANCH = 'branch_main';
const OTHER_BRANCH = 'branch_other';

function item(overrides: Partial<PromotionOrderItem> & { id: string }): PromotionOrderItem {
  return {
    productId: `product_${overrides.id}`,
    categoryId: null,
    quantity: 1,
    unitPrice: D('100.00'),
    ...overrides,
  };
}

function rule(overrides: Partial<PromotionRule> & { ruleCode: string }): PromotionRule {
  return {
    promotionId: `promo_${overrides.ruleCode}`,
    promotionVersionId: `version_${overrides.ruleCode}`,
    versionNumber: 1,
    promotionCode: null,
    status: 'ACTIVE',
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    effectiveTo: null,
    startMinuteOfDay: null,
    endMinuteOfDay: null,
    dayMask: ALL_DAYS,
    targetScope: 'ORDER',
    productIds: [],
    categoryIds: [],
    channels: [],
    branchIds: [],
    benefitKind: 'PERCENTAGE_OFF',
    benefitRate: D('0.10'),
    benefitAmount: null,
    buyQuantity: null,
    getQuantity: null,
    minimumSubtotal: null,
    minimumItemQuantity: null,
    maximumDiscountAmount: null,
    stacking: 'EXCLUSIVE',
    priority: 0,
    authority: 'AUTOMATIC',
    ...overrides,
  };
}

function context(overrides: Partial<PromotionCheckoutContext> = {}): PromotionCheckoutContext {
  return {
    at: FRIDAY_1400,
    timeZone: TZ,
    branchId: BRANCH,
    channel: 'DINE_IN',
    items: [item({ id: 'a' })],
    ...overrides,
  };
}

describe('branch-local window primitives', () => {
  it('resolves the branch-local weekday and minute-of-day, not the UTC one', () => {
    // 09:00 UTC is 14:00 in Karachi; the same instant is still Friday in both.
    expect(localWindowParts(FRIDAY_1400, TZ)).toEqual({ weekday: FRIDAY, minuteOfDay: 14 * 60 });
    // 21:00 UTC Friday is already Saturday 02:00 in Karachi — the local day, not
    // the UTC day, is what a day mask must be tested against.
    expect(localWindowParts(new Date('2026-08-28T21:00:00Z'), TZ)).toEqual({
      weekday: SATURDAY,
      minuteOfDay: 2 * 60,
    });
  });

  it('rejects an unusable timezone rather than silently falling back to UTC', () => {
    expect(() => localWindowParts(FRIDAY_1400, 'Not/AZone')).toThrow(PromotionRuleError);
  });

  it('treats a start-after-end daily window as wrapping past midnight', () => {
    // 22:00 - 02:00 late-night offer.
    const start = 22 * 60;
    const end = 2 * 60;
    expect(isWithinDailyWindow(23 * 60, start, end)).toBe(true);
    expect(isWithinDailyWindow(0, start, end)).toBe(true);
    expect(isWithinDailyWindow(2 * 60, start, end)).toBe(true);
    expect(isWithinDailyWindow(2 * 60 + 1, start, end)).toBe(false);
    expect(isWithinDailyWindow(12 * 60, start, end)).toBe(false);
  });

  it('treats both daily bounds as inclusive and an absent window as always open', () => {
    expect(isWithinDailyWindow(600, 600, 900)).toBe(true);
    expect(isWithinDailyWindow(900, 600, 900)).toBe(true);
    expect(isWithinDailyWindow(599, 600, 900)).toBe(false);
    expect(isWithinDailyWindow(901, 600, 900)).toBe(false);
    expect(isWithinDailyWindow(0, null, null)).toBe(true);
  });

  it('reads the day mask as bit 0 = Sunday', () => {
    expect(isDayAllowed(0b0000001, 0)).toBe(true); // Sunday
    expect(isDayAllowed(0b0000001, FRIDAY)).toBe(false);
    expect(isDayAllowed(0b0100000, FRIDAY)).toBe(true);
    // Weekends only = Sunday + Saturday.
    expect(isDayAllowed(0b1000001, SATURDAY)).toBe(true);
    expect(isDayAllowed(0b1000001, FRIDAY)).toBe(false);
    expect(isDayAllowed(ALL_DAYS, FRIDAY)).toBe(true);
  });
});

describe('eligibility table', () => {
  const cases: {
    name: string;
    rule: PromotionRule;
    context: PromotionCheckoutContext;
    expected: PromotionIneligibilityReason | 'ELIGIBLE';
  }[] = [
    {
      name: 'an active, unscoped rule inside its range applies',
      rule: rule({ ruleCode: 'BASE' }),
      context: context(),
      expected: 'ELIGIBLE',
    },
    {
      name: 'a DRAFT version never applies',
      rule: rule({ ruleCode: 'DRAFT', status: 'DRAFT' }),
      context: context(),
      expected: 'NOT_ACTIVE',
    },
    {
      name: 'a SUPERSEDED version never applies',
      rule: rule({ ruleCode: 'OLD', status: 'SUPERSEDED' }),
      context: context(),
      expected: 'NOT_ACTIVE',
    },
    {
      name: 'before effectiveFrom',
      rule: rule({ ruleCode: 'FUTURE', effectiveFrom: new Date('2027-01-01T00:00:00Z') }),
      context: context(),
      expected: 'BEFORE_WINDOW',
    },
    {
      name: 'effectiveFrom is inclusive',
      rule: rule({ ruleCode: 'STARTS_NOW', effectiveFrom: FRIDAY_1400 }),
      context: context(),
      expected: 'ELIGIBLE',
    },
    {
      name: 'effectiveTo is exclusive',
      rule: rule({ ruleCode: 'ENDS_NOW', effectiveTo: FRIDAY_1400 }),
      context: context(),
      expected: 'AFTER_WINDOW',
    },
    {
      name: 'inside a closed calendar range',
      rule: rule({
        ruleCode: 'RANGE',
        effectiveFrom: new Date('2026-08-01T00:00:00Z'),
        effectiveTo: new Date('2026-09-01T00:00:00Z'),
      }),
      context: context(),
      expected: 'ELIGIBLE',
    },
    {
      name: 'a weekday not in the mask',
      rule: rule({ ruleCode: 'WEEKEND', dayMask: 0b1000001 }),
      context: context(),
      expected: 'DAY_NOT_ALLOWED',
    },
    {
      name: 'a weekday in the mask',
      rule: rule({ ruleCode: 'FRIDAYS', dayMask: 1 << FRIDAY }),
      context: context(),
      expected: 'ELIGIBLE',
    },
    {
      name: 'outside the branch-local daily window',
      rule: rule({ ruleCode: 'LUNCH', startMinuteOfDay: 11 * 60, endMinuteOfDay: 13 * 60 }),
      context: context(),
      expected: 'OUTSIDE_DAILY_WINDOW',
    },
    {
      name: 'inside the branch-local daily window',
      rule: rule({ ruleCode: 'AFTERNOON', startMinuteOfDay: 13 * 60, endMinuteOfDay: 15 * 60 }),
      context: context(),
      expected: 'ELIGIBLE',
    },
    {
      name: 'a wrapping late-night window excludes the afternoon',
      rule: rule({ ruleCode: 'LATE', startMinuteOfDay: 22 * 60, endMinuteOfDay: 2 * 60 }),
      context: context(),
      expected: 'OUTSIDE_DAILY_WINDOW',
    },
    {
      name: 'a wrapping late-night window includes 01:00 local',
      rule: rule({ ruleCode: 'LATE', startMinuteOfDay: 22 * 60, endMinuteOfDay: 2 * 60 }),
      // 20:00 UTC = 01:00 local the next day.
      context: context({ at: new Date('2026-08-28T20:00:00Z') }),
      expected: 'ELIGIBLE',
    },
    {
      name: 'a channel outside the rule set',
      rule: rule({ ruleCode: 'DELIVERY_ONLY', channels: ['DELIVERY'] }),
      context: context(),
      expected: 'CHANNEL_NOT_ALLOWED',
    },
    {
      name: 'a channel inside the rule set',
      rule: rule({ ruleCode: 'DINE_OR_TAKE', channels: ['DINE_IN', 'TAKEAWAY'] }),
      context: context(),
      expected: 'ELIGIBLE',
    },
    {
      name: 'an empty channel set means every channel',
      rule: rule({ ruleCode: 'ANY_CHANNEL', channels: [] }),
      context: context({ channel: 'DELIVERY' }),
      expected: 'ELIGIBLE',
    },
    {
      name: 'a branch outside the rule set',
      rule: rule({ ruleCode: 'OTHER_BRANCH', branchIds: [OTHER_BRANCH] }),
      context: context(),
      expected: 'BRANCH_NOT_ALLOWED',
    },
    {
      name: 'an empty branch set means every branch',
      rule: rule({ ruleCode: 'ANY_BRANCH', branchIds: [] }),
      context: context(),
      expected: 'ELIGIBLE',
    },
    {
      name: 'a code rule whose code was not presented',
      rule: rule({ ruleCode: 'CODED', authority: 'CUSTOMER_CODE', promotionCode: 'EID25' }),
      context: context(),
      expected: 'CODE_NOT_PRESENTED',
    },
    {
      name: 'a code rule whose code was presented',
      rule: rule({ ruleCode: 'CODED', authority: 'CUSTOMER_CODE', promotionCode: 'EID25' }),
      context: context({ presentedCodes: ['EID25'] }),
      expected: 'ELIGIBLE',
    },
    {
      name: 'a product-scoped rule with no matching item',
      rule: rule({ ruleCode: 'PRODUCT', targetScope: 'PRODUCT', productIds: ['product_zzz'] }),
      context: context(),
      expected: 'NO_MATCHING_ITEMS',
    },
    {
      name: 'a product-scoped rule with a matching item',
      rule: rule({ ruleCode: 'PRODUCT', targetScope: 'PRODUCT', productIds: ['product_a'] }),
      context: context(),
      expected: 'ELIGIBLE',
    },
    {
      name: 'a category-scoped rule with a matching item',
      rule: rule({ ruleCode: 'CATEGORY', targetScope: 'CATEGORY', categoryIds: ['cat_dessert'] }),
      context: context({ items: [item({ id: 'a', categoryId: 'cat_dessert' })] }),
      expected: 'ELIGIBLE',
    },
    {
      name: 'a category-scoped rule ignores an uncategorised item',
      rule: rule({ ruleCode: 'CATEGORY', targetScope: 'CATEGORY', categoryIds: ['cat_dessert'] }),
      context: context(),
      expected: 'NO_MATCHING_ITEMS',
    },
    {
      name: 'below the minimum subtotal',
      rule: rule({ ruleCode: 'SPEND', minimumSubtotal: D('500.00') }),
      context: context(),
      expected: 'BELOW_MINIMUM_SUBTOTAL',
    },
    {
      name: 'exactly at the minimum subtotal',
      rule: rule({ ruleCode: 'SPEND', minimumSubtotal: D('100.00') }),
      context: context(),
      expected: 'ELIGIBLE',
    },
    {
      name: 'below the minimum item quantity',
      rule: rule({ ruleCode: 'THREE_ITEMS', minimumItemQuantity: 3 }),
      context: context(),
      expected: 'BELOW_MINIMUM_QUANTITY',
    },
    {
      name: 'exactly at the minimum item quantity',
      rule: rule({ ruleCode: 'THREE_ITEMS', minimumItemQuantity: 3 }),
      context: context({ items: [item({ id: 'a', quantity: 3 })] }),
      expected: 'ELIGIBLE',
    },
    {
      name: 'a minimum is measured against the whole check, not the targeted subset',
      rule: rule({
        ruleCode: 'SPEND_ON_DESSERT',
        targetScope: 'CATEGORY',
        categoryIds: ['cat_dessert'],
        minimumSubtotal: D('300.00'),
      }),
      context: context({
        items: [
          item({ id: 'a', categoryId: 'cat_dessert', unitPrice: D('100.00') }),
          item({ id: 'b', categoryId: 'cat_main', unitPrice: D('250.00') }),
        ],
      }),
      expected: 'ELIGIBLE',
    },
    {
      name: 'an exhausted cap is not offered',
      rule: rule({ ruleCode: 'CAPPED' }),
      context: context({ remainingRedemptions: new Map([['version_CAPPED', 0]]) }),
      expected: 'CAP_EXHAUSTED',
    },
    {
      name: 'a cap with room left is offered',
      rule: rule({ ruleCode: 'CAPPED' }),
      context: context({ remainingRedemptions: new Map([['version_CAPPED', 1]]) }),
      expected: 'ELIGIBLE',
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const verdict = evaluateEligibility(testCase.rule, testCase.context);
      if (testCase.expected === 'ELIGIBLE') {
        expect(verdict.eligible).toBe(true);
      } else {
        expect(verdict).toEqual({ eligible: false, reason: testCase.expected });
      }
    });
  }
});

describe('target matching', () => {
  const items = [
    item({ id: 'a', productId: 'p1', categoryId: 'c1' }),
    item({ id: 'b', productId: 'p2', categoryId: 'c2' }),
    item({ id: 'c', productId: 'p3', categoryId: null }),
  ];

  it('ORDER scope matches every item', () => {
    expect(matchItems(rule({ ruleCode: 'R' }), items).map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('PRODUCT scope matches only the named products', () => {
    const matched = matchItems(
      rule({ ruleCode: 'R', targetScope: 'PRODUCT', productIds: ['p1', 'p3'] }),
      items
    );
    expect(matched.map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('CATEGORY scope never matches an uncategorised item', () => {
    const matched = matchItems(
      rule({ ruleCode: 'R', targetScope: 'CATEGORY', categoryIds: ['c1', 'c2'] }),
      items
    );
    expect(matched.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('sums a set at exact Decimal scale', () => {
    expect(subtotalOf([item({ id: 'a', unitPrice: D('33.33'), quantity: 3 })]).toFixed(2)).toBe(
      '99.99'
    );
  });
});

describe('benefit arithmetic', () => {
  const evaluateOne = (r: PromotionRule, ctx: PromotionCheckoutContext) => {
    const result = evaluatePromotions([r], ctx);
    return result.totalDiscount.toFixed(2);
  };

  it('PERCENTAGE_OFF takes the rate off the matched subtotal, rounded half-up once', () => {
    // 3 x 33.33 = 99.99; 12.5% = 12.49875 -> 12.50 at ROUND_HALF_UP.
    expect(
      evaluateOne(
        rule({ ruleCode: 'PCT', benefitKind: 'PERCENTAGE_OFF', benefitRate: D('0.125') }),
        context({ items: [item({ id: 'a', unitPrice: D('33.33'), quantity: 3 })] })
      )
    ).toBe('12.50');
  });

  it('PERCENTAGE_OFF on a targeted subset ignores the untargeted items', () => {
    expect(
      evaluateOne(
        rule({
          ruleCode: 'PCT',
          targetScope: 'CATEGORY',
          categoryIds: ['cat_dessert'],
          benefitRate: D('0.20'),
        }),
        context({
          items: [
            item({ id: 'a', categoryId: 'cat_dessert', unitPrice: D('250.00') }),
            item({ id: 'b', categoryId: 'cat_main', unitPrice: D('900.00') }),
          ],
        })
      )
    ).toBe('50.00');
  });

  it('AMOUNT_OFF takes a flat amount and never more than the set is worth', () => {
    expect(
      evaluateOne(
        rule({
          ruleCode: 'FLAT',
          benefitKind: 'AMOUNT_OFF',
          benefitRate: null,
          benefitAmount: D('150.00'),
        }),
        context({ items: [item({ id: 'a', unitPrice: D('400.00') })] })
      )
    ).toBe('150.00');
    expect(
      evaluateOne(
        rule({
          ruleCode: 'FLAT',
          benefitKind: 'AMOUNT_OFF',
          benefitRate: null,
          benefitAmount: D('500.00'),
        }),
        context({ items: [item({ id: 'a', unitPrice: D('400.00') })] })
      )
    ).toBe('400.00');
  });

  it('FIXED_PRICE re-prices each matched unit and never becomes a surcharge', () => {
    // Two units at 250 re-priced to 199 = 51 x 2; the 150 unit is already below
    // the fixed price and is left alone.
    expect(
      evaluateOne(
        rule({
          ruleCode: 'FIXED',
          benefitKind: 'FIXED_PRICE',
          benefitRate: null,
          benefitAmount: D('199.00'),
        }),
        context({
          items: [
            item({ id: 'a', unitPrice: D('250.00'), quantity: 2 }),
            item({ id: 'b', unitPrice: D('150.00'), quantity: 1 }),
          ],
        })
      )
    ).toBe('102.00');
  });

  it('FREE_ITEM gives away the cheapest matched units, not the dearest', () => {
    expect(
      evaluateOne(
        rule({
          ruleCode: 'FREE',
          benefitKind: 'FREE_ITEM',
          benefitRate: null,
          getQuantity: 2,
        }),
        context({
          items: [
            item({ id: 'a', unitPrice: D('500.00') }),
            item({ id: 'b', unitPrice: D('120.00') }),
            item({ id: 'c', unitPrice: D('80.00') }),
          ],
        })
      )
    ).toBe('200.00');
  });

  it('BUY_X_GET_Y frees the cheapest unit of each complete group and ignores the remainder', () => {
    // Five units at 100: buy 2 get 1 -> one complete group of 3 uses the two
    // dearest units and frees the third; the trailing 2 units earn nothing.
    expect(
      evaluateOne(
        rule({
          ruleCode: 'BXGY',
          benefitKind: 'BUY_X_GET_Y',
          benefitRate: null,
          buyQuantity: 2,
          getQuantity: 1,
        }),
        context({ items: [item({ id: 'a', unitPrice: D('100.00'), quantity: 5 })] })
      )
    ).toBe('100.00');
  });

  it('BUY_X_GET_Y earns nothing below one complete group', () => {
    expect(
      evaluateOne(
        rule({
          ruleCode: 'BXGY',
          benefitKind: 'BUY_X_GET_Y',
          benefitRate: null,
          buyQuantity: 2,
          getQuantity: 1,
        }),
        context({ items: [item({ id: 'a', unitPrice: D('100.00'), quantity: 2 })] })
      )
    ).toBe('0.00');
  });

  it('maximumDiscountAmount caps a percentage offer', () => {
    expect(
      evaluateOne(
        rule({
          ruleCode: 'CAPPED_PCT',
          benefitRate: D('0.50'),
          maximumDiscountAmount: D('300.00'),
        }),
        context({ items: [item({ id: 'a', unitPrice: D('1000.00') })] })
      )
    ).toBe('300.00');
  });

  it('raises rather than silently discounting zero when an operand is missing', () => {
    expect(() =>
      evaluatePromotions(
        [rule({ ruleCode: 'BROKEN', benefitKind: 'PERCENTAGE_OFF', benefitRate: null })],
        context()
      )
    ).toThrow(PromotionRuleError);
  });
});

describe('deterministic stacking', () => {
  const twoItems = context({
    items: [
      item({ id: 'a', productId: 'p1', categoryId: 'c1', unitPrice: D('600.00') }),
      item({ id: 'b', productId: 'p2', categoryId: 'c2', unitPrice: D('400.00') }),
    ],
  });

  it('an EXCLUSIVE promotion applies alone and closes the check', () => {
    const result = evaluatePromotions(
      [
        rule({ ruleCode: 'EXCL', stacking: 'EXCLUSIVE', priority: 10, benefitRate: D('0.20') }),
        rule({ ruleCode: 'STACK', stacking: 'STACKABLE', priority: 5, benefitRate: D('0.10') }),
      ],
      twoItems
    );
    expect(result.applications.map((a) => a.ruleCode)).toEqual(['EXCL']);
    expect(result.totalDiscount.toFixed(2)).toBe('200.00');
  });

  it('an EXCLUSIVE promotion cannot join a set that already started', () => {
    const result = evaluatePromotions(
      [
        rule({ ruleCode: 'STACK', stacking: 'STACKABLE', priority: 10, benefitRate: D('0.10') }),
        rule({ ruleCode: 'EXCL', stacking: 'EXCLUSIVE', priority: 5, benefitRate: D('0.50') }),
      ],
      twoItems
    );
    expect(result.applications.map((a) => a.ruleCode)).toEqual(['STACK']);
    expect(result.totalDiscount.toFixed(2)).toBe('100.00');
  });

  it('STACKABLE promotions compose in priority order', () => {
    const result = evaluatePromotions(
      [
        rule({
          ruleCode: 'LOW',
          stacking: 'STACKABLE',
          priority: 1,
          targetScope: 'PRODUCT',
          productIds: ['p2'],
          benefitRate: D('0.25'),
        }),
        rule({
          ruleCode: 'HIGH',
          stacking: 'STACKABLE',
          priority: 9,
          targetScope: 'PRODUCT',
          productIds: ['p1'],
          benefitRate: D('0.10'),
        }),
      ],
      twoItems
    );
    expect(result.applications.map((a) => [a.sequence, a.ruleCode])).toEqual([
      [1, 'HIGH'],
      [2, 'LOW'],
    ]);
    // 10% of 600 then 25% of 400.
    expect(result.applications.map((a) => a.discountAmount.toFixed(2))).toEqual([
      '60.00',
      '100.00',
    ]);
    expect(result.totalDiscount.toFixed(2)).toBe('160.00');
  });

  it('at equal priority the larger provisional discount is applied first', () => {
    const result = evaluatePromotions(
      [
        rule({ ruleCode: 'SMALL', stacking: 'STACKABLE', priority: 0, benefitRate: D('0.05') }),
        rule({ ruleCode: 'BIG', stacking: 'STACKABLE', priority: 0, benefitRate: D('0.30') }),
      ],
      twoItems
    );
    expect(result.applications.map((a) => a.ruleCode)).toEqual(['BIG', 'SMALL']);
  });

  it('breaks a total tie on ruleCode so the outcome never depends on input order', () => {
    const alpha = rule({
      ruleCode: 'AAA',
      stacking: 'STACKABLE',
      targetScope: 'PRODUCT',
      productIds: ['p1'],
      benefitRate: D('0.10'),
    });
    const beta = rule({
      ruleCode: 'BBB',
      stacking: 'STACKABLE',
      targetScope: 'PRODUCT',
      productIds: ['p2'],
      benefitRate: D('0.15'),
    });
    // Same priority, and both provisionals are 60.00 — only the ruleCode decides.
    const forward = evaluatePromotions([alpha, beta], twoItems);
    const reversed = evaluatePromotions([beta, alpha], twoItems);
    expect(forward.applications.map((a) => a.ruleCode)).toEqual(['AAA', 'BBB']);
    expect(reversed.applications.map((a) => a.ruleCode)).toEqual(['AAA', 'BBB']);
    expect(forward.totalDiscount.toFixed(2)).toBe(reversed.totalDiscount.toFixed(2));
  });

  it('never lets overlapping stackable rules take more than the check is worth', () => {
    // Three 50% offers on the same 1000.00 check would be 1500.00 unguarded.
    const overlapping = [
      rule({ ruleCode: 'ONE', stacking: 'STACKABLE', priority: 3, benefitRate: D('0.50') }),
      rule({ ruleCode: 'TWO', stacking: 'STACKABLE', priority: 2, benefitRate: D('0.50') }),
      rule({ ruleCode: 'THREE', stacking: 'STACKABLE', priority: 1, benefitRate: D('0.50') }),
    ];
    const result = evaluatePromotions(overlapping, twoItems);
    expect(result.totalDiscount.toFixed(2)).toBe('1000.00');
    // ONE takes its full 500. TWO wants 500 too and the remaining balances still
    // cover it exactly. THREE finds nothing left and is dropped rather than
    // recorded at zero — the floor binds on the third rule, not on the total.
    expect(result.applications.map((a) => a.discountAmount.toFixed(2))).toEqual([
      '500.00',
      '500.00',
    ]);
    expect(result.rejected).toContainEqual({ ruleCode: 'THREE', reason: 'NO_MATCHING_ITEMS' });
    // And the check floors at zero, never below.
    const subtotal = subtotalOf(twoItems.items);
    expect(subtotal.minus(result.totalDiscount).toFixed(2)).toBe('0.00');
  });

  it('drops a rule that is fully absorbed by earlier applications rather than recording a zero', () => {
    const result = evaluatePromotions(
      [
        rule({ ruleCode: 'ALL', stacking: 'STACKABLE', priority: 9, benefitRate: D('1') }),
        rule({ ruleCode: 'MORE', stacking: 'STACKABLE', priority: 1, benefitRate: D('0.10') }),
      ],
      twoItems
    );
    expect(result.applications.map((a) => a.ruleCode)).toEqual(['ALL']);
    expect(result.rejected).toContainEqual({ ruleCode: 'MORE', reason: 'NO_MATCHING_ITEMS' });
  });

  it('numbers applications from 1 with no gaps, and the item parts sum to the amount', () => {
    const result = evaluatePromotions(
      [
        rule({ ruleCode: 'A', stacking: 'STACKABLE', priority: 2, benefitRate: D('0.10') }),
        rule({ ruleCode: 'B', stacking: 'STACKABLE', priority: 1, benefitRate: D('0.10') }),
      ],
      twoItems
    );
    expect(result.applications.map((a) => a.sequence)).toEqual([1, 2]);
    for (const application of result.applications) {
      const parts = [...application.itemDiscounts.values()];
      const total = parts.reduce((acc, part) => acc.plus(part), new Prisma.Decimal(0));
      expect(total.toFixed(2)).toBe(application.discountAmount.toFixed(2));
    }
  });

  it('is reproducible: the same input evaluates identically every time', () => {
    const rules = [
      rule({ ruleCode: 'P1', stacking: 'STACKABLE', priority: 5, benefitRate: D('0.07') }),
      rule({ ruleCode: 'P2', stacking: 'STACKABLE', priority: 5, benefitRate: D('0.07') }),
      rule({ ruleCode: 'P3', stacking: 'STACKABLE', priority: 5, benefitRate: D('0.07') }),
    ];
    const signature = (ctx: PromotionCheckoutContext) =>
      evaluatePromotions(rules, ctx).applications.map(
        (a) => `${a.sequence}:${a.ruleCode}:${a.discountAmount.toFixed(2)}`
      );
    expect(signature(twoItems)).toEqual(signature(twoItems));
    // Each rate is taken against the item's OWN snapshot price, not against the
    // balance left by the previous application, so three 7% offers are 7% three
    // times over — not a compounding 7% of a shrinking base.
    expect(signature(twoItems)).toEqual(['1:P1:70.00', '2:P2:70.00', '3:P3:70.00']);
  });
});
