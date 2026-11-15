export const LOYALTY_POINT_VALUE_MINOR = 100;

export function pointsForNetPaid(netPaidMinor: number): number {
  if (!Number.isSafeInteger(netPaidMinor) || netPaidMinor < 0)
    throw new RangeError('INVALID_MONEY');
  return Math.floor(netPaidMinor / LOYALTY_POINT_VALUE_MINOR);
}

export function redemptionFor(input: {
  requestedPoints: number;
  availablePoints: number;
  outstandingMinor: number;
}) {
  const { requestedPoints, availablePoints, outstandingMinor } = input;
  if (
    !Number.isSafeInteger(requestedPoints) ||
    !Number.isSafeInteger(availablePoints) ||
    !Number.isSafeInteger(outstandingMinor) ||
    requestedPoints <= 0 ||
    availablePoints < 0 ||
    outstandingMinor <= 0
  )
    throw new RangeError('INVALID_REDEMPTION');
  if (requestedPoints > availablePoints) throw new RangeError('INSUFFICIENT_POINTS');
  const points = Math.min(
    requestedPoints,
    Math.floor(outstandingMinor / LOYALTY_POINT_VALUE_MINOR)
  );
  if (points === 0) throw new RangeError('REDEMPTION_BELOW_MINIMUM');
  return { points, amountMinor: points * LOYALTY_POINT_VALUE_MINOR };
}

/**
 * DEV-746: how points are earned is owner configuration, separate from the fixed
 * redemption value above (1 point always redeems for LOYALTY_POINT_VALUE_MINOR).
 *
 * - PERCENT_OF_SPEND: `earnPoints` per `perSpendMinor`, pro rata (2% is 200 points per
 *   PKR 100,000 = 10,000,000 minor; whole points only, the remainder is not paid out).
 * - POINTS_PER_SPEND_STEP: `earnPoints` for each complete `perSpendMinor` step
 *   (1 point per PKR 1,000 spent).
 *
 * A rule may never pay back more than the money spent (earnPoints * point value <= spend).
 */
export const LOYALTY_EARN_MODES = ['PERCENT_OF_SPEND', 'POINTS_PER_SPEND_STEP'] as const;
export type LoyaltyEarnMode = (typeof LOYALTY_EARN_MODES)[number];
export type LoyaltyEarnRule = { earnMode: string; earnPoints: number; perSpendMinor: number };

/** Percentage rules are stored as basis points of this denominator (10,000 bp = 100%). */
export const LOYALTY_PERCENT_SPEND_MINOR = 1_000_000;
const MAX_INT4 = 2_147_483_647;

export function assertLoyaltyEarnRule(rule: LoyaltyEarnRule): asserts rule is {
  earnMode: LoyaltyEarnMode;
  earnPoints: number;
  perSpendMinor: number;
} {
  if (
    !(LOYALTY_EARN_MODES as readonly string[]).includes(rule.earnMode) ||
    !Number.isSafeInteger(rule.earnPoints) ||
    !Number.isSafeInteger(rule.perSpendMinor) ||
    rule.earnPoints <= 0 ||
    rule.perSpendMinor <= 0 ||
    rule.perSpendMinor > MAX_INT4 ||
    BigInt(rule.earnPoints) * BigInt(LOYALTY_POINT_VALUE_MINOR) > BigInt(rule.perSpendMinor)
  )
    throw new RangeError('INVALID_EARN_RULE');
}

/** Whole points for a spend under one rule; exact integer arithmetic, never rounds up. */
export function earnedPointsFor(spendMinor: number, rule: LoyaltyEarnRule): number {
  if (!Number.isSafeInteger(spendMinor) || spendMinor < 0) throw new RangeError('INVALID_MONEY');
  assertLoyaltyEarnRule(rule);
  const spend = BigInt(spendMinor);
  const per = BigInt(rule.perSpendMinor);
  const reward = BigInt(rule.earnPoints);
  const points =
    rule.earnMode === 'POINTS_PER_SPEND_STEP' ? (spend / per) * reward : (spend * reward) / per;
  if (points > BigInt(MAX_INT4)) throw new RangeError('POINTS_OVERFLOW');
  return Number(points);
}

/**
 * Points for `amountMinor` collected on top of `startMinor` already collected against
 * the same debt, so instalments together earn what one payment of the total would.
 */
export function earnedPointsForTranche(
  startMinor: number,
  amountMinor: number,
  rule: LoyaltyEarnRule
): number {
  if (!Number.isSafeInteger(startMinor) || startMinor < 0) throw new RangeError('INVALID_MONEY');
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new RangeError('INVALID_MONEY');
  return earnedPointsFor(startMinor + amountMinor, rule) - earnedPointsFor(startMinor, rule);
}

/** Plain-language description of an earning rule for owners and staff. */
export function describeLoyaltyEarnRule(rule: LoyaltyEarnRule): string {
  if (rule.earnMode === 'PERCENT_OF_SPEND') {
    const percent = (rule.earnPoints * LOYALTY_POINT_VALUE_MINOR * 100) / rule.perSpendMinor;
    return `${Number(percent.toFixed(4))}% of spend`;
  }
  const rupees = (rule.perSpendMinor / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 });
  return `${rule.earnPoints.toLocaleString('en-PK')} ${rule.earnPoints === 1 ? 'point' : 'points'} for every PKR ${rupees} spent`;
}
