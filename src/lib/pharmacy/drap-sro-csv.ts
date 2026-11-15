import type { DrapNoticeSource, DrapPriceNotice } from './drap-monitoring';

/**
 * DEV-693: an SRO price schedule exported or typed up as CSV. Each row becomes a
 * DRAP price notice. The parser copies the official MRP exactly as written; it
 * never computes, rounds or suggests a price.
 */
export class DrapSroCsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DrapSroCsvError';
  }
}

const MAX_ROWS = 100;

type Column = 'registration' | 'mrp' | 'effectiveDate' | 'sro' | 'presentation' | 'pack';

const HEADERS: Record<string, Column> = {
  registration: 'registration',
  registrationnumber: 'registration',
  registrationno: 'registration',
  regno: 'registration',
  drapregistrationnumber: 'registration',
  drapregistrationno: 'registration',
  mrp: 'mrp',
  mrppkr: 'mrp',
  mrprs: 'mrp',
  maximumretailprice: 'mrp',
  effectivedate: 'effectiveDate',
  effectivefrom: 'effectiveDate',
  sro: 'sro',
  sronumber: 'sro',
  srono: 'sro',
  sroreference: 'sro',
  sourcereference: 'sro',
  presentation: 'presentation',
  pack: 'pack',
  packlevel: 'pack',
};

/** RFC 4180 rows: quoted fields may hold commas, quotes ("") and line breaks. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (quoted) throw new DrapSroCsvError('A quoted field is not closed.');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/** "1,250.50" rupees → 125050 paisa, by string arithmetic only. */
function mrpMinor(raw: string, line: number): number {
  const text = raw
    .trim()
    .replace(/^(rs\.?|pkr)\s*/i, '')
    .replaceAll(',', '');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new DrapSroCsvError(`Row ${line}: MRP "${raw.trim()}" is not a rupee amount.`);
  const minor = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(minor))
    throw new DrapSroCsvError(`Row ${line}: MRP "${raw.trim()}" is too large.`);
  return minor;
}

/** YYYY-MM-DD, or DD/MM/YYYY and DD-MM-YYYY as printed on SROs. */
function effectiveDate(raw: string, line: number): Date {
  const text = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const local = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  const [year, month, day] = iso
    ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : local
      ? [Number(local[3]), Number(local[2]), Number(local[1])]
      : [NaN, NaN, NaN];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    throw new DrapSroCsvError(
      `Row ${line}: effective date "${text}" is not a date (use YYYY-MM-DD or DD/MM/YYYY).`
    );
  return date;
}

export function parseDrapSroCsv(contents: string): DrapPriceNotice[] {
  const rows = csvRows(contents.replace(/^﻿/, ''));
  const header = rows.shift();
  if (!header) throw new DrapSroCsvError('The file is empty.');
  const columns = new Map<Column, number>();
  header.forEach((name, index) => {
    const column = HEADERS[name.toLowerCase().replace(/[^a-z0-9]/g, '')];
    if (!column) return;
    if (columns.has(column)) throw new DrapSroCsvError(`Column "${name.trim()}" appears twice.`);
    columns.set(column, index);
  });
  for (const [column, label] of [
    ['registration', 'Registration number'],
    ['mrp', 'MRP'],
    ['effectiveDate', 'Effective date'],
    ['sro', 'SRO'],
  ] as const)
    if (!columns.has(column)) throw new DrapSroCsvError(`Add a "${label}" column.`);
  if (!rows.length) throw new DrapSroCsvError('The file has no price rows.');
  if (rows.length > MAX_ROWS)
    throw new DrapSroCsvError(`Upload at most ${MAX_ROWS} rows at a time.`);

  const seen = new Set<string>();
  return rows.map((cells, index) => {
    const line = index + 2;
    const cell = (column: Column) => {
      const at = columns.get(column);
      return at === undefined ? '' : (cells[at] ?? '').trim();
    };
    const registration = cell('registration');
    const sro = cell('sro');
    if (!registration) throw new DrapSroCsvError(`Row ${line}: registration number is blank.`);
    if (!sro) throw new DrapSroCsvError(`Row ${line}: SRO is blank.`);
    const presentation = cell('presentation');
    const packText = cell('pack').toUpperCase();
    if (packText && !['BOX', 'STRIP', 'UNIT'].includes(packText))
      throw new DrapSroCsvError(`Row ${line}: pack must be BOX, STRIP or UNIT.`);
    const pack = packText as '' | 'BOX' | 'STRIP' | 'UNIT';
    // One SRO lists many medicines; each row needs its own stable reference so a
    // re-upload of the same schedule is recognised rather than duplicated.
    const sourceReference = [sro, registration, presentation, pack].filter(Boolean).join(' / ');
    if (seen.has(sourceReference))
      throw new DrapSroCsvError(`Row ${line}: this medicine is listed twice for the same SRO.`);
    seen.add(sourceReference);
    return {
      kind: 'PRICE' as const,
      ...(presentation ? { presentation } : {}),
      ...(pack ? { packLevel: pack } : {}),
      sourceReference,
      drapRegistrationNumber: registration,
      notifiedPriceMinor: mrpMinor(cell('mrp'), line),
      effectiveDate: effectiveDate(cell('effectiveDate'), line),
    };
  });
}

export class CsvDrapNoticeSource implements DrapNoticeSource {
  readonly adapter = 'FILE' as const;
  constructor(private readonly contents: string) {}
  async read(): Promise<readonly DrapPriceNotice[]> {
    return parseDrapSroCsv(this.contents);
  }
}
