import { describe, expect, it, vi } from 'vitest';

import {
  PROMOTION_ENGINE_VERSION,
  type PromotionEvaluationContext,
  type PromotionInputLine,
  type PromotionRule,
} from '@/lib/restaurant/promotion-contracts';
import { evaluatePromotions } from '@/lib/restaurant/promotion-evaluator';
import { Decimal } from '@/lib/restaurant/money-arithmetic';

import { POS_STORE_SCHEMA_VERSION, type PosScope } from './pos-client-store';
import {
  evaluateCachedPromotions,
  invalidatePromotionCache,
  serializePromotionInput,
  serializePromotionResult,
  serializePromotionRule,
  validatePromotionCache,
  type PromotionCacheEnvelope,
} from './promotion-cache';

const scope: PosScope = { organizationId: 'org-1', branchId: 'branch-1', deviceId: 'device-1' };
const context: PromotionEvaluationContext = {
  evaluatedAt: new Date('2026-08-29T10:00:00.000Z'),
  branchId: scope.branchId,
  channel: 'DINE_IN',
  currency: 'USD',
  customerId: null,
  customerSegments: [],
  couponFingerprints: [],
  authorityActorId: null,
  online: true,
};
const lines: PromotionInputLine[] = [
  {
    orderItemId: 'line-1',
    productId: 'meal-1',
    variantId: null,
    categoryAncestry: ['category-1'],
    quantity: 2,
    unitPrice: new Decimal('10.00'),
    modifierDeltas: [],
    compAllocation: new Decimal(0),
  },
];
const rule: PromotionRule = {
  promotionId: 'promo-1',
  promotionCode: 'LUNCH15',
  versionId: 'version-1',
  versionNumber: 1,
  status: 'PUBLISHED',
  effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
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
  allowedBranchIds: [scope.branchId],
  allowedChannels: ['DINE_IN'],
  customerSegmentRef: null,
  minimumQuantity: null,
  minimumAmount: new Decimal('20.00'),
  benefitKind: 'PERCENT_OFF',
  benefitBasisPoints: 1500,
  benefitAmount: null,
  buyQuantity: null,
  getQuantity: null,
  applicationBasis: 'ORDER',
  maxBenefitAmount: null,
  currency: 'USD',
  components: [],
  priority: 1,
  stackingGroup: 'lunch',
  stackingMode: 'STACKABLE',
  stopFurtherProcessing: false,
  maxApplicationsPerOrder: 1,
  perOrderCap: null,
  globalCap: null,
  perCustomerCap: null,
  budgetAmount: null,
  offlinePolicy: 'ALLOW',
  ruleHash: 'rule-hash-1',
};

function envelope(
  overrides: Partial<PromotionCacheEnvelope['payload']> = {}
): PromotionCacheEnvelope {
  return {
    signature: 'signed',
    payload: {
      schemaVersion: POS_STORE_SCHEMA_VERSION,
      engineVersion: PROMOTION_ENGINE_VERSION,
      scope,
      channel: 'DINE_IN',
      revisionId: 'revision-1',
      revisionHash: 'revision-hash-1',
      etag: 'etag-1',
      issuedAt: '2026-08-29T09:55:00.000Z',
      validUntil: '2026-08-29T10:05:00.000Z',
      rules: [serializePromotionRule(rule)],
      ...overrides,
    },
  };
}

const validation = (candidate: PromotionCacheEnvelope | null, monotonicNowMs = 1_000) =>
  validatePromotionCache({
    envelope: candidate,
    scope,
    channel: 'DINE_IN',
    time: { serverTimeMs: Date.parse('2026-08-29T10:00:00.000Z'), monotonicTimeMs: 1_000 },
    monotonicNowMs,
    verifySignature: vi.fn(async (_payload, signature) => signature === 'signed'),
  });

describe('promotion cache offline parity', () => {
  it('promotion_offline_same_revision_matches_online_byte_for_byte', async () => {
    const checked = await validation(envelope());
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const canonicalInput = serializePromotionInput({ context, lines, rules: [rule] });
    const online = evaluatePromotions({ context, lines, rules: [rule] });
    const offline = evaluateCachedPromotions(checked.cache, canonicalInput);
    expect(serializePromotionResult(offline)).toEqual(serializePromotionResult(online));
    expect(offline.discountTotal.toFixed(2)).toBe('3.00');
  });

  it('promotion_cache_scope_schema_signature_expiry_and_invalidation_fail_closed', async () => {
    await expect(validation(null)).resolves.toMatchObject({ ok: false, reason: 'MISSING' });
    await expect(validation({ ...envelope(), signature: 'bad' })).resolves.toMatchObject({
      ok: false,
      reason: 'SIGNATURE',
    });
    await expect(
      validation(envelope({ scope: { ...scope, deviceId: 'device-2' } }))
    ).resolves.toMatchObject({ ok: false, reason: 'SCOPE' });
    await expect(validation(envelope({ schemaVersion: 99 }))).resolves.toMatchObject({
      ok: false,
      reason: 'SCHEMA',
    });
    await expect(validation(envelope(), 301_000)).resolves.toMatchObject({
      ok: false,
      reason: 'EXPIRED',
    });
    expect(invalidatePromotionCache(envelope(), 'etag-2')).toBeNull();
  });

  it('promotion_offline_refuses_cap_segment_and_online_authority_rules', async () => {
    for (const unsafe of [
      { globalCap: 1 },
      { customerSegmentRef: 'vip' },
      { activationMode: 'MANAGER' as const },
    ]) {
      await expect(
        validation(envelope({ rules: [serializePromotionRule({ ...rule, ...unsafe })] }))
      ).resolves.toMatchObject({ ok: false, reason: 'ONLINE_REQUIRED' });
    }
  });
});
