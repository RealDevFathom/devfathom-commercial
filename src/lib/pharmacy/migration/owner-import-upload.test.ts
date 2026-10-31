import { describe, expect, it, vi } from 'vitest';
import { Workbook } from 'exceljs';
vi.mock('server-only', () => ({}));
import { parseOwnerUpload } from './owner-import-upload';
import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, suggestImportMapping } from './owner-import-input';

describe('owner CSV/XLSX upload boundary', () => {
  it('preserves leading zeroes and quoted commas, quotes and line breaks', async () => {
    const table = await parseOwnerUpload('stock.csv', Buffer.from('\uFEFFCode,Note\r\n001,"a,b"\r\n002,"a""b\nc"\r\n'));
    expect(table).toEqual({ headers: ['Code', 'Note'], rows: [['001', 'a,b'], ['002', 'a"b\nc']] });
  });
  it.each([
    ['empty.csv', ''], ['headers.csv', 'A,B\n'], ['ragged.csv', 'A,B\na,b,c'],
    ['duplicate.csv', 'A,a\n1,2'], ['blank.csv', ',B\n1,2'],
    ['quote.csv', 'A,B\n"a,b'], ['suffix.csv', 'A,B\n"a"b,c'], ['binary.csv', 'A\n\0'],
    ['old.xls', 'A\n1'],
  ])('rejects invalid upload %s', async (name, value) => {
    await expect(parseOwnerUpload(name, Buffer.from(value))).rejects.toThrow();
  });
  it('rejects invalid UTF-8, oversize files, too many rows and long cells', async () => {
    for (const bytes of [Buffer.from([0xff]), Buffer.alloc(IMPORT_MAX_BYTES + 1),
      Buffer.from(`A\n${'1\n'.repeat(IMPORT_MAX_ROWS + 1)}`), Buffer.from(`A\n${'x'.repeat(501)}`)]) {
      await expect(parseOwnerUpload('stock.csv', bytes)).rejects.toThrow();
    }
  });
  it('reads plain workbook values and dates', async () => {
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('Opening');
    sheet.addRow(['Barcode', 'Expiry']);
    sheet.addRow(['00123', new Date('2099-05-30T00:00:00Z')]);
    const table = await parseOwnerUpload('stock.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
    expect(table.rows).toEqual([['00123', '2099-05-30']]);
  });
  it('refuses formulas and multiple populated worksheets', async () => {
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('Opening');
    sheet.addRow(['A']);
    sheet.addRow([{ formula: '1+1', result: 2 }]);
    await expect(parseOwnerUpload('stock.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()))).rejects.toThrow('plain values');
    sheet.getCell('A2').value = 2;
    workbook.addWorksheet('Other').addRow(['A']);
    await expect(parseOwnerUpload('stock.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()))).rejects.toThrow('one populated');
  });
  it('rejects a workbook that expands beyond its budget', async () => {
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('Opening');
    sheet.addRow(['A']);
    // Highly compressible shared string: compressed bytes fit, expanded bytes do not.
    sheet.addRow(['x'.repeat(9 * 1024 * 1024)]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer({ useSharedStrings: true }));
    expect(bytes.length).toBeLessThan(IMPORT_MAX_BYTES);
    await expect(parseOwnerUpload('stock.xlsx', bytes)).rejects.toThrow();
  });
  it('suggests separate expected and counted columns without reusing a column', () => {
    expect(suggestImportMapping(['Code', 'Barcode', 'QTY', 'Physical count', 'Batch'])).toEqual({ sourceRef: 0, pack: 1, batch: 4, expected: 2, counted: 3 });
  });
});
