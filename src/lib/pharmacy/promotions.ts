import { z } from 'zod';
import type { PharmacyPromotion } from '@/generated/prisma/client';
import { can, subjectFromSession } from '@/lib/abac';
import { receiptTextSchema } from '@/lib/receipts/configuration';
import { Decimal } from '@/lib/restaurant/money-arithmetic';
import type { PromotionRule } from '@/lib/restaurant/promotion-contracts';
import { evaluatePromotions } from '@/lib/restaurant/promotion-evaluator';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';

/**
 * #727: date-based automatic counter promotions.
 *
 * A promotion targets one medicine or every non-regulated medicine of a branch,
 * for the half-open window `effectiveFrom <= instant < effectiveTo`, with either
 * a percentage (basis points) or a fixed PKR amount off the line. It is
 * authorized by the manager who created it, so the counter needs no extra PIN.
 */
export const pharmacyPromotionInput = z
  .object({
    branchId: z.string().min(1),
    // The name is snapshotted onto issued receipts, so it obeys the receipt text contract.
    name: receiptTextSchema(80)
      .trim()
      .min(1)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
    medicineId: z.string().min(1).optional(),
    effectiveFrom: z.coerce.date(),
    effectiveTo: z.coerce.date(),
    benefitBasisPoints: z.number().int().min(1).max(10_000).optional(),
    benefitMinor: z.number().int().min(1).max(2_147_483_647).optional(),
    priority: z.number().int().min(-1_000_000).max(1_000_000).default(0),
  })
  .strict()
  .refine((value) => value.effectiveTo > value.effectiveFrom, {
    message: 'The promotion must end after it starts.',
    path: ['effectiveTo'],
  })
  .refine(
    (value) => (value.benefitBasisPoints === undefined) !== (value.benefitMinor === undefined),
    { message: 'Choose a percentage or a fixed line discount.', path: ['benefitBasisPoints'] }
  );

export type PharmacyPromotionRule = Pick<
  PharmacyPromotion,
  | 'id'
  | 'organizationId'
  | 'branchId'
  | 'name'
  | 'medicineId'
  | 'effectiveFrom'
  | 'effectiveTo'
  | 'benefitBasisPoints'
  | 'benefitMinor'
  | 'priority'
  | 'active'
  | 'createdByUserId'
>;

/** Adapt a pharmacy promotion to the shared restaurant evaluator and its exact
 * money rounding. One synthetic unit represents the whole counter line, so a
 * percentage rounds once per line and a fixed amount applies once per line. */
function toRule(promotion: PharmacyPromotionRule): PromotionRule {
  return {
    promotionId: promotion.id,
    promotionCode: promotion.id,
    versionId: promotion.id,
    versionNumber: 1,
    status: promotion.active ? 'PUBLISHED' : 'SUPERSEDED',
    effectiveFrom: promotion.effectiveFrom,
    effectiveTo: promotion.effectiveTo,
    timezone: 'UTC',
    dayMask: 127,
    startMinute: null,
    endMinute: null,
    activationMode: 'AUTOMATIC',
    couponCodeHash: null,
    requiresCoAuthorization: false,
    targetKind: promotion.medicineId ? 'ITEM' : 'ORDER',
    targetProductIds: promotion.medicineId ? [promotion.medicineId] : [],
    targetVariantIds: [],
    targetCategoryIds: [],
    includeDescendants: false,
    componentTargeting: false,
    allowedBranchIds: [promotion.branchId],
    allowedChannels: [],
    customerSegmentRef: null,
    minimumQuantity: null,
    minimumAmount: null,
    benefitKind: promotion.benefitBasisPoints !== null ? 'PERCENT_OFF' : 'AMOUNT_OFF',
    benefitBasisPoints: promotion.benefitBasisPoints,
    benefitAmount:
      promotion.benefitMinor === null ? null : new Decimal(promotion.benefitMinor).div(100),
    buyQuantity: null,
    getQuantity: null,
    applicationBasis: 'LINE',
    maxBenefitAmount: null,
    currency: 'PKR',
    components: [],
    priority: promotion.priority,
    stackingGroup: 'pharmacy-counter',
    stackingMode: 'EXCLUSIVE',
    stopFurtherProcessing: true,
    maxApplicationsPerOrder: 1,
    perOrderCap: null,
    globalCap: null,
    perCustomerCap: null,
    budgetAmount: null,
    offlinePolicy: 'ONLINE_ONLY',
    ruleHash: promotion.id,
  };
}

export type PharmacyPromotionResult = {
  promotion: PharmacyPromotionRule;
  discountMinor: number;
};

/**
 * Pick the promotion for one counter line. Rx, restricted and controlled
 * medicines never receive one. Candidates are tried by priority descending,
 * then id ascending; the first that discounts the line without selling below
 * cost wins. Promotions never stack.
 */
export function evaluatePharmacyPromotion(input: {
  organizationId: string;
  branchId: string;
  medicineId: string;
  regulated: boolean;
  grossMinor: number;
  costMinor: number;
  at: Date;
  promotions: readonly PharmacyPromotionRule[];
}): PharmacyPromotionResult | null {
  if (input.regulated) return null;
  if (
    ![input.grossMinor, input.costMinor].every((value) => Number.isSafeInteger(value) && value >= 0)
  )
    throw new RangeError('Invalid pharmacy promotion money.');
  if (input.grossMinor === 0) return null;
  const candidates = input.promotions
    .filter(
      (promotion) =>
        promotion.organizationId === input.organizationId &&
        promotion.branchId === input.branchId &&
        (promotion.medicineId === null || promotion.medicineId === input.medicineId)
    )
    .sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const promotion of candidates) {
    const result = evaluatePromotions({
      context: {
        evaluatedAt: input.at,
        branchId: input.branchId,
        channel: 'TAKEAWAY',
        currency: 'PKR',
        customerId: null,
        customerSegments: [],
        couponFingerprints: [],
        authorityActorId: null,
        online: true,
      },
      lines: [
        {
          orderItemId: 'counter-line',
          productId: input.medicineId,
          variantId: null,
          categoryAncestry: [],
          quantity: 1,
          unitPrice: new Decimal(input.grossMinor).div(100),
          modifierDeltas: [],
          compAllocation: new Decimal(0),
        },
      ],
      rules: [toRule(promotion)],
    });
    const discountMinor = result.discountTotal.times(100).toNumber();
    if (!Number.isSafeInteger(discountMinor) || discountMinor <= 0) continue;
    // An offer that would sell below cost is skipped, never allowed to block the sale.
    if (discountMinor <= input.grossMinor && input.grossMinor - discountMinor >= input.costMinor)
      return { promotion, discountMinor };
  }
  return null;
}

/** Load the promotions live at `at` for this branch and line. The caller owns the transaction. */
export async function priceCounterPromotion(
  db: ScopedDb,
  scope: LedgerScope,
  input: { medicineId: string; regulated: boolean; grossMinor: number; costMinor: number; at: Date }
): Promise<PharmacyPromotionResult | null> {
  if (input.regulated) return null;
  const promotions = await db.pharmacyPromotion.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      active: true,
      effectiveFrom: { lte: input.at },
      effectiveTo: { gt: input.at },
      OR: [{ medicineId: null }, { medicineId: input.medicineId }],
    },
  });
  // The creating manager authorizes every discount, so their rights are re-checked now:
  // a promotion whose creator is no longer an active `pharmacy:manage` holder is not applied.
  const creatorMay = new Map<string, boolean>();
  const standing: typeof promotions = [];
  for (const promotion of promotions) {
    let may = creatorMay.get(promotion.createdByUserId);
    if (may === undefined) {
      may = await promotionCreatorMayManage(db, scope.organizationId, promotion.createdByUserId);
      creatorMay.set(promotion.createdByUserId, may);
    }
    if (may) standing.push(promotion);
  }
  return evaluatePharmacyPromotion({
    ...input,
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    promotions: standing,
  });
}

/** QA-8: the creator must still be an active member holding `pharmacy:manage`. */
export async function promotionCreatorMayManage(
  db: ScopedDb,
  organizationId: string,
  userId: string
): Promise<boolean> {
  const user = await db.user.findFirst({ where: { id: userId, organizationId, status: 'ACTIVE' } });
  if (!user || user.organizationId !== organizationId || user.status !== 'ACTIVE') return false;
  return can(subjectFromSession(user), 'pharmacy:manage', undefined, { db });
}

/** The approval policy stamped on a line priced by a promotion. */
export function promotionApprovalPolicy(promotionId: string) {
  return `pharmacy-promotion:${promotionId}`;
}
