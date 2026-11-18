import { describe, expect, it } from 'vitest';

import { excelCsvProfiler } from './excel-csv-profiler';
import {
  MEDICINE_IMPORT_TEMPLATE_COLUMNS,
  medicineImportTemplateCsv,
  medicineImportTemplateXlsx,
} from './import-template';
import { profileTable } from './profiler';
import { planStagedMedicine, stagedLevelPrices } from './staged-creation';
import { parseStagingUpload } from './staging-upload';
import { parseDelimitedText } from './source-values';

const headers = MEDICINE_IMPORT_TEMPLATE_COLUMNS.map((column) => column.header);
const csvRow = (cells: Record<string, string>) =>
  headers.map((header) => cells[header] ?? '').join(',');

function stage(text: string) {
  const table = parseDelimitedText(text);
  const mapping = excelCsvProfiler.resolveColumns(table)!;
  const profiled = profileTable({ ...excelCsvProfiler, resolveColumns: () => mapping }, table, {
    quantityUnit: 'PACKS',
  });
  return { mapping, rows: profiled.rows };
}

describe('DEV-912 medicine import template', () => {
  it('has prices, pack size, generic name, class, supplier, stock, tax and reorder columns', () => {
    expect(headers).toEqual([
      'Product name',
      'Generic name',
      'Units per pack',
      'Strips per box',
      'Pack type',
      'MRP',
      'Purchase price',
      'Class',
      'Supplier',
      'Barcode',
      'Legacy code',
      'Opening quantity',
      'Batch number',
      'Expiry date',
      'Shelf or rack',
      'Tax rate %',
      'Reorder level',
    ]);
    expect(MEDICINE_IMPORT_TEMPLATE_COLUMNS.filter((column) => column.required)).toHaveLength(1);
    for (const column of MEDICINE_IMPORT_TEMPLATE_COLUMNS) expect(column.meaning).not.toBe('');
  });

  it('maps its columns into the existing staging fields without a manual choice', () => {
    const { mapping } = stage(medicineImportTemplateCsv());
    for (const [field, header] of [
      ['product', 'Product name'],
      ['pack', 'Units per pack'],
      ['mrp', 'MRP'],
      ['cost', 'Purchase price'],
      ['quantity', 'Opening quantity'],
      ['batch', 'Batch number'],
      ['expiry', 'Expiry date'],
      ['barcode', 'Barcode'],
      ['supplier', 'Supplier'],
    ] as const)
      expect(mapping[field], field).toBe(headers.indexOf(header));
  });

  it('turns a filled row into a medicine with its MRP, purchase price and pack levels', () => {
    const { rows } = stage(
      [
        headers.join(','),
        csvRow({
          'Product name': 'Fixture Tablet 500mg',
          'Generic name': 'Fixture salt',
          'Units per pack': '100',
          'Strips per box': '10',
          MRP: '350.00',
          'Purchase price': '300.00',
          Class: 'NARCOTICS',
          'Legacy code': 'OLD-1',
        }),
      ].join('\n')
    );
    const plan = planStagedMedicine({ id: 'r', ...rows[0]!, rawPayload: rows[0]!.rawPayload });
    expect(plan).toMatchObject({
      productName: 'Fixture Tablet 500mg',
      mrpMinor: 35_000,
      purchasePriceMinor: 30_000,
      genericName: 'Fixture salt',
      legacyCode: 'OLD-1',
      narcoticsClass: true,
      packLevels: [
        { level: 'BOX', unitsPerParent: 10 },
        { level: 'STRIP', unitsPerParent: 10 },
      ],
    });
    expect(stagedLevelPrices(plan!)?.unitPriceMinor).toBe(350);
  });

  it('accepts a file with only names: everything else is not recorded', () => {
    const { rows } = stage(
      [headers.join(','), csvRow({ 'Product name': 'Fixture Syrup' })].join('\n')
    );
    expect(rows).toHaveLength(1);
    expect(planStagedMedicine({ id: 'r', ...rows[0]! })).toMatchObject({
      productName: 'Fixture Syrup',
      packLevels: [],
      mrpMinor: null,
      purchasePriceMinor: null,
    });
  });

  it('still reads the old desktop system headers', () => {
    const { mapping, rows } = stage(
      'Name,aliasname,PackUnits,saleprice,purprice,QTY,classname\nFixture Capsule,C-9,10,120.00,96.00,3,CAPSULES\n'
    );
    expect([mapping.product, mapping.pack, mapping.mrp, mapping.cost, mapping.quantity]).toEqual([
      0, 2, 3, 4, 5,
    ]);
    expect(planStagedMedicine({ id: 'r', ...rows[0]! })).toMatchObject({
      legacyCode: 'C-9',
      mrpMinor: 12_000,
      purchasePriceMinor: 9_600,
      unitsPerPack: 10,
    });
  });

  it('downloads an Excel template the staging upload accepts, with a note on every header', async () => {
    const bytes = await medicineImportTemplateXlsx();
    const table = await parseStagingUpload('medicine-import-template.xlsx', Buffer.from(bytes));
    expect(table.headers).toEqual(headers);
    expect(table.rows).toHaveLength(1);
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
    const header = workbook.worksheets[0]!.getRow(1);
    expect(String(header.getCell(1).note)).toMatch(/^Required\./);
    expect(String(header.getCell(6).note)).toMatch(/SALEPRICE/);
    expect(String(header.getCell(7).note)).toMatch(/PURPRICE/);
  });
});
