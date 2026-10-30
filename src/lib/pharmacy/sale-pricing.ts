type SaleLinePrice = {
  quantity: number;
  unitPriceMinor: number;
  /** Integer unit-price rounding, separate from an approved customer discount. */
  priceAdjustmentMinor?: number;
};

export function saleLineGrossMinor(line: SaleLinePrice) {
  return line.quantity * line.unitPriceMinor - (line.priceAdjustmentMinor ?? 0);
}

export function saleLineNetMinor(line: SaleLinePrice & { discountMinor: number }) {
  return saleLineGrossMinor(line) - line.discountMinor;
}

type ReturnedUnits = { inventoryLotId?: string; canonicalUnits: number };
type ReturnPricedLine = SaleLinePrice & {
  discountMinor: number;
  canonicalUnits: number;
  allocations?: readonly {
    inventoryLotId: string;
    canonicalUnits: number;
    unitPriceMinor?: number | null;
  }[];
  returnLines: readonly ReturnedUnits[];
  unidentifiedReturnHolds: readonly { canonicalUnits: number }[];
};

/** Value identified returns at their issued lot price. Historical allocations
 * have no price snapshot and keep their original cumulative pro-rata policy.
 * Unidentified stock retains pro-rata value, bounded by the entire paid line. */
export function returnedSaleLineMoney(line: ReturnPricedLine) {
  const unidentified = line.unidentifiedReturnHolds.reduce((n, row) => n + row.canonicalUnits, 0);
  const units = line.returnLines.reduce((n, row) => n + row.canonicalUnits, unidentified);
  const grossTotal = saleLineGrossMinor(line);
  const netTotal = saleLineNetMinor(line);
  if (!line.allocations?.length || line.allocations.some((row) => row.unitPriceMinor == null)) {
    const netMinor = Math.floor((netTotal * units) / line.canonicalUnits);
    const discountMinor = Math.floor((line.discountMinor * units) / line.canonicalUnits);
    return { grossMinor: netMinor + discountMinor, discountMinor, netMinor };
  }
  const prices = new Map(line.allocations.map((row) => [row.inventoryLotId, row.unitPriceMinor!]));
  const identifiedGross = line.returnLines.reduce(
    (n, row) => n + (prices.get(row.inventoryLotId ?? '') ?? 0) * row.canonicalUnits,
    0
  );
  const grossMinor =
    units === line.canonicalUnits
      ? grossTotal
      : Math.min(
          grossTotal,
          identifiedGross + Math.floor((grossTotal * unidentified) / line.canonicalUnits)
        );
  const netMinor = grossTotal === 0 ? 0 : Math.floor((netTotal * grossMinor) / grossTotal);
  return { grossMinor, discountMinor: grossMinor - netMinor, netMinor };
}
