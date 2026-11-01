// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  buildPharmacyExportFiles,
  buildPharmacyExportReadme,
  exportCsvCell,
  exportRowsToCsv,
  formatCalendarDate,
  formatKarachiDate,
  formatMinor,
  neutralizeSpreadsheetFormula,
  PHARMACY_EXPORT_FILE_KEYS,
  PHARMACY_EXPORT_FILES,
  pharmacyExportRowCounts,
  type ExportFileSpec,
  type PharmacyExportDataset,
} from './data-export-format';
import { parsePharmacyExportCatalogue } from './data-export-catalogue';
import { devfathomCatalogueProfiler } from './migration/devfathom-catalogue-profiler';
import { devfathomStockLotsProfiler } from './migration/devfathom-stock-lots-profiler';
import { excelCsvProfiler } from './migration/excel-csv-profiler';
import { profileTable } from './migration/profiler';
import { parseDelimitedText } from './migration/source-values';
import { registerPrintTotals } from './register-print';

/** The Excel/CSV profiler's synonyms, normalized the way the profiler normalizes. */
const PRESET_SYNONYMS = new Set([
  'id', 'code', 'itemcode', 'productcode', 'sr', 'srno', 'serial', 'sno',
  'product', 'productname', 'item', 'itemname', 'description', 'medicine', 'drug',
  'pack', 'packsize', 'packing', 'uom', 'unit', 'unitofmeasure',
  'barcode', 'ean', 'ean13', 'upc', 'gtin',
  'batch', 'batchno', 'batchnumber', 'lot', 'lotno', 'lotnumber',
  'expiry', 'expirydate', 'exp', 'expdate', 'expdt', 'expiredate',
  'mrp', 'retailprice', 'saleprice', 'sellingprice', 'rate',
  'cost', 'costprice', 'tradeprice', 'tp', 'purchaseprice', 'purchaserate',
  'qty', 'quantity', 'stock', 'stockqty', 'onhand', 'balanceqty', 'closingqty',
  'supplier', 'vendor', 'distributor', 'suppliername',
  'customer', 'client', 'customername', 'account',
  'balance', 'closingbalance', 'outstanding', 'amountdue', 'openingbalance',
]);
const PRESET_HEADERS = new Set([
  'code', 'product', 'pack', 'barcode', 'batch', 'expiry', 'mrp', 'cost', 'quantity',
  'supplier', 'customer', 'balance',
]);
const normalize = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, '');

function emptyDataset(): Record<keyof typeof PHARMACY_EXPORT_FILES, Record<string, unknown>[]> {
  return Object.fromEntries(PHARMACY_EXPORT_FILE_KEYS.map((key) => [key, []])) as never;
}

function seededDataset(): PharmacyExportDataset {
  const data = emptyDataset();
  data.branches.push({ code: 'br-1', branch_code: 'RWP', name: 'Saddar', city: 'Rawalpindi' });
  data.medicines.push(
    { code: 'pk-1', product: 'Panadol 500mg', pack: 10, pack_level: 'STRIP', barcode: '8964000000011' },
    { code: 'pk-2', product: 'Panadol 500mg', pack: 200, pack_level: 'BOX', barcode: null },
    { code: 'pr-3', product: '=HYPERLINK("http://evil")', pack: null }
  );
  data.stockLots.push(
    {
      code: 'lot-1:MAIN:AVAILABLE',
      product: 'Panadol 500mg',
      pack: 10,
      batch: 'B-1',
      expiry: '2027-06-30',
      quantity: 120,
      cost: formatMinor(250),
      mrp: formatMinor(3_000),
      supplier: 'Muller & Phipps',
    },
    { code: 'lot-2', product: 'Brufen', pack: 20, batch: 'B-2', expiry: '2027-01-31', quantity: 0, mrp: '25.00' }
  );
  data.customers.push(
    { code: 'c-1', customer: 'Ayesha Khan', balance: formatMinor(125_050) },
    { code: 'c-2', customer: 'Bilal, "Shop" Ahmed', balance: formatMinor(-2_000) },
    { code: 'c-3', customer: '@risky', balance: formatMinor(0) }
  );
  data.suppliers.push({ code: 's-1', supplier: 'Muller & Phipps', balance: formatMinor(990_000) });
  data.sales.push({ code: 'sale-1', customer: 'Ayesha Khan', net: formatMinor(3_000) });
  data.saleLines.push({ code: 'line-1', sale_code: 'sale-1', product: 'Panadol 500mg', quantity: 10 });
  data.controlledRegister.push(
    {
      code: 'cr-1',
      branch_code: 'RWP',
      serial_no: 1,
      entry_type: 'Purchase',
      product: 'Tramadol 50mg',
      quantity: 100,
      balance_delta: 100,
      batch: 'T-1',
      running_balance: 100,
      lot_code: 'lot-t',
    },
    {
      code: 'cr-2',
      branch_code: 'RWP',
      serial_no: 2,
      entry_type: 'Sale',
      patient: 'Patient One',
      product: 'Tramadol 50mg',
      quantity: 10,
      balance_delta: -10,
      batch: 'T-1',
      running_balance: 90,
      lot_code: 'lot-t',
    }
  );
  data.medicines = data.medicines.map((row, index) => ({
    brand_name: null, manufacturer: null, drap_registration_no: null,
    product_family: 'PHARMACEUTICAL', rx: false, otc: false, restricted: false,
    controlled: false, high_alert: false, lasa: false, cold_chain: false, saleable: false,
    medicine_code: index < 2 ? 'med-1' : 'med-2',
    presentation_code: index < 2 ? 'pr-1' : '',
    presentation: index < 2 ? 'Tablet' : '', dosage_form: null, route: null,
    ...row,
  }));
  return data as PharmacyExportDataset;
}

describe('owner data export — CSV safety', () => {
  it('neutralises spreadsheet formulas in text but keeps signed money numeric', () => {
    expect(neutralizeSpreadsheetFormula('=2+2')).toBe("'=2+2");
    expect(neutralizeSpreadsheetFormula('+92 300 1234567')).toBe("'+92 300 1234567");
    expect(neutralizeSpreadsheetFormula('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(neutralizeSpreadsheetFormula('  -cmd|calc')).toBe("'  -cmd|calc");
    expect(neutralizeSpreadsheetFormula('\tnote')).toBe("'\tnote");
    expect(neutralizeSpreadsheetFormula('\rnote')).toBe("'\rnote");
    expect(neutralizeSpreadsheetFormula('-125.50')).toBe('-125.50');
    expect(neutralizeSpreadsheetFormula('-1+1')).toBe("'-1+1");
    expect(neutralizeSpreadsheetFormula('Panadol')).toBe('Panadol');
  });

  it('quotes cells RFC 4180 style after neutralising', () => {
    expect(exportCsvCell('Bilal, "Shop" Ahmed')).toBe('"Bilal, ""Shop"" Ahmed"');
    expect(exportCsvCell('=1,2')).toBe('"\'=1,2"');
    expect(exportCsvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(exportCsvCell(null)).toBe('');
    expect(exportCsvCell(undefined)).toBe('');
    expect(exportCsvCell(true)).toBe('true');
    expect(exportCsvCell(42)).toBe('42');
  });

  it('formats money, dates and Pakistan calendar days exactly', () => {
    expect(formatMinor(125_050)).toBe('1250.50');
    expect(formatMinor(-2_000)).toBe('-20.00');
    expect(formatMinor(5)).toBe('0.05');
    expect(formatMinor(BigInt(-1))).toBe('-0.01');
    expect(formatMinor(null)).toBeNull();
    // 20:00 UTC on 30 June is already 1 July in Pakistan.
    expect(formatKarachiDate(new Date('2027-06-30T20:00:00.000Z'))).toBe('2027-07-01');
    expect(formatCalendarDate(new Date('2026-10-01T00:00:00.000Z'))).toBe('2026-10-01');
  });

  it('writes CRLF CSV with the declared headers in order', () => {
    const spec: ExportFileSpec = PHARMACY_EXPORT_FILES.suppliers;
    const csv = exportRowsToCsv(spec, [{ code: 's-1', supplier: '=evil', balance: '10.00' }]);
    const [header, row] = csv.split('\r\n');
    expect(header).toBe(spec.columns.map((column) => column.header).join(','));
    expect(row!.startsWith("s-1,'=evil,10.00,")).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});

describe('owner data export — import preset columns', () => {
  it.each([
    { product: '' },
    { pack: '0' },
    { pack: '1.5' },
    { pack: '2147483648' },
    { rx: 'maybe' },
    { presentation_code: '' },
  ])('rejects malformed catalogue data before importing: %j', (change) => {
    const row = { ...seededDataset().medicines[0], ...change };
    const csv = exportRowsToCsv(PHARMACY_EXPORT_FILES.medicines, [row]);
    expect(() => parsePharmacyExportCatalogue(csv)).toThrow('valid, consistent catalogue rows');
  });

  it('refuses conflicting medicine identities and duplicate source row identifiers', () => {
    const rows = [...seededDataset().medicines];
    rows[1] = { ...rows[1], product: 'A different medicine' };
    expect(() => parsePharmacyExportCatalogue(exportRowsToCsv(PHARMACY_EXPORT_FILES.medicines, rows)))
      .toThrow('valid, consistent catalogue rows');
    expect(() => parsePharmacyExportCatalogue(exportRowsToCsv(PHARMACY_EXPORT_FILES.medicines, [rows[0]!, rows[0]!])))
      .toThrow('valid, consistent catalogue rows');
  });

  it('declares unique headers, and only preset headers normalize to a profiler synonym', () => {
    for (const key of PHARMACY_EXPORT_FILE_KEYS) {
      const headers: string[] = PHARMACY_EXPORT_FILES[key].columns.map((column) => column.header);
      expect(new Set(headers).size, key).toBe(headers.length);
      expect(headers[0], key).toBe('code');
      for (const header of headers) {
        if (PRESET_HEADERS.has(header)) continue;
        expect(PRESET_SYNONYMS.has(normalize(header)), `${key}.${header}`).toBe(false);
      }
    }
  });

  it.each(['medicines', 'stockLots', 'customers', 'suppliers'] as const)(
    're-imports %s through the migration wizard profiler with matching row counts',
    (key) => {
      const dataset = seededDataset();
      const file = buildPharmacyExportFiles(dataset, {
        organizationName: 'Seeded',
        generatedAt: new Date('2026-10-31T00:00:00.000Z'),
        salesFrom: '2026-01-01',
        salesTo: '2026-10-31',
      }).find((item) => item.name === PHARMACY_EXPORT_FILES[key].name)!;
      expect(PHARMACY_EXPORT_FILES[key].importable).toBe(true);
      const table = parseDelimitedText(file.data.toString('utf8'));
      // The wizard routes medicines.csv and stock-lots.csv to their DevFathom
      // adapters; every other file to Excel/CSV.
      const profiled = profileTable(
        key === 'medicines'
          ? devfathomCatalogueProfiler
          : key === 'stockLots'
            ? devfathomStockLotsProfiler
            : excelCsvProfiler,
        table
      );
      expect(profiled.rows).toHaveLength(dataset[key].length);
      expect(profiled.exceptions).toEqual([]);
      if (key === 'medicines') {
        const catalogue = parsePharmacyExportCatalogue(file.data.toString('utf8'));
        expect(catalogue).toHaveLength(dataset.medicines.length);
        expect(catalogue.map((row) => row.pack)).toEqual([10, 200, null]);
        // The stock profiler still refuses catalogue rows without lot evidence.
        const stockProfile = profileTable(excelCsvProfiler, table);
        expect(stockProfile.exceptions.some((exception) => exception.bucket === 'MISSING_BATCH')).toBe(true);
      } else {
        expect(devfathomCatalogueProfiler.resolveColumns(table)).toBeNull();
      }
      expect(profiled.rows.map((row) => row.sourceKey)).toEqual(
        dataset[key].map((row) => String(row.code))
      );
    }
  );

  it('reads preset values back exactly, including negative balances and formula-looking names', () => {
    const dataset = seededDataset();
    const csv = exportRowsToCsv(PHARMACY_EXPORT_FILES.customers, dataset.customers);
    const profiled = profileTable(excelCsvProfiler, parseDelimitedText(csv));
    expect(profiled.rows.map((row) => [row.customerName, row.balanceMinor])).toEqual([
      ['Ayesha Khan', BigInt(125_050)],
      ['Bilal, "Shop" Ahmed', BigInt(-2_000)],
      ["'@risky", BigInt(0)],
    ]);
    const stock = profileTable(
      excelCsvProfiler,
      parseDelimitedText(exportRowsToCsv(PHARMACY_EXPORT_FILES.stockLots, dataset.stockLots))
    ).rows[0]!;
    expect(stock).toMatchObject({
      productName: 'Panadol 500mg',
      packFactor: BigInt(10),
      batchNumber: 'B-1',
      expiryDate: new Date('2027-06-30T00:00:00.000Z'),
      quantityCanonical: BigInt(120),
      costMinor: BigInt(250),
      mrpMinor: BigInt(3_000),
      supplierName: 'Muller & Phipps',
    });
  });

  it('keeps the history files profilable one row per CSV row', () => {
    const dataset = seededDataset();
    for (const key of ['sales', 'saleLines', 'controlledRegister'] as const) {
      const csv = exportRowsToCsv(PHARMACY_EXPORT_FILES[key], dataset[key]);
      expect(profileTable(excelCsvProfiler, parseDelimitedText(csv)).rows).toHaveLength(
        dataset[key].length
      );
    }
  });
});

describe('owner data export — README and register parity', () => {
  it('documents every file and column with its row count', () => {
    const dataset = seededDataset();
    const readme = buildPharmacyExportReadme(dataset, {
      organizationName: 'Seeded Pharmacy',
      generatedAt: new Date('2026-10-31T00:00:00.000Z'),
      salesFrom: '2026-01-01',
      salesTo: '2026-10-31',
    });
    expect(readme).toContain('Organization: Seeded Pharmacy');
    expect(readme).toContain('Sales range:  2026-01-01 to 2026-10-31');
    const counts = pharmacyExportRowCounts(dataset);
    for (const key of PHARMACY_EXPORT_FILE_KEYS) {
      const spec: ExportFileSpec = PHARMACY_EXPORT_FILES[key];
      expect(readme).toContain(`${spec.name} — ${spec.title}`);
      expect(readme).toContain(`  Rows: ${counts[key]}`);
      for (const column of spec.columns) {
        expect(readme).toContain(`    ${column.header}: ${column.description}`);
      }
    }
  });

  it('prints the same register totals the printed register shows', () => {
    const dataset = seededDataset();
    const printed = registerPrintTotals(
      dataset.controlledRegister.map((row) => ({
        inventoryLotId: String(row.lot_code),
        batchNumber: String(row.batch),
        balanceDelta: Number(row.balance_delta),
        runningBalance: Number(row.running_balance),
        serial: Number(row.serial_no),
      }))
    );
    const readme = buildPharmacyExportReadme(dataset, {
      organizationName: 'Seeded',
      generatedAt: new Date('2026-10-31T00:00:00.000Z'),
      salesFrom: '2026-01-01',
      salesTo: '2026-10-31',
    });
    expect(printed).toMatchObject({ rows: 2, unitsIn: 100, unitsOut: 10 });
    expect(readme).toContain('Branch RWP: 2 rows, in 100, out 10, closing T-1 balance 90');
  });

  it('builds README first and every CSV as UTF-8 with a byte-order mark', () => {
    const files = buildPharmacyExportFiles(seededDataset(), {
      organizationName: 'Seeded',
      generatedAt: new Date('2026-10-31T00:00:00.000Z'),
      salesFrom: '2026-01-01',
      salesTo: '2026-10-31',
    });
    expect(files.map((file) => file.name)).toEqual([
      'README.txt',
      ...PHARMACY_EXPORT_FILE_KEYS.map((key) => PHARMACY_EXPORT_FILES[key].name),
    ]);
    for (const file of files) expect([...file.data.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const medicines = files.find((file) => file.name === 'medicines.csv')!.data.toString('utf8');
    expect(medicines).toContain('"\'=HYPERLINK(""http://evil"")"');
  });
});
