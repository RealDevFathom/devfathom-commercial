/**
 * WHA-288 / promotions Lane A — §4, the deterministic evaluator.
 *
 * ONE pure total function: identical input always yields byte-identical output,
 * on the server and (later, §7) in the offline client. That property is the
 * whole contract — the server reproduces an offline quote exactly or rejects it
 * with a typed reprice, so any hidden non-determinism here becomes a customer
 * seeing a different price at the till.
 *
 * What guarantees it:
 *   - candidates are visited ONCE in the canonical order priority desc,
 *     promotion id asc, version number asc, rule id asc (§4.1). Nothing depends
 *     on database row order, `Map` insertion order, or `Array.sort` stability.
 *   - unit selection for quantity benefits sorts by eligible remaining charge
 *     ASCENDING — customer-conservative and deterministic — then by
 *     `(orderItemId, unitOrdinal)` (§4.1).
 *   - there is NO best-deal search (§15). Canonical priority order IS the
 *     contract; an optimizer would make stacking unexplainable.
 *   - money goes through `money.ts` only, and rounds exactly once per
 *     application, immediately before allocation (§4.1).
 *
 * Non-obvious rule worth stating: a MINIMUM is measured against the post-comp
 * PRE-promotion charge (§3.3), while a BENEFIT is computed against the charge
 * REMAINING after earlier accepted applications (§4.1). Those are deliberately
 * different bases — spec example 9 (10% then a flat 5.00 on 100.00 totals 15.00,
 * not 14.50) only works if the second candidate's minimum still sees 100.00.
 */

import {
  PROMOTION_ENGINE_VERSION,
  PROMOTION_MONEY_VERSION,
  PROMOTION_REASON,
  type PromotionApplication,
  type PromotionCandidateOutcome,
  type PromotionEvaluationContext,
  type PromotionEvaluationResult,
  type PromotionInputLine,
  type PromotionRejectionReason,
  type PromotionRule,
  type PromotionRuleComponent,
  type PromotionUnit,
  type PromotionUnitAllocation,
  type PromotionUnitKey,
} from '@/lib/restaurant/promotion-contracts';
import { resolvePromotionSchedule } from '@/lib/restaurant/promotion-schedule';
import {
  Decimal,
  ZERO,
  add,
  allocate,
  compare,
  multiply,
  roundMoney,
  sub,
  sum,
} from '@/lib/restaurant/money-arithmetic';

/** A unit plus the charge still available to discount. Mutated as applications
 * are accepted, which is why the evaluator owns it and never hands it out. */
type WorkingUnit = PromotionUnit & { remainingCharge: Decimal };

export type PromotionEvaluationInput = {
  context: PromotionEvaluationContext;
  lines: readonly PromotionInputLine[];
  /** The pinned promotion-set revision: every published rule in scope. Order is
   * irrelevant — the evaluator imposes the canonical one. */
  rules: readonly PromotionRule[];
};

/**
 * §4.1 — expand lines into stable `(orderItemId, unitOrdinal)` units.
 *
 * A unit's gross charge is `unitPrice + Σ modifier deltas`. The line's comp
 * allocation is spread across its units with the same largest-remainder rule
 * used everywhere else, so Σ comp shares is EXACTLY the line comp and a comp of
 * 10.00 over 3 units never quietly becomes 9.99.
 */
export function expandUnits(lines: readonly PromotionInputLine[]): PromotionUnit[] {
  const units: PromotionUnit[] = [];
  // Canonical line order first, so unit indices are reproducible.
  const ordered = [...lines].sort((a, b) => compareStrings(a.orderItemId, b.orderItemId));
  for (const line of ordered) {
    if (line.quantity <= 0) continue;
    const grossCharge = add(line.unitPrice, sum(line.modifierDeltas));
    const compShares = allocate(
      line.compAllocation,
      Array.from({ length: line.quantity }, () => 1)
    );
    for (let unitOrdinal = 0; unitOrdinal < line.quantity; unitOrdinal += 1) {
      const compShare = compShares[unitOrdinal]!;
      // A comp may cover the whole unit; it can never overdraw it into a credit.
      const eligibleCharge =
        compare(compShare, grossCharge) >= 0 ? ZERO : sub(grossCharge, compShare);
      units.push({
        orderItemId: line.orderItemId,
        unitOrdinal,
        productId: line.productId,
        variantId: line.variantId,
        categoryAncestry: line.categoryAncestry,
        grossCharge,
        compShare,
        eligibleCharge,
      });
    }
  }
  return units;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** §4.1 canonical candidate order. Total and independent of input order. */
function compareCandidates(a: PromotionRule, b: PromotionRule): number {
  if (a.priority !== b.priority) return b.priority - a.priority; // priority DESC
  const byPromotion = compareStrings(a.promotionId, b.promotionId);
  if (byPromotion !== 0) return byPromotion;
  if (a.versionNumber !== b.versionNumber) return a.versionNumber - b.versionNumber;
  return compareStrings(a.versionId, b.versionId);
}

/** §4.1 canonical unit order for allocation and tie-breaking. */
function compareUnitKeys(a: PromotionUnitKey, b: PromotionUnitKey): number {
  const byItem = compareStrings(a.orderItemId, b.orderItemId);
  return byItem !== 0 ? byItem : a.unitOrdinal - b.unitOrdinal;
}

/**
 * §4.1 selection order for quantity benefits: cheapest remaining charge first
 * (customer-conservative), ties by stable unit key. Buy-two-get-one over 5/7/9
 * therefore always discounts the 5.00 unit.
 */
function compareBySelectionOrder(a: WorkingUnit, b: WorkingUnit): number {
  const byCharge = compare(a.remainingCharge, b.remainingCharge);
  return byCharge !== 0 ? byCharge : compareUnitKeys(a, b);
}

/** §3.3 does this unit satisfy the rule's target predicate? */
function unitMatchesTarget(unit: WorkingUnit, rule: PromotionRule): boolean {
  switch (rule.targetKind) {
    case 'ORDER':
      // "all otherwise eligible non-voided lines" — the filters do the work.
      return true;
    case 'ITEM': {
      if (!rule.targetProductIds.includes(unit.productId)) return false;
      // Variants NARROW an item target; an empty variant list means every
      // variant of the named products. Modifiers never independently qualify.
      if (rule.targetVariantIds.length === 0) return true;
      return unit.variantId !== null && rule.targetVariantIds.includes(unit.variantId);
    }
    case 'CATEGORY': {
      // Evaluated from the SNAPSHOTTED ancestry (nearest first). Descendants
      // count only when the rule opts in; otherwise the item's own (nearest)
      // category must be named.
      if (rule.includeDescendants) {
        return unit.categoryAncestry.some((categoryId) =>
          rule.targetCategoryIds.includes(categoryId)
        );
      }
      const ownCategory = unit.categoryAncestry[0];
      return ownCategory !== undefined && rule.targetCategoryIds.includes(ownCategory);
    }
  }
}

/** §3.3 component predicate for BUNDLE_PRICE: product OR category, with
 * alternatives inside one component. */
function unitMatchesComponent(unit: WorkingUnit, component: PromotionRuleComponent): boolean {
  if (component.productIds.includes(unit.productId)) return true;
  return unit.categoryAncestry.some((categoryId) => component.categoryIds.includes(categoryId));
}

/** §3.3 the filters common to every target, evaluated before any unit work. */
function checkCommonFilters(
  rule: PromotionRule,
  context: PromotionEvaluationContext
): PromotionRejectionReason | null {
  if (rule.status !== 'PUBLISHED') return PROMOTION_REASON.NOT_PUBLISHED;
  // §3.4: currency must equal the order currency. A mismatch is a rule defect,
  // not a near miss, so it is reported distinctly.
  if (rule.currency !== context.currency) return PROMOTION_REASON.CURRENCY_MISMATCH;
  if (rule.allowedBranchIds.length > 0 && !rule.allowedBranchIds.includes(context.branchId)) {
    return PROMOTION_REASON.BRANCH_EXCLUDED;
  }
  if (rule.allowedChannels.length > 0 && !rule.allowedChannels.includes(context.channel)) {
    return PROMOTION_REASON.CHANNEL_EXCLUDED;
  }
  if (
    rule.customerSegmentRef !== null &&
    !context.customerSegments.includes(rule.customerSegmentRef)
  ) {
    return PROMOTION_REASON.SEGMENT_EXCLUDED;
  }
  // §7 fail-closed: offline may never quote a rule that needs the server.
  if (!context.online && rule.offlinePolicy === 'ONLINE_ONLY') {
    return PROMOTION_REASON.ONLINE_REQUIRED;
  }
  switch (rule.activationMode) {
    case 'AUTOMATIC':
      break;
    case 'COUPON_CODE':
      // §4.2: a coupon only ADDS its exact eligible candidate; it never alters
      // ordering. Matching is on the keyed fingerprint — plaintext never
      // reaches this module (§10).
      if (
        rule.couponCodeHash === null ||
        !context.couponFingerprints.includes(rule.couponCodeHash)
      ) {
        return PROMOTION_REASON.COUPON_NOT_PRESENTED;
      }
      break;
    case 'STAFF':
    case 'MANAGER':
      if (context.authorityActorId === null) return PROMOTION_REASON.AUTHORITY_REQUIRED;
      break;
  }
  return null;
}

/** The units a rule may act on right now: target match, still carrying charge. */
function eligibleUnitsFor(rule: PromotionRule, units: readonly WorkingUnit[]): WorkingUnit[] {
  return units.filter(
    (unit) => unit.remainingCharge.greaterThan(0) && unitMatchesTarget(unit, rule)
  );
}

/**
 * §4.2 — allocate a rounded benefit across the selected units, proportional to
 * each unit's REMAINING charge, by largest remainder with ties broken by
 * `(orderItemId, unitOrdinal)`.
 *
 * The units are sorted into canonical key order before `allocate`, because
 * `money.allocate` breaks equal remainders by ascending INDEX — feeding it
 * selection-order units would silently make the tie-break depend on price.
 */
function allocateBenefit(
  benefit: Decimal,
  selected: readonly WorkingUnit[]
): PromotionUnitAllocation[] {
  const ordered = [...selected].sort(compareUnitKeys);
  // Weights in integer cents of remaining charge. A zero-charge unit cannot
  // absorb cents, so it is excluded rather than given a zero weight (which
  // would still be eligible for a leftover cent).
  const weighted = ordered.filter((unit) => unit.remainingCharge.greaterThan(0));
  if (weighted.length === 0) return [];
  const weights = weighted.map((unit) => Number(roundMoney(unit.remainingCharge).times(100)));
  const shares = allocate(benefit, weights);
  return weighted.map((unit, index) => ({
    orderItemId: unit.orderItemId,
    unitOrdinal: unit.unitOrdinal,
    allocatedAmount: shares[index]!,
  }));
}

/**
 * One candidate application. `null` means the benefit formula found nothing to
 * do. Two distinct unit sets, because they genuinely differ for quantity
 * benefits:
 *   - `selected` RECEIVES the allocated cents (a BOGO's "get" units);
 *   - `consumed` is retired from future eligibility (a BOGO's whole set — the
 *     "buy" units carry no discount but must not re-qualify on the next pass,
 *     or four units would yield two buy-two-get-one sets instead of one).
 * `repeatable` is false for the order-scoped benefits, which apply at most once
 * per order; repeating them would compound a percentage against its own result.
 */
type BenefitDraft = {
  selected: WorkingUnit[];
  consumed: WorkingUnit[];
  unrounded: Decimal;
  repeatable: boolean;
};

/**
 * §3.4 — the benefit formulas. Each returns ONE application's worth of work;
 * quantity benefits are driven one SET at a time by the caller, so
 * `maxApplicationsPerOrder` and the per-order cap count sets, and each repeat
 * "consumes the next canonical eligible units" (§4.2).
 */
function draftBenefit(rule: PromotionRule, eligible: readonly WorkingUnit[]): BenefitDraft | null {
  switch (rule.benefitKind) {
    case 'PERCENT_OFF': {
      const basis = sum(eligible.map((unit) => unit.remainingCharge));
      if (!basis.greaterThan(0)) return null;
      const rate = new Decimal(rule.benefitBasisPoints ?? 0).dividedBy(10_000);
      return {
        selected: [...eligible],
        consumed: [],
        unrounded: multiply(basis, rate),
        repeatable: false,
      };
    }
    case 'AMOUNT_OFF': {
      const basis = sum(eligible.map((unit) => unit.remainingCharge));
      if (!basis.greaterThan(0)) return null;
      // §12.2: capped at the eligible remaining charge — never a credit.
      const amount = rule.benefitAmount ?? ZERO;
      return {
        selected: [...eligible],
        consumed: [],
        unrounded: compare(amount, basis) > 0 ? basis : amount,
        repeatable: false,
      };
    }
    case 'FIXED_PRICE': {
      const basis = sum(eligible.map((unit) => unit.remainingCharge));
      const target = rule.benefitAmount ?? ZERO;
      // §12.3: promotions never surcharge, so a total already below the fixed
      // price yields zero rather than a negative benefit.
      if (compare(basis, target) <= 0) return null;
      return {
        selected: [...eligible],
        consumed: [],
        unrounded: sub(basis, target),
        repeatable: false,
      };
    }
    case 'BUY_X_GET_Y_PERCENT':
    case 'BUY_X_GET_Y_AMOUNT':
    case 'BUY_X_GET_Y_FREE': {
      const buyQuantity = rule.buyQuantity ?? 0;
      const getQuantity = rule.getQuantity ?? 0;
      if (buyQuantity <= 0 || getQuantity <= 0) return null;
      // One SET consumes buy + get units (§12.4: 5/7/9 with buy 2 get 1 is
      // exactly ONE set), drawn in canonical selection order — cheapest first.
      // The benefit units are the cheapest `getQuantity` of that set, which is
      // why 5/7/9 discounts the 5.00 unit.
      const setSize = buyQuantity + getQuantity;
      if (eligible.length < setSize) return null;
      const setUnits = [...eligible].sort(compareBySelectionOrder).slice(0, setSize);
      const getUnits = setUnits.slice(0, getQuantity);
      const basisPoints =
        rule.benefitKind === 'BUY_X_GET_Y_FREE' ? 10_000 : (rule.benefitBasisPoints ?? 0);
      if (rule.benefitKind === 'BUY_X_GET_Y_AMOUNT') {
        // §3.4.5: a fixed per-unit discount, capped at THAT unit's remaining
        // charge — §12.5's 5.00 off a 3.00 unit is worth 3.00, not 5.00.
        const perUnit = rule.benefitAmount ?? ZERO;
        const total = sum(
          getUnits.map((unit) =>
            compare(perUnit, unit.remainingCharge) > 0 ? unit.remainingCharge : perUnit
          )
        );
        if (!total.greaterThan(0)) return null;
        return { selected: getUnits, consumed: setUnits, unrounded: total, repeatable: true };
      }
      const rate = new Decimal(basisPoints).dividedBy(10_000);
      const total = sum(getUnits.map((unit) => multiply(unit.remainingCharge, rate)));
      if (!total.greaterThan(0)) return null;
      return { selected: getUnits, consumed: setUnits, unrounded: total, repeatable: true };
    }
    case 'BUNDLE_PRICE': {
      if (rule.components.length === 0) return null;
      // §4.1: components are matched in RULE COMPONENT ORDER, then canonical
      // unit order, so a unit that could satisfy two components always goes to
      // the earlier one.
      const claimed = new Set<string>();
      const selected: WorkingUnit[] = [];
      const componentsInOrder = [...rule.components].sort((a, b) => a.ordinal - b.ordinal);
      for (const component of componentsInOrder) {
        const matches = [...eligible]
          .filter((unit) => !claimed.has(unitKeyOf(unit)) && unitMatchesComponent(unit, component))
          .sort(compareBySelectionOrder);
        if (matches.length < component.quantity) return null; // incomplete set
        for (const unit of matches.slice(0, component.quantity)) {
          claimed.add(unitKeyOf(unit));
          selected.push(unit);
        }
      }
      const basis = sum(selected.map((unit) => unit.remainingCharge));
      const bundlePrice = rule.benefitAmount ?? ZERO;
      if (compare(basis, bundlePrice) <= 0) return null; // never a surcharge
      // Every component unit is consumed, so the next bundle needs a fresh set.
      return { selected, consumed: selected, unrounded: sub(basis, bundlePrice), repeatable: true };
    }
  }
}

function unitKeyOf(unit: PromotionUnitKey): string {
  return `${unit.orderItemId}#${unit.unitOrdinal}`;
}

/**
 * §4 — evaluate one order against one pinned promotion-set revision.
 *
 * Total function. Every rule in `rules` appears in `candidates` exactly once,
 * accepted or rejected with a stable reason, because §5.1 keeps rejected
 * candidates as part of the reconstruction evidence.
 */
export function evaluatePromotions(input: PromotionEvaluationInput): PromotionEvaluationResult {
  const { context, lines, rules } = input;
  const units: WorkingUnit[] = expandUnits(lines).map((unit) => ({
    ...unit,
    remainingCharge: unit.eligibleCharge,
  }));

  const candidates: PromotionCandidateOutcome[] = [];
  const applications: PromotionApplication[] = [];
  const acceptedGroups = new Set<string>();
  const acceptedPromotions = new Set<string>();
  let exclusiveAccepted = false;
  let processingStopped = false;

  const ordered = [...rules].sort(compareCandidates);

  for (let ordinal = 0; ordinal < ordered.length; ordinal += 1) {
    const rule = ordered[ordinal]!;
    const record = (reasonCode: PromotionRejectionReason, applicationCount: number): void => {
      candidates.push({
        ordinal,
        promotionId: rule.promotionId,
        promotionVersionId: rule.versionId,
        versionNumber: rule.versionNumber,
        ruleHash: rule.ruleHash,
        activationMode: rule.activationMode,
        outcome: applicationCount > 0 ? 'ACCEPTED' : 'REJECTED',
        reasonCode,
        applicationCount,
      });
    };

    // §4.2: `stopFurtherProcessing` ends the VISIT, but every remaining rule is
    // still recorded — an auditor must see what was never considered and why.
    if (processingStopped) {
      record(PROMOTION_REASON.PROCESSING_STOPPED, 0);
      continue;
    }
    // §4.2 exclusivity, tested against what has already been ACCEPTED.
    if (exclusiveAccepted) {
      record(PROMOTION_REASON.EXCLUDED_BY_EXCLUSIVE, 0);
      continue;
    }
    if (
      rule.stackingMode === 'GROUP_EXCLUSIVE' &&
      rule.stackingGroup !== '' &&
      acceptedGroups.has(rule.stackingGroup) &&
      !acceptedPromotions.has(rule.promotionId)
    ) {
      record(PROMOTION_REASON.EXCLUDED_BY_STACKING_GROUP, 0);
      continue;
    }

    const filterRejection = checkCommonFilters(rule, context);
    if (filterRejection !== null) {
      record(filterRejection, 0);
      continue;
    }

    const scheduleVerdict = resolvePromotionSchedule(context.evaluatedAt, rule);
    if (!scheduleVerdict.eligible) {
      record(scheduleVerdict.reasonCode, 0);
      continue;
    }

    // §3.3 the minimums are measured ONCE, against the post-comp PRE-promotion
    // charge of the qualifying units — not against what earlier applications
    // left behind.
    const targeted = units.filter((unit) => unitMatchesTarget(unit, rule));
    const qualifyingUnits = targeted.filter((unit) => unit.eligibleCharge.greaterThan(0));
    if (qualifyingUnits.length === 0) {
      record(PROMOTION_REASON.NO_ELIGIBLE_UNITS, 0);
      continue;
    }
    if (rule.minimumQuantity !== null && qualifyingUnits.length < rule.minimumQuantity) {
      record(PROMOTION_REASON.MINIMUM_QUANTITY_NOT_MET, 0);
      continue;
    }
    if (rule.minimumAmount !== null) {
      const qualifyingAmount = sum(qualifyingUnits.map((unit) => unit.eligibleCharge));
      if (compare(qualifyingAmount, rule.minimumAmount) < 0) {
        record(PROMOTION_REASON.MINIMUM_AMOUNT_NOT_MET, 0);
        continue;
      }
    }

    // §4.2 repeated applications, each consuming the next canonical eligible
    // units. Both limits are per-order and settled here without any ledger.
    const applicationLimit = Math.min(
      rule.maxApplicationsPerOrder ?? Number.MAX_SAFE_INTEGER,
      rule.perOrderCap ?? Number.MAX_SAFE_INTEGER
    );
    let acceptedForRule = 0;
    let lastRejection: PromotionRejectionReason = PROMOTION_REASON.BENEFIT_NOT_POSITIVE;
    let benefitSpent = ZERO;
    /** Units this rule has already used up, scoped to this rule only. */
    const retired = new Set<string>();

    while (acceptedForRule < applicationLimit) {
      const eligible = eligibleUnitsFor(rule, units).filter(
        (unit) => !retired.has(unitKeyOf(unit))
      );
      if (eligible.length === 0) {
        lastRejection = PROMOTION_REASON.NO_ELIGIBLE_UNITS;
        break;
      }
      const draft = draftBenefit(rule, eligible);
      if (draft === null) break;

      let unrounded = draft.unrounded;
      // §3.4 the per-rule maximum benefit money, applied across ALL of this
      // rule's applications on this order.
      if (rule.maxBenefitAmount !== null) {
        const headroom = sub(rule.maxBenefitAmount, benefitSpent);
        if (compare(headroom, ZERO) <= 0) break;
        if (compare(unrounded, headroom) > 0) unrounded = headroom;
      }
      // §4.1 round ONCE, here, immediately before allocation.
      const rounded = roundMoney(unrounded);
      if (!rounded.greaterThan(0)) {
        lastRejection = PROMOTION_REASON.BENEFIT_NOT_POSITIVE;
        break;
      }

      const allocations = allocateBenefit(rounded, draft.selected);
      if (allocations.length === 0) {
        lastRejection = PROMOTION_REASON.BENEFIT_NOT_POSITIVE;
        break;
      }

      // Consume the charge. An application can never take a unit below zero.
      const byKey = new Map(units.map((unit) => [unitKeyOf(unit), unit]));
      for (const allocation of allocations) {
        const unit = byKey.get(unitKeyOf(allocation))!;
        unit.remainingCharge = sub(unit.remainingCharge, allocation.allocatedAmount);
      }
      // §4.2 "an identity/version/rule cannot consume the same unit twice in one
      // application". A quantity benefit retires its whole set — the BUY units
      // carry no discount but must not re-qualify — so `retired` is tracked
      // per rule rather than by zeroing charge, which would wrongly hide those
      // units from LATER, lower-priority rules that are entitled to see them.
      for (const unit of draft.consumed) retired.add(unitKeyOf(unit));

      applications.push({
        applicationOrdinal: applications.length,
        promotionId: rule.promotionId,
        promotionVersionId: rule.versionId,
        ruleHash: rule.ruleHash,
        benefitKind: rule.benefitKind,
        unroundedBenefit: unrounded,
        roundedBenefit: rounded,
        // §3.3: the qualifying amount is what the application's units were
        // worth pre-promotion — for a BOGO that is the whole set, not just the
        // discounted units.
        qualifyingAmount: sum(
          (draft.consumed.length > 0 ? draft.consumed : draft.selected).map(
            (unit) => unit.eligibleCharge
          )
        ),
        discountedQuantity: allocations.length,
        selectedUnits: [...draft.selected].sort(compareUnitKeys).map((unit) => ({
          orderItemId: unit.orderItemId,
          unitOrdinal: unit.unitOrdinal,
        })),
        allocations,
      });
      benefitSpent = add(benefitSpent, rounded);
      acceptedForRule += 1;
      if (!draft.repeatable) break;
    }

    if (acceptedForRule === 0) {
      record(lastRejection, 0);
      continue;
    }

    record(PROMOTION_REASON.ACCEPTED, acceptedForRule);
    acceptedPromotions.add(rule.promotionId);
    if (rule.stackingGroup !== '') acceptedGroups.add(rule.stackingGroup);
    if (rule.stackingMode === 'EXCLUSIVE') exclusiveAccepted = true;
    if (rule.stopFurtherProcessing) processingStopped = true;
  }

  return {
    engineVersion: PROMOTION_ENGINE_VERSION,
    moneyVersion: PROMOTION_MONEY_VERSION,
    discountTotal: sum(applications.map((application) => application.roundedBenefit)),
    candidates,
    applications,
    units,
  };
}
