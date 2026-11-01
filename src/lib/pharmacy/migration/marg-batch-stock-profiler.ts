/**
 * #721 — the Marg ERP "Batch Stock" import preset for the PH-MIG profiler.
 *
 * Marg's practical export path is Stock → Batch Stock → Excel. That report is a
 * flat sheet with one line per item batch, under a short preamble (firm name,
 * report title, date range) and above a closing total line. This preset:
 *
 *  1. `prepareMargBatchStockTable` locates the real header row inside the
 *     preamble and sets aside report-level total lines, returning an ordinary
 *     `SourceTable` plus a record of exactly what it set aside and why. Nothing
 *     else is dropped; every other line reaches the shared pass.
 *  2. `margBatchStockProfiler` is an ordinary `SourceProfiler` over that table,
 *     so the exception rules stay the single shared pass in `profiler.ts` and the
 *     result feeds the existing workbench, batch, exception and parallel-run flow
 *     unchanged.
 *
 * TOLERANT HEADER MATCHING, NEVER FUZZY MATCHING. Headers are compared after
 * casefolding and stripping everything that is not a letter or digit, against a
 * synonym list per field ("Item Name", "ITEM NAME", "Item_Name" and "Item Name."
 * are one header; "Exp.", "Expiry" and "Exp Date" are one field). A header that
 * matches no synonym stays unmapped and its cells still reach `rawPayload`.
 *
 * ══ UNCONFIRMED AGAINST A REAL MARG FILE ══
 * The column set below is the documented one (Item Name, Batch, Exp, Qty, MRP,
 * Rate) and is exercised only against a SYNTHETIC fixture built from those
 * columns. No real customer export has been seen: the CTO's sample request is
 * outstanding. Until it is fulfilled `MARG_REAL_FILE_CONFIRMED` stays `false`
 * and `assertMargRealFileAccepted` refuses a real (non-synthetic) handover, so a
 * production cutover cannot run through an unverified mapping.
 *
 * ── Assumptions, TO CONFIRM against the first real Marg file ───────────────
 *  1. "Rate" on the Batch Stock report is the purchase (cost) rate per pack, and
 *     "MRP" the retail price per pack. Neither is converted.
 *  2. "Qty" is the closing count in packs. A free-quantity form such as "10+2"
 *     is not a whole count and is reported as UNIT_AMBIGUOUS, never summed.
 *  3. "Exp" is month precision ("05/27", "May-27") and resolves to month end via
 *     the shared `readExpiryDate`.
 *  4. The header row sits within the first `MAX_PREAMBLE_ROWS` lines.
 *  5. An item code repeats once per batch, so it is NOT the row's source key
 *     (a source key is unique within a migration batch). Rows keep their sheet
 *     position as the key and the item code survives in `rawPayload`.
 */
import { MIGRATION_TARGET_KEYS } from './mapping-targets';
import type { ColumnMap, ProfiledRow, SourceField, SourceProfiler } from './profiler';
import { parseDelimitedRecords, type SourceTable } from './source-values';

/**
 * Header synonyms per logical field, normalized form (lowercase, alphanumeric).
 * The first six are the documented Marg Batch Stock columns.
 */
export const MARG_HEADER_SYNONYMS: Readonly<Partial<Record<SourceField, readonly string[]>>> = {
  product: ['itemname', 'item', 'itemdescription', 'productname', 'product', 'particulars'],
  batch: ['batch', 'batchno', 'batchnumber', 'batchname'],
  expiry: ['exp', 'expiry', 'expdate', 'expirydate', 'expdt', 'expiredate'],
  quantity: ['qty', 'quantity', 'stock', 'stockqty', 'closingqty', 'clqty', 'balqty', 'closing'],
  mrp: ['mrp', 'mrprate', 'mrpperpack'],
  cost: ['rate', 'purrate', 'purchaserate', 'prate', 'costrate', 'cost'],
  pack: ['pack', 'packing', 'packsize', 'unit', 'uom'],
  barcode: ['barcode', 'ean', 'ean13', 'gtin'],
};

/** Fields whose header must be present for a sheet to be a Marg Batch Stock report. */
export const MARG_REQUIRED_FIELDS: readonly SourceField[] = [
  'product',
  'batch',
  'expiry',
  'quantity',
  'mrp',
  'cost',
];

/** How many leading lines may be report preamble before the header row. */
export const MAX_PREAMBLE_ROWS = 15;

/** Recorded on every batch; the suffix marks the mapping as not yet confirmed. */
export const MARG_PROFILER_VERSION = 'marg-batch-stock/1-unconfirmed';

/**
 * Flip to `true` only once a real Marg Batch Stock export has been profiled and
 * this mapping corrected against it (and bump `MARG_PROFILER_VERSION`).
 */
export const MARG_REAL_FILE_CONFIRMED = false;

const FIELD_ORDER = Object.keys(MARG_HEADER_SYNONYMS) as SourceField[];

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Map one candidate header row. Field-major, first match wins, one column per field. */
function mapHeaders(headers: readonly string[]): ColumnMap {
  const normalized = headers.map(normalizeHeader);
  const columnMap: ColumnMap = {};
  const claimed = new Set<number>();
  for (const field of FIELD_ORDER) {
    const synonyms = MARG_HEADER_SYNONYMS[field] ?? [];
    const index = normalized.findIndex(
      (header, position) => header !== '' && synonyms.includes(header) && !claimed.has(position)
    );
    if (index !== -1) {
      columnMap[field] = index;
      claimed.add(index);
    }
  }
  return columnMap;
}

export function unmappedMargRequiredFields(columnMap: ColumnMap): SourceField[] {
  return MARG_REQUIRED_FIELDS.filter((field) => columnMap[field] === undefined);
}

export type MargSetAsideLine = {
  /** 1-based position among the sheet's non-blank lines (header row included). */
  line: number;
  reason: 'PREAMBLE' | 'REPORT_TOTAL';
  cells: string[];
};

export type PreparedMargTable = {
  table: SourceTable;
  /** 1-based position of the located header row among non-blank lines. */
  headerLine: number;
  setAside: MargSetAsideLine[];
};

export class MargBatchStockFormatError extends Error {
  constructor(readonly missing: SourceField[]) {
    super(
      `No Marg Batch Stock header row found in the first ${MAX_PREAMBLE_ROWS} lines` +
        (missing.length > 0 ? `; unmapped required fields: ${missing.join(', ')}.` : '.')
    );
    this.name = 'MargBatchStockFormatError';
  }
}

const TOTAL_LABELS = new Set(['total', 'grandtotal', 'totals', 'nettotal']);

/**
 * Re-head a sheet parsed by `parseDelimitedText` (or any spreadsheet reader) so
 * the Marg header row is the table's header row.
 *
 * A line is set aside only when it is (a) above the header row, or (b) a report
 * total — its item cell reads "Total"/"Grand Total" and it carries no batch.
 * Every set-aside line is returned with its cells so an operator can see it.
 *
 * @throws {MargBatchStockFormatError} when no line in the preamble window maps
 * every required field; the error lists the fields the best candidate lacked.
 */
export function prepareMargBatchStockTable(sheet: SourceTable): PreparedMargTable {
  return prepareMargLines([
    sheet.headers.map((cell) => cell.trim()),
    ...sheet.rows.map((row) => row.map((cell) => cell.trim())),
  ]);
}

/**
 * Read a Marg Batch Stock report saved as CSV/TSV text. Preferred over
 * `parseDelimitedText` + `prepareMargBatchStockTable`, because a one-cell title
 * line would otherwise become the header and truncate every data row.
 */
export function parseMargBatchStockText(text: string): PreparedMargTable {
  return prepareMargLines(parseDelimitedRecords(text, MAX_PREAMBLE_ROWS));
}

function prepareMargLines(lines: string[][]): PreparedMargTable {
  let headerIndex = -1;
  let bestMissing: SourceField[] = [...MARG_REQUIRED_FIELDS];
  for (let index = 0; index < Math.min(lines.length, MAX_PREAMBLE_ROWS); index += 1) {
    const missing = unmappedMargRequiredFields(mapHeaders(lines[index]!));
    if (missing.length === 0) {
      headerIndex = index;
      break;
    }
    if (missing.length < bestMissing.length) bestMissing = missing;
  }
  if (headerIndex === -1) throw new MargBatchStockFormatError(bestMissing);

  const headers = lines[headerIndex]!;
  const columnMap = mapHeaders(headers);
  const setAside: MargSetAsideLine[] = lines
    .slice(0, headerIndex)
    .map((cells, index) => ({ line: index + 1, reason: 'PREAMBLE' as const, cells }));

  const rows: string[][] = [];
  lines.slice(headerIndex + 1).forEach((cells, offset) => {
    const aligned = headers.map((_header, position) => cells[position] ?? '');
    if (aligned.every((cell) => cell === '')) return;
    const item = normalizeHeader(aligned[columnMap.product!] ?? '');
    const batch = aligned[columnMap.batch!] ?? '';
    if (TOTAL_LABELS.has(item) && batch === '') {
      setAside.push({ line: headerIndex + offset + 2, reason: 'REPORT_TOTAL', cells: aligned });
      return;
    }
    rows.push(aligned);
  });

  return { table: { headers, rows }, headerLine: headerIndex + 1, setAside };
}

export class MargRealFileBlockedError extends Error {
  constructor() {
    super(
      'Real Marg Batch Stock files are blocked until a real sample has confirmed the ' +
        `${MARG_PROFILER_VERSION} column mapping.`
    );
    this.name = 'MargRealFileBlockedError';
  }
}

/**
 * The gate a caller runs before profiling a Marg handover. Synthetic files
 * (fixtures, rehearsal data built from the documented columns) always pass; a
 * real customer file is refused while `confirmed` is false.
 */
export function assertMargRealFileAccepted(
  input: { synthetic: boolean },
  confirmed: boolean = MARG_REAL_FILE_CONFIRMED
): void {
  if (!input.synthetic && !confirmed) throw new MargRealFileBlockedError();
}

export const margBatchStockProfiler: SourceProfiler = {
  kind: 'MARG_EXCEL',
  // Bump on any change to the synonym list or the preparation rules.
  version: MARG_PROFILER_VERSION,

  /**
   * Recognises a table whose header row maps every required field. Run
   * `prepareMargBatchStockTable` first when the sheet still carries its preamble.
   */
  resolveColumns(table: SourceTable): ColumnMap | null {
    const columnMap = mapHeaders(table.headers);
    return unmappedMargRequiredFields(columnMap).length === 0 ? columnMap : null;
  },

  // The Batch Stock report lists one item once per batch.
  duplicateDiscriminator(row: ProfiledRow): string {
    if (row.targetModelKey !== MIGRATION_TARGET_KEYS.PRODUCT) return '';
    return (row.batchNumber ?? '').toLowerCase();
  },
};
