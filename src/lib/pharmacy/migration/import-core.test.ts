import { crc32 } from 'node:zlib';

import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  assertBatchTransition,
  csvSafeCell,
  ImportValidationError,
  normalizePakistaniPhone,
  parseImportFile,
  productDedupeKey,
} from './import-core';
import { importApplicationKey } from './import-commit';

function syntheticZip(name: string, compressed = 1, uncompressed = 1): Uint8Array {
  const encoded = new TextEncoder().encode(name);
  const localSize = 30 + encoded.length + compressed;
  const bytes = new Uint8Array(localSize + 46 + encoded.length + 22);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(26, encoded.length, true);
  bytes.set(encoded, 30);
  const central = localSize;
  view.setUint32(central, 0x02014b50, true);
  view.setUint32(central + 20, compressed, true);
  view.setUint32(central + 24, uncompressed, true);
  view.setUint16(central + 28, encoded.length, true);
  bytes.set(encoded, central + 46);
  const eocd = central + 46 + encoded.length;
  view.setUint32(eocd, 0x06054b50, true);
  view.setUint16(eocd + 8, 1, true);
  view.setUint16(eocd + 10, 1, true);
  view.setUint32(eocd + 12, 46 + encoded.length, true);
  view.setUint32(eocd + 16, central, true);
  return bytes;
}

/** A well-formed stored (uncompressed) ZIP whose entries can then be made wrong one at a time. */
function storedZip(
  entries: Array<{ name: string; data?: string; flags?: number; method?: number; crc?: number }>
): Uint8Array {
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const data = new TextEncoder().encode(entry.data ?? '<x/>');
    const crc = entry.crc ?? crc32(data);
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(6, entry.flags ?? 0, true);
    lv.setUint16(8, entry.method ?? 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(8, entry.flags ?? 0, true);
    cv.setUint16(10, entry.method ?? 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    parts.push(local);
    directory.push(central);
    offset += local.length;
  }
  const directorySize = directory.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);
  const bytes = new Uint8Array(offset + directorySize + 22);
  let at = 0;
  for (const part of [...parts, ...directory, end]) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

/** Central-directory offsets by entry name, to edit one field of a real archive. */
function centralEntries(bytes: Uint8Array): Map<string, number> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  const found = new Map<string, number>();
  let offset = view.getUint32(eocd + 16, true);
  for (let index = 0; index < view.getUint16(eocd + 10, true); index += 1) {
    const nameLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    found.set(name, offset);
    offset +=
      46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return found;
}

async function workbookBytes(cell = 'Panadol'): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Import');
  sheet.addRow(['Name']);
  sheet.addRow([cell]);
  return new Uint8Array(await book.xlsx.writeBuffer());
}

const UNSUPPORTED = { code: 'UNSUPPORTED' };

describe('pharmacy import core', () => {
  it.each([
    ['03001234567', '+923001234567'],
    ['+923001234567', '+923001234567'],
    ['923001234567', '+923001234567'],
    ['0300 123 4567', '+923001234567'],
    ['123', null],
  ])('normalizes %s', (raw, expected) => expect(normalizePakistaniPhone(raw)).toBe(expected));
  it('parses csv', async () =>
    expect(await parseImportFile('a.csv', new TextEncoder().encode('Name,Qty\nPanadol,2'))).toEqual(
      { headers: ['Name', 'Qty'], rows: [['Panadol', '2']] }
    ));
  it('enforces byte and column limits before profiling', async () => {
    await expect(
      parseImportFile('a.csv', new Uint8Array(20 * 1024 * 1024 + 1))
    ).rejects.toMatchObject({ code: 'MAX_BYTES' });
    await expect(
      parseImportFile(
        'a.csv',
        new TextEncoder().encode(Array.from({ length: 201 }, (_, index) => `c${index}`).join(','))
      )
    ).rejects.toMatchObject({ code: 'MAX_COLUMNS' });
  });
  it('parses xlsx and rejects formulas', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Import');
    sheet.addRow(['Name']);
    sheet.addRow(['Panadol']);
    const bytes = await book.xlsx.writeBuffer();
    expect((await parseImportFile('a.xlsx', new Uint8Array(bytes))).rows).toEqual([['Panadol']]);
    sheet.getCell('A2').value = { formula: '1+1', result: 2 };
    await expect(
      parseImportFile('a.xlsx', new Uint8Array(await book.xlsx.writeBuffer()))
    ).rejects.toEqual(
      expect.objectContaining({ code: 'FORMULA' } satisfies Partial<ImportValidationError>)
    );
  });
  it('rejects macro paths and zip bombs from the central directory before workbook loading', async () => {
    await expect(
      parseImportFile('macro.xlsx', syntheticZip('xl/vbaProject.bin'))
    ).rejects.toMatchObject({ code: 'MACRO' });
    await expect(
      parseImportFile('bomb.xlsx', syntheticZip('xl/worksheets/sheet1.xml', 1, 101))
    ).rejects.toMatchObject({ code: 'MAX_BYTES' });
  });
  it('refuses encrypted, ZIP64, duplicate-name and unknown-compression archives', async () => {
    const types = { name: '[Content_Types].xml', data: '<Types/>' };
    expect(() => storedZip([types])).not.toThrow();
    await expect(
      parseImportFile('encrypted.xlsx', storedZip([{ ...types, flags: 0x0001 }]))
    ).rejects.toMatchObject(UNSUPPORTED);
    await expect(
      parseImportFile('bzip2.xlsx', storedZip([{ ...types, method: 12 }]))
    ).rejects.toMatchObject(UNSUPPORTED);
    // Names are compared as the workbook reader resolves them: case and slashes normalized.
    await expect(
      parseImportFile(
        'duplicate.xlsx',
        storedZip([types, { name: 'xl/workbook.xml' }, { name: 'XL\\Workbook.xml' }])
      )
    ).rejects.toMatchObject(UNSUPPORTED);
    // ZIP64: a locator record before the end record, or a 0xFFFFFFFF size field.
    const plain = storedZip([types, { name: 'xl/workbook.xml' }]);
    const zip64 = new Uint8Array(plain.length + 20);
    zip64.set(plain.subarray(0, plain.length - 22));
    new DataView(zip64.buffer).setUint32(plain.length - 22, 0x07064b50, true);
    zip64.set(plain.subarray(plain.length - 22), plain.length - 2);
    await expect(parseImportFile('zip64.xlsx', zip64)).rejects.toMatchObject(UNSUPPORTED);
    const huge = storedZip([types, { name: 'xl/workbook.xml' }]);
    new DataView(huge.buffer).setUint32(
      centralEntries(huge).get('xl/workbook.xml')! + 24,
      0xffffffff,
      true
    );
    await expect(parseImportFile('zip64-size.xlsx', huge)).rejects.toMatchObject(UNSUPPORTED);
  });
  it('refuses truncated and corrupt archives', async () => {
    const workbook = await workbookBytes();
    await expect(
      parseImportFile('truncated.xlsx', workbook.subarray(0, workbook.length - 10))
    ).rejects.toMatchObject(UNSUPPORTED);
    // The directory survives but claims more data than the file holds.
    const short = storedZip([{ name: '[Content_Types].xml', data: '<Types/>' }]);
    const shortCentral = centralEntries(short).get('[Content_Types].xml')!;
    new DataView(short.buffer).setUint32(shortCentral + 20, 4_000, true);
    new DataView(short.buffer).setUint32(shortCentral + 24, 4_000, true);
    await expect(parseImportFile('short.xlsx', short)).rejects.toMatchObject(UNSUPPORTED);
    await expect(
      parseImportFile(
        'crc.xlsx',
        storedZip([{ name: '[Content_Types].xml', data: '<Types/>', crc: 12_345 }])
      )
    ).rejects.toMatchObject(UNSUPPORTED);
    // The local header names a different file than the directory.
    const renamed = storedZip([{ name: '[Content_Types].xml', data: '<Types/>' }]);
    renamed[30] = 'X'.charCodeAt(0);
    await expect(parseImportFile('renamed.xlsx', renamed)).rejects.toMatchObject(UNSUPPORTED);
  });
  it('refuses a directory that understates an entry, and a real highly compressed workbook', async () => {
    // A real workbook whose directory claims a smaller sheet than it inflates to: the limits
    // were checked against the claim, so the claim itself is verified while inflating.
    const lying = await workbookBytes();
    const sheet = centralEntries(lying).get('xl/worksheets/sheet1.xml')!;
    new DataView(lying.buffer).setUint32(sheet + 24, 10, true);
    await expect(parseImportFile('lying.xlsx', lying)).rejects.toMatchObject({ code: 'MAX_BYTES' });
    // A genuine ExcelJS workbook with one very repetitive cell compresses far beyond 100:1.
    await expect(
      parseImportFile('dense.xlsx', await workbookBytes('A'.repeat(200_000)))
    ).rejects.toMatchObject({ code: 'MAX_BYTES' });
  });
  it('dedupes barcode first and normalized fallback', () => {
    expect(productDedupeKey({ barcode: ' 123 ', name: 'ignored' })).toBe('barcode:123');
    expect(
      productDedupeKey({ name: ' Panadol ', generic: ' PARACETAMOL', strength: '500 milligrams' })
    ).toBe('product:panadol|paracetamol|500mg');
  });
  it('neutralizes spreadsheet injection on export', () =>
    expect(csvSafeCell('=cmd()')).toBe("'=cmd()"));
  it('pins the lifecycle', () => {
    expect(() => assertBatchTransition('PREVIEW', 'COMMITTING')).not.toThrow();
    expect(() => assertBatchTransition('UPLOADED', 'COMMITTED')).toThrow();
  });
  it('derives a collision-safe application key from scope, content, row and operation only', () => {
    const base = {
      organizationId: 'org',
      branchId: 'branch-a',
      contentHash: 'a'.repeat(64),
      rowSourceKey: 'row-1',
      entityType: 'PharmacyStockMovement',
      operation: 'STOCK_MOVEMENT' as const,
    };
    const key = importApplicationKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(importApplicationKey({ ...base })).toBe(key);
    for (const change of [
      { organizationId: 'org-b' },
      { branchId: 'branch-b' },
      { contentHash: 'b'.repeat(64) },
      { rowSourceKey: 'row-2' },
      { entityType: 'PharmacySupplier' },
      { operation: 'CREATED' as const },
    ])
      expect(importApplicationKey({ ...base, ...change })).not.toBe(key);
    // A colon-joined key would make these two identical; the JSON encoding does not.
    expect(importApplicationKey({ ...base, branchId: 'a:b', contentHash: 'c' })).not.toBe(
      importApplicationKey({ ...base, branchId: 'a', contentHash: 'b:c' })
    );
    expect(importApplicationKey({ ...base, rowSourceKey: 'x","y' })).not.toBe(
      importApplicationKey({ ...base, rowSourceKey: 'x', entityType: 'y' })
    );
  });
});
