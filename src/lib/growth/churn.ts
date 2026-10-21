export function calculateChurn(
  input: {
    lastPurchaseAt: Date | null;
    orders90d: number;
    totalOrders: number;
    medianGapDays: number | null;
  },
  now: Date,
  defaultGap = 30,
  threshold = 60
) {
  if (!input.lastPurchaseAt) return { churnScore: 0, churnBand: 'low' };
  const days = Math.max(0, (now.getTime() - input.lastPurchaseAt.getTime()) / 86_400_000);
  const ratio = days / Math.max(1, input.medianGapDays ?? defaultGap);
  let churnScore = Math.max(
    0,
    Math.min(100, Math.round(40 * ratio)) - Math.min(15, 3 * input.orders90d)
  );
  if (input.totalOrders === 1 && days <= 2 * defaultGap) churnScore = Math.min(59, churnScore);
  const churnBand =
    ratio > 3 || churnScore >= 80
      ? 'lost'
      : churnScore >= Math.max(40, threshold)
        ? 'high'
        : churnScore >= 40
          ? 'medium'
          : 'low';
  return { churnScore, churnBand };
}
