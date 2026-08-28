import 'server-only';

import { Prisma } from '@/generated/prisma/client';

import { add, compare, money, multiply, roundMoney, sub, sum, ZERO } from './money';

/**
 * WHA-288 Promotions Lane A — the promotion EVALUATOR.
 *
 * Pure and I/O-free: the caller loads the candidate rules and the check, this
 * module decides which promotions are eligible, what each one takes off, and in
 * what order. Persisting the outcome is promotion-snapshots.ts; enforcing the
 * redemption caps against concurrent terminals is promotion-caps.ts.
 *
 * Two properties are load-bearing, and both are the reason this lives in one
 * pure module rather than inline in a checkout handler:
 *
 *   DETERMINISM. Identical input produces an identical, byte-reproducible
 *   outcome — the same promotions, the same amounts, in the same sequence. The
 *   evaluation order is a TOTAL order (priority, then provisional discount, then
 *   ruleCode), never a partial one, so no tie is ever settled by input order or
 *   by map iteration. Where a benefit must choose which units it discounts
 *   (FREE_ITEM, BUY_X_GET_Y), the choice is pinned — cheapest units first, ties
 *   broken by item id — not left to the guest or the terminal.
 *
 *   NO EMERGENT STACKING. Discount is allocated against a per-item REMAINING
 *   balance that every application decrements. Three overlapping offers on one
 *   item can therefore never take off more than the item is worth, and no
 *   combination of individually-sane rules composes into a negative check. The
 *   floor is enforced per item, so it holds for order-scoped and item-scoped
 *   promotions alike.
 *
 * Money is Decimal throughout, via money.ts — no float, no epsilon comparison.
 * A percentage benefit is a Decimal rate in [0,1] (the tax-core convention);
 * the product is rounded ROUND_HALF_UP at 2dp exactly once, at the point the
 * benefit amount is produced.
 */

/** Mirrors the Prisma `RestaurantVersionStatus` enum. */
export type PromotionVersionStatus = 'DRAFT' | 'ACTIVE' | 'SUPERSEDED';

/** Mirrors the Prisma `RestaurantOrderChannel` enum. */
export type PromotionChannel = 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';

/** Mirrors the Prisma `RestaurantPromotionTargetScope` enum. */
export type PromotionTargetScope = 'ORDER' | 'CATEGORY' | 'PRODUCT';

/** Mirrors the Prisma `RestaurantPromotionBenefitKind` enum. */
export type PromotionBenefitKind =
  'PERCENTAGE_OFF' | 'AMOUNT_OFF' | 'FIXED_PRICE' | 'FREE_ITEM' | 'BUY_X_GET_Y';

/** Mirrors the Prisma `RestaurantPromotionStackingMode` enum. */
export type PromotionStackingMode = 'EXCLUSIVE' | 'STACKABLE';

/** Mirrors the Prisma `RestaurantPromotionAuthority` enum. */
export type PromotionAuthority = 'AUTOMATIC' | 'CUSTOMER_CODE' | 'MANAGER_OVERRIDE';

/** Raised when a rule is internally inconsistent — the operand a benefit kind
 * requires is missing. The DB CHECK constraints make this unreachable for
 * persisted rules; it exists so a hand-built rule fails loudly, not silently at
 * zero. */
export class PromotionRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromotionRuleError';
  }
}

/**
 * One order item as the evaluator sees it: the frozen unit-price snapshot, an
 * integer quantity, and the catalog coordinates a target matches on. The
 * evaluator NEVER reads a price list — the order item's own snapshot is the
 * authoritative price (C4).
 */
export type PromotionOrderItem = {
  id: string;
  productId: string;
  categoryId: string | null;
  quantity: number;
  unitPrice: Prisma.Decimal;
};

/**
 * A candidate rule, flattened from a promotion version and its child target,
 * channel and branch rows. Empty `channels`/`branchIds` mean "every channel" /
 * "every branch": scoping is opt-in, and absence is never a deny.
 */
export type PromotionRule = {
  promotionId: string;
  promotionVersionId: string;
  versionNumber: number;
  ruleCode: string;
  promotionCode: string | null;
  status: PromotionVersionStatus;

  effectiveFrom: Date;
  effectiveTo: Date | null;
  /** Branch-local minute-of-day window; start > end wraps past midnight. */
  startMinuteOfDay: number | null;
  endMinuteOfDay: number | null;
  /** 7-bit branch-local weekday mask, bit 0 = Sunday. */
  dayMask: number;

  targetScope: PromotionTargetScope;
  productIds: readonly string[];
  categoryIds: readonly string[];
  channels: readonly PromotionChannel[];
  branchIds: readonly string[];

  benefitKind: PromotionBenefitKind;
  benefitRate: Prisma.Decimal | null;
  benefitAmount: Prisma.Decimal | null;
  buyQuantity: number | null;
  getQuantity: number | null;

  minimumSubtotal: Prisma.Decimal | null;
  minimumItemQuantity: number | null;
  maximumDiscountAmount: Prisma.Decimal | null;

  stacking: PromotionStackingMode;
  priority: number;
  /** How this rule would be authorized if it applies. A CUSTOMER_CODE rule only
   * becomes eligible once its code appears in the context's presented codes. */
  authority: PromotionAuthority;
};

/** The check being evaluated, at the instant it is evaluated. */
export type PromotionCheckoutContext = {
  /** The SERVER instant. Client time is untrusted (C5/C6). */
  at: Date;
  /** The branch's IANA timezone — windows are branch-local, never UTC. */
  timeZone: string;
  branchId: string;
  channel: PromotionChannel;
  items: readonly PromotionOrderItem[];
  /** Codes the guest presented at the till. A CUSTOMER_CODE rule whose code is
   * absent is not eligible; an AUTOMATIC rule ignores this entirely. */
  presentedCodes?: readonly string[];
  /**
   * Remaining redemptions per promotion version, when the caller already knows
   * a cap is exhausted. A version absent from the map is unconstrained here;
   * the AUTHORITATIVE cap enforcement is the ordinal claim in
   * promotion-caps.ts, not this hint — this only avoids offering the guest a
   * discount that is certain to be refused.
   */
  remainingRedemptions?: ReadonlyMap<string, number>;
};

/** Why a rule did or did not apply — the vocabulary the evaluator table test
 * asserts against, and the reason surfaced to an operator asking "why not?". */
export type PromotionIneligibilityReason =
  | 'NOT_ACTIVE'
  | 'BEFORE_WINDOW'
  | 'AFTER_WINDOW'
  | 'DAY_NOT_ALLOWED'
  | 'OUTSIDE_DAILY_WINDOW'
  | 'CHANNEL_NOT_ALLOWED'
  | 'BRANCH_NOT_ALLOWED'
  | 'CODE_NOT_PRESENTED'
  | 'NO_MATCHING_ITEMS'
  | 'BELOW_MINIMUM_SUBTOTAL'
  | 'BELOW_MINIMUM_QUANTITY'
  | 'CAP_EXHAUSTED';

export type PromotionEligibility =
  | { eligible: true; matchedItemIds: readonly string[] }
  | { eligible: false; reason: PromotionIneligibilityReason };

/** One promotion that applied, with the money it took off and its position in
 * the deterministic order. `sequence` is 1-based and is what makes a later
 * reconstruction order-stable. */
export type PromotionApplicationPlan = {
  sequence: number;
  promotionId: string;
  promotionVersionId: string;
  versionNumber: number;
  ruleCode: string;
  promotionCode: string | null;
  targetScope: PromotionTargetScope;
  benefitKind: PromotionBenefitKind;
  benefitRate: Prisma.Decimal | null;
  benefitAmount: Prisma.Decimal | null;
  authority: PromotionAuthority;
  discountAmount: Prisma.Decimal;
  /** Per-item breakdown of `discountAmount`; the parts sum to it exactly. */
  itemDiscounts: ReadonlyMap<string, Prisma.Decimal>;
};

export type PromotionEvaluation = {
  applications: readonly PromotionApplicationPlan[];
  /** Σ of every application's discount. Never exceeds the order subtotal. */
  totalDiscount: Prisma.Decimal;
  /** Every candidate that did not apply, with the reason it did not. */
  rejected: readonly { ruleCode: string; reason: PromotionIneligibilityReason }[];
};

const MINUTES_PER_DAY = 1440;

/**
 * The branch-local weekday and minute-of-day of a server instant, via `Intl` so
 * the platform tz database handles DST rather than manual offset math (the same
 * approach business-date.ts takes for the business date).
 */
export function localWindowParts(
  instant: Date,
  timeZone: string
): { weekday: number; minuteOfDay: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(instant);
  } catch {
    throw new PromotionRuleError(`Invalid IANA timezone "${timeZone}".`);
  }
  const lookup = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekday = weekdays.indexOf(lookup('weekday'));
  if (weekday < 0) {
    throw new PromotionRuleError(`Could not resolve a weekday in timezone "${timeZone}".`);
  }
  return { weekday, minuteOfDay: Number(lookup('hour')) * 60 + Number(lookup('minute')) };
}

/** True iff `minuteOfDay` falls in the rule's daily window. A window whose
 * start is greater than its end WRAPS past midnight (22:00-02:00), which is a
 * supported late-night configuration, not a mistake. Both bounds inclusive. */
export function isWithinDailyWindow(
  minuteOfDay: number,
  startMinuteOfDay: number | null,
  endMinuteOfDay: number | null
): boolean {
  if (startMinuteOfDay === null || endMinuteOfDay === null) return true;
  const start = ((startMinuteOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const end = ((endMinuteOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return start <= end
    ? minuteOfDay >= start && minuteOfDay <= end
    : minuteOfDay >= start || minuteOfDay <= end;
}

/** True iff the rule's 7-bit mask has the branch-local weekday set (bit 0 =
 * Sunday). */
export function isDayAllowed(dayMask: number, weekday: number): boolean {
  return (dayMask & (1 << weekday)) !== 0;
}

/** The items a rule targets: every item for ORDER scope, the named products for
 * PRODUCT scope, items in the named categories for CATEGORY scope. */
export function matchItems(
  rule: PromotionRule,
  items: readonly PromotionOrderItem[]
): PromotionOrderItem[] {
  if (rule.targetScope === 'ORDER') return [...items];
  if (rule.targetScope === 'PRODUCT') {
    const wanted = new Set(rule.productIds);
    return items.filter((item) => wanted.has(item.productId));
  }
  const wanted = new Set(rule.categoryIds);
  return items.filter((item) => item.categoryId !== null && wanted.has(item.categoryId));
}

/** Σ unitPrice × quantity over the given items — the gross value of the set
 * before any discount. */
export function subtotalOf(items: readonly PromotionOrderItem[]): Prisma.Decimal {
  return sum(items.map((item) => multiply(item.unitPrice, item.quantity)));
}

/**
 * Decide whether a rule may apply to this check, and say why when it may not.
 *
 * The gates compose as an AND and are evaluated in a FIXED order, so the
 * reported reason is stable: lifecycle, calendar range, weekday, daily window,
 * channel, branch, code presentation, target match, minimums, cap hint. The
 * order runs cheapest and most-decisive first — a superseded rule never reaches
 * the item scan.
 */
export function evaluateEligibility(
  rule: PromotionRule,
  context: PromotionCheckoutContext
): PromotionEligibility {
  if (rule.status !== 'ACTIVE') return { eligible: false, reason: 'NOT_ACTIVE' };

  const at = context.at.getTime();
  if (at < rule.effectiveFrom.getTime()) return { eligible: false, reason: 'BEFORE_WINDOW' };
  // `effectiveTo` is the exclusive end of the range, matching the DB CHECK.
  if (rule.effectiveTo !== null && at >= rule.effectiveTo.getTime()) {
    return { eligible: false, reason: 'AFTER_WINDOW' };
  }

  const local = localWindowParts(context.at, context.timeZone);
  if (!isDayAllowed(rule.dayMask, local.weekday)) {
    return { eligible: false, reason: 'DAY_NOT_ALLOWED' };
  }
  if (!isWithinDailyWindow(local.minuteOfDay, rule.startMinuteOfDay, rule.endMinuteOfDay)) {
    return { eligible: false, reason: 'OUTSIDE_DAILY_WINDOW' };
  }

  if (rule.channels.length > 0 && !rule.channels.includes(context.channel)) {
    return { eligible: false, reason: 'CHANNEL_NOT_ALLOWED' };
  }
  if (rule.branchIds.length > 0 && !rule.branchIds.includes(context.branchId)) {
    return { eligible: false, reason: 'BRANCH_NOT_ALLOWED' };
  }

  if (rule.authority === 'CUSTOMER_CODE') {
    const presented = context.presentedCodes ?? [];
    if (rule.promotionCode === null || !presented.includes(rule.promotionCode)) {
      return { eligible: false, reason: 'CODE_NOT_PRESENTED' };
    }
  }

  const matched = matchItems(rule, context.items);
  if (matched.length === 0) return { eligible: false, reason: 'NO_MATCHING_ITEMS' };

  // Minimums are measured against the WHOLE check, not the matched subset: "spend
  // 2000 to get 10% off desserts" is a threshold on the check, not on desserts.
  if (rule.minimumSubtotal !== null) {
    if (compare(subtotalOf(context.items), rule.minimumSubtotal) < 0) {
      return { eligible: false, reason: 'BELOW_MINIMUM_SUBTOTAL' };
    }
  }
  if (rule.minimumItemQuantity !== null) {
    const units = context.items.reduce((total, item) => total + item.quantity, 0);
    if (units < rule.minimumItemQuantity) {
      return { eligible: false, reason: 'BELOW_MINIMUM_QUANTITY' };
    }
  }

  const remaining = context.remainingRedemptions?.get(rule.promotionVersionId);
  if (remaining !== undefined && remaining <= 0) {
    return { eligible: false, reason: 'CAP_EXHAUSTED' };
  }

  return { eligible: true, matchedItemIds: matched.map((item) => item.id) };
}

/** One sellable unit, exploded from an item's quantity — the granularity
 * FREE_ITEM and BUY_X_GET_Y reason about. */
type Unit = { itemId: string; unitPrice: Prisma.Decimal };

/** Explode items into units in a deterministic order: ascending unit price,
 * ties broken by ascending item id, then by the unit's index within its item. */
function explodeUnits(items: readonly PromotionOrderItem[]): Unit[] {
  const units: Unit[] = [];
  for (const item of items) {
    for (let index = 0; index < item.quantity; index += 1) {
      units.push({ itemId: item.id, unitPrice: item.unitPrice });
    }
  }
  return units.sort((a, b) => {
    const byPrice = compare(a.unitPrice, b.unitPrice);
    if (byPrice !== 0) return byPrice;
    return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0;
  });
}

function requireDecimal(
  value: Prisma.Decimal | null,
  rule: PromotionRule,
  field: string
): Prisma.Decimal {
  if (value === null) {
    throw new PromotionRuleError(
      `Rule ${rule.ruleCode} is ${rule.benefitKind} but carries no ${field}.`
    );
  }
  return money(value);
}

function requireInteger(value: number | null, rule: PromotionRule, field: string): number {
  if (value === null) {
    throw new PromotionRuleError(
      `Rule ${rule.ruleCode} is ${rule.benefitKind} but carries no ${field}.`
    );
  }
  return value;
}

/**
 * The gross benefit a rule confers on `matched`, BEFORE the per-item remaining
 * floor and the rule's own maximum are applied. Returned per unit so the caller
 * can allocate the discount to specific items.
 *
 * PERCENTAGE_OFF  rate × the matched subtotal, rounded once at 2dp.
 * AMOUNT_OFF      a flat amount off the matched set, never more than it is worth.
 * FIXED_PRICE     each matched unit is re-priced to `benefitAmount`; a unit
 *                 already cheaper than that is untouched (never a surcharge).
 * FREE_ITEM       the `getQuantity` CHEAPEST matched units are free.
 * BUY_X_GET_Y     the units are chunked into groups of (buy + get) taking the
 *                 most expensive first; within each complete group the `get`
 *                 cheapest units are free. Incomplete trailing groups earn
 *                 nothing.
 */
function grossBenefitByUnit(
  rule: PromotionRule,
  matched: readonly PromotionOrderItem[]
): Map<string, Prisma.Decimal> {
  const perItem = new Map<string, Prisma.Decimal>();
  const addTo = (itemId: string, amount: Prisma.Decimal) => {
    perItem.set(itemId, add(perItem.get(itemId) ?? ZERO, amount));
  };

  switch (rule.benefitKind) {
    case 'PERCENTAGE_OFF': {
      const rate = requireDecimal(rule.benefitRate, rule, 'benefitRate');
      for (const item of matched) {
        addTo(item.id, roundMoney(multiply(multiply(item.unitPrice, item.quantity), rate)));
      }
      return perItem;
    }
    case 'AMOUNT_OFF': {
      const amount = requireDecimal(rule.benefitAmount, rule, 'benefitAmount');
      // A flat amount is spread across the matched items, cheapest first, so the
      // allocation is deterministic and never exceeds any single item's value.
      let left = amount;
      const ordered = [...matched].sort((a, b) => {
        const byPrice = compare(a.unitPrice, b.unitPrice);
        return byPrice !== 0 ? byPrice : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      for (const item of ordered) {
        if (compare(left, ZERO) <= 0) break;
        const itemValue = multiply(item.unitPrice, item.quantity);
        const take = compare(left, itemValue) < 0 ? left : itemValue;
        addTo(item.id, take);
        left = sub(left, take);
      }
      return perItem;
    }
    case 'FIXED_PRICE': {
      const fixed = requireDecimal(rule.benefitAmount, rule, 'benefitAmount');
      for (const item of matched) {
        const perUnit = sub(item.unitPrice, fixed);
        if (compare(perUnit, ZERO) <= 0) continue;
        addTo(item.id, multiply(perUnit, item.quantity));
      }
      return perItem;
    }
    case 'FREE_ITEM': {
      const free = requireInteger(rule.getQuantity, rule, 'getQuantity');
      // Cheapest units first — the house gives away the least valuable unit, and
      // the guest never chooses.
      for (const unit of explodeUnits(matched).slice(0, free)) {
        addTo(unit.itemId, unit.unitPrice);
      }
      return perItem;
    }
    case 'BUY_X_GET_Y': {
      const buy = requireInteger(rule.buyQuantity, rule, 'buyQuantity');
      const get = requireInteger(rule.getQuantity, rule, 'getQuantity');
      const groupSize = buy + get;
      // Descending price: the expensive units fill the "buy" slots and the
      // cheapest units in each complete group are the ones given away.
      const descending = explodeUnits(matched).reverse();
      const completeGroups = Math.floor(descending.length / groupSize);
      for (let group = 0; group < completeGroups; group += 1) {
        const start = group * groupSize + buy;
        for (const unit of descending.slice(start, start + get)) {
          addTo(unit.itemId, unit.unitPrice);
        }
      }
      return perItem;
    }
  }
}

/**
 * Allocate a rule's gross benefit against the per-item remaining balances,
 * honouring the rule's own `maximumDiscountAmount`, and decrement the balances.
 * Returns the per-item amounts actually taken (the parts that sum to the
 * application's discount) — this is where the no-emergent-stacking floor lives.
 */
function allocateAgainstRemaining(
  rule: PromotionRule,
  gross: ReadonlyMap<string, Prisma.Decimal>,
  remaining: Map<string, Prisma.Decimal>
): Map<string, Prisma.Decimal> {
  // Deterministic allocation order so a maximum that binds always cuts the same
  // items: ascending item id.
  const itemIds = [...gross.keys()].sort();
  let budget = rule.maximumDiscountAmount === null ? null : money(rule.maximumDiscountAmount);
  const taken = new Map<string, Prisma.Decimal>();

  for (const itemId of itemIds) {
    if (budget !== null && compare(budget, ZERO) <= 0) break;
    const want = roundMoney(gross.get(itemId) ?? ZERO);
    if (compare(want, ZERO) <= 0) continue;
    const available = remaining.get(itemId) ?? ZERO;
    let amount = compare(want, available) < 0 ? want : available;
    if (budget !== null && compare(amount, budget) > 0) amount = budget;
    if (compare(amount, ZERO) <= 0) continue;
    taken.set(itemId, amount);
    remaining.set(itemId, sub(available, amount));
    if (budget !== null) budget = sub(budget, amount);
  }
  return taken;
}

/**
 * The pinned evaluation order — a TOTAL order, so the outcome never depends on
 * how the caller happened to sort the rules:
 *
 *   1. `priority` DESCENDING — the operator's explicit intent wins first.
 *   2. provisional discount DESCENDING — at equal priority the guest gets the
 *      better offer. "Provisional" is the benefit measured against the UNTOUCHED
 *      check, so this ranking cannot depend on the outcome it is ranking.
 *   3. `ruleCode` ASCENDING — the final tiebreak, always decisive.
 */
function orderCandidates(
  candidates: readonly { rule: PromotionRule; provisional: Prisma.Decimal }[]
): { rule: PromotionRule; provisional: Prisma.Decimal }[] {
  return [...candidates].sort((a, b) => {
    if (a.rule.priority !== b.rule.priority) return b.rule.priority - a.rule.priority;
    const byAmount = compare(b.provisional, a.provisional);
    if (byAmount !== 0) return byAmount;
    return a.rule.ruleCode < b.rule.ruleCode ? -1 : a.rule.ruleCode > b.rule.ruleCode ? 1 : 0;
  });
}

/**
 * Evaluate every candidate rule against the check and return the deterministic
 * set that applies.
 *
 * The stacking policy, in full:
 *   - An EXCLUSIVE promotion applies ONLY as the first application on the check,
 *     and once it has applied nothing else may join. It is a whole-check offer.
 *   - STACKABLE promotions compose with each other in the pinned order.
 *   - Every application is allocated against the per-item remaining balance, so
 *     Σ discounts can never exceed the order subtotal and no item can go below
 *     zero — regardless of how many rules overlap it.
 *   - A rule that computes to zero after the floor does NOT apply and produces
 *     no snapshot: an application record always means money actually moved.
 */
export function evaluatePromotions(
  rules: readonly PromotionRule[],
  context: PromotionCheckoutContext
): PromotionEvaluation {
  const rejected: { ruleCode: string; reason: PromotionIneligibilityReason }[] = [];
  const eligible: { rule: PromotionRule; provisional: Prisma.Decimal }[] = [];

  for (const rule of rules) {
    const verdict = evaluateEligibility(rule, context);
    if (!verdict.eligible) {
      rejected.push({ ruleCode: rule.ruleCode, reason: verdict.reason });
      continue;
    }
    const matched = matchItems(rule, context.items);
    const gross = grossBenefitByUnit(rule, matched);
    let provisional = sum([...gross.values()]);
    if (
      rule.maximumDiscountAmount !== null &&
      compare(provisional, rule.maximumDiscountAmount) > 0
    ) {
      provisional = money(rule.maximumDiscountAmount);
    }
    eligible.push({ rule, provisional: roundMoney(provisional) });
  }

  // The per-item budget every application draws down. Seeded from the item's own
  // gross value — an item can never give up more than it is worth.
  const remaining = new Map<string, Prisma.Decimal>(
    context.items.map((item) => [item.id, roundMoney(multiply(item.unitPrice, item.quantity))])
  );

  const applications: PromotionApplicationPlan[] = [];
  let closed = false;

  for (const candidate of orderCandidates(eligible)) {
    if (closed) {
      rejected.push({ ruleCode: candidate.rule.ruleCode, reason: 'NO_MATCHING_ITEMS' });
      continue;
    }
    // An exclusive offer cannot join a set that has already started.
    if (candidate.rule.stacking === 'EXCLUSIVE' && applications.length > 0) {
      rejected.push({ ruleCode: candidate.rule.ruleCode, reason: 'NO_MATCHING_ITEMS' });
      continue;
    }

    const matched = matchItems(candidate.rule, context.items);
    const taken = allocateAgainstRemaining(
      candidate.rule,
      grossBenefitByUnit(candidate.rule, matched),
      remaining
    );
    const discountAmount = sum([...taken.values()]);
    if (compare(discountAmount, ZERO) <= 0) {
      // Fully absorbed by earlier applications — nothing left to take.
      rejected.push({ ruleCode: candidate.rule.ruleCode, reason: 'NO_MATCHING_ITEMS' });
      continue;
    }

    applications.push({
      sequence: applications.length + 1,
      promotionId: candidate.rule.promotionId,
      promotionVersionId: candidate.rule.promotionVersionId,
      versionNumber: candidate.rule.versionNumber,
      ruleCode: candidate.rule.ruleCode,
      promotionCode: candidate.rule.promotionCode,
      targetScope: candidate.rule.targetScope,
      benefitKind: candidate.rule.benefitKind,
      benefitRate: candidate.rule.benefitRate,
      benefitAmount: candidate.rule.benefitAmount,
      authority: candidate.rule.authority,
      discountAmount: roundMoney(discountAmount),
      itemDiscounts: taken,
    });

    if (candidate.rule.stacking === 'EXCLUSIVE') closed = true;
  }

  return {
    applications,
    totalDiscount: sum(applications.map((application) => application.discountAmount)),
    rejected,
  };
}
