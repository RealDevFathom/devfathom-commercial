import 'server-only';

import ExcelJS from 'exceljs';
import { parseDelimitedText, type SourceTable } from './source-values';

export const IMPORT_LIMITS = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  maxRows: 50_000,
  maxColumns: 200,
});
export const ASYNC_IMPORT_THRESHOLD_BYTES = 2 * 1024 * 1024;

export type ImportBatchStatus =
  | 'UPLOADED'
  | 'PARSING'
  | 'PREVIEW'
  | 'COMMITTING'
  | 'COMMITTED'
  | 'ROLLED_BACK'
  | 'FAILED';
const NEXT_STATUS: Readonly<Record<ImportBatchStatus, readonly ImportBatchStatus[]>> = {
  UPLOADED: ['PARSING', 'FAILED'],
  PARSING: ['PREVIEW', 'FAILED'],
  PREVIEW: ['PARSING', 'COMMITTING', 'FAILED'],
  COMMITTING: ['COMMITTED', 'FAILED'],
  COMMITTED: ['ROLLED_BACK'],
  ROLLED_BACK: [],
  FAILED: ['PARSING'],
};
export function assertBatchTransition(from: ImportBatchStatus, to: ImportBatchStatus): void {
  if (!NEXT_STATUS[from].includes(to))
    throw new Error(`Invalid import batch transition: ${from} -> ${to}`);
}

export function importRowIdempotencyKey(contentHash: string, sourceKey: string): string {
  return `pharmacy-import:${contentHash}:${sourceKey}`;
}

export type ImportManifestEntry = {
  entityType: string;
  entityId: string;
  operation: 'CREATED' | 'STOCK_MOVEMENT';
  referencedSince?: boolean;
};
export function planRollback(entries: readonly ImportManifestEntry[]) {
  const blocked = entries.filter((entry) => entry.operation === 'CREATED' && entry.referencedSince);
  return {
    blocked,
    deleteEntityIds: blocked.length
      ? []
      : entries.filter((e) => e.operation === 'CREATED').map((e) => e.entityId),
    reverseMovementIds: blocked.length
      ? []
      : entries.filter((e) => e.operation === 'STOCK_MOVEMENT').map((e) => e.entityId),
  };
}

export class ImportValidationError extends Error {
  constructor(
    readonly code: 'MAX_BYTES' | 'MAX_ROWS' | 'MAX_COLUMNS' | 'UNSUPPORTED' | 'FORMULA' | 'MACRO'
  ) {
    super(code);
    this.name = 'ImportValidationError';
  }
}

function enforceTableLimits(table: SourceTable): SourceTable {
  if (table.headers.length > IMPORT_LIMITS.maxColumns)
    throw new ImportValidationError('MAX_COLUMNS');
  if (table.rows.length > IMPORT_LIMITS.maxRows) throw new ImportValidationError('MAX_ROWS');
  return table;
}

/** Parse untrusted CSV/XLSX bytes. Formula cells are rejected, never evaluated. */
export async function parseImportFile(fileName: string, bytes: Uint8Array): Promise<SourceTable> {
  if (bytes.byteLength > IMPORT_LIMITS.maxBytes) throw new ImportValidationError('MAX_BYTES');
  const extension = fileName.toLowerCase().split('.').pop();
  if (extension === 'csv' || extension === 'tsv' || extension === 'txt') {
    return enforceTableLimits(
      parseDelimitedText(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    );
  }
  if (extension !== 'xlsx') throw new ImportValidationError('UNSUPPORTED');
  if (Buffer.from(bytes).includes(Buffer.from('vbaProject.bin', 'ascii'))) {
    throw new ImportValidationError('MACRO');
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes));
  const sheet = workbook.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };
  if (sheet.columnCount > IMPORT_LIMITS.maxColumns) throw new ImportValidationError('MAX_COLUMNS');
  if (Math.max(0, sheet.rowCount - 1) > IMPORT_LIMITS.maxRows)
    throw new ImportValidationError('MAX_ROWS');
  const values: string[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const cells: string[] = [];
    for (let column = 1; column <= sheet.columnCount; column += 1) {
      const value = row.getCell(column).value;
      if (value && typeof value === 'object' && 'formula' in value)
        throw new ImportValidationError('FORMULA');
      cells.push(value === null || value === undefined ? '' : String(value));
    }
    values.push(cells);
  });
  const [headers = [], ...rows] = values;
  return enforceTableLimits({ headers: headers.map((v) => v.trim()), rows });
}

/** Pakistani mobile numbers canonicalized for tenant-local customer dedupe. */
export function normalizePakistaniPhone(value: string): string | null {
  const compact = value.trim().replace(/[\s().-]/g, '');
  const local = compact.startsWith('+92')
    ? `0${compact.slice(3)}`
    : compact.startsWith('92')
      ? `0${compact.slice(2)}`
      : compact;
  return /^03\d{9}$/.test(local) ? `+92${local.slice(1)}` : null;
}

const UNIT_ALIASES: Record<string, string> = {
  milligram: 'mg',
  milligrams: 'mg',
  mg: 'mg',
  gram: 'g',
  grams: 'g',
  gm: 'g',
  g: 'g',
  millilitre: 'ml',
  millilitres: 'ml',
  ml: 'ml',
};
export function normalizeProductPart(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLocaleLowerCase('en')
    .replace(/\s+/g, ' ')
    .replace(/(\d)\s*([a-z]+)/g, (_m, n: string, u: string) => `${n}${UNIT_ALIASES[u] ?? u}`);
}
export function productDedupeKey(input: {
  barcode?: string | null;
  name?: string | null;
  generic?: string | null;
  strength?: string | null;
}): string | null {
  const barcode = input.barcode?.replace(/\s/g, '');
  if (barcode) return `barcode:${barcode}`;
  const parts = [input.name, input.generic, input.strength].map(normalizeProductPart);
  return parts[0] && parts[1] && parts[2] ? `product:${parts.join('|')}` : null;
}

/** Prefix spreadsheet metacharacters on any CSV export surface. */
export function csvSafeCell(value: unknown): string {
  const text = String(value ?? '');
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}
