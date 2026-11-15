export const LOYALTY_POINT_VALUE_MINOR = 100;

export function pointsForNetPaid(netPaidMinor: number): number {
  if (!Number.isSafeInteger(netPaidMinor) || netPaidMinor < 0)
    throw new RangeError('INVALID_MONEY');
  return Math.floor(netPaidMinor / LOYALTY_POINT_VALUE_MINOR);
}

/** DEV-764: the most one point may redeem for (PKR 1,000). */
export const LOYALTY_MAX_POINT_VALUE_MINOR = 100_000;

export function assertPointValueMinor(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > LOYALTY_MAX_POINT_VALUE_MINOR)
    throw new RangeError('INVALID_POINT_VALUE');
}

/**
 * Points redeemed against an outstanding bill. `pointValueMinor` is the owner's redemption
 * value (DEV-764); it defaults to the original fixed value of PKR 1 per point.
 */
export function redemptionFor(input: {
  requestedPoints: number;
  availablePoints: number;
  outstandingMinor: number;
  pointValueMinor?: number;
}) {
  const { requestedPoints, availablePoints, outstandingMinor } = input;
  const pointValueMinor = input.pointValueMinor ?? LOYALTY_POINT_VALUE_MINOR;
  assertPointValueMinor(pointValueMinor);
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
  const points = Math.min(requestedPoints, Math.floor(outstandingMinor / pointValueMinor));
  if (points === 0) throw new RangeError('REDEMPTION_BELOW_MINIMUM');
  return { points, amountMinor: points * pointValueMinor };
}

/**
 * DEV-764: points to give back when `releasedMinor` of a redemption tender worth
 * `tenderMinor` for `redeemedPoints` is refunded or released. Uses the value the points were
 * actually redeemed at, so a later change of redemption value never mints or loses points.
 */
export function pointsForRedeemedMoney(input: {
  releasedMinor: number;
  tenderMinor: number;
  redeemedPoints: number;
}) {
  const { releasedMinor, tenderMinor, redeemedPoints } = input;
  if (
    !Number.isSafeInteger(releasedMinor) ||
    !Number.isSafeInteger(tenderMinor) ||
    !Number.isSafeInteger(redeemedPoints) ||
    releasedMinor < 0 ||
    tenderMinor <= 0 ||
    redeemedPoints <= 0
  )
    throw new RangeError('INVALID_REDEMPTION');
  const points = (BigInt(releasedMinor) * BigInt(redeemedPoints)) / BigInt(tenderMinor);
  return Math.min(redeemedPoints, Number(points));
}

/** DEV-764: money owed for unredeemed points at the current redemption value. */
export function loyaltyLiabilityMinor(points: number, pointValueMinor: number) {
  if (!Number.isSafeInteger(points)) throw new RangeError('INVALID_POINTS');
  assertPointValueMinor(pointValueMinor);
  return Math.max(0, points) * pointValueMinor;
}

const DAY_MS = 86_400_000;
/** DEV-764: when a lot earned at `at` expires under `expiryDays`; null means never. */
export function loyaltyExpiresAt(at: Date, expiryDays: number | null | undefined) {
  if (expiryDays === null || expiryDays === undefined) return null;
  if (!Number.isSafeInteger(expiryDays) || expiryDays < 1) throw new RangeError('INVALID_EXPIRY');
  return new Date(at.getTime() + expiryDays * DAY_MS);
}

/**
 * DEV-746: how points are earned is owner configuration. DEV-764: the redemption value is too
 * (`redemptionValueMinor`, default LOYALTY_POINT_VALUE_MINOR for versions saved before it).
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
export type LoyaltyEarnRule = {
  earnMode: string;
  earnPoints: number;
  perSpendMinor: number;
  /** DEV-764: money one point redeems for under this rule; defaults to PKR 1. */
  redemptionValueMinor?: number;
};

/** Percentage rules are stored as basis points of this denominator (10,000 bp = 100%). */
export const LOYALTY_PERCENT_SPEND_MINOR = 1_000_000;
const MAX_INT4 = 2_147_483_647;

export function assertLoyaltyEarnRule(rule: LoyaltyEarnRule): asserts rule is {
  earnMode: LoyaltyEarnMode;
  earnPoints: number;
  perSpendMinor: number;
} {
  const pointValue = rule.redemptionValueMinor ?? LOYALTY_POINT_VALUE_MINOR;
  assertPointValueMinor(pointValue);
  if (
    !(LOYALTY_EARN_MODES as readonly string[]).includes(rule.earnMode) ||
    !Number.isSafeInteger(rule.earnPoints) ||
    !Number.isSafeInteger(rule.perSpendMinor) ||
    rule.earnPoints <= 0 ||
    rule.perSpendMinor <= 0 ||
    rule.perSpendMinor > MAX_INT4 ||
    BigInt(rule.earnPoints) * BigInt(pointValue) > BigInt(rule.perSpendMinor)
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
    const pointValue = rule.redemptionValueMinor ?? LOYALTY_POINT_VALUE_MINOR;
    const percent = (rule.earnPoints * pointValue * 100) / rule.perSpendMinor;
    return `${Number(percent.toFixed(4))}% of spend`;
  }
  const rupees = (rule.perSpendMinor / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 });
  return `${rule.earnPoints.toLocaleString('en-PK')} ${rule.earnPoints === 1 ? 'point' : 'points'} for every PKR ${rupees} spent`;
}

/** DEV-764: plain-language redemption value, e.g. "1 point = PKR 1". */
export function describeRedemptionValue(pointValueMinor: number): string {
  const rupees = (pointValueMinor / 100).toLocaleString('en-PK', {
    minimumFractionDigits: pointValueMinor % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `1 point = PKR ${rupees}`;
}
