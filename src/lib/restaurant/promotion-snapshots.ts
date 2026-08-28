import 'server-only';

import { Prisma } from '@/generated/prisma/client';

import { compare, equals, money, multiply, roundMoney, sum, ZERO } from './money';
import type {
  PromotionApplicationPlan,
  PromotionAuthority,
  PromotionBenefitKind,
  PromotionEvaluation,
  PromotionTargetScope,
} from './promotion-rules';

/**
 * WHA-288 Promotions Lane A — immutable application SNAPSHOTS.
 *
 * A promotion application is financial history. The rule that produced it will
 * be superseded, its code reused, its targets re-pointed at a new menu; none of
 * that may change what a guest was charged. So the application record copies
 * everything needed to explain the amount — promotion id, version id,
 * versionNumber, ruleCode, the benefit kind and its operand, the authority, the
 * target scope, and the money — and a reconstruction reads THE RECORD, never
 * the rule.
 *
 * The test of the design is blunt: six months later, with the version
 * SUPERSEDED and its targets deleted, `reconstructCheckDiscounts` on the stored
 * rows alone must still produce the same total, in the same order, with the same
 * explanation. Nothing in this module reads a promotion version.
 *
 * The rows themselves are append-only in the database (UPDATE/DELETE rejected by
 * trigger), and their parents are RESTRICT, so history cannot be rewritten or
 * orphaned even by a direct SQL client.
 */

/** Raised when a stored snapshot set is not a coherent history — a duplicated
 * or missing sequence number, a negative amount, or a snapshot that does not
 * carry the operand its benefit kind requires. */
export class PromotionSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromotionSnapshotError';
  }
}

/** Where an application lands: the order it came off, the bill it is attributed
 * to once the order is divided, and the tenant/branch/day coordinates. */
export type PromotionApplicationPlacement = {
  organizationId: string;
  orderId: string;
  billId: string | null;
  branchId: string;
  /** The order's stamped business date (C5) — never recomputed from UTC. */
  businessDate: Date;
  /** Bare snapshot columns, deliberately without a foreign key: an immutable
   * row must not be rewritten by a cascade, and a customer erasure must not be
   * blocked by a Restrict. */
  customerId: string | null;
  authorizedByStaffProfileId: string | null;
};

/** The exact insert payload for one `restaurant_promotion_applications` row. */
export type PromotionApplicationSnapshot = {
  organizationId: string;
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
  authorizedByStaffProfileId: string | null;
  orderId: string;
  billId: string | null;
  branchId: string;
  customerId: string | null;
  businessDate: Date;
  sequence: number;
  discountAmount: Prisma.Decimal;
};

/**
 * Turn an evaluation into the rows to persist.
 *
 * The only authority that carries an operator is MANAGER_OVERRIDE, and it must
 * carry one — that pairing is a DB CHECK, and it is asserted here too so a bad
 * call fails at the boundary with a useful message instead of as a constraint
 * violation three frames down.
 */
export function buildApplicationSnapshots(
  evaluation: PromotionEvaluation,
  placement: PromotionApplicationPlacement
): PromotionApplicationSnapshot[] {
  return evaluation.applications.map((application) =>
    buildApplicationSnapshot(application, placement)
  );
}

export function buildApplicationSnapshot(
  application: PromotionApplicationPlan,
  placement: PromotionApplicationPlacement
): PromotionApplicationSnapshot {
  const operator = placement.authorizedByStaffProfileId;
  if (application.authority === 'MANAGER_OVERRIDE' && operator === null) {
    throw new PromotionSnapshotError(
      `Rule ${application.ruleCode} applied under MANAGER_OVERRIDE without an authorizing operator.`
    );
  }
  if (application.authority !== 'MANAGER_OVERRIDE' && operator !== null) {
    throw new PromotionSnapshotError(
      `Rule ${application.ruleCode} applied under ${application.authority} but named an authorizing operator; only MANAGER_OVERRIDE may.`
    );
  }
  if (application.authority === 'CUSTOMER_CODE' && application.promotionCode === null) {
    throw new PromotionSnapshotError(
      `Rule ${application.ruleCode} applied under CUSTOMER_CODE without the presented code.`
    );
  }
  if (compare(application.discountAmount, ZERO) <= 0) {
    throw new PromotionSnapshotError(
      `Rule ${application.ruleCode} produced a non-positive discount; an application record must mean money moved.`
    );
  }

  return {
    organizationId: placement.organizationId,
    promotionId: application.promotionId,
    promotionVersionId: application.promotionVersionId,
    versionNumber: application.versionNumber,
    ruleCode: application.ruleCode,
    promotionCode: application.promotionCode,
    targetScope: application.targetScope,
    benefitKind: application.benefitKind,
    benefitRate: application.benefitRate,
    benefitAmount: application.benefitAmount,
    authority: application.authority,
    authorizedByStaffProfileId: operator,
    orderId: placement.orderId,
    billId: placement.billId,
    branchId: placement.branchId,
    customerId: placement.customerId,
    businessDate: placement.businessDate,
    sequence: application.sequence,
    discountAmount: roundMoney(application.discountAmount),
  };
}

/** A stored row as a reconstruction reads it — the subset that explains the
 * money. Widening this type is a warning sign: anything a reconstruction needs
 * must be ON the row. */
export type StoredPromotionApplication = {
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
  authorizedByStaffProfileId: string | null;
  sequence: number;
  discountAmount: Prisma.Decimal;
};

export type ReconstructedDiscountLine = {
  sequence: number;
  ruleCode: string;
  promotionId: string;
  promotionVersionId: string;
  versionNumber: number;
  authority: PromotionAuthority;
  authorizedByStaffProfileId: string | null;
  discountAmount: Prisma.Decimal;
  /** A plain-language restatement of the rule, from the snapshot alone. */
  explanation: string;
};

export type ReconstructedCheckDiscounts = {
  lines: readonly ReconstructedDiscountLine[];
  totalDiscount: Prisma.Decimal;
};

/** Restate a snapshot's benefit in words, using only the row. This is what a
 * reprinted receipt or an audit export says about a promotion whose rule no
 * longer exists in any readable form. */
export function describeBenefit(row: StoredPromotionApplication): string {
  switch (row.benefitKind) {
    case 'PERCENTAGE_OFF': {
      if (row.benefitRate === null) {
        throw new PromotionSnapshotError(
          `Snapshot ${row.ruleCode} is PERCENTAGE_OFF but carries no benefitRate.`
        );
      }
      const percent = multiply(row.benefitRate, 100);
      return `${percent.toDecimalPlaces(4).toString()}% off (${row.targetScope.toLowerCase()})`;
    }
    case 'AMOUNT_OFF': {
      if (row.benefitAmount === null) {
        throw new PromotionSnapshotError(
          `Snapshot ${row.ruleCode} is AMOUNT_OFF but carries no benefitAmount.`
        );
      }
      return `${row.benefitAmount.toFixed(2)} off (${row.targetScope.toLowerCase()})`;
    }
    case 'FIXED_PRICE': {
      if (row.benefitAmount === null) {
        throw new PromotionSnapshotError(
          `Snapshot ${row.ruleCode} is FIXED_PRICE but carries no benefitAmount.`
        );
      }
      return `fixed price ${row.benefitAmount.toFixed(2)} per unit (${row.targetScope.toLowerCase()})`;
    }
    case 'FREE_ITEM':
      return `free item (${row.targetScope.toLowerCase()})`;
    case 'BUY_X_GET_Y':
      return `buy-x-get-y (${row.targetScope.toLowerCase()})`;
  }
}

/**
 * Rebuild a check's discount history from its stored applications ALONE.
 *
 * Guards, because a corrupted history must not reconstruct into a plausible
 * number: sequences must start at 1, be contiguous, and be unique, and every
 * amount must be positive. A gap means a row was lost — which the append-only
 * trigger should make impossible, so it is reported rather than papered over.
 */
export function reconstructCheckDiscounts(
  rows: readonly StoredPromotionApplication[]
): ReconstructedCheckDiscounts {
  const ordered = [...rows].sort((a, b) => a.sequence - b.sequence);
  const seen = new Set<number>();
  for (const [index, row] of ordered.entries()) {
    if (seen.has(row.sequence)) {
      throw new PromotionSnapshotError(
        `Duplicate promotion application sequence ${row.sequence} on this check.`
      );
    }
    seen.add(row.sequence);
    if (row.sequence !== index + 1) {
      throw new PromotionSnapshotError(
        `Promotion application sequence is not contiguous: expected ${index + 1}, found ${row.sequence}.`
      );
    }
    if (compare(row.discountAmount, ZERO) <= 0) {
      throw new PromotionSnapshotError(
        `Promotion application ${row.ruleCode} carries a non-positive discount ${row.discountAmount.toString()}.`
      );
    }
  }

  const lines = ordered.map<ReconstructedDiscountLine>((row) => ({
    sequence: row.sequence,
    ruleCode: row.ruleCode,
    promotionId: row.promotionId,
    promotionVersionId: row.promotionVersionId,
    versionNumber: row.versionNumber,
    authority: row.authority,
    authorizedByStaffProfileId: row.authorizedByStaffProfileId,
    discountAmount: money(row.discountAmount),
    explanation: describeBenefit(row),
  }));

  return {
    lines,
    totalDiscount: sum(lines.map((line) => line.discountAmount)),
  };
}

/**
 * Independent re-derivation of a PERCENTAGE_OFF snapshot from its own rate and
 * the base it was taken against — the arithmetic audit that catches a stored
 * amount which never followed from its stored rule.
 *
 * Only the percentage kind is re-derivable from the snapshot plus a single
 * base; the unit-selecting kinds (FREE_ITEM, BUY_X_GET_Y) depend on the item
 * set, which is the order's own history, not this row's. `null` means "this
 * kind is not re-derivable here", which is not the same as "it disagrees".
 */
export function recomputeSnapshotDiscount(
  row: StoredPromotionApplication,
  base: Prisma.Decimal
): Prisma.Decimal | null {
  if (row.benefitKind !== 'PERCENTAGE_OFF' || row.benefitRate === null) return null;
  return roundMoney(multiply(base, row.benefitRate));
}

/** True iff the snapshot's stored amount matches the re-derivation exactly
 * (Decimal equality, never epsilon). Returns true when the kind is not
 * re-derivable. */
export function snapshotAgreesWithRule(
  row: StoredPromotionApplication,
  base: Prisma.Decimal
): boolean {
  const expected = recomputeSnapshotDiscount(row, base);
  return expected === null || equals(expected, row.discountAmount);
}
