/** Earning uses exact integer ratios; redemption remains independently fixed at PKR 1. */
export type LoyaltyRate = { mode: string; rewardPoints: number; spendMinor: number };

export const LOYALTY_RATE_OPTIONS = [
  { id: 'percent-1', label: '1% of spend', mode: 'PERCENT', rewardPoints: 1, spendMinor: 10_000 },
  { id: 'percent-2', label: '2% of spend', mode: 'PERCENT', rewardPoints: 1, spendMinor: 5_000 },
  {
    id: 'step-1000',
    label: '1 point per PKR 1,000',
    mode: 'STEP',
    rewardPoints: 1,
    spendMinor: 100_000,
  },
] as const;

export function earnedPoints(spendMinor: number, rate: LoyaltyRate): number {
  if (
    !Number.isSafeInteger(spendMinor) ||
    spendMinor < 0 ||
    !Number.isSafeInteger(rate.rewardPoints) ||
    rate.rewardPoints <= 0 ||
    !Number.isSafeInteger(rate.spendMinor) ||
    rate.spendMinor <= 0 ||
    !['PERCENT', 'STEP'].includes(rate.mode) ||
    BigInt(rate.rewardPoints) * BigInt(100) > BigInt(rate.spendMinor)
  )
    throw new RangeError('INVALID_LOYALTY_RATE');
  const spend = BigInt(spendMinor),
    step = BigInt(rate.spendMinor),
    reward = BigInt(rate.rewardPoints);
  const points = rate.mode === 'STEP' ? (spend / step) * reward : (spend * reward) / step;
  if (points > BigInt(2147483647)) throw new RangeError('LOYALTY_POINTS_OVERFLOW');
  return Number(points);
}
