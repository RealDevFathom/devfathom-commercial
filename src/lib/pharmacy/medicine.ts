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
  const loose = deriveLooseUnitPrice({
    printedMrpMinor: input.printedMrpMinor,
    canonicalUnitsInPack: input.canonicalUnitsInPack,
    roundingIncrementMinor: input.roundingIncrementMinor ?? 1,
  });
  return {
    unitPriceMinor: loose.unitPriceMinor * input.canonicalUnitsPerSaleUnit,
    proRataCeilingMinor: loose.proRataCeilingMinor * input.canonicalUnitsPerSaleUnit,
  };
}

/** Resolve the rounding rule for the exact pack/batch printed on a received lot. */
export function roundingIncrementForLot(
  mrps: readonly {
    packLevelId: string;
    batchReference: string;
    roundingIncrementMinor: number;
  }[],
  lot: { packLevelId: string; batchNumber: string }
): number {
  return (
    mrps.find(
      (mrp) =>
        mrp.packLevelId === lot.packLevelId && mrp.batchReference === lot.batchNumber
    )?.roundingIncrementMinor ?? 1
  );
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
