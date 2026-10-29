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
  pointValueMinor?: number;
  minimumPoints?: number;
}) {
  const { requestedPoints, availablePoints, outstandingMinor } = input;
  const value = input.pointValueMinor ?? LOYALTY_POINT_VALUE_MINOR;
  const minimum = input.minimumPoints ?? 1;
  if (
    !Number.isSafeInteger(requestedPoints) ||
    !Number.isSafeInteger(availablePoints) ||
    !Number.isSafeInteger(outstandingMinor) ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    !Number.isSafeInteger(minimum) ||
    minimum < 1 ||
    requestedPoints <= 0 ||
    availablePoints < 0 ||
    outstandingMinor <= 0
  )
    throw new RangeError('INVALID_REDEMPTION');
  if (requestedPoints > availablePoints) throw new RangeError('INSUFFICIENT_POINTS');
  const points = Math.min(requestedPoints, Math.floor(outstandingMinor / value));
  if (points < minimum) throw new RangeError('REDEMPTION_BELOW_MINIMUM');
  return { points, amountMinor: points * value };
}
