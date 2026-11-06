import { z } from 'zod';
import { receiptTextSchema } from '@/lib/receipts/configuration';
import type { PharmacyPromotion } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';
import type { PromotionRule } from '@/lib/restaurant/promotion-contracts';
import { evaluatePromotions } from '@/lib/restaurant/promotion-evaluator';
import { Decimal } from '@/lib/restaurant/money-arithmetic';

export const pharmacyPromotionInput = z
  .object({
    branchId: z.string().min(1),
    // Names are snapshotted onto issued receipts, so they must satisfy the shared
    // receipt text contract (no controls, bidi overrides or lone surrogates).
    name: receiptTextSchema(80)
      .trim()
      .min(1)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
    medicineId: z.string().min(1).optional(),
    effectiveFrom: z.date(),
    effectiveTo: z.date(),
    benefitBasisPoints: z.number().int().min(1).max(10_000).optional(),
    benefitMinor: z.number().int().min(1).max(2_147_483_647).optional(),
    priority: z.number().int().min(-2_147_483_648).max(2_147_483_647).default(0),
  })
  .strict()
  .refine((value) => value.effectiveTo > value.effectiveFrom, {
    message: 'The promotion must end after it starts.',
    path: ['effectiveTo'],
  })
  .refine(
    (value) => (value.benefitBasisPoints === undefined) !== (value.benefitMinor === undefined),
    {
      message: 'Choose a percentage or a fixed line discount.',
      path: ['benefitBasisPoints'],
    }
  );

/** Adapt the small pharmacy contract to the shared evaluator and #242 money
 * allocation. A single synthetic unit represents the entire counter line:
 * fixed benefits apply once per line and percentages round once per line.
 * Overlaps use priority descending then id ascending, without stacking.
 */
function rule(promotion: PharmacyPromotion): PromotionRule {
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

export function evaluatePharmacyPromotion(input: {
  organizationId: string;
  branchId: string;
  medicineId: string;
  regulated: boolean;
  grossMinor: number;
  costMinor: number;
  at: Date;
  promotions: readonly PharmacyPromotion[];
}) {
  if (input.regulated) return null;
  if (
    ![input.grossMinor, input.costMinor].every((value) => Number.isSafeInteger(value) && value >= 0)
  )
    throw new RangeError('Invalid pharmacy promotion money.');
  const candidates = input.promotions
    .filter(
      (promotion) =>
        promotion.organizationId === input.organizationId && promotion.branchId === input.branchId
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
      rules: [rule(promotion)],
    });
    const discountMinor = result.discountTotal.times(100).toNumber();
    // An unsafe offer is skipped, never allowed to block an otherwise safe sale.
    if (discountMinor > 0 && input.grossMinor - discountMinor >= input.costMinor)
      return { promotion, discountMinor };
  }
  return null;
}

/** Caller owns the sale transaction. The counter opts in explicitly; reserved
 * orders and signed offline replay retain their existing quoted prices. Manual
 * discounts/complimentary lines never stack with automatic offers.
 */
export async function priceCounterPromotion(
  db: ScopedDb,
  scope: LedgerScope,
  input: { medicineId: string; regulated: boolean; grossMinor: number; costMinor: number; at: Date }
) {
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
  return evaluatePharmacyPromotion({ ...input, ...scope, promotions });
}
