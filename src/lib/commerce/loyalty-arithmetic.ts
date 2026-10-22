export const LOYALTY_POINT_VALUE_MINOR = 100;
export const LOYALTY_EARN_BLOCK_MINOR = 10_000;
export const LOYALTY_MINIMUM_REDEMPTION_POINTS = 200;

export type LoyaltyPointsRules = {
  medicineEarnPoints: number;
  nonDrugEarnPoints: number;
  earnBlockMinor: number;
  pointValueMinor: number;
  minimumRedemptionPoints: number;
  goldTierMultiplier: number;
};

export const DEFAULT_LOYALTY_POINTS_RULES: LoyaltyPointsRules = {
  medicineEarnPoints: 1,
  nonDrugEarnPoints: 3,
  earnBlockMinor: LOYALTY_EARN_BLOCK_MINOR,
  pointValueMinor: LOYALTY_POINT_VALUE_MINOR,
  minimumRedemptionPoints: LOYALTY_MINIMUM_REDEMPTION_POINTS,
  goldTierMultiplier: 1,
};

/** Every points column is a PostgreSQL INTEGER. */
export const LOYALTY_POINTS_MAX = 2_147_483_647;

/**
 * Floors each category subtotal independently; paisa never passes through a float. The
 * award is computed in BigInt and refused above the INTEGER points column rather than
 * rounded or wrapped, so a large basket or owner-configured rate cannot store a wrong
 * award.
 */
export function categoryEarnPoints(
  subtotals: { medicineMinor: number; nonDrugMinor: number },
  rules: LoyaltyPointsRules = DEFAULT_LOYALTY_POINTS_RULES
) {
  // The named rule fields only: callers pass wider policy objects (expiry months, a Gold
  // flag), which are not earning rules.
  const values = [
    subtotals.medicineMinor,
    subtotals.nonDrugMinor,
    rules.medicineEarnPoints,
    rules.nonDrugEarnPoints,
    rules.earnBlockMinor,
    rules.goldTierMultiplier,
  ];
  if (
    values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    rules.earnBlockMinor === 0
  )
    throw new RangeError('INVALID_LOYALTY_RULES');
  const block = BigInt(rules.earnBlockMinor);
  const award =
    ((BigInt(subtotals.medicineMinor) / block) * BigInt(rules.medicineEarnPoints) +
      (BigInt(subtotals.nonDrugMinor) / block) * BigInt(rules.nonDrugEarnPoints)) *
    BigInt(rules.goldTierMultiplier);
  if (award > BigInt(LOYALTY_POINTS_MAX)) throw new RangeError('LOYALTY_AWARD_OUT_OF_RANGE');
  return Number(award);
}

export function pointsForNetPaid(netPaidMinor: number): number {
  if (!Number.isSafeInteger(netPaidMinor) || netPaidMinor < 0)
    throw new RangeError('INVALID_MONEY');
  return Math.floor(netPaidMinor / LOYALTY_POINT_VALUE_MINOR);
}

export function redemptionFor(input: {
  requestedPoints: number;
  availablePoints: number;
  outstandingMinor: number;
  pointValueMinor?: number;
  minimumRedemptionPoints?: number;
}) {
  const { requestedPoints, availablePoints, outstandingMinor } = input;
  const pointValueMinor = input.pointValueMinor ?? LOYALTY_POINT_VALUE_MINOR;
  const minimumRedemptionPoints = input.minimumRedemptionPoints ?? 1;
  if (
    !Number.isSafeInteger(requestedPoints) ||
    !Number.isSafeInteger(availablePoints) ||
    !Number.isSafeInteger(outstandingMinor) ||
    requestedPoints <= 0 ||
    availablePoints < 0 ||
    outstandingMinor <= 0 ||
    !Number.isSafeInteger(pointValueMinor) ||
    pointValueMinor <= 0 ||
    !Number.isSafeInteger(minimumRedemptionPoints) ||
    minimumRedemptionPoints <= 0
  )
    throw new RangeError('INVALID_REDEMPTION');
  if (requestedPoints > availablePoints) throw new RangeError('INSUFFICIENT_POINTS');
  // The minimum applies to what is actually debited: cap to what the bill can take first,
  // then refuse a capped redemption below the configured minimum (no rounding up exists:
  // decisions/loyalty-points-defaults.md requires at least the minimum per redemption).
  const points = Math.min(requestedPoints, Math.floor(outstandingMinor / pointValueMinor));
  if (points < minimumRedemptionPoints) throw new RangeError('REDEMPTION_BELOW_MINIMUM');
  return { points, amountMinor: points * pointValueMinor };
}
