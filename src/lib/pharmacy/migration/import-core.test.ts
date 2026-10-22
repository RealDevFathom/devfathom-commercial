import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  assertBatchTransition,
  csvSafeCell,
  ImportValidationError,
  importRowIdempotencyKey,
  normalizePakistaniPhone,
  parseImportFile,
  planRollback,
  productDedupeKey,
  transitionImportBatch,
} from './import-core';

function syntheticZip(name: string, compressed = 1, uncompressed = 1): Uint8Array {
  const encoded = new TextEncoder().encode(name);
  const localSize = 30 + encoded.length + compressed;
  const bytes = new Uint8Array(localSize + 46 + encoded.length + 22);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true); view.setUint16(26, encoded.length, true);
  bytes.set(encoded, 30);
  const central = localSize;
  view.setUint32(central, 0x02014b50, true); view.setUint32(central + 20, compressed, true);
  view.setUint32(central + 24, uncompressed, true); view.setUint16(central + 28, encoded.length, true);
  bytes.set(encoded, central + 46);
  const eocd = central + 46 + encoded.length;
  view.setUint32(eocd, 0x06054b50, true); view.setUint16(eocd + 8, 1, true);
  view.setUint16(eocd + 10, 1, true); view.setUint32(eocd + 12, 46 + encoded.length, true);
  view.setUint32(eocd + 16, central, true);
  return bytes;
}

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
    await expect(parseImportFile('macro.xlsx', syntheticZip('xl/vbaProject.bin'))).rejects.toMatchObject({ code: 'MACRO' });
    await expect(parseImportFile('bomb.xlsx', syntheticZip('xl/worksheets/sheet1.xml', 1, 101))).rejects.toMatchObject({ code: 'MAX_BYTES' });
  });
  it('dedupes barcode first and normalized fallback', () => {
    expect(productDedupeKey({ barcode: ' 123 ', name: 'ignored' })).toBe('barcode:123');
    expect(
      productDedupeKey({ name: ' Panadol ', generic: ' PARACETAMOL', strength: '500 milligrams' })
    ).toBe('product:panadol|paracetamol|500mg');
  });
  it('neutralizes spreadsheet injection on export', () =>
    expect(csvSafeCell('=cmd()')).toBe("'=cmd()"));
  it('pins lifecycle and content/row idempotency', () => {
    expect(() => assertBatchTransition('PREVIEW', 'COMMITTING')).not.toThrow();
    expect(() => assertBatchTransition('UPLOADED', 'COMMITTED')).toThrow();
    expect(importRowIdempotencyKey('abc', 'row-1', 'CREATED')).toBe(importRowIdempotencyKey('abc', 'row-1', 'CREATED'));
    expect(importRowIdempotencyKey('abc', 'row-1', 'CREATED')).not.toBe(importRowIdempotencyKey('abc', 'row-1', 'STOCK_MOVEMENT'));
  });
  it('allows only one concurrent lifecycle writer to win', async () => {
    let status: string = 'PREVIEW';
    const db = { pharmacyMigrationBatch: { updateMany: async ({ where, data }: any) => {
      if (status !== where.status) return { count: 0 }; status = data.status; return { count: 1 };
    } } };
    const scope = { organizationId: 'org', branchId: 'branch', batchId: 'batch' };
    const settled = await Promise.allSettled([
      transitionImportBatch(db, scope, 'PREVIEW', 'COMMITTING'),
      transitionImportBatch(db, scope, 'PREVIEW', 'COMMITTING'),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });
  it('rolls back only manifested creates and reverses manifested stock', () => {
    expect(
      planRollback([
        { entityType: 'Medicine', entityId: 'new', operation: 'CREATED' },
        { entityType: 'Medicine', entityId: 'pre-existing', operation: 'STOCK_MOVEMENT' },
      ])
    ).toEqual({ blocked: [], deleteEntityIds: ['new'], reverseMovementIds: ['pre-existing'] });
    expect(
      planRollback([
        { entityType: 'Medicine', entityId: 'used', operation: 'CREATED', referencedSince: true },
      ]).blocked
    ).toHaveLength(1);
  });
});
