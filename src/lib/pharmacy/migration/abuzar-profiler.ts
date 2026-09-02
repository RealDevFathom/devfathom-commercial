/**
 * PH-MIG / MIG-01 (P0, Abuzar) — the Abuzar/WASEELA export profiler.
 *
 * ══ THE FORMAT IS UNKNOWN UNTIL SEEN ══
 *
 * Abuzar/WASEELA is desktop pharmacy software with no published export schema
 * and no sample file available to this lane. Everything below is a FIXTURE-DRIVEN
 * HYPOTHESIS: the column map is a literal, it is exercised against a fixture
 * checked in beside this file, and every assumption is marked
 * "TO CONFIRM IN PHASE 0". None of it is inferred from a real customer export.
 *
 * The hypothesis is deliberately cheap to replace. `ABUZAR_COLUMN_MAP` is a
 * single object of header names; correcting it against the first real file is a
 * one-object edit with no change to the profiling pass, the exception rules, the
 * schema, or the workbench. That is the whole reason the adapter interface takes
 * a table and returns a column map rather than parsing bytes itself.
 *
 * REFUSES RATHER THAN GUESSES. `resolveColumns` returns `null` unless every
 * REQUIRED header is present. An Abuzar file whose headers have moved is
 * therefore rejected outright instead of being profiled through a partial map,
 * which would emit confident rows built from the wrong columns.
 *
 * ── Assumptions, all TO CONFIRM IN PHASE 0 ────────────────────────────────
 *  1. The export is delimited text. Abuzar-class software commonly writes a
 *     tab-delimited file named `.xls`; `parseDelimitedText` reads that as well as
 *     true CSV, so a wrong guess about the extension costs nothing.
 *  2. Exactly one header row, first row of the file.
 *  3. Header spellings are the literals in `ABUZAR_COLUMN_MAP` below.
 *  4. `ITEM_CODE` is the incumbent's stable per-item key and is what a later
 *     parallel-run comparison (MIG-04) will join on.
 *  5. Numeric dates are day-first (`dd/mm/yy`) — see `readExpiryDate`.
 *  6. `T.P.` (trade price) is the cost basis and `M.R.P.` the retail price, both
 *     per PACK rather than per unit. MED-07/08 derive the unit price from MRP, so
 *     this adapter stores the pack figures unchanged and derives nothing.
 *  7. Money is in PKR with two minor digits.
 *  8. There is no character encoding declaration; see `parseDelimitedText`.
 */
import type { ColumnMap, SourceField, SourceProfiler } from './profiler';
import type { SourceTable } from './source-values';

/**
 * The documented column map. Header literal → logical field.
 *
 * TO CONFIRM IN PHASE 0 — every entry. Matching is exact after casefolding and
 * stripping non-alphanumerics, so `M.R.P.`, `MRP` and `mrp` are the same header
 * but a genuinely different word is not.
 */
export const ABUZAR_COLUMN_MAP: Readonly<Record<string, SourceField>> = {
  ITEM_CODE: 'sourceKey',
  ITEM_NAME: 'product',
  PACKING: 'pack',
  BAR_CODE: 'barcode',
  BATCH_NO: 'batch',
  EXPIRY: 'expiry',
  'M.R.P.': 'mrp',
  'T.P.': 'cost',
  QTY: 'quantity',
  SUPPLIER: 'supplier',
  PARTY_BALANCE: 'balance',
};

/**
 * Headers without which the file is not an Abuzar stock export.
 *
 * TO CONFIRM IN PHASE 0. Kept to the identity columns: a real export missing
 * batch, expiry or MRP is exactly the case MIG-02 must turn into exception rows,
 * so those are NOT required here. Requiring them would make the acceptance
 * criterion untestable, because the file would be rejected before a single
 * MISSING_* exception could be raised.
 */
const REQUIRED_FIELDS: readonly SourceField[] = ['sourceKey', 'product'];

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const NORMALIZED_COLUMN_MAP = new Map<string, SourceField>(
  Object.entries(ABUZAR_COLUMN_MAP).map(([header, field]) => [normalizeHeader(header), field])
);

export const abuzarProfiler: SourceProfiler = {
  kind: 'ABUZAR',
  // Bump on any change to ABUZAR_COLUMN_MAP, so a Phase 0 correction is visible
  // on every batch profiled after it.
  version: 'abuzar/1-unconfirmed',

  resolveColumns(table: SourceTable): ColumnMap | null {
    const columnMap: ColumnMap = {};

    table.headers.forEach((header, index) => {
      const field = NORMALIZED_COLUMN_MAP.get(normalizeHeader(header));
      if (field !== undefined && columnMap[field] === undefined) columnMap[field] = index;
    });

    const complete = REQUIRED_FIELDS.every((field) => columnMap[field] !== undefined);
    return complete ? columnMap : null;
  },
};
