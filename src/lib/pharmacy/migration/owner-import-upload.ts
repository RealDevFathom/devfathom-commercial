import 'server-only';

import { inflateRawSync } from 'node:zlib';
import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS } from './owner-import-input';
import type { SourceTable } from './source-values';

export class OwnerImportError extends Error {}
const MAX_EXPANDED = 8 * 1024 * 1024;

// Check actual decompression before handing a workbook to ExcelJS/JSZip. A
// compressed-size limit alone does not bound an XLSX zip bomb's memory use.
function boundedWorkbook(bytes: Buffer) {
  const end = bytes.length - 22;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50 ||
      bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0 ||
      bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10)) {
    throw new OwnerImportError('Use a standard, single-volume XLSX workbook without a ZIP comment.');
  }
  const entries = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const directoryEnd = cursor + bytes.readUInt32LE(end + 12);
  if (entries > 128 || directoryEnd !== end) throw new OwnerImportError('Workbook is too complex. Export a smaller sheet.');
  let total = 0;
  const names = new Set<string>();
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new OwnerImportError('Invalid XLSX directory.');
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const expanded = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if ((flags & 1) || ![0, 8].includes(method) || expanded > MAX_EXPANDED - total ||
        names.has(name) || /(^\/|\\|(^|\/)\.\.(\/|$))/.test(name) ||
        local + 30 > bytes.readUInt32LE(end + 16) || bytes.readUInt32LE(local) !== 0x04034b50 ||
        bytes.readUInt16LE(local + 8) !== method) throw new OwnerImportError('Unsupported or oversized XLSX archive.');
    names.add(name);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + compressed > bytes.readUInt32LE(end + 16)) throw new OwnerImportError('Invalid XLSX entry.');
    const data = bytes.subarray(start, start + compressed);
    const actual = method === 0 ? data.length : inflateRawSync(data, { maxOutputLength: MAX_EXPANDED - total + 1 }).length;
    if (actual !== expanded || actual > MAX_EXPANDED - total) throw new OwnerImportError('Workbook expands beyond the size limit.');
    total += actual;
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== directoryEnd) throw new OwnerImportError('Invalid XLSX directory size.');
}

function csvRecords(text: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, closed = false;
  const finishCell = () => { row.push(cell.trim()); cell = ''; closed = false; };
  const finishRow = () => {
    finishCell();
    if (row.some(Boolean)) records.push(row);
    row = [];
    if (records.length > IMPORT_MAX_ROWS + 1) throw new OwnerImportError(`Use at most ${IMPORT_MAX_ROWS} data rows per file.`);
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; closed = true; }
      } else cell += char;
    } else if (char === ',' ) finishCell();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      finishRow();
    } else if (char === '"' && cell === '' && !closed) quoted = true;
    else {
      if (closed || char === '"') throw new OwnerImportError('Malformed CSV quoting. Export a new CSV file.');
      cell += char;
    }
    if (cell.length > 500 || row.length > 40) throw new OwnerImportError('Use at most 40 columns and 500 characters per cell.');
  }
  if (quoted) throw new OwnerImportError('CSV contains an unclosed quoted cell.');
  finishRow();
  return records;
}

/**
 * Excel turns a typed `2027-06` into a date cell on the 1st. Its display format
 * is the only record of month precision; keep it rather than invent a day.
 */
export function excelShowsDay(numFmt: string | undefined | null): boolean {
  if (!numFmt) return true;
  const tokens = numFmt.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '').toLowerCase();
  return !/[ym]/.test(tokens) || /d/.test(tokens);
}

export async function parseOwnerUpload(fileName: string, bytes: Buffer): Promise<SourceTable> {
  if (!bytes.length || bytes.length > IMPORT_MAX_BYTES) throw new OwnerImportError('Choose a CSV or Excel (.xlsx) file that is not empty and is no larger than 1 MB.');
  let records: string[][];
  if (/\.csv$/i.test(fileName)) {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new OwnerImportError('Save the CSV using UTF-8 encoding.'); }
    if (text.includes('\0')) throw new OwnerImportError('The CSV contains binary data.');
    records = csvRecords(text.replace(/^\uFEFF/, ''));
  } else if (/\.xlsx$/i.test(fileName)) {
    try {
      boundedWorkbook(bytes);
      const { default: ExcelJS } = await import('exceljs');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(new Uint8Array(bytes).buffer);
      const sheets = workbook.worksheets.filter((sheet) => sheet.actualRowCount > 0);
      if (sheets.length !== 1) throw new OwnerImportError('Upload exactly one populated worksheet.');
      const sheet = sheets[0]!;
      if (sheet.rowCount > IMPORT_MAX_ROWS + 1 || sheet.columnCount > 40) throw new OwnerImportError(`Use at most ${IMPORT_MAX_ROWS} rows and 40 columns.`);
      records = [];
      sheet.eachRow((row) => {
        const values: string[] = [];
        for (let index = 1; index <= sheet.columnCount; index++) {
          const cell = row.getCell(index);
          const value = cell.value;
          if (value === null || value === undefined) values.push('');
          else if (value instanceof Date) values.push(value.toISOString().slice(0, excelShowsDay(cell.numFmt) ? 10 : 7));
          else if (typeof value === 'string' || typeof value === 'number') values.push(String(value).trim());
          else throw new OwnerImportError('Replace formulas, links, and rich text with plain values before uploading.');
        }
        if (values.some(Boolean)) records.push(values);
      });
    } catch (error) {
      if (error instanceof OwnerImportError) throw error;
      throw new OwnerImportError('Could not read this XLSX workbook. Export a plain CSV or a smaller XLSX.');
    }
  } else throw new OwnerImportError('Choose a CSV or XLSX file.');
  const [headers, ...rows] = records;
  if (!headers?.length || !rows.length) throw new OwnerImportError('Include a header row and at least one stock row.');
  if (headers.length > 40 || headers.some((header) => !header || header.length > 100) ||
      new Set(headers.map((header) => header.toLowerCase())).size !== headers.length) throw new OwnerImportError('Use up to 40 unique, nonempty column headers.');
  if (rows.length > IMPORT_MAX_ROWS || rows.some((row) => row.length !== headers.length || row.some((cell) => cell.length > 500))) throw new OwnerImportError('Each row must match the headers and contain at most 500 characters per cell.');
  return { headers, rows };
}
