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

const PACK_MEASURE =
  /\d+(?:[.,]\d+)?\s*(?:ml|mls|l|ltr|litre|liter|mg|mcg|µg|μg|g|gm|gms|kg|iu|%)(?![\p{L}])/giu;
const MAX_PACK_UNITS = 2_147_483_647;

/**
 * The default receiving pack for a reviewed `pack` value: how many individual
 * units one pack holds. Only unambiguous forms are accepted ("10 tablets",
 * "Strip of 10", "10's", "3 x 10", "100 ml bottle" = one container); anything
 * else returns null so a pharmacist corrects it instead of the importer
 * inheriting a guessed multiplier.
 */
export function parseDefaultPackSize(
  input: string
): { level: 'UNIT' | 'STRIP' | 'BOX' | 'CARTON'; unitsPerParent: number } | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  const rest = text.replace(PACK_MEASURE, ' ');
  const measured = rest !== text;
  if (/\d[.,]\d/.test(rest)) return null;
  // A count of strips, boxes, etc. leaves their individual contents unknown,
  // even in a multiplication such as "2 x 10 strips".
  if (/\d+\s*(?:strip|blister|box|boxe|carton|pack|packet)s?\b/.test(rest)) return null;
  const integers = rest.match(/\d+/g) ?? [];
  let units: number;
  const chain = rest.match(/\d+(?:\s*[x×*]\s*\d+)+/);
  if (chain) {
    const factors = chain[0].match(/\d+/g)!;
    if (factors.length !== integers.length) return null;
    units = factors.reduce((total, factor) => total * Number(factor), 1);
  } else if (integers.length === 1) {
    units = Number(integers[0]);
  } else if (integers.length === 0 && measured) {
    units = 1;
  } else {
    return null;
  }
  if (!Number.isSafeInteger(units) || units <= 0 || units > MAX_PACK_UNITS) return null;
  // A chain such as "Blister 10 x 10" multiplies several packs together, so
  // the outer pack is a box of strips rather than a single strip.
  const nested = (chain?.[0].match(/\d+/g) ?? []).filter((factor) => Number(factor) > 1).length > 1;
  const level =
    units === 1
      ? 'UNIT'
      : /\bcartons?\b/.test(text)
        ? 'CARTON'
        : !nested && /\b(?:strip|blister)s?\b/.test(text)
          ? 'STRIP'
          : 'BOX';
  return { level, unitsPerParent: units };
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
  const roundingIncrementMinor = input.roundingIncrementMinor ?? 1;
  // Reuse the loose-price validation, then calculate the pro-rata amount for
  // this sale unit directly. Multiplying an already-floored loose price loses
  // the pack's remainder (for example, 1000 / 3 * 3 used to charge 999).
  deriveLooseUnitPrice({
    printedMrpMinor: input.printedMrpMinor,
    canonicalUnitsInPack: input.canonicalUnitsInPack,
    roundingIncrementMinor,
  });
  if (
    !Number.isSafeInteger(input.canonicalUnitsPerSaleUnit) ||
    input.canonicalUnitsPerSaleUnit <= 0 ||
    input.canonicalUnitsPerSaleUnit > input.canonicalUnitsInPack
  ) {
    throw new PharmacyMedicineError('INVALID_PRICE');
  }

  const proRataCeilingMinor = Number(
    (BigInt(input.printedMrpMinor) * BigInt(input.canonicalUnitsPerSaleUnit)) /
      BigInt(input.canonicalUnitsInPack)
  );
  // A sealed pack carries its printed MRP exactly. Partial sale units remain
  // rounded down to the configured increment and therefore never exceed their
  // pro-rata share.
  const unitPriceMinor =
    input.canonicalUnitsPerSaleUnit === input.canonicalUnitsInPack
      ? input.printedMrpMinor
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
