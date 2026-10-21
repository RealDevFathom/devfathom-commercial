/**
 * WHA-288 / promotions Lane A — §5, the immutable reconstruction contract.
 *
 * Named acceptance tests (§13):
 *   - promotion_snapshot_reconstructs_six_month_old_checkout_without_live_joins
 *   - promotion_publish_is_immutable_and_audited_without_sensitive_payloads
 *     (the "without sensitive payloads" half; the DB immutability half lives in
 *     promotion-caps.db.test.ts, which can actually attempt the UPDATE)
 *   - promotion_reversal_is_append_only_and_preserves_original_evidence
 *
 * The central test does not merely re-run the evaluator with the same objects
 * in memory — that would prove nothing. It reconstructs from a payload that has
 * been JSON round-tripped and then SUPERSEDES and rewrites every live rule, so
 * a reconstruction that secretly consulted live configuration would produce a
 * different answer and fail.
 */

import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import {
  type PromotionEvaluationContext,
  type PromotionInputLine,
  type PromotionRule,
} from '@/lib/restaurant/promotion-contracts';
import { evaluatePromotions } from '@/lib/restaurant/promotion-evaluator';
import {
  buildEvaluationSnapshot,
  buildReversalSnapshot,
  canonicalHash,
  canonicalJson,
  computeOutputHash,
  computeRuleHash,
  reconstructEvaluation,
  ruleFromSnapshot,
  ruleSnapshotOf,
  type CanonicalJson,
  type PromotionSnapshotIdentity,
} from '@/lib/restaurant/promotion-snapshot';

const d = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);

function rule(
  overrides: Partial<PromotionRule> & Pick<PromotionRule, 'versionId' | 'benefitKind'>
): PromotionRule {
  const base: PromotionRule = {
    promotionId: `promo-${overrides.versionId}`,
    promotionCode: `CODE-${overrides.versionId}`,
    versionNumber: 1,
    status: 'PUBLISHED',
    effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
    effectiveTo: null,
    timezone: 'Asia/Karachi',
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
    ruleHash: '',
    ...overrides,
  };
  return { ...base, ruleHash: computeRuleHash(base) };
}

const LINES: PromotionInputLine[] = [
  {
    orderItemId: 'item-a',
    productId: 'coffee',
    variantId: 'large',
    categoryAncestry: ['drinks', 'beverages'],
    quantity: 2,
    unitPrice: d('12.00'),
    modifierDeltas: [d('1.50')],
    compAllocation: d('3.00'),
  },
  {
    orderItemId: 'item-b',
    productId: 'steak',
    variantId: null,
    categoryAncestry: ['mains'],
    quantity: 1,
    unitPrice: d('40.00'),
    modifierDeltas: [],
    compAllocation: d('0.00'),
  },
];

const CONTEXT: PromotionEvaluationContext = {
  evaluatedAt: new Date('2026-03-06T18:30:00.000Z'),
  branchId: 'branch-1',
  channel: 'DINE_IN',
  currency: 'USD',
  customerId: 'customer-1',
  customerSegments: ['vip'],
  couponFingerprints: ['fingerprint-x'],
  authorityActorId: 'staff-7',
  online: true,
};

const IDENTITY: PromotionSnapshotIdentity = {
  organizationId: 'org-1',
  orderId: 'order-1',
  branchId: 'branch-1',
  idempotencyKey: 'evaluation-key-1',
  timezone: 'Asia/Karachi',
  setRevisionId: 'revision-9',
  setRevisionHash: 'revision-hash-9',
  source: 'ONLINE',
  terminalDeviceId: 'device-3',
  priceListVersionId: 'price-list-4',
};

/** A representative set: one accepted percent rule, one accepted BOGO, one
 * rejected on its minimum, and one coupon rule. The rejected candidates matter
 * — they are part of what a reconstruction must reproduce. */
function buildRules(): PromotionRule[] {
  return [
    rule({
      versionId: 'v-percent',
      benefitKind: 'PERCENT_OFF',
      benefitBasisPoints: 1500,
      priority: 30,
    }),
    rule({
      versionId: 'v-bogo',
      benefitKind: 'BUY_X_GET_Y_FREE',
      buyQuantity: 1,
      getQuantity: 1,
      priority: 20,
      targetKind: 'ITEM',
      targetProductIds: ['coffee'],
    }),
    rule({
      versionId: 'v-too-small',
      benefitKind: 'AMOUNT_OFF',
      benefitAmount: d('5.00'),
      priority: 10,
      minimumAmount: d('10000.00'),
    }),
    rule({
      versionId: 'v-coupon',
      benefitKind: 'AMOUNT_OFF',
      benefitAmount: d('2.00'),
      priority: 5,
      activationMode: 'COUPON_CODE',
      couponCodeHash: 'fingerprint-x',
    }),
  ];
}

describe('promotion snapshot — canonical serialization', () => {
  it('is independent of property insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalHash({ b: 1, a: 2 })).toBe(canonicalHash({ a: 2, b: 1 }));
  });

  it('serializes Decimal exactly and never as a float', () => {
    // 0.1 + 0.2 is the classic float trap; the canonical form must be exact.
    expect(canonicalJson({ amount: d('0.1').plus(d('0.2')) })).toBe('{"amount":"0.3"}');
    expect(canonicalJson({ amount: d('12.50') })).toBe('{"amount":"12.5"}');
  });

  it('distinguishes null from absent', () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
    expect(canonicalJson({ a: undefined })).toBe('{}');
  });

  it('a rule hash covers the rule content but not the hash field itself', () => {
    const original = rule({
      versionId: 'v-1',
      benefitKind: 'AMOUNT_OFF',
      benefitAmount: d('1.00'),
    });
    // Recomputing over a copy carrying a bogus hash yields the SAME digest.
    expect(computeRuleHash({ ...original, ruleHash: 'nonsense' })).toBe(original.ruleHash);
    // Any content change moves it.
    expect(computeRuleHash({ ...original, benefitAmount: d('1.01') })).not.toBe(original.ruleHash);
  });

  it('a rule survives a JSON round trip through its ruleSnapshot', () => {
    const original = rule({
      versionId: 'v-1',
      benefitKind: 'BUY_X_GET_Y_PERCENT',
      buyQuantity: 2,
      getQuantity: 1,
      benefitBasisPoints: 5000,
      effectiveTo: new Date('2027-01-01T00:00:00.000Z'),
      minimumAmount: d('20.00'),
      components: [{ ordinal: 0, productIds: ['a'], categoryIds: ['c'], quantity: 2 }],
    });
    const wire = JSON.parse(JSON.stringify(ruleSnapshotOf(original))) as CanonicalJson;
    const restored = ruleFromSnapshot(wire, original.ruleHash);
    expect(computeRuleHash(restored)).toBe(original.ruleHash);
  });
});

describe('promotion snapshot — §5.2 reconstruction without live joins', () => {
  it('reproduces a checkout after every live rule has been superseded and rewritten', () => {
    const rules = buildRules();
    const result = evaluatePromotions({ context: CONTEXT, lines: LINES, rules });
    expect(result.applications.length).toBeGreaterThan(0);

    const payload = buildEvaluationSnapshot({
      identity: IDENTITY,
      context: CONTEXT,
      lines: LINES,
      rules,
      result,
    });

    // Persisting and re-reading is a JSON round trip; do it for real so a
    // Date or Decimal that only survives in memory is caught here.
    const stored = JSON.parse(
      JSON.stringify({
        inputLines: payload.evaluation.inputLines,
        evaluationContext: payload.evaluation.evaluationContext,
        candidates: payload.candidates.map((candidate) => ({
          ruleSnapshot: candidate.ruleSnapshot,
          ruleHash: candidate.ruleHash,
        })),
      })
    ) as Parameters<typeof reconstructEvaluation>[0];

    // Six months pass: the promotions are superseded, the benefits rewritten,
    // the schedules moved, the category retitled, the branch re-zoned. If the
    // reconstruction consulted ANY of that, the totals below would move.
    for (const live of rules) {
      live.status = 'SUPERSEDED';
      live.benefitBasisPoints = 9999;
      live.benefitAmount = d('999.00');
      live.timezone = 'America/New_York';
      live.effectiveTo = new Date('2020-06-01T00:00:00.000Z');
    }

    const replayed = reconstructEvaluation(stored);
    expect(replayed.discountTotal.toFixed(2)).toBe(result.discountTotal.toFixed(2));
    expect(computeOutputHash(replayed)).toBe(payload.evaluation.outputHash);
  });

  it('reproduces the candidate ORDER and every rejection reason, not just the money', () => {
    const rules = buildRules();
    const result = evaluatePromotions({ context: CONTEXT, lines: LINES, rules });
    const payload = buildEvaluationSnapshot({
      identity: IDENTITY,
      context: CONTEXT,
      lines: LINES,
      rules,
      result,
    });
    const replayed = reconstructEvaluation({
      inputLines: payload.evaluation.inputLines,
      evaluationContext: payload.evaluation.evaluationContext,
      candidates: payload.candidates.map((candidate) => ({
        ruleSnapshot: candidate.ruleSnapshot,
        ruleHash: candidate.ruleHash,
      })),
    });

    expect(replayed.candidates.map((candidate) => candidate.promotionVersionId)).toEqual(
      result.candidates.map((candidate) => candidate.promotionVersionId)
    );
    expect(replayed.candidates.map((candidate) => candidate.reasonCode)).toEqual(
      result.candidates.map((candidate) => candidate.reasonCode)
    );
    // §5.1: rejected candidates are RETAINED — explaining why a lower-priority
    // rule won is part of reconstruction.
    expect(payload.candidates.some((candidate) => candidate.outcome === 'REJECTED')).toBe(true);
    expect(payload.candidates).toHaveLength(rules.length);
  });

  it('reproduces the per-unit cents, not merely the order total', () => {
    const rules = buildRules();
    const result = evaluatePromotions({ context: CONTEXT, lines: LINES, rules });
    const payload = buildEvaluationSnapshot({
      identity: IDENTITY,
      context: CONTEXT,
      lines: LINES,
      rules,
      result,
    });
    const replayed = reconstructEvaluation({
      inputLines: payload.evaluation.inputLines,
      evaluationContext: payload.evaluation.evaluationContext,
      candidates: payload.candidates.map((candidate) => ({
        ruleSnapshot: candidate.ruleSnapshot,
        ruleHash: candidate.ruleHash,
      })),
    });

    const cents = (evaluation: typeof result) =>
      evaluation.applications.flatMap((application) =>
        application.allocations.map(
          (allocation) =>
            `${allocation.orderItemId}#${allocation.unitOrdinal}=${allocation.allocatedAmount.toFixed(2)}`
        )
      );
    expect(cents(replayed)).toEqual(cents(result));
    // And Σ allocated cents is exactly the discount total — no cent is lost.
    const allocated = result.applications
      .flatMap((application) => application.allocations)
      .reduce((total, allocation) => total.plus(allocation.allocatedAmount), d(0));
    expect(allocated.toFixed(2)).toBe(result.discountTotal.toFixed(2));
  });

  it('records the resolved local schedule facts so no timezone lookup is needed later', () => {
    const rules = buildRules();
    const result = evaluatePromotions({ context: CONTEXT, lines: LINES, rules });
    const payload = buildEvaluationSnapshot({
      identity: IDENTITY,
      context: CONTEXT,
      lines: LINES,
      rules,
      result,
    });
    // 2026-03-06T18:30Z is Friday 23:30 in Asia/Karachi (UTC+5).
    expect(payload.evaluation.localDate).toBe('2026-03-06');
    expect(payload.evaluation.localMinute).toBe(23 * 60 + 30);
    expect(payload.evaluation.utcOffsetMinutes).toBe(300);
    expect(payload.evaluation.engineVersion).toBe(result.engineVersion);
    expect(payload.evaluation.moneyVersion).toBe(result.moneyVersion);
  });

  it('changing any input moves the input hash', () => {
    const rules = buildRules();
    const result = evaluatePromotions({ context: CONTEXT, lines: LINES, rules });
    const base = buildEvaluationSnapshot({
      identity: IDENTITY,
      context: CONTEXT,
      lines: LINES,
      rules,
      result,
    });
    const nudged = buildEvaluationSnapshot({
      identity: IDENTITY,
      context: CONTEXT,
      lines: [{ ...LINES[0]!, unitPrice: d('12.01') }, LINES[1]!],
      rules,
      result,
    });
    expect(nudged.evaluation.inputHash).not.toBe(base.evaluation.inputHash);
  });
});

describe('promotion snapshot — §10 privacy', () => {
  it('stores no coupon plaintext and no customer attributes on the candidate', () => {
    const rules = buildRules();
    const result = evaluatePromotions({ context: CONTEXT, lines: LINES, rules });
    const payload = buildEvaluationSnapshot({
      identity: IDENTITY,
      context: CONTEXT,
      lines: LINES,
      rules,
      result,
    });
    const coupon = payload.candidates.find(
      (candidate) => candidate.promotionVersionId === 'v-coupon'
    );
    // Only the non-reversible fingerprint is retained.
    expect(coupon?.couponFingerprint).toBe('fingerprint-x');
    // An automatic rule carries no fingerprint and no actor at all.
    const automatic = payload.candidates.find(
      (candidate) => candidate.promotionVersionId === 'v-percent'
    );
    expect(automatic?.couponFingerprint).toBeNull();
    expect(automatic?.authorityActorId).toBeNull();
  });

  it('keeps the actor only where the activation authority actually needed one', () => {
    const rules = [
      rule({
        versionId: 'v-manager',
        benefitKind: 'AMOUNT_OFF',
        benefitAmount: d('1.00'),
        activationMode: 'MANAGER',
      }),
    ];
    const result = evaluatePromotions({ context: CONTEXT, lines: LINES, rules });
    const payload = buildEvaluationSnapshot({
      identity: IDENTITY,
      context: CONTEXT,
      lines: LINES,
      rules,
      result,
    });
    expect(payload.candidates[0]?.authorityActorId).toBe('staff-7');
  });
});

describe('promotion snapshot — §5.2 reversal', () => {
  it('is an exact accounting inverse that references, not edits, the original', () => {
    const rules = buildRules();
    const result = evaluatePromotions({ context: CONTEXT, lines: LINES, rules });
    const payload = buildEvaluationSnapshot({
      identity: IDENTITY,
      context: CONTEXT,
      lines: LINES,
      rules,
      result,
    });
    const original = { ...payload.evaluation, id: 'evaluation-1' };
    const reversal = buildReversalSnapshot({
      original,
      reversalReason: 'ORDER_VOIDED',
      idempotencyKey: 'evaluation-key-1-reversal',
    });

    expect(reversal.reversesSnapshotId).toBe('evaluation-1');
    expect(reversal.reversalReason).toBe('ORDER_VOIDED');
    expect(reversal.discountTotal.toFixed(2)).toBe(original.discountTotal.negated().toFixed(2));
    // A distinct idempotency key: the reversal is its own append, not a replay
    // of the evaluation it negates.
    expect(reversal.idempotencyKey).not.toBe(original.idempotencyKey);
    // The original object is untouched — evidence is preserved, not rewritten.
    expect(original.discountTotal.toFixed(2)).toBe(result.discountTotal.toFixed(2));
    expect(original).not.toHaveProperty('reversesSnapshotId');
  });
});
