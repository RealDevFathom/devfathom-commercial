/**
 * WHA-288 / promotions Lane A — the shared promotion vocabulary.
 *
 * Spec: docs/specs/restaurant-promotions.md (WHA-279) §3, §4, §11.
 *
 * The unions here MIRROR the Prisma `RestaurantPromotion*` enums rather than
 * importing them, following the `effective-dating.ts` precedent: the evaluator
 * that consumes them is a pure function, must stay trivially unit-testable, and
 * §7 requires the same canonical evaluator to eventually run in a client-safe
 * form for offline quoting. `promotion-evaluator.ts` therefore depends on this
 * module and on `money.ts`, never on the generated client.
 *
 * `promotion-snapshot.ts` maps these shapes onto the Prisma rows; a compile-time
 * `satisfies` there keeps the mirror honest.
 */

import type { Prisma } from '@/generated/prisma/client';

/** The engine identity stamped into every evaluation snapshot (§5.1). Bump this
 * whenever a change could alter the output for identical input — an offline
 * quote produced by a different engine version is never replayed as equal. */
export const PROMOTION_ENGINE_VERSION = '1.0.0';

/** The money/rounding contract this engine was evaluated under (§5.1). Pins
 * `money.ts`'s ROUND_HALF_UP at 2dp plus the C4 largest-remainder allocation. */
export const PROMOTION_MONEY_VERSION = 'money-c2-half-up-2dp-c4-largest-remainder';

export type PromotionVersionStatus = 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';

export type PromotionActivationMode = 'AUTOMATIC' | 'COUPON_CODE' | 'STAFF' | 'MANAGER';

export type PromotionTargetKind = 'ITEM' | 'CATEGORY' | 'ORDER';

export type PromotionBenefitKind =
  | 'PERCENT_OFF'
  | 'AMOUNT_OFF'
  | 'FIXED_PRICE'
  | 'BUY_X_GET_Y_PERCENT'
  | 'BUY_X_GET_Y_AMOUNT'
  | 'BUY_X_GET_Y_FREE'
  | 'BUNDLE_PRICE';

export type PromotionApplicationBasis = 'LINE' | 'UNIT' | 'ORDER';

export type PromotionStackingMode = 'EXCLUSIVE' | 'GROUP_EXCLUSIVE' | 'STACKABLE';

export type PromotionOfflinePolicy = 'ALLOW' | 'ONLINE_ONLY';

export type PromotionCapScopeKind = 'GLOBAL' | 'CUSTOMER' | 'BUDGET';

/** Mirrors the existing `RestaurantOrderChannel` enum — this lane consumes it
 * and does not extend it. */
export type PromotionOrderChannel = 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';

/**
 * §11 — the stable ERROR contract. These are transaction failures raised at the
 * command boundary, not candidate outcomes. Expected ineligibility never
 * appears here; it appears as a {@link PromotionRejectionReason}.
 */
export const PROMOTION_ERROR = {
  NOT_FOUND: 'PROMOTION_NOT_FOUND',
  NOT_ACTIVE: 'PROMOTION_NOT_ACTIVE',
  NOT_ELIGIBLE: 'PROMOTION_NOT_ELIGIBLE',
  CODE_INVALID: 'PROMOTION_CODE_INVALID',
  AUTH_REQUIRED: 'PROMOTION_AUTH_REQUIRED',
  CAP_EXHAUSTED: 'PROMOTION_CAP_EXHAUSTED',
  ONLINE_REQUIRED: 'PROMOTION_ONLINE_REQUIRED',
  CACHE_INVALID: 'PROMOTION_CACHE_INVALID',
  REPRICE_REQUIRED: 'PROMOTION_REPRICE_REQUIRED',
  RULE_INVALID: 'PROMOTION_RULE_INVALID',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
} as const;

export type PromotionErrorCode = (typeof PROMOTION_ERROR)[keyof typeof PROMOTION_ERROR];

/**
 * §5.1 — the stable reason code recorded against every CONSIDERED candidate.
 * Rejected candidates are retained, so "why did the lower-priority rule win"
 * is answerable six months later from the snapshot alone. These are finer than
 * the §11 error list on purpose: an auditor needs to distinguish "the day mask
 * excluded it" from "the minimum was not met".
 */
export const PROMOTION_REASON = {
  ACCEPTED: 'ACCEPTED',
  NOT_PUBLISHED: 'NOT_PUBLISHED',
  OUTSIDE_EFFECTIVE_RANGE: 'OUTSIDE_EFFECTIVE_RANGE',
  DAY_MASK_EXCLUDED: 'DAY_MASK_EXCLUDED',
  TIME_WINDOW_EXCLUDED: 'TIME_WINDOW_EXCLUDED',
  BRANCH_EXCLUDED: 'BRANCH_EXCLUDED',
  CHANNEL_EXCLUDED: 'CHANNEL_EXCLUDED',
  SEGMENT_EXCLUDED: 'SEGMENT_EXCLUDED',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  COUPON_NOT_PRESENTED: 'COUPON_NOT_PRESENTED',
  AUTHORITY_REQUIRED: 'AUTHORITY_REQUIRED',
  NO_ELIGIBLE_UNITS: 'NO_ELIGIBLE_UNITS',
  MINIMUM_QUANTITY_NOT_MET: 'MINIMUM_QUANTITY_NOT_MET',
  MINIMUM_AMOUNT_NOT_MET: 'MINIMUM_AMOUNT_NOT_MET',
  BENEFIT_NOT_POSITIVE: 'BENEFIT_NOT_POSITIVE',
  EXCLUDED_BY_EXCLUSIVE: 'EXCLUDED_BY_EXCLUSIVE',
  EXCLUDED_BY_STACKING_GROUP: 'EXCLUDED_BY_STACKING_GROUP',
  PROCESSING_STOPPED: 'PROCESSING_STOPPED',
  ONLINE_REQUIRED: 'ONLINE_REQUIRED',
} as const;

export type PromotionRejectionReason = (typeof PROMOTION_REASON)[keyof typeof PROMOTION_REASON];

/** Raised at the command boundary. §11: the owning transaction rolls back; no
 * catch converts one of these into a committed partial checkout. */
export class PromotionError extends Error {
  readonly code: PromotionErrorCode;

  constructor(code: PromotionErrorCode, message: string) {
    super(message);
    this.name = 'PromotionError';
    this.code = code;
  }
}

/**
 * §3.4/§8 one immutable BUNDLE_PRICE component requirement. A component is
 * satisfied by `quantity` units matching ANY of its product/category ids —
 * alternatives are why a promotion bundle cannot reuse combo composition.
 */
export type PromotionRuleComponent = {
  ordinal: number;
  productIds: readonly string[];
  categoryIds: readonly string[];
  quantity: number;
};

/**
 * §3.1/§3.3/§3.4 — one published version, as the evaluator sees it. This is
 * exactly the content hashed into `ruleHash` and stored in `ruleSnapshot`, so a
 * candidate row alone can drive a replay (§5.2).
 */
export type PromotionRule = {
  promotionId: string;
  promotionCode: string;
  versionId: string;
  versionNumber: number;
  status: PromotionVersionStatus;

  // §3.2 schedule. dayMask bit 0 = Monday .. bit 6 = Sunday.
  effectiveFrom: Date;
  effectiveTo: Date | null;
  timezone: string;
  dayMask: number;
  startMinute: number | null;
  endMinute: number | null;

  // §3.1 authority.
  activationMode: PromotionActivationMode;
  couponCodeHash: string | null;
  requiresCoAuthorization: boolean;

  // §3.3 target expression + common filters.
  targetKind: PromotionTargetKind;
  targetProductIds: readonly string[];
  targetVariantIds: readonly string[];
  targetCategoryIds: readonly string[];
  includeDescendants: boolean;
  componentTargeting: boolean;
  allowedBranchIds: readonly string[];
  allowedChannels: readonly PromotionOrderChannel[];
  customerSegmentRef: string | null;
  minimumQuantity: number | null;
  minimumAmount: Prisma.Decimal | null;

  // §3.4 benefit.
  benefitKind: PromotionBenefitKind;
  benefitBasisPoints: number | null;
  benefitAmount: Prisma.Decimal | null;
  buyQuantity: number | null;
  getQuantity: number | null;
  applicationBasis: PromotionApplicationBasis;
  maxBenefitAmount: Prisma.Decimal | null;
  currency: string;
  components: readonly PromotionRuleComponent[];

  // §4.2 ordering and stacking.
  priority: number;
  stackingGroup: string;
  stackingMode: PromotionStackingMode;
  stopFurtherProcessing: boolean;
  maxApplicationsPerOrder: number | null;

  // §6 caps. `perOrderCap` is settled inside the evaluation; the other three
  // require a reservation and make the rule ONLINE_ONLY.
  perOrderCap: number | null;
  globalCap: number | null;
  perCustomerCap: number | null;
  budgetAmount: Prisma.Decimal | null;

  offlinePolicy: PromotionOfflinePolicy;
  ruleHash: string;
};

/**
 * §4.1 one non-voided order line as frozen at item-add time. `categoryAncestry`
 * is the SNAPSHOTTED ancestry (nearest category first); the evaluator never
 * reads a live category tree.
 */
export type PromotionInputLine = {
  orderItemId: string;
  productId: string;
  variantId: string | null;
  categoryAncestry: readonly string[];
  quantity: number;
  unitPrice: Prisma.Decimal;
  /** Snapshotted modifier price deltas; summed into the unit's gross charge. */
  modifierDeltas: readonly Prisma.Decimal[];
  /** §4.3 step 2: manager comp already allocated to this LINE. */
  compAllocation: Prisma.Decimal;
};

/** §4.1 the stable unit key. Quantity expands into `(orderItemId, unitOrdinal)`
 * with `unitOrdinal` zero-based. */
export type PromotionUnitKey = {
  orderItemId: string;
  unitOrdinal: number;
};

/** §4.1 one expanded unit with its post-comp charge. */
export type PromotionUnit = PromotionUnitKey & {
  productId: string;
  variantId: string | null;
  categoryAncestry: readonly string[];
  /** unitPrice + Σ modifier deltas. */
  grossCharge: Prisma.Decimal;
  /** This unit's share of the line comp allocation. */
  compShare: Prisma.Decimal;
  /** grossCharge − compShare: what promotions may discount before any apply. */
  eligibleCharge: Prisma.Decimal;
};

/** §4.1/§3.3 the evaluation context. `couponFingerprints` are already hashed —
 * plaintext never reaches this module (§10). */
export type PromotionEvaluationContext = {
  evaluatedAt: Date;
  branchId: string;
  channel: PromotionOrderChannel;
  currency: string;
  customerId: string | null;
  customerSegments: readonly string[];
  couponFingerprints: readonly string[];
  /** Actor present for STAFF/MANAGER activation; null when unattended. */
  authorityActorId: string | null;
  /** §7: an offline quote refuses ONLINE_ONLY rules outright. */
  online: boolean;
};

/** §5.1 the cents this application put on one unit. */
export type PromotionUnitAllocation = PromotionUnitKey & {
  allocatedAmount: Prisma.Decimal;
};

/** §5.1 one ACCEPTED application. */
export type PromotionApplication = {
  applicationOrdinal: number;
  promotionId: string;
  promotionVersionId: string;
  ruleHash: string;
  benefitKind: PromotionBenefitKind;
  /** The exact pre-rounding benefit, retained so the rounding is auditable. */
  unroundedBenefit: Prisma.Decimal;
  roundedBenefit: Prisma.Decimal;
  /** The post-comp charge of the units this application selected. */
  qualifyingAmount: Prisma.Decimal;
  discountedQuantity: number;
  selectedUnits: readonly PromotionUnitKey[];
  allocations: readonly PromotionUnitAllocation[];
};

/** §5.1 every CONSIDERED candidate, in canonical order. */
export type PromotionCandidateOutcome = {
  ordinal: number;
  promotionId: string;
  promotionVersionId: string;
  versionNumber: number;
  ruleHash: string;
  activationMode: PromotionActivationMode;
  outcome: 'ACCEPTED' | 'REJECTED';
  reasonCode: PromotionRejectionReason;
  /** How many applications this candidate produced (0 when rejected). */
  applicationCount: number;
};

/** §4 the total function's result. */
export type PromotionEvaluationResult = {
  engineVersion: string;
  moneyVersion: string;
  /** Σ rounded benefits; equals Σ of every allocation cent. */
  discountTotal: Prisma.Decimal;
  candidates: readonly PromotionCandidateOutcome[];
  applications: readonly PromotionApplication[];
  /** The expanded units with their FINAL remaining charge, for the caller's
   * tax/bill allocation (§4.3). */
  units: readonly (PromotionUnit & { remainingCharge: Prisma.Decimal })[];
};
