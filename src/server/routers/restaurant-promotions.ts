import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import type { PromotionRule } from '@/lib/restaurant/promotion-contracts';
import { computeRuleHash, ruleSnapshotOf } from '@/lib/restaurant/promotion-snapshot';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { capabilityProcedure, router } from '../trpc';

const configureProcedure = capabilityProcedure('restaurant:configure');
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const identifier = z.string().min(1);
const money = z.string().regex(/^\d+(?:\.\d{1,2})?$/, 'Enter a non-negative amount.');
const nullableMoney = money.nullable().default(null);
const nullablePositiveInt = z.number().int().positive().nullable().default(null);
const componentSchema = strict({
  productIds: z.array(identifier).max(100).default([]),
  categoryIds: z.array(identifier).max(100).default([]),
  quantity: z.number().int().positive(),
});
const offerRuleSchema = strict({
  effectiveFrom: z.coerce.date(),
  effectiveTo: z.coerce.date().nullable().default(null),
  timezone: z.string().min(1).max(100),
  dayMask: z.number().int().min(1).max(127).default(127),
  startMinute: z.number().int().min(0).max(1439).nullable().default(null),
  endMinute: z.number().int().min(0).max(1439).nullable().default(null),
  targetKind: z.enum(['ITEM', 'CATEGORY', 'ORDER']),
  targetProductIds: z.array(identifier).max(100).default([]),
  targetVariantIds: z.array(identifier).max(100).default([]),
  targetCategoryIds: z.array(identifier).max(100).default([]),
  includeDescendants: z.boolean().default(false),
  componentTargeting: z.boolean().default(false),
  allowedBranchIds: z.array(identifier).max(100).default([]),
  allowedChannels: z
    .array(z.enum(['DINE_IN', 'TAKEAWAY', 'DELIVERY']))
    .max(3)
    .default([]),
  minimumQuantity: nullablePositiveInt,
  minimumAmount: nullableMoney,
  benefitKind: z.enum([
    'PERCENT_OFF',
    'AMOUNT_OFF',
    'FIXED_PRICE',
    'BUY_X_GET_Y_PERCENT',
    'BUY_X_GET_Y_AMOUNT',
    'BUY_X_GET_Y_FREE',
    'BUNDLE_PRICE',
  ]),
  benefitBasisPoints: z.number().int().min(1).max(10_000).nullable().default(null),
  benefitAmount: nullableMoney,
  buyQuantity: nullablePositiveInt,
  getQuantity: nullablePositiveInt,
  applicationBasis: z.enum(['LINE', 'UNIT', 'ORDER']),
  maxBenefitAmount: nullableMoney,
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((value) => value.toUpperCase()),
  components: z.array(componentSchema).max(20).default([]),
  priority: z.number().int().default(0),
  stackingGroup: z.string().max(80).default(''),
  stackingMode: z.enum(['EXCLUSIVE', 'GROUP_EXCLUSIVE', 'STACKABLE']).default('STACKABLE'),
  stopFurtherProcessing: z.boolean().default(false),
  maxApplicationsPerOrder: nullablePositiveInt,
  perOrderCap: nullablePositiveInt,
  offlinePolicy: z.enum(['ALLOW', 'ONLINE_ONLY']).default('ALLOW'),
});
const createOfferSchema = strict({
  code: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[A-Z0-9_-]+$/),
  name: z.string().trim().min(1).max(160),
  rule: offerRuleSchema,
});

type OfferRuleInput = z.infer<typeof offerRuleSchema>;

function decimal(value: string | null) {
  return value === null ? null : new Prisma.Decimal(value);
}

function validateRuleShape(rule: OfferRuleInput) {
  const invalid = (message: string): never => {
    throw new TRPCError({ code: 'BAD_REQUEST', message });
  };
  try {
    new Intl.DateTimeFormat('en', { timeZone: rule.timezone });
  } catch {
    invalid('Choose a valid timezone.');
  }
  if ((rule.startMinute === null) !== (rule.endMinute === null))
    invalid('Provide both daily window endpoints.');
  if (
    (rule.targetKind === 'ITEM' && rule.targetCategoryIds.length) ||
    (rule.targetKind === 'CATEGORY' &&
      (rule.targetProductIds.length || rule.targetVariantIds.length)) ||
    (rule.targetKind === 'ORDER' &&
      (rule.targetProductIds.length ||
        rule.targetVariantIds.length ||
        rule.targetCategoryIds.length))
  ) {
    invalid('Selected records must match the target type.');
  }
  const percent = rule.benefitKind.includes('PERCENT');
  const amount = ['AMOUNT_OFF', 'FIXED_PRICE', 'BUY_X_GET_Y_AMOUNT', 'BUNDLE_PRICE'].includes(
    rule.benefitKind
  );
  const buyGet = rule.benefitKind.startsWith('BUY_X_GET_Y');
  if (
    (!percent && rule.benefitBasisPoints !== null) ||
    (!amount && rule.benefitAmount !== null) ||
    (!buyGet && (rule.buyQuantity !== null || rule.getQuantity !== null))
  ) {
    invalid('Benefit operands must match the benefit type.');
  }
  if (
    (rule.benefitKind !== 'BUNDLE_PRICE' && rule.components.length) ||
    rule.components.some(
      (component) => !component.productIds.length && !component.categoryIds.length
    )
  ) {
    invalid('Bundle components must contain product or category records.');
  }

  if (rule.effectiveTo && rule.effectiveTo <= rule.effectiveFrom)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'End time must be after start time.' });
  if (rule.targetKind === 'ITEM' && rule.targetProductIds.length === 0)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose at least one item.' });
  if (rule.targetKind === 'CATEGORY' && rule.targetCategoryIds.length === 0)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose at least one category.' });
  if (rule.benefitKind.includes('PERCENT') && rule.benefitBasisPoints === null)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Enter a percentage benefit.' });
  if (
    ['AMOUNT_OFF', 'FIXED_PRICE', 'BUY_X_GET_Y_AMOUNT', 'BUNDLE_PRICE'].includes(
      rule.benefitKind
    ) &&
    rule.benefitAmount === null
  )
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Enter a monetary benefit.' });
  if (rule.benefitKind.startsWith('BUY_X_GET_Y') && (!rule.buyQuantity || !rule.getQuantity))
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Enter buy and get quantities.' });
  if (rule.benefitKind === 'BUNDLE_PRICE' && rule.components.length === 0)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Add at least one bundle component.' });
}

async function assertPickerReferences(db: ScopedDb, rule: OfferRuleInput) {
  const productIds = [
    ...new Set([...rule.targetProductIds, ...rule.components.flatMap((x) => x.productIds)]),
  ];
  const categoryIds = [
    ...new Set([...rule.targetCategoryIds, ...rule.components.flatMap((x) => x.categoryIds)]),
  ];
  const [branches, products, variants, categories] = await Promise.all([
    db.restaurantBranch.count({
      where: { id: { in: [...new Set(rule.allowedBranchIds)] }, active: true },
    }),
    db.restaurantProduct.count({ where: { id: { in: productIds }, status: 'ACTIVE' } }),
    db.restaurantProductVariant.count({
      where: { id: { in: [...new Set(rule.targetVariantIds)] } },
    }),
    db.restaurantCategory.count({ where: { id: { in: categoryIds } } }),
  ]);
  if (
    branches !== new Set(rule.allowedBranchIds).size ||
    products !== productIds.length ||
    variants !== new Set(rule.targetVariantIds).size ||
    categories !== categoryIds.length
  )
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'A selected branch, item, variant, or category is unavailable in this workspace.',
    });
}

function buildRule(params: {
  promotionId: string;
  code: string;
  versionId: string;
  versionNumber: number;
  input: OfferRuleInput;
}): PromotionRule {
  const rule = params.input;
  return {
    promotionId: params.promotionId,
    promotionCode: params.code,
    versionId: params.versionId,
    versionNumber: params.versionNumber,
    status: 'DRAFT',
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
    timezone: rule.timezone,
    dayMask: rule.dayMask,
    startMinute: rule.startMinute,
    endMinute: rule.endMinute,
    activationMode: 'AUTOMATIC',
    couponCodeHash: null,
    requiresCoAuthorization: false,
    targetKind: rule.targetKind,
    targetProductIds: rule.targetProductIds,
    targetVariantIds: rule.targetVariantIds,
    targetCategoryIds: rule.targetCategoryIds,
    includeDescendants: rule.includeDescendants,
    componentTargeting: rule.componentTargeting,
    allowedBranchIds: rule.allowedBranchIds,
    allowedChannels: rule.allowedChannels,
    customerSegmentRef: null,
    minimumQuantity: rule.minimumQuantity,
    minimumAmount: decimal(rule.minimumAmount),
    benefitKind: rule.benefitKind,
    benefitBasisPoints: rule.benefitBasisPoints,
    benefitAmount: decimal(rule.benefitAmount),
    buyQuantity: rule.buyQuantity,
    getQuantity: rule.getQuantity,
    applicationBasis: rule.applicationBasis,
    maxBenefitAmount: decimal(rule.maxBenefitAmount),
    currency: rule.currency,
    components: rule.components.map((component, ordinal) => ({ ...component, ordinal })),
    priority: rule.priority,
    stackingGroup: rule.stackingGroup,
    stackingMode: rule.stackingMode,
    stopFurtherProcessing: rule.stopFurtherProcessing,
    maxApplicationsPerOrder: rule.maxApplicationsPerOrder,
    perOrderCap: rule.perOrderCap,
    globalCap: null,
    perCustomerCap: null,
    budgetAmount: null,
    offlinePolicy: rule.offlinePolicy,
    ruleHash: '',
  };
}

type Draft = Prisma.RestaurantPromotionVersionGetPayload<{ include: { components: true } }>;

const editableOperandsSchema = offerRuleSchema.pick({
  benefitKind: true,
  benefitBasisPoints: true,
  benefitAmount: true,
  buyQuantity: true,
  getQuantity: true,
});

// Do not silently repair a stored rule when an operator edits another field.
function hasRepresentableStoredValues(draft: Draft, name: string) {
  const parsedName = createOfferSchema.shape.name.safeParse(name);
  const parsedCurrency = offerRuleSchema.shape.currency.safeParse(draft.currency);
  if (
    !parsedName.success ||
    parsedName.data !== name ||
    /[\r\n]/.test(name) ||
    !parsedCurrency.success ||
    parsedCurrency.data !== draft.currency
  )
    return false;
  const parsed = editableOperandsSchema.safeParse({
    benefitKind: draft.benefitKind,
    benefitBasisPoints: draft.benefitBasisPoints,
    benefitAmount: draft.benefitAmount?.toString() ?? null,
    buyQuantity: draft.buyQuantity,
    getQuantity: draft.getQuantity,
  });
  if (!parsed.success) return false;
  const value = parsed.data;
  const percent = value.benefitKind.includes('PERCENT');
  const amount = ['AMOUNT_OFF', 'FIXED_PRICE', 'BUY_X_GET_Y_AMOUNT', 'BUNDLE_PRICE'].includes(
    value.benefitKind
  );
  const buyGet = value.benefitKind.startsWith('BUY_X_GET_Y');
  return (
    (percent ? value.benefitBasisPoints !== null : value.benefitBasisPoints === null) &&
    (amount ? value.benefitAmount !== null : value.benefitAmount === null) &&
    (buyGet
      ? value.buyQuantity !== null && value.getQuantity !== null
      : value.buyQuantity === null && value.getQuantity === null)
  );
}

function editRestriction(draft: Draft | undefined, name: string): string | null {
  if (!draft || draft.status !== 'DRAFT') return 'Only the latest draft can be edited.';
  if (
    draft.activationMode !== 'AUTOMATIC' ||
    draft.requiresCoAuthorization ||
    [
      draft.couponCodeHash,
      draft.requiredPermission,
      draft.approvedByStaffId,
      draft.approvalReference,
      draft.customerSegmentRef,
      draft.globalCap,
      draft.perCustomerCap,
      draft.budgetAmount,
      draft.publishedAt,
      draft.supersededAt,
    ].some((value) => value !== null)
  ) {
    return 'This offer has advanced rules or approval evidence and is read-only here.';
  }
  if (
    (draft.targetKind === 'ORDER' &&
      (draft.targetProductIds.length ||
        draft.targetVariantIds.length ||
        draft.targetCategoryIds.length)) ||
    (draft.targetKind === 'ITEM' &&
      (!draft.targetProductIds.length || draft.targetCategoryIds.length)) ||
    (draft.targetKind === 'CATEGORY' &&
      (!draft.targetCategoryIds.length ||
        draft.targetProductIds.length ||
        draft.targetVariantIds.length))
  ) {
    return 'This offer has additional targeting rules and is read-only here.';
  }
  const components = draft.components;
  if (
    draft.benefitKind === 'BUNDLE_PRICE'
      ? components.length < 1 ||
        components.length > 20 ||
        components.some(
          (component, index) =>
            component.ordinal !== index ||
            component.variantIds.length > 0 ||
            (!component.productIds.length && !component.categoryIds.length) ||
            !componentSchema.safeParse({
              productIds: component.productIds,
              categoryIds: component.categoryIds,
              quantity: component.quantity,
            }).success
        )
      : components.length > 0
  ) {
    return 'This bundle uses advanced components and is read-only here.';
  }
  if (!hasRepresentableStoredValues(draft, name)) {
    return 'This offer has stored values this editor cannot preserve and is read-only here.';
  }
  return null;
}

function prismaRuleSnapshot(rule: PromotionRule): Prisma.InputJsonObject {
  const snapshot = ruleSnapshotOf(rule);
  if (snapshot === null || Array.isArray(snapshot) || typeof snapshot !== 'object') {
    throw new TypeError('A promotion rule snapshot must be a JSON object.');
  }
  return snapshot as Prisma.InputJsonObject;
}

function versionData(rule: PromotionRule) {
  const ruleHash = computeRuleHash(rule);
  return {
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
    timezone: rule.timezone,
    dayMask: rule.dayMask,
    startMinute: rule.startMinute,
    endMinute: rule.endMinute,
    activationMode: rule.activationMode,
    couponCodeHash: null,
    requiresCoAuthorization: false,
    targetKind: rule.targetKind,
    targetProductIds: [...rule.targetProductIds],
    targetVariantIds: [...rule.targetVariantIds],
    targetCategoryIds: [...rule.targetCategoryIds],
    includeDescendants: rule.includeDescendants,
    componentTargeting: rule.componentTargeting,
    allowedBranchIds: [...rule.allowedBranchIds],
    allowedChannels: [...rule.allowedChannels],
    customerSegmentRef: null,
    minimumQuantity: rule.minimumQuantity,
    minimumAmount: rule.minimumAmount,
    benefitKind: rule.benefitKind,
    benefitBasisPoints: rule.benefitBasisPoints,
    benefitAmount: rule.benefitAmount,
    buyQuantity: rule.buyQuantity,
    getQuantity: rule.getQuantity,
    applicationBasis: rule.applicationBasis,
    maxBenefitAmount: rule.maxBenefitAmount,
    currency: rule.currency,
    priority: rule.priority,
    stackingGroup: rule.stackingGroup,
    stackingMode: rule.stackingMode,
    stopFurtherProcessing: rule.stopFurtherProcessing,
    maxApplicationsPerOrder: rule.maxApplicationsPerOrder,
    perOrderCap: rule.perOrderCap,
    offlinePolicy: rule.offlinePolicy,
    ruleSnapshot: prismaRuleSnapshot(rule),
    ruleHash,
  };
}

/**
 * Owner/admin promotion read model. Identifiers are deliberately returned only
 * alongside tenant-scoped, human-readable records so the authoring console can
 * use pickers instead of asking an operator to paste database identifiers.
 */
export const restaurantPromotionsRouter = router({
  list: configureProcedure.query(async ({ ctx }) => {
    const promotions = await ctx.db.restaurantPromotion.findMany({
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      include: {
        versions: {
          orderBy: { versionNumber: 'desc' },
          take: 1,
          include: { components: { orderBy: { ordinal: 'asc' } } },
        },
      },
    });

    return promotions.map((promotion) => ({
      ...promotion,
      editRestriction: editRestriction(promotion.versions[0], promotion.name),
      latestVersion: promotion.versions[0]
        ? {
            ...promotion.versions[0],
            minimumAmount: promotion.versions[0].minimumAmount?.toString() ?? null,
            benefitAmount: promotion.versions[0].benefitAmount?.toString() ?? null,
            maxBenefitAmount: promotion.versions[0].maxBenefitAmount?.toString() ?? null,
            budgetAmount: promotion.versions[0].budgetAmount?.toString() ?? null,
          }
        : null,
      versions: undefined,
    }));
  }),

  pickerOptions: configureProcedure.query(async ({ ctx }) => {
    const [branches, categories, products] = await Promise.all([
      ctx.db.restaurantBranch.findMany({
        where: { active: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, timezone: true },
      }),
      ctx.db.restaurantCategory.findMany({
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, parentId: true },
      }),
      ctx.db.restaurantProduct.findMany({
        where: { status: 'ACTIVE' },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          categoryId: true,
          variants: { orderBy: { sortOrder: 'asc' }, select: { id: true, name: true } },
        },
      }),
    ]);
    return { branches, categories, products };
  }),

  assertBranchAccess: configureProcedure
    .input(strict({ branchId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const branch = await ctx.db.restaurantBranch.findFirst({
        where: {
          id: input.branchId,
          organizationId: ctx.entitlements.organizationId,
          active: true,
        },
        select: { id: true, name: true, timezone: true },
      });
      if (!branch) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'The selected branch is unavailable in this workspace.',
        });
      }
      return branch;
    }),

  createOffer: configureProcedure.input(createOfferSchema).mutation(async ({ ctx, input }) => {
    validateRuleShape(input.rule);
    await assertPickerReferences(ctx.db, input.rule);
    return ctx.db.$transaction(async (tx) => {
      const promotion = await tx.restaurantPromotion.create({
        data: { code: input.code, name: input.name },
      });
      const versionId = crypto.randomUUID();
      const rule = buildRule({
        promotionId: promotion.id,
        code: promotion.code,
        versionId,
        versionNumber: 1,
        input: input.rule,
      });
      const version = await tx.restaurantPromotionVersion.create({
        data: {
          id: versionId,
          promotionId: promotion.id,
          versionNumber: 1,
          ...versionData(rule),
          components: {
            create: rule.components.map((component) => ({
              ...component,
              productIds: [...component.productIds],
              categoryIds: [...component.categoryIds],
              variantIds: [],
            })),
          },
        },
      });
      await tx.restaurantPromotionAuditEvent.create({
        data: {
          action: 'DRAFT_CREATED',
          promotionId: promotion.id,
          promotionVersionId: version.id,
          actorUserId: ctx.session.user.id,
          payloadHash: version.ruleHash,
        },
      });
      return { promotionId: promotion.id, versionId: version.id, ruleHash: version.ruleHash };
    });
  }),

  editOffer: configureProcedure
    .input(
      strict({
        promotionId: identifier,
        expectedVersionId: identifier,
        expectedRuleHash: z.string().min(1),
        expectedUpdatedAt: z.coerce.date(),
        name: z.string().trim().min(1).max(160),
        rule: offerRuleSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      validateRuleShape(input.rule);
      await assertPickerReferences(ctx.db, input.rule);
      const promotion = await ctx.db.restaurantPromotion.findFirst({
        where: { id: input.promotionId, status: 'ACTIVE' },
        include: {
          versions: {
            orderBy: { versionNumber: 'desc' },
            take: 1,
            include: { components: { orderBy: { ordinal: 'asc' } } },
          },
        },
      });
      const draft = promotion?.versions[0];
      if (!promotion || !draft)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Editable offer draft not found.' });
      if (
        draft.id !== input.expectedVersionId ||
        draft.ruleHash !== input.expectedRuleHash ||
        draft.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()
      ) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'The offer changed. Reload before editing.',
        });
      }
      const restriction = editRestriction(draft, promotion.name);
      if (restriction) throw new TRPCError({ code: 'CONFLICT', message: restriction });
      const rule = buildRule({
        promotionId: promotion.id,
        code: promotion.code,
        versionId: draft.id,
        versionNumber: draft.versionNumber,
        input: input.rule,
      });
      return ctx.db.$transaction(async (tx) => {
        // A concurrent publication or edit must not mutate a previously read draft.
        const version = await tx.restaurantPromotionVersion
          .update({
            where: {
              id: draft.id,
              status: 'DRAFT',
              ruleHash: draft.ruleHash,
              updatedAt: draft.updatedAt,
              promotion: { status: 'ACTIVE' },
            },
            data: {
              ...versionData(rule),
              components: {
                deleteMany: {},
                create: rule.components.map((component) => ({
                  ...component,
                  productIds: [...component.productIds],
                  categoryIds: [...component.categoryIds],
                  variantIds: [],
                })),
              },
            },
          })
          .catch((error: unknown) => {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
              throw new TRPCError({
                code: 'CONFLICT',
                message: 'The offer changed. Reload before editing.',
              });
            }
            throw error;
          });
        await tx.restaurantPromotion.update({
          where: { id: promotion.id, status: 'ACTIVE' },
          data: { name: input.name },
        });
        await tx.restaurantPromotionAuditEvent.create({
          data: {
            action: 'DRAFT_EDITED',
            promotionId: promotion.id,
            promotionVersionId: draft.id,
            actorUserId: ctx.session.user.id,
            payloadHash: version.ruleHash,
          },
        });
        return { promotionId: promotion.id, versionId: version.id, ruleHash: version.ruleHash };
      });
    }),

  disableOffer: configureProcedure
    .input(strict({ promotionId: identifier, reason: z.string().trim().min(3).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const promotion = await ctx.db.restaurantPromotion.findFirst({
        where: { id: input.promotionId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!promotion)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Active offer not found.' });
      return ctx.db.$transaction(async (tx) => {
        const disabled = await tx.restaurantPromotion.update({
          where: { id: promotion.id },
          data: { status: 'ARCHIVED', archivedAt: new Date() },
        });
        await tx.restaurantPromotionAuditEvent.create({
          data: {
            action: 'EMERGENCY_DISABLED',
            promotionId: promotion.id,
            actorUserId: ctx.session.user.id,
            reasonCode: input.reason,
          },
        });
        return { id: disabled.id, status: disabled.status };
      });
    }),
});
