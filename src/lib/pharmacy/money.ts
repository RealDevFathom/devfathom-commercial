/** Floor a nonnegative integer money share without rounding its intermediate product. */
export function proportionalMinor(amountMinor: number, units: number, totalUnits: number): number {
  return Number((BigInt(amountMinor) * BigInt(units)) / BigInt(totalUnits));
}
