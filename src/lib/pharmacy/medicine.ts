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
