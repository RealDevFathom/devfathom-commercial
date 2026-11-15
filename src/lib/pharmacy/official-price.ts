/**
 * DEV-693: the one sentence shown for an official DRAP price change, on the
 * owner's list and as a goods-in hint. It reports the regulator's figure only.
 */
export function officialPriceText(alert: { effectiveDate: Date; notifiedPriceMinor: number }) {
  const amount = new Intl.NumberFormat('en-PK', {
    style: 'currency',
    currency: 'PKR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(alert.notifiedPriceMinor / 100);
  return `Official price changed as of ${alert.effectiveDate.toISOString().slice(0, 10)}: ${amount}`;
}
