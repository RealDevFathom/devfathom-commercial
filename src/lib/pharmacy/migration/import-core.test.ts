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
} from './import-core';

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
    expect(importRowIdempotencyKey('abc', 'row-1')).toBe(importRowIdempotencyKey('abc', 'row-1'));
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
