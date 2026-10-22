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

/** Floors each category subtotal independently; paisa never passes through a float. */
export function categoryEarnPoints(
  subtotals: { medicineMinor: number; nonDrugMinor: number },
  rules: LoyaltyPointsRules = DEFAULT_LOYALTY_POINTS_RULES
) {
  const values = [subtotals.medicineMinor, subtotals.nonDrugMinor, ...Object.values(rules)];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0) || rules.earnBlockMinor === 0)
    throw new RangeError('INVALID_LOYALTY_RULES');
  const basePoints =
    Math.floor(subtotals.medicineMinor / rules.earnBlockMinor) * rules.medicineEarnPoints +
    Math.floor(subtotals.nonDrugMinor / rules.earnBlockMinor) * rules.nonDrugEarnPoints;
  return basePoints * rules.goldTierMultiplier;
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
    outstandingMinor <= 0 || !Number.isSafeInteger(pointValueMinor) || pointValueMinor <= 0 ||
    !Number.isSafeInteger(minimumRedemptionPoints) || minimumRedemptionPoints <= 0
  )
    throw new RangeError('INVALID_REDEMPTION');
  if (requestedPoints > availablePoints) throw new RangeError('INSUFFICIENT_POINTS');
  if (requestedPoints < minimumRedemptionPoints)
    throw new RangeError('REDEMPTION_BELOW_MINIMUM');
  const points = Math.min(
    requestedPoints,
    Math.floor(outstandingMinor / pointValueMinor)
  );
  if (points === 0) throw new RangeError('REDEMPTION_BELOW_MINIMUM');
  return { points, amountMinor: points * pointValueMinor };
}
