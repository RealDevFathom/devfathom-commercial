/**
 * #716 — the migration wizard's adapter for a DevFathom owner-export `stock-lots.csv`.
 *
 * The file reuses the Excel/CSV preset headers, so column location (and every
 * MIG-02 stock check: batch, expiry, MRP, pack, quantity) is delegated to that
 * profiler unchanged. What differs is row identity. The export writes one row
 * per lot, stock location and disposition, so ordinary multi-lot stock repeats
 * the same product and pack on many rows. The generic profiler identifies a row
 * by product plus pack and would raise a BLOCKING `DUPLICATE_PRODUCT` for every
 * second lot. This adapter extends that identity with the exported lot, location
 * and disposition, which every row carries in its raw payload, so:
 *
 * - two lots of one medicine, or one lot split across shelves or dispositions,
 *   profile cleanly and keep their lot/location identity in the migration rows;
 * - two rows naming the SAME lot, location and disposition are still duplicates.
 *
 * Recognition is by the exact export header row. Any other sheet is refused, so
 * an incumbent's stock sheet can never use this adapter to relax duplicate checks.
 */
import { PHARMACY_EXPORT_FILES } from '../data-export-format';
import { excelCsvProfiler } from './excel-csv-profiler';
import { MIGRATION_TARGET_KEYS } from './mapping-targets';
import type { ColumnMap, ProfiledRow, SourceProfiler } from './profiler';
import type { SourceTable } from './source-values';

const HEADERS = PHARMACY_EXPORT_FILES.stockLots.columns.map((column) => column.header);

export function isDevfathomStockLotsTable(table: SourceTable): boolean {
  return table.headers.join('\0') === HEADERS.join('\0');
}

/** The exported lot, location and disposition of one stock-lots.csv row. */
export function stockLotIdentity(row: Pick<ProfiledRow, 'rawPayload'>): {
  lotCode: string;
  locationCode: string;
  disposition: string;
} {
  return {
    lotCode: (row.rawPayload.lot_code ?? '').trim(),
    locationCode: (row.rawPayload.location_code ?? '').trim(),
    disposition: (row.rawPayload.disposition ?? '').trim().toUpperCase(),
  };
}

export const devfathomStockLotsProfiler: SourceProfiler = {
  kind: 'EXCEL_CSV',
  version: 'devfathom-stock-lots/1',

  resolveColumns(table: SourceTable): ColumnMap | null {
    if (!isDevfathomStockLotsTable(table)) return null;
    return excelCsvProfiler.resolveColumns(table);
  },

  duplicateDiscriminator(row: ProfiledRow): string {
    if (row.targetModelKey !== MIGRATION_TARGET_KEYS.PRODUCT) return '';
    const identity = stockLotIdentity(row);
    return [identity.lotCode, identity.locationCode, identity.disposition].join('\u0000');
  },
};
