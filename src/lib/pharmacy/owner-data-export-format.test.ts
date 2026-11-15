// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { excelCsvProfiler } from './migration/excel-csv-profiler';
import { profileTable } from './migration/profiler';
import { parseDelimitedText, readExpiryDate, readMoneyMinor } from './migration/source-values';
import {
  OWNER_DATA_EXPORT_FILES,
  buildOwnerDataExportZip,
  countExportRows,
  exportCsv,
  exportReadme,
  exportRowCounts,
  formatExpiryDateOnly,
  formatMinor,
  type OwnerDataExportRows,
} from './owner-data-export-format';

const EMPTY: OwnerDataExportRows = {
  medicines: [],
  stockLots: [],
  customers: [],
  khataLedger: [],
  suppliers: [],
  sales: [],
  saleLines: [],
  purchaseOrders: [],
  goodsReceipts: [],
  goodsReceiptLines: [],
  controlledRegister: [],
};

const SEEDED: OwnerDataExportRows = {
  ...EMPTY,
  medicines: [
    { code: 'pk1', product: 'Panadol 500mg', pack: '10 units', barcode: '8961234567890' },
    { code: 'pk2', product: 'Brufen 400mg', pack: '100 units', barcode: '' },
  ],
  stockLots: [
    {
      code: 'lot1',
      product: 'Panadol 500mg',
      pack: '10 units',
      batch: 'B-101',
      expiry: '2027-03-31',
      mrp: formatMinor(4550),
      cost: formatMinor(312),
      quantity: 120,
      supplier: 'Muller & Phipps',
    },
  ],
  customers: [
    { code: 'c1', customer: 'Ayesha Khan', balance: formatMinor(150000) },
    { code: 'c2', customer: '=HYPERLINK("http://x")', balance: formatMinor(0) },
    { code: 'c3', customer: 'Bilal, "Bilu"', balance: formatMinor(-2500) },
  ],
  suppliers: [{ code: 's1', supplier: 'Muller & Phipps', goods_received_value: '10.00' }],
};

function reimport(key: 'medicines' | 'stockLots' | 'customers' | 'suppliers') {
  const table = parseDelimitedText(exportCsv(OWNER_DATA_EXPORT_FILES[key], SEEDED[key]));
  return profileTable(excelCsvProfiler, table);
}

describe('owner data export format', () => {
  it('formats paisa as exact rupees', () => {
    expect(formatMinor(0)).toBe('0.00');
    expect(formatMinor(5)).toBe('0.05');
    expect(formatMinor(4550)).toBe('45.50');
    expect(formatMinor(-2500)).toBe('-25.00');
    expect(formatMinor(null)).toBe('');
    expect(() => formatMinor(1.5)).toThrow();
  });

  it('re-imports through the migration wizard profiler with matching row counts', () => {
    const medicines = reimport('medicines');
    expect(medicines.rows).toHaveLength(SEEDED.medicines.length);
    expect(medicines.columnMap).toMatchObject({ sourceKey: 0, product: 1, pack: 2, barcode: 4 });

    const lots = reimport('stockLots');
    expect(lots.rows).toHaveLength(SEEDED.stockLots.length);
    expect(Object.keys(lots.columnMap).sort()).toEqual(
      [
        'sourceKey',
        'product',
        'pack',
        'batch',
        'expiry',
        'mrp',
        'cost',
        'quantity',
        'supplier',
      ].sort()
    );

    const customers = reimport('customers');
    expect(customers.rows).toHaveLength(SEEDED.customers.length);
    expect(customers.columnMap).toMatchObject({ sourceKey: 0, customer: 1, balance: 2 });

    // The importer reads every exported pack as a countable unit, so nothing is ambiguous.
    for (const result of [medicines, lots]) {
      expect(result.exceptions.filter((item) => item.bucket === 'UNIT_AMBIGUOUS')).toEqual([]);
    }

    const suppliers = reimport('suppliers');
    expect(suppliers.rows).toHaveLength(SEEDED.suppliers.length);
    expect(suppliers.columnMap).toMatchObject({ sourceKey: 0, supplier: 1 });
    // A received-goods total is not an opening balance and must not import as one.
    expect(suppliers.columnMap.balance).toBeUndefined();
  });

  it('writes values the importer reads back exactly', () => {
    const table = parseDelimitedText(
      exportCsv(OWNER_DATA_EXPORT_FILES.stockLots, SEEDED.stockLots)
    );
    const row = table.rows[0]!;
    const cell = (header: string) => row[table.headers.indexOf(header)];
    expect(readMoneyMinor(cell('mrp'))).toBe(BigInt(4550));
    expect(readMoneyMinor(cell('cost'))).toBe(BigInt(312));
    const customers = parseDelimitedText(
      exportCsv(OWNER_DATA_EXPORT_FILES.customers, SEEDED.customers)
    );
    // A credit (negative) balance survives the round trip as a number, not text.
    expect(readMoneyMinor(customers.rows[2]![customers.headers.indexOf('balance')])).toBe(
      BigInt(-2500)
    );
    expect(readExpiryDate(cell('expiry'))?.toISOString().slice(0, 10)).toBe('2027-03-31');
  });

  it('neutralises spreadsheet formulas and keeps quotes and commas intact', () => {
    const csv = exportCsv(OWNER_DATA_EXPORT_FILES.customers, SEEDED.customers);
    expect(csv).not.toMatch(/(^|,)"=HYPERLINK/m);
    const table = parseDelimitedText(csv);
    expect(table.rows[1]![1]).toBe(`'=HYPERLINK("http://x")`);
    expect(table.rows[2]![1]).toBe('Bilal, "Bilu"');
    expect(csv.startsWith('﻿')).toBe(true);
  });

  it('documents every column of every file in the README', () => {
    const readme = exportReadme(
      {
        organizationName: 'Shifa',
        generatedAt: new Date('2026-11-15T00:00:00Z'),
        salesFrom: null,
        salesTo: null,
      },
      countExportRows(SEEDED)
    );
    for (const spec of Object.values(OWNER_DATA_EXPORT_FILES)) {
      expect(readme).toContain(`## ${spec.name}`);
      for (const column of spec.columns) expect(readme).toContain(`| ${column.header} |`);
    }
    expect(readme).toContain('customers.csv (3 rows)');
  });

  it('lets only the four importable files map onto import fields', () => {
    const importable = new Set([
      'medicines.csv',
      'stock_lots.csv',
      'customers.csv',
      'suppliers.csv',
    ]);
    for (const spec of Object.values(OWNER_DATA_EXPORT_FILES)) {
      const headers = spec.columns.map((column) => column.header);
      const map = excelCsvProfiler.resolveColumns({ headers, rows: [] });
      if (importable.has(spec.name)) expect(map).not.toBeNull();
      else expect(map).toBeNull();
    }
  });

  it('packs a README and one CSV per file', () => {
    const archive = buildOwnerDataExportZip(
      { organizationName: 'Shifa', generatedAt: new Date(), salesFrom: null, salesTo: null },
      SEEDED
    );
    const text = archive.toString('latin1');
    for (const name of [
      'README.md',
      ...Object.values(OWNER_DATA_EXPORT_FILES).map((f) => f.name),
    ]) {
      expect(text).toContain(name);
    }
    expect(exportRowCounts(countExportRows(SEEDED))['customers.csv']).toBe(3);
  });
});

describe('formatExpiryDateOnly (QA-3)', () => {
  it('leaves a no-expiry lot blank instead of exporting 9998-12-31', () => {
    expect(formatExpiryDateOnly(new Date('9998-12-31T00:00:00.000Z'))).toBe('');
    expect(formatExpiryDateOnly(new Date('9998-12-31T19:00:00.000Z'))).toBe('');
    expect(formatExpiryDateOnly(new Date('2027-04-30T19:00:00.000Z'))).toBe('2027-04-30');
    expect(formatExpiryDateOnly(null)).toBe('');
  });
});
