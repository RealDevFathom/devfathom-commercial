export type Gs1DataMatrixFields = {
  gtin: string;
  batch: string | null;
  expiry: string | null;
  serial: string | null;
  unknownAis: ReadonlyArray<{ ai: string; value: string }>;
};

export type Gs1DataMatrixParseResult =
  | { kind: 'parsed'; fields: Gs1DataMatrixFields }
  | { kind: 'not-gs1'; reason: string }
  | { kind: 'invalid'; reason: string };

const GROUP_SEPARATOR = '\u001d';
const VARIABLE_AIS = new Map([
  ['10', 20],
  ['21', 20],
]);
const FIXED_AIS = new Map([
  ['01', 14],
  ['17', 6],
]);

function validDate(value: string) {
  const year = 2000 + Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  if (month < 1 || month > 12 || day < 1) return false;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= lastDay;
}

function parseParenthesized(raw: string): Gs1DataMatrixParseResult {
  const elements: Array<{ ai: string; value: string }> = [];
  let offset = 0;
  while (offset < raw.length) {
    const match = /^\((\d{2,4})\)/.exec(raw.slice(offset));
    if (!match) return { kind: 'invalid', reason: 'Malformed GS1 application identifier.' };
    const ai = match[1];
    offset += match[0].length;
    const next = raw.indexOf('(', offset);
    const value = raw.slice(offset, next === -1 ? raw.length : next);
    if (!value) return { kind: 'invalid', reason: `GS1 AI ${ai} has no value.` };
    elements.push({ ai, value });
    offset = next === -1 ? raw.length : next;
  }
  return build(elements);
}

function parseScannerText(raw: string): Gs1DataMatrixParseResult {
  let value = raw;
  if (value.startsWith(']d2')) value = value.slice(3);
  else if (!value.startsWith('01'))
    return { kind: 'not-gs1', reason: 'Barcode is not a GS1 DataMatrix payload.' };

  const elements: Array<{ ai: string; value: string }> = [];
  let offset = 0;
  while (offset < value.length) {
    if (value[offset] === GROUP_SEPARATOR) {
      offset += 1;
      continue;
    }
    const ai = value.slice(offset, offset + 2);
    if (!/^\d{2}$/.test(ai))
      return { kind: 'invalid', reason: 'Malformed GS1 application identifier.' };
    offset += 2;
    const fixed = FIXED_AIS.get(ai);
    if (fixed !== undefined) {
      const field = value.slice(offset, offset + fixed);
      if (field.length !== fixed) return { kind: 'invalid', reason: `GS1 AI ${ai} is truncated.` };
      elements.push({ ai, value: field });
      offset += fixed;
      continue;
    }
    const maximum = VARIABLE_AIS.get(ai);
    if (maximum === undefined)
      return { kind: 'invalid', reason: `Unknown AI ${ai} cannot be safely delimited.` };
    const separator = value.indexOf(GROUP_SEPARATOR, offset);
    const end = separator === -1 ? value.length : separator;
    const field = value.slice(offset, Math.min(end, offset + maximum));
    if (!field || end - offset > maximum)
      return { kind: 'invalid', reason: `GS1 AI ${ai} has an invalid length.` };
    elements.push({ ai, value: field });
    offset = end;
  }
  return build(elements);
}

function build(elements: Array<{ ai: string; value: string }>): Gs1DataMatrixParseResult {
  const first = new Map<string, string>();
  for (const element of elements) if (!first.has(element.ai)) first.set(element.ai, element.value);
  const gtin = first.get('01');
  if (!gtin) return { kind: 'invalid', reason: 'A pack-level GTIN (AI 01) is required.' };
  if (!/^\d{14}$/.test(gtin)) return { kind: 'invalid', reason: 'GTIN must contain 14 digits.' };
  const expiry = first.get('17') ?? null;
  if (expiry !== null && (!/^\d{6}$/.test(expiry) || !validDate(expiry)))
    return { kind: 'invalid', reason: 'Expiry (AI 17) is not a valid YYMMDD date.' };
  const batch = first.get('10') ?? null;
  const serial = first.get('21') ?? null;
  if (batch !== null && batch.length > 20)
    return { kind: 'invalid', reason: 'Batch/lot (AI 10) exceeds 20 characters.' };
  if (serial !== null && serial.length > 20)
    return { kind: 'invalid', reason: 'Serial (AI 21) exceeds 20 characters.' };
  return {
    kind: 'parsed',
    fields: {
      gtin,
      batch,
      expiry,
      serial,
      unknownAis: elements.filter((element) => !['01', '10', '17', '21'].includes(element.ai)),
    },
  };
}

/** Pure GS1 DataMatrix parser. Scanner symbology prefix and human-readable AI notation are accepted. */
export function parseGs1DataMatrix(payload: string): Gs1DataMatrixParseResult {
  const raw = payload.trim();
  if (!raw) return { kind: 'not-gs1', reason: 'No code was supplied.' };
  return raw.startsWith('(') ? parseParenthesized(raw) : parseScannerText(raw);
}
