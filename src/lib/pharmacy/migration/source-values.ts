/**
 * PH-MIG / MIG-01 — reading raw incumbent cells.
 *
 * Every function here returns `null` for anything it cannot read EXACTLY. None
 * of them guesses, rounds, or substitutes a default: an unreadable cell becomes
 * `null` here and an exception row upstream (MIG-02, "missing batch/expiry/MRP
 * is never silently defaulted"). A defaulting parser would satisfy the type
 * system and destroy the acceptance criterion.
 *
 * Money is canonical INTEGER minor units (`bigint`), never a float.
 */

/** Delimiters seen in real pharmacy exports, most specific first. */
const CANDIDATE_DELIMITERS = ['\t', '|', ';', ','] as const;

export type SourceTable = {
  readonly headers: readonly string[];
  /** One entry per data row, aligned to `headers`; short rows are padded. */
  readonly rows: readonly (readonly string[])[];
};

/**
 * Parse delimited text (CSV, TSV, and the tab-delimited ".xls" that Abuzar-class
 * DOS/Windows retail software actually emits) into a table.
 *
 * Quoting follows RFC 4180: a field may be double-quoted, and a doubled quote
 * inside a quoted field is one literal quote. Line endings may be LF or CRLF.
 *
 * TO CONFIRM IN PHASE 0: real exports may arrive in a non-UTF-8 Windows code
 * page. Decoding bytes to text happens before this function; this lane takes
 * text and records the source file's hash so a wrong decode is detectable rather
 * than silently absorbed.
 */
export function parseDelimitedText(text: string, options: { trimCells?: boolean } = {}): SourceTable {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (withoutBom.trim().length === 0) return { headers: [], rows: [] };

  const delimiter = detectDelimiter(withoutBom);
  const records = splitRecords(withoutBom, delimiter);
  const [headerRecord, ...dataRecords] = records;
  if (!headerRecord) return { headers: [], rows: [] };

  const headers = headerRecord.map((header) => header.trim());
  const rows = dataRecords
    // A trailing newline yields one empty record; an all-blank row carries no
    // incumbent record and is not an exception either.
    .filter((record) => record.some((cell) => cell.trim().length > 0))
    .map((record) => headers.map((_header, index) => {
      const cell = record[index] ?? '';
      return options.trimCells === false ? cell : cell.trim();
    }));

  return { headers, rows };
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  let best = ',';
  let bestCount = 0;
  for (const candidate of CANDIDATE_DELIMITERS) {
    const count = countOutsideQuotes(firstLine, candidate);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let inQuotes = false;
  let count = 0;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && character === delimiter) count += 1;
  }
  return count;
}

function splitRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      inQuotes = true;
    } else if (character === delimiter) {
      record.push(field);
      field = '';
    } else if (character === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else if (character !== '\r') {
      field += character;
    }
  }

  record.push(field);
  records.push(record);
  return records;
}

/** Cells the incumbent uses to mean "nothing here". */
const BLANK_TOKENS = new Set(['', '-', '--', 'n/a', 'na', 'nil', 'null', 'none', '.']);

export function isBlank(raw: string | undefined): boolean {
  return raw === undefined || BLANK_TOKENS.has(raw.trim().toLowerCase());
}

export function readText(raw: string | undefined): string | null {
  if (isBlank(raw)) return null;
  return raw!.trim().replace(/\s+/g, ' ');
}

/**
 * Read a money cell into integer minor units (paisa for PKR).
 *
 * Accepts a leading currency word or symbol, thousands separators, and up to two
 * decimal places. Returns `null` — never a rounded value — for anything else,
 * including three or more decimals, because rounding an incumbent price silently
 * changes what the pharmacy charges.
 */
export function readMoneyMinor(raw: string | undefined, minorUnitDigits = 2): bigint | null {
  if (isBlank(raw)) return null;
  const cleaned = raw!
    .trim()
    .replace(/^(?:rs\.?|pkr|₨)\s*/i, '')
    .replace(/,/g, '');
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!match) return null;

  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > minorUnitDigits) return null;

  const padded = fraction.padEnd(minorUnitDigits, '0');
  const magnitude = BigInt(whole + padded);
  return sign === '-' ? -magnitude : magnitude;
}

/**
 * Read a stock quantity as a canonical integer count.
 *
 * A fractional quantity is NOT rounded: it means the incumbent counted in a unit
 * this profiler cannot name, which is exactly the UNIT_AMBIGUOUS bucket.
 */
export function readQuantity(raw: string | undefined): bigint | null {
  if (isBlank(raw)) return null;
  const cleaned = raw!.trim().replace(/,/g, '');
  const match = /^(-?\d+)(?:\.0+)?$/.exec(cleaned);
  return match ? BigInt(match[1]!) : null;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * Read a medicine expiry into the LAST day of the expiry month, as a UTC date.
 *
 * Pharmacy expiry is a month, not a day: a pack marked "03/2027" is saleable
 * through 31 March 2027. Collapsing that to the 1st would quarantine a month of
 * saleable stock, so the month-precision forms resolve to the month end.
 *
 * TO CONFIRM IN PHASE 0: the day/month order of a numeric `dd/mm/yyyy` cell.
 * Pakistani retail software writes day-first, which is what this assumes. A cell
 * whose first component exceeds 12 proves day-first; a genuinely ambiguous cell
 * (both components ≤ 12) is read day-first and CANNOT be distinguished from a
 * US-ordered export by inspection. Confirm against a real Abuzar file before the
 * first live cutover.
 */
export function readExpiryDate(raw: string | undefined): Date | null {
  if (isBlank(raw)) return null;
  const value = raw!.trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) return exactDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const isoMonth = /^(\d{4})-(\d{2})$/.exec(value);
  if (isoMonth) return endOfMonth(Number(isoMonth[1]), Number(isoMonth[2]));

  const named = /^([A-Za-z]{3,9})[-\s/](\d{2}|\d{4})$/.exec(value);
  if (named) {
    const month = MONTH_NAMES[named[1]!.slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    return endOfMonth(expandYear(named[2]!), month);
  }

  const numericMonth = /^(\d{1,2})[/-](\d{2}|\d{4})$/.exec(value);
  if (numericMonth) {
    const month = Number(numericMonth[1]);
    if (month < 1 || month > 12) return null;
    return endOfMonth(expandYear(numericMonth[2]!), month);
  }

  const dayFirst = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(value);
  if (dayFirst) {
    return exactDate(expandYear(dayFirst[3]!), Number(dayFirst[2]), Number(dayFirst[1]));
  }

  return null;
}

/**
 * TO CONFIRM IN PHASE 0: two-digit years. A medicine expiry is always in the
 * future relative to its manufacture, and no in-scope export predates 2000, so
 * `yy` expands to `20yy`.
 */
function expandYear(raw: string): number {
  return raw.length === 4 ? Number(raw) : 2000 + Number(raw);
}

function exactDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1) return null;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  // Reject 31 February rather than letting Date roll it into March.
  if (candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null;
  return candidate;
}

function endOfMonth(year: number, month: number): Date | null {
  if (month < 1 || month > 12) return null;
  return new Date(Date.UTC(year, month, 0));
}

/**
 * Read a pack label into the integer number of canonical units it contains.
 *
 * Handles the two forms these exports use: a multiplied grid ("10x10", "1 x 20")
 * and a counted unit ("20 Tabs", "100ML"). Returns `null` when the label names
 * no countable quantity, which raises UNIT_AMBIGUOUS rather than assuming 1 —
 * assuming 1 would silently misstate every opening stock figure for that pack.
 */
export function readPackFactor(raw: string | undefined): bigint | null {
  if (isBlank(raw)) return null;
  const value = raw!
    .trim()
    .toLowerCase()
    .replace(/['’]s\b/g, '');

  const grid = /^(\d+)\s*[x*]\s*(\d+)(?:\s*[a-z]+)?$/.exec(value);
  if (grid) {
    const factor = BigInt(grid[1]!) * BigInt(grid[2]!);
    return factor > BigInt(0) ? factor : null;
  }

  const counted = /^(\d+)\s*(?:[a-z]+)?$/.exec(value);
  if (counted) {
    const factor = BigInt(counted[1]!);
    return factor > BigInt(0) ? factor : null;
  }

  return null;
}
