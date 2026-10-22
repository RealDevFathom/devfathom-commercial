import 'server-only';

import ExcelJS from 'exceljs';
import { crc32, inflateRawSync } from 'node:zlib';
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
  'UPLOADED' | 'PARSING' | 'PREVIEW' | 'COMMITTING' | 'COMMITTED' | 'ROLLED_BACK' | 'FAILED';
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

// Commit, rollback and the persisted retry barrier live in ./import-commit, behind
// ./import-authority. This module stays pure: limits, the state machine, parsing and matching.

export class ImportValidationError extends Error {
  constructor(
    readonly code: 'MAX_BYTES' | 'MAX_ROWS' | 'MAX_COLUMNS' | 'UNSUPPORTED' | 'FORMULA' | 'MACRO'
  ) {
    super(code);
    this.name = 'ImportValidationError';
  }
}

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP_MAX16 = 0xffff;
const ZIP_MAX32 = 0xffffffff;

/**
 * Inflate one entry, bounded by its declared size, and prove the directory told the truth:
 * the exact size and CRC-32 it states. A size the directory understated is a bomb (MAX_BYTES);
 * anything else that does not match is a corrupt or truncated archive (UNSUPPORTED).
 */
function verifiedEntry(
  bytes: Uint8Array,
  view: DataView,
  entry: {
    local: number;
    name: Uint8Array;
    method: number;
    crc: number;
    compressed: number;
    uncompressed: number;
  }
): Uint8Array {
  const { local, name, method, crc, compressed, uncompressed } = entry;
  if (local + 30 > bytes.length || view.getUint32(local, true) !== ZIP_LOCAL)
    throw new ImportValidationError('UNSUPPORTED');
  const localNameLength = view.getUint16(local + 26, true);
  const start = local + 30 + localNameLength + view.getUint16(local + 28, true);
  const localName = bytes.subarray(local + 30, local + 30 + localNameLength);
  if (
    start + compressed > bytes.length ||
    localName.length !== name.length ||
    localName.some((byte, index) => byte !== name[index])
  )
    throw new ImportValidationError('UNSUPPORTED');
  const payload = bytes.subarray(start, start + compressed);
  let data: Uint8Array;
  if (method === 0) {
    data = payload;
  } else {
    try {
      data = inflateRawSync(payload, { maxOutputLength: Math.max(1, uncompressed) });
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE')
        throw new ImportValidationError('MAX_BYTES');
      throw new ImportValidationError('UNSUPPORTED');
    }
  }
  if (data.length !== uncompressed || crc32(data) !== crc)
    throw new ImportValidationError('UNSUPPORTED');
  return data;
}

/**
 * Check an XLSX archive before any workbook parser sees it. Refused: macros, path traversal,
 * encrypted entries, ZIP64 and multi-disk archives, duplicate names, compression other than
 * stored/deflate, entry/size/ratio limits, and any entry whose real content does not match the
 * size and CRC-32 its directory declares (so the limits above cannot be lied past).
 */
function inspectXlsxArchive(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i -= 1) {
    if (view.getUint32(i, true) === ZIP_END) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ImportValidationError('UNSUPPORTED');
  const entries = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (
    (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR) ||
    view.getUint16(eocd + 4, true) !== 0 ||
    view.getUint16(eocd + 6, true) !== 0 ||
    view.getUint16(eocd + 8, true) !== entries ||
    entries === ZIP_MAX16 ||
    directorySize === ZIP_MAX32 ||
    directoryOffset === ZIP_MAX32 ||
    directoryOffset + directorySize > eocd
  )
    throw new ImportValidationError('UNSUPPORTED');
  if (entries > IMPORT_LIMITS.maxZipEntries) throw new ImportValidationError('MAX_BYTES');
  const names = new Set<string>();
  let offset = directoryOffset;
  let total = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== ZIP_CENTRAL)
      throw new ImportValidationError('UNSUPPORTED');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length) throw new ImportValidationError('UNSUPPORTED');
    // Bit 0: encrypted; bit 6: strong encryption. 0xFFFFFFFF fields mean ZIP64.
    if (
      flags & 0x0041 ||
      (method !== 0 && method !== 8) ||
      compressed === ZIP_MAX32 ||
      uncompressed === ZIP_MAX32 ||
      local === ZIP_MAX32
    )
      throw new ImportValidationError('UNSUPPORTED');
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = new TextDecoder()
      .decode(rawName)
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .toLowerCase();
    if (name.split('/').includes('..')) throw new ImportValidationError('UNSUPPORTED');
    if (name.includes('vbaproject') || name.endsWith('.bin'))
      throw new ImportValidationError('MACRO');
    if (names.has(name)) throw new ImportValidationError('UNSUPPORTED');
    names.add(name);
    total += uncompressed;
    if (
      uncompressed > IMPORT_LIMITS.maxZipEntryBytes ||
      total > IMPORT_LIMITS.maxZipUncompressedBytes
    )
      throw new ImportValidationError('MAX_BYTES');
    if (
      compressed === 0
        ? uncompressed !== 0
        : uncompressed / compressed > IMPORT_LIMITS.maxZipCompressionRatio
    )
      throw new ImportValidationError('MAX_BYTES');
    const data = verifiedEntry(bytes, view, {
      local,
      name: rawName,
      method,
      crc,
      compressed,
      uncompressed,
    });
    if (name === '[content_types].xml') {
      const types = new TextDecoder().decode(data).toLowerCase();
      if (types.includes('macroenabled') || types.includes('vba'))
        throw new ImportValidationError('MACRO');
    }
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
  // A copied ArrayBuffer: ExcelJS's Buffer type is an ArrayBuffer, not Node's generic Buffer.
  await workbook.xlsx.load(new Uint8Array(bytes).buffer);
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
