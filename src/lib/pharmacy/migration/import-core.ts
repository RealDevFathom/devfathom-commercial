import 'server-only';

import ExcelJS from 'exceljs';
import { inflateRawSync } from 'node:zlib';
import { parseDelimitedText, type SourceTable } from './source-values';

export const IMPORT_LIMITS = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  maxRows: 50_000,
  maxColumns: 200,
  maxZipEntries: 1_000,
  maxZipEntryBytes: 40 * 1024 * 1024,
  maxZipUncompressedBytes: 100 * 1024 * 1024,
  maxZipCompressionRatio: 100,
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

export function importRowIdempotencyKey(
  contentHash: string,
  sourceKey: string,
  operation: 'CREATED' | 'STOCK_MOVEMENT'
): string {
  return `pharmacy-import:${contentHash}:${sourceKey}:${operation}`;
}

/** Atomically wins one lifecycle edge; a concurrent/stale writer affects no row. */
export async function transitionImportBatch(
  db: { pharmacyMigrationBatch: { updateMany(args: unknown): Promise<{ count: number }> } },
  scope: { organizationId: string; branchId: string; batchId: string },
  expected: ImportBatchStatus,
  next: ImportBatchStatus
): Promise<void> {
  assertBatchTransition(expected, next);
  const result = await db.pharmacyMigrationBatch.updateMany({
    where: { id: scope.batchId, organizationId: scope.organizationId, branchId: scope.branchId, status: expected },
    data: { status: next },
  });
  if (result.count !== 1) throw new Error('Import batch transition lost a concurrent race or is outside branch scope');
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

export type RollbackManifestEntry = ImportManifestEntry & {
  manifestId: string;
  quantity?: bigint;
};

/**
 * Roll back under one branch-scoped transaction. The adapter's lock operation
 * must SELECT the batch, manifest rows, target rows and their references FOR
 * UPDATE; references are deliberately checked again after those locks rather
 * than trusting a preview-time plan.
 */
export async function rollbackImportBatch(
  db: { $transaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> },
  scope: { organizationId: string; branchId: string; batchId: string },
  adapter: {
    lockManifest(tx: unknown, scope: { organizationId: string; branchId: string; batchId: string }): Promise<readonly RollbackManifestEntry[]>;
    isReferenced(tx: unknown, scope: { organizationId: string; branchId: string; batchId: string }, entry: RollbackManifestEntry): Promise<boolean>;
    deleteCreated(tx: unknown, scope: { organizationId: string; branchId: string; batchId: string }, entry: RollbackManifestEntry): Promise<void>;
    compensateStock(tx: unknown, scope: { organizationId: string; branchId: string; batchId: string }, entry: RollbackManifestEntry, signedQuantity: bigint): Promise<string>;
    linkReversal(tx: unknown, manifestId: string, reversalId: string): Promise<void>;
    transition(tx: unknown, scope: { organizationId: string; branchId: string; batchId: string }, expected: 'COMMITTED', next: 'ROLLED_BACK'): Promise<boolean>;
  }
): Promise<void> {
  await db.$transaction(async (tx) => {
    const entries = await adapter.lockManifest(tx, scope);
    for (const entry of entries) {
      if (entry.operation === 'CREATED') {
        if (await adapter.isReferenced(tx, scope, entry))
          throw new Error(`Imported entity became referenced: ${entry.entityId}`);
        await adapter.deleteCreated(tx, scope, entry);
      } else {
        if (entry.quantity === undefined) throw new Error('Stock manifest is missing signed quantity');
        const reversalId = await adapter.compensateStock(tx, scope, entry, -entry.quantity);
        await adapter.linkReversal(tx, entry.manifestId, reversalId);
      }
    }
    if (!(await adapter.transition(tx, scope, 'COMMITTED', 'ROLLED_BACK')))
      throw new Error('Import rollback lost a concurrent race or is outside branch scope');
  });
}

export class ImportValidationError extends Error {
  constructor(
    readonly code: 'MAX_BYTES' | 'MAX_ROWS' | 'MAX_COLUMNS' | 'UNSUPPORTED' | 'FORMULA' | 'MACRO'
  ) {
    super(code);
    this.name = 'ImportValidationError';
  }
}

function inspectXlsxArchive(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ImportValidationError('UNSUPPORTED');
  const entries = view.getUint16(eocd + 10, true);
  if (entries > IMPORT_LIMITS.maxZipEntries) throw new ImportValidationError('MAX_BYTES');
  let offset = view.getUint32(eocd + 16, true);
  let total = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50)
      throw new ImportValidationError('UNSUPPORTED');
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length) throw new ImportValidationError('UNSUPPORTED');
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
      .replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    if (name.split('/').includes('..')) throw new ImportValidationError('UNSUPPORTED');
    if (name.includes('vbaproject') || name.endsWith('.bin')) throw new ImportValidationError('MACRO');
    if (name === '[content_types].xml') {
      const local = view.getUint32(offset + 42, true);
      if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50)
        throw new ImportValidationError('UNSUPPORTED');
      const localNameLength = view.getUint16(local + 26, true);
      const localExtraLength = view.getUint16(local + 28, true);
      const start = local + 30 + localNameLength + localExtraLength;
      const payload = bytes.subarray(start, start + compressed);
      let xml: Uint8Array;
      try { xml = compressionMethod === 0 ? payload : new Uint8Array(inflateRawSync(payload)); }
      catch { throw new ImportValidationError('UNSUPPORTED'); }
      const types = new TextDecoder().decode(xml).toLowerCase();
      if (types.includes('macroenabled') || types.includes('vba')) throw new ImportValidationError('MACRO');
    }
    total += uncompressed;
    if (uncompressed > IMPORT_LIMITS.maxZipEntryBytes || total > IMPORT_LIMITS.maxZipUncompressedBytes)
      throw new ImportValidationError('MAX_BYTES');
    if (compressed === 0 ? uncompressed !== 0 : uncompressed / compressed > IMPORT_LIMITS.maxZipCompressionRatio)
      throw new ImportValidationError('MAX_BYTES');
    offset = end;
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
  inspectXlsxArchive(bytes);
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
