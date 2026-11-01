const DAY_MS = 86_400_000;

export type ExpiryRiskPosition = {
  daysLeft: number;
  valueAtRiskMinor: number;
};

/** Cumulative PKR-at-risk buckets for unexpired lots (days left rounded up). */
export function expiryRiskBuckets(
  rows: readonly ExpiryRiskPosition[],
  windows: readonly number[] = [30, 60, 90]
) {
  return windows.map((days) => ({
    days,
    valueAtRiskMinor: rows
      .filter((row) => row.daysLeft > 0 && row.daysLeft <= days)
      .reduce((total, row) => total + row.valueAtRiskMinor, 0),
  }));
}

export function supplierReturnDates(expiresAt: Date, returnWindowDays: number | null) {
  if (!returnWindowDays) return null;
  return {
    opensAt: new Date(expiresAt.getTime() - returnWindowDays * DAY_MS),
    deadlineAt: expiresAt,
  };
}

/** Promotions are only suggested for explicitly OTC or non-drug/front-shop stock. */
export function maySuggestExpiryMarkdown(input: {
  rx: boolean;
  restricted: boolean;
  controlled: boolean;
  otc: boolean;
  productFamily: string;
}) {
  if (input.rx || input.restricted || input.controlled) return false;
  return input.otc || input.productFamily === 'FRONT_SHOP' || input.productFamily === 'DEVICE';
}
