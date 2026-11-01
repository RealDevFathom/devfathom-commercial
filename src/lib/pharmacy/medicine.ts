export class PharmacyMedicineError extends Error {
  constructor(
    readonly reason:
      | 'INVALID_CONVERSION'
      | 'INVALID_PRICE'
      | 'NOT_SALEABLE'
      | 'NOT_FOUND'
      | 'CROSS_TENANT_REFERENCE'
  ) {
    super(reason);
  }
}

/** Stable normalization shared by aliases, scans, and duplicate review groups. */
export function normalizeMedicineText(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** MED-03: only losslessly parse one scalar strength. Ratios and compounds need human structure. */
export function parseSimpleMedicineStrength(input: string): { value: number; unit: string } | null {
  const match = input.trim().match(/^(\d+(?:\.\d+)?)\s*([\p{L}%µμ]+)$/u);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2]!.trim();
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000 || unit.length > 50) return null;
  return { value, unit };
}

export function medicineDuplicateKey(input: {
  productName: string;
  strengths: readonly { value: number | string; unit: string }[];
  dosageForm?: string | null;
}): string {
  const strength = input.strengths
    .map(({ value, unit }) => `${value}${normalizeMedicineText(unit)}`)
    .sort()
    .join('+');
  return [
    normalizeMedicineText(input.productName),
    strength,
    normalizeMedicineText(input.dosageForm ?? ''),
  ].join(':');
}

export function canonicalUnits(quantity: number, factors: readonly number[]): number {
  if (!Number.isSafeInteger(quantity) || quantity < 0 || factors.length === 0) {
    throw new PharmacyMedicineError('INVALID_CONVERSION');
  }
  return factors.reduce((total, factor) => {
    if (!Number.isSafeInteger(factor) || factor <= 0) {
      throw new PharmacyMedicineError('INVALID_CONVERSION');
    }
    const result = total * factor;
    if (!Number.isSafeInteger(result)) throw new PharmacyMedicineError('INVALID_CONVERSION');
    return result;
  }, quantity);
}

/** Round down to the approved minor-unit increment so the pro-rata ceiling is never exceeded. */
export function deriveLooseUnitPrice(input: {
  printedMrpMinor: number;
  canonicalUnitsInPack: number;
  roundingIncrementMinor: number;
}): { unitPriceMinor: number; proRataCeilingMinor: number } {
  const { printedMrpMinor, canonicalUnitsInPack, roundingIncrementMinor } = input;
  if (
    !Number.isSafeInteger(printedMrpMinor) ||
    printedMrpMinor < 0 ||
    !Number.isSafeInteger(canonicalUnitsInPack) ||
    canonicalUnitsInPack <= 0 ||
    !Number.isSafeInteger(roundingIncrementMinor) ||
    roundingIncrementMinor <= 0
  ) {
    throw new PharmacyMedicineError('INVALID_PRICE');
  }
  const proRataCeilingMinor = Math.floor(printedMrpMinor / canonicalUnitsInPack);
  const unitPriceMinor =
    Math.floor(proRataCeilingMinor / roundingIncrementMinor) * roundingIncrementMinor;
  return { unitPriceMinor, proRataCeilingMinor };
}

/**
 * Printed-MRP rounding is approved for a particular pack AND manufacturing
 * batch. Both the counter quote and the sale writer must resolve that same
 * record; another batch's increment must never leak in through query order.
 * Lots without a recorded policy retain the one-minor-unit default.
 */
export function roundingIncrementForLot(
  lot: { packLevelId: string; batch: { batchNumber: string } },
  mrps: readonly {
    packLevelId: string;
    batchReference: string;
    roundingIncrementMinor: number;
  }[]
): number {
  return (
    mrps.find(
      (mrp) => mrp.packLevelId === lot.packLevelId && mrp.batchReference === lot.batch.batchNumber
    )?.roundingIncrementMinor ?? 1
  );
}

/**
 * MED-08: the price of one sale unit drawn from a received lot.
 *
 * Lives here, beside `deriveLooseUnitPrice`, rather than next to the sale
 * writer: the counter previews this price in the browser before a line is sent,
 * and this module is free of Prisma and `server-only` so a client bundle can
 * hold it. Keeping ONE definition is what makes the quoted price and the
 * charged price the same number.
 */
export function priceFromLot(input: {
  printedMrpMinor: number;
  canonicalUnitsInPack: number;
  canonicalUnitsPerSaleUnit: number;
  roundingIncrementMinor?: number;
}): { unitPriceMinor: number; proRataCeilingMinor: number } {
  const roundingIncrementMinor = input.roundingIncrementMinor ?? 1;
  // Keep the shared validation here, but do not multiply its already-rounded
  // loose-unit result: rounding before scaling makes a complete pack cheaper
  // than its printed MRP whenever the MRP is not divisible by the pack size.
  deriveLooseUnitPrice({
    printedMrpMinor: input.printedMrpMinor,
    canonicalUnitsInPack: input.canonicalUnitsInPack,
    roundingIncrementMinor,
  });
  // A sale unit may aggregate canonical units across more than one source pack
  // (allocation draws canonical units, not packs), so it is not capped at the
  // source pack size. Only a non-positive or non-integer conversion is invalid.
  if (
    !Number.isSafeInteger(input.canonicalUnitsPerSaleUnit) ||
    input.canonicalUnitsPerSaleUnit <= 0
  ) {
    throw new PharmacyMedicineError('INVALID_PRICE');
  }

  const proRataCeiling =
    (BigInt(input.printedMrpMinor) * BigInt(input.canonicalUnitsPerSaleUnit)) /
    BigInt(input.canonicalUnitsInPack);
  if (proRataCeiling > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PharmacyMedicineError('INVALID_PRICE');
  }
  const proRataCeilingMinor = Number(proRataCeiling);
  // Whole packs (one or several) are charged exactly at their printed MRP;
  // only a partial-pack remainder is rounded down to the approved increment.
  const unitPriceMinor =
    input.canonicalUnitsPerSaleUnit % input.canonicalUnitsInPack === 0
      ? proRataCeilingMinor
      : Math.floor(proRataCeilingMinor / roundingIncrementMinor) * roundingIncrementMinor;
  return {
    unitPriceMinor,
    proRataCeilingMinor,
  };
}

export function assertSaleable(input: {
  productFamily: 'PHARMACEUTICAL' | 'BIOLOGICAL' | 'DEVICE' | 'ALTERNATIVE' | 'FRONT_SHOP';
  hasPresentation: boolean;
  hasStrength: boolean;
  hasRegistration: boolean;
  provenanceFields: ReadonlySet<string>;
}): void {
  if (!input.hasPresentation) throw new PharmacyMedicineError('NOT_SALEABLE');
  if (input.productFamily === 'FRONT_SHOP') return;
  if (!input.hasStrength || !input.hasRegistration) {
    throw new PharmacyMedicineError('NOT_SALEABLE');
  }
  if (!input.provenanceFields.has('drapRegistrationNumber')) {
    throw new PharmacyMedicineError('NOT_SALEABLE');
  }
}
