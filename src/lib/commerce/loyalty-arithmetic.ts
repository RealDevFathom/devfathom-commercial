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
