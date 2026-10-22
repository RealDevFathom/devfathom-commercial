/** Values accepted by entity preview. Committers only consume these normalized values. */
export type PackConversion = {
  unit: number;
  strip: number | null;
  box: number | null;
  smallestUnits: number;
};

export function parsePackConversion(value: unknown): PackConversion | null {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return { unit: 1, strip: null, box: null, smallestUnits: 1 };
  const numbers = text.match(/\d+/g)?.map(Number) ?? [];
  if (numbers.length === 0 || numbers.length > 2 || numbers.some((part) => part <= 0)) return null;
  if (numbers.length === 1) {
    return { unit: 1, strip: numbers[0]!, box: null, smallestUnits: numbers[0]! };
  }
  return {
    unit: 1,
    strip: numbers[1]!,
    box: numbers[0]!,
    smallestUnits: numbers[0]! * numbers[1]!,
  };
}

function utcDate(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date
    : null;
}

/** Parse incumbent expiry formats without allowing JS's locale-dependent date parser. */
export function parseImportExpiry(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.valueOf()))
    return utcDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 2_958_465) {
    // Excel's 1900 date system includes the fictitious 1900-02-29; this epoch preserves serials >= 60.
    const date = new Date(Date.UTC(1899, 11, 30) + Math.trunc(value) * 86_400_000);
    return utcDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  const text = String(value ?? '').trim();
  let match = /^(\d{2})\/(\d{2}|\d{4})$/.exec(text);
  if (match) {
    const year = match[2]!.length === 2 ? 2000 + Number(match[2]) : Number(match[2]);
    const month = Number(match[1]);
    if (month < 1 || month > 12) return null;
    return utcDate(year, month, new Date(Date.UTC(year, month, 0)).getUTCDate());
  }
  match = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(text);
  if (match) return utcDate(Number(match[3]), Number(match[2]), Number(match[1]));
  match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  return match ? utcDate(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

export function smallestUnitQuantity(quantity: unknown, packing: unknown): bigint | null {
  const conversion = parsePackConversion(packing);
  const number = typeof quantity === 'bigint' ? quantity : /^\d+$/.test(String(quantity ?? '').trim()) ? BigInt(String(quantity).trim()) : null;
  return conversion && number !== null && number >= 0n ? number * BigInt(conversion.smallestUnits) : null;
}
