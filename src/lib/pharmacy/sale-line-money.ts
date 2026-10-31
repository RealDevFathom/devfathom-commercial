/** Integer money shared by checkout, refund authorization and journal adapters. */
export function apportionDiscount(totalMinor: number, weights: readonly number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0 || weights.length === 0) return weights.map(() => 0);
  // Cumulative rounding keeps every share within its weight when total <= sum(weights).
  let through = 0;
  return weights.map((weight) => {
    const before = Math.floor((totalMinor * through) / total);
    through += weight;
    return Math.floor((totalMinor * through) / total) - before;
  });
}

type Money = { grossMinor?: number | null; discountMinor?: number | null };
type ReturnMoney = Money & { canonicalUnits: number };
type SoldMoney = {
  grossMinor?: number;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  canonicalUnits: number;
  returnLines?: readonly ReturnMoney[];
  unidentifiedReturnHolds?: readonly ReturnMoney[];
};

export function saleAllocationMoney<T extends Money & { id: string; canonicalUnits: number }>(
  line: SoldMoney & { allocations: readonly T[] }
) {
  const gross = line.grossMinor ?? line.quantity * line.unitPriceMinor;
  const units = line.allocations.map((row) => row.canonicalUnits);
  // Historical allocations predate the snapshot and were charged a uniform line price.
  const historicalGross = apportion(gross, units);
  const historicalDiscount = apportion(line.discountMinor, units);
  return line.allocations.map((row, i) => ({
    ...row,
    grossMinor: row.grossMinor ?? historicalGross[i]!,
    discountMinor: row.discountMinor ?? historicalDiscount[i]!,
  }));
}

export function apportion(totalMinor: number, weights: readonly number[]) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0 || weights.length === 0) return weights.map(() => 0);
  const shares = weights.map((weight) => Math.floor((totalMinor * weight) / total));
  shares[shares.length - 1]! += totalMinor - shares.reduce((sum, share) => sum + share, 0);
  return shares;
}

/** Historical returns retain their original cumulative average valuation. */
export function returnedMoney(line: SoldMoney) {
  const rows = [...(line.returnLines ?? []), ...(line.unidentifiedReturnHolds ?? [])];
  const legacyUnits = rows
    .filter((row) => row.grossMinor == null || row.discountMinor == null)
    .reduce((sum, row) => sum + row.canonicalUnits, 0);
  const gross = line.grossMinor ?? line.quantity * line.unitPriceMinor;
  let netMinor = Math.floor(((gross - line.discountMinor) * legacyUnits) / line.canonicalUnits);
  let discountMinor = Math.floor((line.discountMinor * legacyUnits) / line.canonicalUnits);
  for (const row of rows) {
    if (row.grossMinor != null && row.discountMinor != null) {
      netMinor += row.grossMinor - row.discountMinor;
      discountMinor += row.discountMinor;
    }
  }
  return { netMinor, discountMinor, units: rows.reduce((sum, row) => sum + row.canonicalUnits, 0) };
}

/** Snapshot a return once, under the sold-line lock; later returns cannot revalue it. */
export function priceReturn(
  line: SoldMoney,
  units: number,
  charged?: { grossMinor: number; discountMinor: number }
) {
  const prior = returnedMoney(line);
  const gross = line.grossMinor ?? line.quantity * line.unitPriceMinor;
  const net = gross - line.discountMinor;
  const remainingNet = net - prior.netMinor;
  const remainingDiscount = line.discountMinor - prior.discountMinor;
  const final = prior.units + units === line.canonicalUnits;
  const delta = (amount: number) =>
    Math.floor((amount * (prior.units + units)) / line.canonicalUnits) -
    Math.floor((amount * prior.units) / line.canonicalUnits);
  // Unidentified holds retain the average policy. Bound every new snapshot by
  // unreturned money; the final physical slice takes any remaining rounding.
  const netMinor = final
    ? remainingNet
    : Math.min(remainingNet, charged ? charged.grossMinor - charged.discountMinor : delta(net));
  const discountMinor = final
    ? remainingDiscount
    : Math.min(remainingDiscount, charged ? charged.discountMinor : delta(line.discountMinor));
  if (netMinor < 0 || discountMinor < 0) throw new Error('Invalid return money');
  return { grossMinor: netMinor + discountMinor, discountMinor };
}
