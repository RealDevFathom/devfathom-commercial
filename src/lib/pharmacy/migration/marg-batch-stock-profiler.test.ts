/**
 * #721 — the Marg Batch Stock import preset.
 *
 * Acceptance: a SYNTHETIC file built from the documented columns (Item Name,
 * Batch, Exp, Qty, MRP, Rate) imports; a REAL file stays blocked until a real
 * sample has confirmed the mapping.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { excelCsvProfiler } from './excel-csv-profiler';
import { MIGRATION_TARGET_KEYS } from './mapping-targets';
import {
  assertMargRealFileAccepted,
  MARG_PROFILER_VERSION,
  MARG_REAL_FILE_CONFIRMED,
  MARG_REQUIRED_FIELDS,
  MargBatchStockFormatError,
  margBatchStockProfiler,
  MargRealFileBlockedError,
  parseMargBatchStockText,
  prepareMargBatchStockTable,
  unmappedMargRequiredFields,
} from './marg-batch-stock-profiler';
import { profileTable, UnrecognisedSourceError, type ProfileResult } from './profiler';
import { parseDelimitedRecords, parseDelimitedText } from './source-values';

const FIXTURE_DIR = join(process.cwd(), 'src/lib/pharmacy/migration/fixtures');
const SYNTHETIC = readFileSync(join(FIXTURE_DIR, 'marg-batch-stock-synthetic.csv'), 'utf8');

function profileText(text: string): ProfileResult {
  return profileTable(margBatchStockProfiler, parseMargBatchStockText(text).table);
}

function bucketsOf(result: ProfileResult): string[] {
  return result.exceptions.map((exception) => exception.bucket).sort();
}

describe('Marg synthetic Batch Stock file — acceptance', () => {
  it('locates the header row under the report preamble and maps every required field', () => {
    const prepared = parseMargBatchStockText(SYNTHETIC);
    const columnMap = margBatchStockProfiler.resolveColumns(prepared.table);

    expect(prepared.headerLine).toBe(3);
    expect(columnMap).not.toBeNull();
    expect(unmappedMargRequiredFields(columnMap!)).toEqual([]);
    expect(columnMap).toMatchObject({
      product: 1,
      pack: 2,
      batch: 3,
      expiry: 4,
      quantity: 5,
      mrp: 6,
      cost: 7,
    });
  });

  it('imports every batch line with no exceptions', () => {
    const result = profileText(SYNTHETIC);

    expect(result.rows).toHaveLength(4);
    expect(result.exceptions).toEqual([]);
  });

  it('sets aside the preamble and the report total, and says so', () => {
    const { setAside } = parseMargBatchStockText(SYNTHETIC);

    expect(setAside.map((line) => [line.line, line.reason])).toEqual([
      [1, 'PREAMBLE'],
      [2, 'PREAMBLE'],
      [8, 'REPORT_TOTAL'],
    ]);
    expect(setAside[2]!.cells[1]).toBe('Total');
  });

  it('reads Marg values exactly: pack, month-end expiry, MRP, Rate as cost, Qty', () => {
    const [panadol, panadolNext, augmentin] = profileText(SYNTHETIC).rows;

    expect(panadol).toMatchObject({
      sourceKey: 'row:1',
      targetModelKey: MIGRATION_TARGET_KEYS.PRODUCT,
      productName: 'Panadol 500mg Tab',
      packFactor: BigInt(100),
      batchNumber: 'B2411',
      mrpMinor: BigInt(25000),
      costMinor: BigInt(21250),
      quantityCanonical: BigInt(120),
    });
    expect(panadol!.expiryDate?.toISOString()).toBe('2027-03-31T00:00:00.000Z');
    // The item code repeats per batch, so it is evidence, not the source key.
    expect(panadol!.rawPayload['Item Code']).toBe('M001');
    expect(panadol!.rawPayload['Value']).toBe('25500.00');

    expect(panadolNext).toMatchObject({ sourceKey: 'row:2', batchNumber: 'B2502' });
    expect(panadolNext!.expiryDate?.toISOString()).toBe('2027-09-30T00:00:00.000Z');
    expect(augmentin!.expiryDate?.toISOString()).toBe('2027-05-31T00:00:00.000Z');
  });

  it('gives every row a unique source key', () => {
    const keys = profileText(SYNTHETIC).rows.map((row) => row.sourceKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('Marg tolerant header matching', () => {
  it.each([
    [['Item Name', 'Batch', 'Exp', 'Qty', 'MRP', 'Rate']],
    [['ITEM NAME', 'BATCH NO.', 'EXP.', 'QTY.', 'M.R.P.', 'RATE']],
    [['item_name', 'Batch No', 'Expiry Date', 'Quantity', 'mrp', 'Pur. Rate']],
    [['Rate', 'MRP', 'Qty', 'Exp', 'Batch', 'Item Name']],
  ])('recognises %j', (headers) => {
    const columnMap = margBatchStockProfiler.resolveColumns({ headers, rows: [] });
    expect(columnMap).not.toBeNull();
    expect(unmappedMargRequiredFields(columnMap!)).toEqual([]);
  });

  it('maps Rate to cost, not to MRP as the generic profiler does', () => {
    const headers = ['Item Name', 'Batch', 'Exp', 'Qty', 'MRP', 'Rate'];
    expect(margBatchStockProfiler.resolveColumns({ headers, rows: [] })).toMatchObject({
      mrp: 4,
      cost: 5,
    });
  });

  it('refuses a sheet missing a documented column rather than profiling a partial map', () => {
    const table = { headers: ['Item Name', 'Batch', 'Qty', 'MRP', 'Rate'], rows: [] };
    expect(margBatchStockProfiler.resolveColumns(table)).toBeNull();
    expect(() => profileTable(margBatchStockProfiler, table)).toThrow(UnrecognisedSourceError);
  });

  it('reports which required fields the best header candidate lacked', () => {
    const text = 'Store\nItem Name,Batch,Qty,MRP\nA,B1,1,10.00\n';
    expect(() => parseMargBatchStockText(text)).toThrow(MargBatchStockFormatError);
    try {
      parseMargBatchStockText(text);
    } catch (error) {
      expect((error as MargBatchStockFormatError).missing).toEqual(['expiry', 'cost']);
    }
  });

  it('requires exactly the six documented columns', () => {
    expect([...MARG_REQUIRED_FIELDS].sort()).toEqual(
      ['batch', 'cost', 'expiry', 'mrp', 'product', 'quantity'].sort()
    );
  });
});

describe('Marg values flow through the shared exception pass', () => {
  const header = 'Item Name,Pack,Batch,Exp,Qty,MRP,Rate';

  it('raises the shared buckets and never defaults a value', () => {
    const result = profileText(
      [header, 'Brufen,20,,06/28,10,50.00,40.00', 'Flagyl,10x10,F1,,10+2,,40.00'].join('\n')
    );

    expect(result.rows[0]!.batchNumber).toBeNull();
    expect(result.rows[1]).toMatchObject({
      expiryDate: null,
      mrpMinor: null,
      quantityCanonical: null,
    });
    expect(bucketsOf(result)).toEqual([
      'MISSING_BATCH',
      'MISSING_EXPIRY',
      'MISSING_MRP',
      'UNIT_AMBIGUOUS',
    ]);
  });

  it('allows two batches of one item but flags a repeated batch', () => {
    const result = profileText(
      [
        header,
        'Panadol,10x10,B1,03/27,1,250.00,200.00',
        'Panadol,10x10,B2,03/27,1,250.00,200.00',
        'Panadol,10x10,b1,03/27,1,250.00,200.00',
      ].join('\n')
    );

    expect(result.exceptions).toHaveLength(1);
    expect(result.exceptions[0]).toMatchObject({ rowIndex: 2, bucket: 'DUPLICATE_PRODUCT' });
  });

  it('keeps an item line named "Total" that carries a batch', () => {
    const prepared = parseMargBatchStockText(
      [header, 'Total,10,T1,03/27,1,10.00,8.00', 'Grand Total,,,,1,,'].join('\n')
    );
    expect(prepared.table.rows).toHaveLength(1);
    expect(prepared.setAside.map((line) => line.reason)).toEqual(['REPORT_TOTAL']);
  });

  it('re-heads a table that was already parsed with its preamble as the header', () => {
    const sheet = parseDelimitedText(SYNTHETIC);
    const prepared = prepareMargBatchStockTable(sheet);
    expect(profileTable(margBatchStockProfiler, prepared.table).rows).toHaveLength(4);
  });

  it('is a distinct preset from the generic Excel/CSV profiler', () => {
    expect(margBatchStockProfiler.kind).toBe('MARG_EXCEL');
    expect(margBatchStockProfiler.version).toBe(MARG_PROFILER_VERSION);
    expect(excelCsvProfiler.kind).toBe('EXCEL_CSV');
  });
});

describe('Real Marg files are blocked until a real sample confirms the mapping', () => {
  it('is unconfirmed today', () => {
    expect(MARG_REAL_FILE_CONFIRMED).toBe(false);
    expect(MARG_PROFILER_VERSION).toMatch(/unconfirmed/);
  });

  it('refuses a real file and accepts a synthetic one', () => {
    expect(() => assertMargRealFileAccepted({ synthetic: false })).toThrow(
      MargRealFileBlockedError
    );
    expect(() => assertMargRealFileAccepted({ synthetic: true })).not.toThrow();
  });

  it('accepts a real file once the mapping is confirmed', () => {
    expect(() => assertMargRealFileAccepted({ synthetic: false }, true)).not.toThrow();
  });
});

describe('parseDelimitedRecords', () => {
  it('keeps every record at its own width and skips blank lines', () => {
    expect(parseDelimitedRecords('Title\n\na,b,c\n" x ",y\n')).toEqual([
      ['Title'],
      ['a', 'b', 'c'],
      ['x', 'y'],
    ]);
  });

  it('chooses the delimiter from the widest line, not the first', () => {
    expect(parseDelimitedRecords('Report\nA\tB\tC\n1\t2\t3')).toEqual([
      ['Report'],
      ['A', 'B', 'C'],
      ['1', '2', '3'],
    ]);
  });
});
