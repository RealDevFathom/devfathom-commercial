/**
 * #716 — the migration wizard's adapter for a DevFathom owner-export `medicines.csv`.
 *
 * The file reuses the Excel/CSV preset headers, so column location is delegated
 * to that profiler. What differs is the meaning: the export's catalogue file
 * carries medicine identity, presentations, packs and barcodes, never stock.
 * Batch, expiry and MRP belong to the separate `stock-lots.csv`, so this adapter
 * declares itself catalogue-only and the shared derivation does not raise lot
 * exceptions that no row could ever satisfy.
 *
 * Recognition is by the exact export header row (current or pre-barcode legacy
 * layout). Any other sheet is refused, so an incumbent stock sheet can never be
 * profiled here to dodge its batch/expiry/MRP checks.
 */
import { PHARMACY_EXPORT_FILES } from '../data-export-format';
import { excelCsvProfiler } from './excel-csv-profiler';
import type { ColumnMap, SourceProfiler } from './profiler';
import type { SourceTable } from './source-values';

const EXTENDED_HEADERS = new Set([
  'strength_components',
  'pack_barcodes',
  'presentation_barcodes',
  'catalogue_encoding',
]);
const CURRENT_HEADERS = PHARMACY_EXPORT_FILES.medicines.columns.map((column) => column.header);
const LEGACY_HEADERS = CURRENT_HEADERS.filter((header) => !EXTENDED_HEADERS.has(header));

export function isDevfathomCatalogueTable(table: SourceTable): boolean {
  const signature = table.headers.join('\0');
  return signature === CURRENT_HEADERS.join('\0') || signature === LEGACY_HEADERS.join('\0');
}

export const devfathomCatalogueProfiler: SourceProfiler = {
  kind: 'EXCEL_CSV',
  version: 'devfathom-catalogue/1',
  catalogueOnly: true,

  resolveColumns(table: SourceTable): ColumnMap | null {
    if (!isDevfathomCatalogueTable(table)) return null;
    return excelCsvProfiler.resolveColumns(table);
  },
};
