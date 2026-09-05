import 'server-only';

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import {
  PROMOTION_ERROR,
  PromotionError,
  type PromotionRule,
} from '@/lib/restaurant/promotion-contracts';
import { evaluatePromotions } from '@/lib/restaurant/promotion-evaluator';
import { computeRuleHash, ruleSnapshotOf } from '@/lib/restaurant/promotion-snapshot';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const id = z.string().trim().min(1).max(191);

export const createPublishedOrderPercentagePromotionSchema = z
  .object({
    organizationId: id,
    code: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Z0-9_-]+$/),
    name: z.string().trim().min(1).max(200),
    effectiveFrom: z.date(),
    effectiveTo: z.date(),
    publishedAt: z.date(),
    timezone: z.string().trim().min(1).max(100),
    allowedBranchIds: z.array(id).min(1).max(100),
    minimumSpend: z.number().finite().positive().max(9_999_999_999.99),
    percentageOff: z
      .number()
      .finite()
      .positive()
      .max(100)
      .refine((value) => Number.isInteger(value * 100), 'Percentage supports two decimals.'),
    currency: z
      .string()
      .trim()
      .length(3)
      .regex(/^[A-Z]{3}$/),
    actorUserId: id,
    actorStaffProfileId: id,
  })
  .strict();

export type CreatePublishedOrderPercentagePromotionInput = z.input<
  typeof createPublishedOrderPercentagePromotionSchema
>;

export async function createPublishedOrderPercentagePromotion(
  db: ScopedDb,
  rawInput: CreatePublishedOrderPercentagePromotionInput
) {
  const input = createPublishedOrderPercentagePromotionSchema.parse(rawInput);
  if (input.effectiveTo <= input.effectiveFrom) {
    throw new PromotionError(
      PROMOTION_ERROR.RULE_INVALID,
      'Promotion effectiveTo must follow effectiveFrom.'
    );
  }
  const branchIds = [...new Set(input.allowedBranchIds)];
  const [organization, branches, publications, publisher, duplicate] = await Promise.all([
    db.organization.findFirst({
      where: { id: input.organizationId },
      select: { id: true },
    }),
    db.restaurantBranch.findMany({
      where: { id: { in: branchIds }, active: true },
      select: { id: true },
    }),
    db.restaurantBranchMenuPublication.findMany({
      where: { branchId: { in: branchIds }, status: 'PUBLISHED' },
      select: { branchId: true },
    }),
    db.restaurantStaffProfile.findFirst({
      where: {
        id: input.actorStaffProfileId,
        status: 'ACTIVE',
        userId: input.actorUserId,
      },
      select: { id: true },
    }),
    db.restaurantPromotion.findUnique({
      where: {
        organizationId_code: { organizationId: input.organizationId, code: input.code },
      },
      select: { id: true },
    }),
  ]);
  if (!organization || !publisher) {
    throw new PromotionError(
      PROMOTION_ERROR.NOT_FOUND,
      'Promotion tenant or linked publisher was not found.'
    );
  }
  if (branches.length !== branchIds.length) {
    throw new PromotionError(PROMOTION_ERROR.NOT_FOUND, 'Promotion branch is missing or inactive.');
  }
  if (new Set(publications.map(({ branchId }) => branchId)).size !== branchIds.length) {
    throw new PromotionError(
      PROMOTION_ERROR.RULE_INVALID,
      'Every promotion branch requires a published menu.'
    );
  }
  if (duplicate) {
    throw new PromotionError(PROMOTION_ERROR.RULE_INVALID, 'Promotion code already exists.');
  }

  const promotion = await db.restaurantPromotion.create({
    data: { code: input.code, name: input.name },
    select: { id: true, code: true },
  });
  const versionId = randomUUID();
  const minimumAmount = new Prisma.Decimal(input.minimumSpend.toFixed(2));
  const ruleBase: PromotionRule = {
    promotionId: promotion.id,
    promotionCode: promotion.code,
    versionId,
    versionNumber: 1,
    status: 'PUBLISHED',
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    timezone: input.timezone,
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
    allowedBranchIds: branchIds,
    allowedChannels: ['DINE_IN', 'TAKEAWAY', 'DELIVERY'],
    customerSegmentRef: null,
    minimumQuantity: null,
    minimumAmount,
    benefitKind: 'PERCENT_OFF',
    benefitBasisPoints: Math.round(input.percentageOff * 100),
    benefitAmount: null,
    buyQuantity: null,
    getQuantity: null,
    applicationBasis: 'ORDER',
    maxBenefitAmount: null,
    currency: input.currency,
    components: [],
    priority: 0,
    stackingGroup: '',
    stackingMode: 'STACKABLE',
    stopFurtherProcessing: false,
    maxApplicationsPerOrder: 1,
    perOrderCap: null,
    globalCap: null,
    perCustomerCap: null,
    budgetAmount: null,
    offlinePolicy: 'ALLOW',
    ruleHash: '',
  };
  const rule = { ...ruleBase, ruleHash: computeRuleHash(ruleBase) };
  const evaluation = evaluatePromotions({
    context: {
      evaluatedAt: input.effectiveFrom,
      branchId: branchIds[0]!,
      channel: 'DINE_IN',
      currency: input.currency,
      customerId: null,
      customerSegments: [],
      couponFingerprints: [],
      authorityActorId: null,
      online: true,
    },
    lines: [
      {
        orderItemId: 'promotion-authoring-validation',
        productId: 'order-target',
        variantId: null,
        categoryAncestry: [],
        quantity: 1,
        unitPrice: minimumAmount,
        modifierDeltas: [],
        compAllocation: new Prisma.Decimal(0),
      },
    ],
    rules: [rule],
  });
  if (evaluation.applications.length !== 1 || !evaluation.discountTotal.isPositive()) {
    throw new PromotionError(
      PROMOTION_ERROR.RULE_INVALID,
      'Promotion must produce a positive benefit at its eligibility threshold.'
    );
  }

  const canonicalRuleSnapshot = ruleSnapshotOf(rule);
  if (
    canonicalRuleSnapshot === null ||
    Array.isArray(canonicalRuleSnapshot) ||
    typeof canonicalRuleSnapshot !== 'object'
  ) {
    throw new TypeError('Published promotion rule snapshot must be a canonical JSON object.');
  }
  const ruleSnapshot: Prisma.InputJsonObject = canonicalRuleSnapshot;

  const version = await db.restaurantPromotionVersion.create({
    data: {
      id: versionId,
      promotionId: promotion.id,
      versionNumber: 1,
      status: 'PUBLISHED',
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
      timezone: input.timezone,
      dayMask: 127,
      activationMode: 'AUTOMATIC',
      approvedByStaffId: input.actorStaffProfileId,
      approvalReference: `USER:${input.actorUserId}`,
      publishedAt: input.publishedAt,
      targetKind: 'ORDER',
      allowedBranchIds: branchIds,
      allowedChannels: ['DINE_IN', 'TAKEAWAY', 'DELIVERY'],
      minimumAmount,
      benefitKind: 'PERCENT_OFF',
      benefitBasisPoints: rule.benefitBasisPoints,
      applicationBasis: 'ORDER',
      currency: input.currency,
      stackingMode: 'STACKABLE',
      maxApplicationsPerOrder: 1,
      offlinePolicy: 'ALLOW',
      ruleSnapshot,
      ruleHash: rule.ruleHash,
    },
    select: { id: true, promotionId: true, status: true, ruleHash: true },
  });
  await db.restaurantPromotionAuditEvent.createMany({
    data: ['DRAFT_CREATED', 'PUBLISHED'].map((action) => ({
      action: action as 'DRAFT_CREATED' | 'PUBLISHED',
      promotionId: promotion.id,
      promotionVersionId: version.id,
      actorUserId: input.actorUserId,
      actorStaffId: input.actorStaffProfileId,
      payloadHash: rule.ruleHash,
      occurredAt: input.publishedAt,
    })),
  });
  return { promotion, version };
}
