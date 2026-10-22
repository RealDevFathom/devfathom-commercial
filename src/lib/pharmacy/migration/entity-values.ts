/** Values accepted by entity preview. Committers only consume these normalized values. */
export const MAX_PACK_FACTOR = 2_147_483_647n;
export const MAX_SMALLEST_UNITS = 9_223_372_036_854_775_807n;
export type PackConversion = { unit: bigint; strip: bigint | null; box: bigint | null; smallestUnits: bigint };

function boundedPositiveInteger(text: string): bigint | null {
  if (!/^\d+$/.test(text) || text === '0' || text.length > 19) return null;
  const value = BigInt(text);
  return value <= MAX_PACK_FACTOR ? value : null;
}

export function parsePackConversion(value: unknown): PackConversion | null {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return { unit: 1n, strip: null, box: null, smallestUnits: 1n };
  // Separators may be labels or `x`; signs, decimals and embedded whitespace are rejected.
  if (/^[+-]|\d\s+\d|\d+\.\d+/.test(text)) return null;
  const tokens = text.match(/\d+/g) ?? [];
  if (tokens.length < 1 || tokens.length > 2) return null;
  const factors = tokens.map(boundedPositiveInteger);
  if (factors.some((factor) => factor === null)) return null;
  const [first, second] = factors as [bigint, bigint?];
  const product = second === undefined ? first : first * second;
  if (product > MAX_SMALLEST_UNITS) return null;
  return second === undefined
    ? { unit: 1n, strip: first, box: null, smallestUnits: first }
    : { unit: 1n, strip: second, box: first, smallestUnits: product };
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
  if (!conversion || number === null || number < 0n) return null;
  const result = number * conversion.smallestUnits;
  return result <= MAX_SMALLEST_UNITS ? result : null;
}
