/**
 * Pure GS1 element-string parser for DRAP pack DataMatrix scans and GS1-128
 * carton labels.
 *
 * Stock-in uses AIs 01 (GTIN), 17 (expiry), 10 (batch) and 21 (serial). The
 * same payload is read from a secondary box or, under SRO 963(I)/2026 r.3A(4),
 * from a primary bottle or tube sold without one. A homogeneous tertiary
 * carton adds AI 00 (SSCC); its GS1-128 logistic form may carry the contained
 * GTIN as AI 02 with the pack count in AI 37 instead of AI 01. Other known AIs
 * are accepted and kept aside. An AI that is not in the table is an error so
 * the bench can fall back to manual entry.
 */

export type Gs1WarningCode = 'EXPIRY_END_OF_MONTH' | 'SERIAL_FORMAT' | 'NEAR_EXPIRY';

export const GS1_WARNING_CODES = [
  'EXPIRY_END_OF_MONTH',
  'SERIAL_FORMAT',
  'NEAR_EXPIRY',
] as const satisfies readonly Gs1WarningCode[];

/** Near-expiry window used at goods-in. Matches the stock-signal policy. */
export const GOODS_IN_NEAR_EXPIRY_DAYS = 90;

export type Gs1Warning = { code: Gs1WarningCode; message: string };

export type Gs1DataMatrixFields = {
  gtin: string;
  /** GTIN-13 when the GTIN-14 starts with 0. */
  gtin13: string | null;
  batch: string | null;
  /** Raw YYMMDD, including day 00 when that is what the pack encoded. */
  expiry: string | null;
  /** Calendar date. Day 00 is the last day of the month. */
  expiryDate: string | null;
  serial: string | null;
  /** SSCC (AI 00) of a tertiary carton. Present only when the label carries one. */
  sscc?: string;
  /** Packs in a GS1-128 logistic unit (AI 37 with AI 02). Present only with AI 02. */
  count?: number;
  unknownAis: ReadonlyArray<{ ai: string; value: string }>;
  warnings: readonly Gs1Warning[];
};

export type Gs1DataMatrixParseResult =
  | { kind: 'parsed'; fields: Gs1DataMatrixFields }
  | { kind: 'not-gs1'; reason: string }
  | { kind: 'invalid'; reason: string };

const GROUP_SEPARATOR = '\u001d';
const CORE_AIS = new Set(['01', '10', '17', '21']);
/** Carton AIs read into named fields rather than kept aside. */
const CARTON_AIS = new Set(['00', '02', '37']);
const GS1_TEXT = /^[0-9A-Za-z!"%&'()*+,\-./:;<=>?_]+$/;

/** Fixed length, or a variable maximum. Variable AIs end at the next separator. */
const AIS = new Map<string, { fixed?: number; max?: number; numeric?: boolean }>([
  ['00', { fixed: 18, numeric: true }],
  ['01', { fixed: 14, numeric: true }],
  ['02', { fixed: 14, numeric: true }],
  ['11', { fixed: 6, numeric: true }],
  ['12', { fixed: 6, numeric: true }],
  ['13', { fixed: 6, numeric: true }],
  ['15', { fixed: 6, numeric: true }],
  ['16', { fixed: 6, numeric: true }],
  ['17', { fixed: 6, numeric: true }],
  ['20', { fixed: 2, numeric: true }],
  ['10', { max: 20 }],
  ['21', { max: 20 }],
  ['30', { max: 8, numeric: true }],
  ['37', { max: 8, numeric: true }],
  ['240', { max: 30 }],
  ['241', { max: 30 }],
]);

const SYMBOLOGY = [']d2', ']C1', ']Q3'] as const;

export function gtinCheckDigit(dataDigits: string): number {
  let sum = 0;
  for (let index = 0; index < dataDigits.length; index += 1) {
    const digit = Number(dataDigits[dataDigits.length - 1 - index]);
    sum += digit * (index % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** GS1 sliding window: YY−current ≥ 51 is the previous century; ≤ −50 is the next. */
export function gs1Year(yy: number, now: Date): number {
  const current = now.getUTCFullYear();
  const currentYy = current % 100;
  const century = current - currentYy;
  const delta = yy - currentYy;
  if (delta >= 51) return century - 100 + yy;
  if (delta <= -50) return century + 100 + yy;
  return century + yy;
}

function resolveExpiry(
  value: string,
  now: Date
): { expiryDate: string; warnings: Gs1Warning[] } | { error: string } {
  if (!/^\d{6}$/.test(value)) return { error: 'Expiry (AI 17) is not a valid YYMMDD date.' };
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  if (month < 1 || month > 12) return { error: 'Expiry (AI 17) is not a valid YYMMDD date.' };
  const year = gs1Year(Number(value.slice(0, 2)), now);
  const last = lastDayOfMonth(year, month);
  if (day === 0) {
    const expiryDate = `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
    return {
      expiryDate,
      warnings: [
        {
          code: 'EXPIRY_END_OF_MONTH',
          message: 'Expiry day 00 was read as the last day of the month.',
        },
      ],
    };
  }
  if (day > last) return { error: 'Expiry (AI 17) is not a valid YYMMDD date.' };
  return {
    expiryDate: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    warnings: [],
  };
}

function matchAi(value: string, offset: number) {
  if (!/^\d{2}/.test(value.slice(offset, offset + 2))) return { malformed: true as const };
  for (const length of [4, 3, 2]) {
    const code = value.slice(offset, offset + length);
    const spec = AIS.get(code);
    if (spec) return { malformed: false as const, code, spec };
  }
  const head = value.slice(offset, offset + 4).replace(/\D.*$/, '');
  return { malformed: false as const, unknown: head || value.slice(offset, offset + 2) };
}

function parseElements(value: string, now: Date): Gs1DataMatrixParseResult {
  const elements: Array<{ ai: string; value: string }> = [];
  let offset = 0;
  while (offset < value.length) {
    if (value[offset] === GROUP_SEPARATOR) {
      offset += 1;
      continue;
    }
    const matched = matchAi(value, offset);
    if (matched.malformed)
      return { kind: 'invalid', reason: 'Malformed GS1 application identifier.' };
    if ('unknown' in matched) {
      return {
        kind: 'invalid',
        reason: `Unknown AI ${matched.unknown} cannot be read. Enter the pack by hand.`,
      };
    }
    offset += matched.code.length;
    if (matched.spec.fixed !== undefined) {
      const field = value.slice(offset, offset + matched.spec.fixed);
      if (field.length !== matched.spec.fixed || field.includes(GROUP_SEPARATOR)) {
        return { kind: 'invalid', reason: `GS1 AI ${matched.code} is truncated.` };
      }
      elements.push({ ai: matched.code, value: field });
      offset += matched.spec.fixed;
      continue;
    }
    const separator = value.indexOf(GROUP_SEPARATOR, offset);
    const end = separator === -1 ? value.length : separator;
    const field = value.slice(offset, end);
    const maximum = matched.spec.max ?? 20;
    if (!field || field.length > maximum) {
      return { kind: 'invalid', reason: `GS1 AI ${matched.code} has an invalid length.` };
    }
    if (separator === -1 && followedByKnownAi(field, maximum)) {
      return {
        kind: 'invalid',
        reason: `GS1 AI ${matched.code} is not terminated before the next AI.`,
      };
    }
    elements.push({ ai: matched.code, value: field });
    offset = end;
  }
  if (!elements.length) return { kind: 'invalid', reason: 'Malformed GS1 application identifier.' };
  return build(elements, now);
}

function parseParenthesized(raw: string, now: Date): Gs1DataMatrixParseResult {
  const elements: Array<{ ai: string; value: string }> = [];
  let offset = 0;
  while (offset < raw.length) {
    const match = /^\((\d{2,4})\)/.exec(raw.slice(offset));
    if (!match) return { kind: 'invalid', reason: 'Malformed GS1 application identifier.' };
    const code = match[1]!;
    const spec = AIS.get(code);
    if (!spec) {
      return {
        kind: 'invalid',
        reason: `Unknown AI ${code} cannot be read. Enter the pack by hand.`,
      };
    }
    offset += match[0].length;
    const next = raw.indexOf('(', offset);
    const value = raw.slice(offset, next === -1 ? raw.length : next);
    if (!value) return { kind: 'invalid', reason: `GS1 AI ${code} has no value.` };
    const limit = spec.fixed ?? spec.max ?? 20;
    if (spec.fixed !== undefined && value.length !== spec.fixed) {
      return { kind: 'invalid', reason: `GS1 AI ${code} is truncated.` };
    }
    if (value.length > limit) {
      return { kind: 'invalid', reason: `GS1 AI ${code} has an invalid length.` };
    }
    elements.push({ ai: code, value });
    offset = next === -1 ? raw.length : next;
  }
  return build(elements, now);
}

function followedByKnownAi(field: string, max: number): boolean {
  const limit = Math.min(field.length, max);
  for (let split = 1; split < field.length && split <= limit; split += 1) {
    const matched = matchAi(field, split);
    if (!matched.malformed && !('unknown' in matched)) return true;
  }
  return false;
}

/** Calendar day in UTC. Goods-in dates are stored at UTC midnight. */
export function utcDay(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

export function packIsExpired(expiry: Date, now: Date): boolean {
  if (Number.isNaN(expiry.getTime())) return true;
  return utcDay(expiry) < utcDay(now);
}

export function nearExpiryWarning(expiryDate: string, now: Date): Gs1Warning | null {
  const expiry = new Date(`${expiryDate}T00:00:00.000Z`);
  if (Number.isNaN(expiry.getTime()) || packIsExpired(expiry, now)) return null;
  const horizon = utcDay(now) + GOODS_IN_NEAR_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  if (utcDay(expiry) <= horizon) {
    return {
      code: 'NEAR_EXPIRY',
      message: 'This pack expires within 90 days. Confirm it before it is sold.',
    };
  }
  return null;
}

/**
 * One serialized pack is one unit. A GS1-128 carton with AI 37 is that many
 * packs. A scan without either keeps the outstanding order quantity.
 */
export function receivedPacksForScan(
  serial: string | null | undefined,
  outstandingPacks: number,
  cartonCount?: number | null
) {
  if (serial) return 1;
  if (cartonCount && cartonCount > 0) return cartonCount;
  return outstandingPacks;
}

function build(
  elements: Array<{ ai: string; value: string }>,
  now: Date
): Gs1DataMatrixParseResult {
  const seen = new Set<string>();
  for (const element of elements) {
    if ((CORE_AIS.has(element.ai) || CARTON_AIS.has(element.ai)) && seen.has(element.ai)) {
      return { kind: 'invalid', reason: `GS1 AI ${element.ai} is repeated.` };
    }
    seen.add(element.ai);
  }
  const first = new Map<string, string>();
  for (const element of elements) if (!first.has(element.ai)) first.set(element.ai, element.value);

  for (const [ai, value] of first) {
    const spec = AIS.get(ai);
    if (spec?.numeric && !/^\d+$/.test(value)) {
      return { kind: 'invalid', reason: `GS1 AI ${ai} must be numeric.` };
    }
    if ((ai === '10' || ai === '21') && !GS1_TEXT.test(value)) {
      return { kind: 'invalid', reason: `GS1 AI ${ai} contains a character outside the GS1 set.` };
    }
  }

  const sscc = first.get('00');
  if (sscc !== undefined && gtinCheckDigit(sscc.slice(0, 17)) !== Number(sscc[17])) {
    return { kind: 'invalid', reason: 'SSCC (AI 00) check digit does not match.' };
  }
  const contentGtin = first.get('02');
  if (first.has('01') && contentGtin !== undefined) {
    return { kind: 'invalid', reason: 'A label cannot carry both AI 01 and AI 02.' };
  }
  let count: number | undefined;
  if (contentGtin !== undefined) {
    const rawCount = first.get('37');
    count = rawCount === undefined ? 0 : Number(rawCount);
    if (sscc === undefined || !Number.isSafeInteger(count) || count < 1) {
      return {
        kind: 'invalid',
        reason: 'A carton GTIN (AI 02) needs its SSCC (AI 00) and a pack count (AI 37).',
      };
    }
  }

  // AI 37 is a named field only beside AI 02; otherwise it is kept aside.
  const named = (ai: string) =>
    CORE_AIS.has(ai) || (CARTON_AIS.has(ai) && (ai !== '37' || contentGtin !== undefined));

  const gtin = first.get('01') ?? contentGtin;
  if (!gtin) return { kind: 'invalid', reason: 'A pack-level GTIN (AI 01) is required.' };
  if (!/^\d{14}$/.test(gtin)) return { kind: 'invalid', reason: 'GTIN must contain 14 digits.' };
  if (gtinCheckDigit(gtin.slice(0, 13)) !== Number(gtin[13])) {
    return { kind: 'invalid', reason: 'GTIN check digit does not match.' };
  }

  const warnings: Gs1Warning[] = [];
  const rawExpiry = first.get('17') ?? null;
  let expiryDate: string | null = null;
  if (rawExpiry !== null) {
    const resolved = resolveExpiry(rawExpiry, now);
    if ('error' in resolved) return { kind: 'invalid', reason: resolved.error };
    expiryDate = resolved.expiryDate;
    warnings.push(...resolved.warnings);
    const near = nearExpiryWarning(resolved.expiryDate, now);
    if (near) warnings.push(near);
  }

  const batch = first.get('10') ?? null;
  const serial = first.get('21') ?? null;
  if (batch !== null && (batch.length < 1 || batch.length > 20)) {
    return { kind: 'invalid', reason: 'Batch/lot (AI 10) exceeds 20 characters.' };
  }
  if (serial !== null && (serial.length < 1 || serial.length > 20)) {
    return { kind: 'invalid', reason: 'Serial (AI 21) exceeds 20 characters.' };
  }
  if (serial !== null && contentGtin !== undefined) {
    return {
      kind: 'invalid',
      reason: 'A carton of several packs cannot carry one serial (AI 21).',
    };
  }
  if (serial !== null && !/^[0-9A-Fa-f]{12,20}$/.test(serial)) {
    warnings.push({
      code: 'SERIAL_FORMAT',
      message:
        'Serial is not 12–20 hexadecimal characters. DRAP expects that form; the pack was still accepted.',
    });
  }

  return {
    kind: 'parsed',
    fields: {
      gtin,
      gtin13: gtin.startsWith('0') ? gtin.slice(1) : null,
      batch,
      expiry: rawExpiry,
      expiryDate,
      serial,
      ...(sscc !== undefined ? { sscc } : {}),
      ...(count !== undefined ? { count } : {}),
      unknownAis: elements.filter((element) => !named(element.ai)),
      warnings,
    },
  };
}

function looksLikeGs1(original: string, body: string): boolean {
  if (SYMBOLOGY.some((prefix) => original.startsWith(prefix))) return true;
  if (body.includes(GROUP_SEPARATOR) || original.includes('<GS>')) return true;
  return /^(00|01|02)/.test(body) && body.length >= 16;
}

/**
 * Parse one scanner payload or a parenthesized element string.
 * `now` fixes the GS1 year window; production callers can omit it.
 */
export function parseGs1DataMatrix(payload: string, now = new Date()): Gs1DataMatrixParseResult {
  const original = payload.trim();
  if (!original) return { kind: 'not-gs1', reason: 'No code was supplied.' };

  let body = original;
  const prefix = SYMBOLOGY.find((item) => body.startsWith(item));
  if (prefix) body = body.slice(prefix.length);
  while (body.startsWith(GROUP_SEPARATOR)) body = body.slice(1);
  if (!body) return { kind: 'not-gs1', reason: 'No code was supplied.' };

  if (body.startsWith('(')) return parseParenthesized(body, now);
  if (!looksLikeGs1(original, body)) {
    return { kind: 'not-gs1', reason: 'Barcode is not a GS1 DataMatrix payload.' };
  }
  const scanner = body
    .replaceAll('<GS>', GROUP_SEPARATOR)
    .replaceAll('|', GROUP_SEPARATOR)
    .replaceAll('~', GROUP_SEPARATOR);
  return parseElements(scanner, now);
}
