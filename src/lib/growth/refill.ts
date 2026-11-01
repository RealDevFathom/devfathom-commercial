import { dosesPerDayFromDirections } from '@/lib/pharmacy/refill-support';

/** Reuse RX-07's deterministic dose grammar; unknown directions use G2's 30-day default. */
export function nextRefillDueAt(
  soldAt: Date | null,
  quantity: number | null,
  directions: string | null
) {
  if (!soldAt || !quantity) return null;
  const dose = directions ? dosesPerDayFromDirections(directions) : null;
  return new Date(soldAt.getTime() + (dose ? quantity / dose : 30) * 86_400_000);
}
