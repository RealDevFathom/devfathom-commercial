/** Print lines for a settled receipt. Null when the bill has no restaurant customer. */
export type LoyaltyReceiptBalance = {
  pointsBalance: number;
  pointsEarned: number;
  pointsPerPkr: string | null;
  balancePkr: string;
};

export function loyaltyReceiptLines(loyalty: LoyaltyReceiptBalance | null | undefined): string[] {
  if (!loyalty) return [];
  const lines = [`Loyalty balance ${loyalty.pointsBalance} points / PKR ${loyalty.balancePkr}`];
  if (loyalty.pointsEarned > 0) {
    lines.push(`Loyalty earned ${loyalty.pointsEarned} points`);
  }
  return lines;
}
