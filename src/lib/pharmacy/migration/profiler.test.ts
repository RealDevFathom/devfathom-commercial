/**
 * PH-MIG / MIG-01, MIG-02 — profiling three fixtures to EXACT exception buckets.
 *
 * The acceptance criterion is "missing batch/expiry/MRP is never silently
 * defaulted", so these cases assert both halves of that: the exception buckets
 * are exhaustive (`toEqual`, not `toMatchObject` — an unexpected bucket fails),
 * AND the parsed column stays `null` rather than acquiring a stand-in value.
 * Asserting only the exception would pass against a profiler that raised the
 * exception and defaulted the field anyway.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { abuzarProfiler, ABUZAR_COLUMN_MAP } from './abuzar-profiler';
import { excelCsvProfiler } from './excel-csv-profiler';
import { MIGRATION_TARGET_KEYS, naturalKey } from './mapping-targets';
import {
  EXCEPTION_SEVERITY,
  profileTable,
  UnrecognisedSourceError,
  type ExceptionBucket,
  type ProfileResult,
} from './profiler';
import {
  parseDelimitedText,
  readExpiryDate,
  readMoneyMinor,
  readPackFactor,
  readQuantity,
} from './source-values';

/** Vitest sets its root to the repository root, so resolve from there. */
const FIXTURE_DIR = join(process.cwd(), 'src/lib/pharmacy/migration/fixtures');

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

function bucketCounts(result: ProfileResult): Partial<Record<ExceptionBucket, number>> {
  const counts: Partial<Record<ExceptionBucket, number>> = {};
  for (const exception of result.exceptions) {
    counts[exception.bucket] = (counts[exception.bucket] ?? 0) + 1;
  }
  return counts;
}

function profileFixture(name: string, profiler = excelCsvProfiler): ProfileResult {
  return profileTable(profiler, parseDelimitedText(fixture(name)), { quantityUnit: 'UNITS' });
}

describe('Excel/CSV profiling — the three PRD fixtures', () => {
  it('profiles the clean fixture with no exceptions at all', () => {
    const result = profileFixture('excel-clean.csv');

    expect(result.rows).toHaveLength(3);
    expect(bucketCounts(result)).toEqual({});
  });

  it('reads exact canonical integers and month-end expiries from the clean fixture', () => {
    const [panadol, augmentin, brufen] = profileFixture('excel-clean.csv').rows;

    expect(panadol).toMatchObject({
      sourceKey: '1',
      rowNumber: 1,
      targetModelKey: MIGRATION_TARGET_KEYS.PRODUCT,
      productName: 'Panadol 500mg',
      batchNumber: 'B2411',
      packFactor: BigInt(100),
      // "Rs. 250.00" in paisa. Integer, not 250.0.
      mrpMinor: BigInt(25000),
      costMinor: BigInt(21250),
      quantityCanonical: BigInt(120),
    });
    // A pack marked 03/2027 is saleable through the LAST day of March.
    expect(panadol!.expiryDate?.toISOString()).toBe('2027-03-31T00:00:00.000Z');
    expect(augmentin!.expiryDate?.toISOString()).toBe('2027-05-31T00:00:00.000Z');
    expect(brufen!.expiryDate?.toISOString()).toBe('2026-06-30T00:00:00.000Z');
    expect(brufen!.packFactor).toBe(BigInt(20));

    // The untouched source cells travel with the row.
    expect(panadol!.rawPayload['MRP']).toBe('Rs. 250.00');
  });

  it('routes every missing or unreadable field to its exact bucket', () => {
    const result = profileFixture('excel-missing-fields.csv');

    expect(result.rows).toHaveLength(5);
    expect(bucketCounts(result)).toEqual({
      MISSING_BATCH: 1,
      MISSING_EXPIRY: 1,
      MISSING_MRP: 1,
      // One unreadable pack ("bottle") and one fractional quantity ("3.5").
      UNIT_AMBIGUOUS: 2,
    });
  });

  it('leaves the missing values null instead of defaulting them', () => {
    const rows = profileFixture('excel-missing-fields.csv').rows;

    expect(rows[0]!.batchNumber).toBeNull();
    expect(rows[1]!.expiryDate).toBeNull();
    expect(rows[2]!.mrpMinor).toBeNull();
    expect(rows[3]!.packFactor).toBeNull();
    expect(rows[4]!.quantityCanonical).toBeNull();

    // Nothing was dropped either: the unreadable cells survive in rawPayload,
    // so a workbench operator sees what the incumbent actually wrote.
    expect(rows[3]!.rawPayload['Pack Size']).toBe('bottle');
    expect(rows[4]!.rawPayload['Qty']).toBe('3.5');
  });

  it('attaches each exception to the row that caused it', () => {
    const result = profileFixture('excel-missing-fields.csv');
    const byRow = result.exceptions.map((exception) => [
      exception.rowIndex,
      exception.bucket,
      exception.severity,
    ]);

    expect(byRow).toEqual([
      [0, 'MISSING_BATCH', 'BLOCKING'],
      [1, 'MISSING_EXPIRY', 'BLOCKING'],
      [2, 'MISSING_MRP', 'BLOCKING'],
      [3, 'UNIT_AMBIGUOUS', 'BLOCKING'],
      [4, 'UNIT_AMBIGUOUS', 'BLOCKING'],
    ]);
  });

  it('flags duplicates by barcode and by normalized name plus pack', () => {
    const result = profileFixture('excel-duplicates.csv');

    expect(result.rows).toHaveLength(4);
    expect(bucketCounts(result)).toEqual({ DUPLICATE_PRODUCT: 2 });

    // Row 2 duplicates row 1 on the barcode even though the names differ;
    // row 4 duplicates row 3 on name + pack with different casing and spacing.
    const [first, second] = result.exceptions;
    expect(first!.rowIndex).toBe(1);
    expect(second!.rowIndex).toBe(3);
    expect(result.rows[3]!.targetNaturalKey).toBe(
      naturalKey(MIGRATION_TARGET_KEYS.PRODUCT, 'Disprin 300mg', '20 Tabs')
    );
  });
});

describe('Excel/CSV column detection', () => {
  it('maps every header the fixtures use', () => {
    const table = parseDelimitedText(fixture('excel-clean.csv'));

    expect(excelCsvProfiler.resolveColumns(table)).toEqual({
      sourceKey: 0,
      product: 1,
      pack: 2,
      barcode: 3,
      batch: 4,
      expiry: 5,
      mrp: 6,
      cost: 7,
      quantity: 8,
      supplier: 9,
    });
  });

  it('matches headers exactly, so a stock count is never read as a party balance', () => {
    const table = parseDelimitedText('Item,Balance Qty,Closing Balance\nPanadol,10,500.00\n');

    expect(excelCsvProfiler.resolveColumns(table)).toEqual({
      product: 0,
      quantity: 1,
      balance: 2,
    });
  });

  it('refuses a sheet with no importable column rather than profiling nothing', () => {
    const table = parseDelimitedText('Sr,Notes\n1,anything\n');

    expect(excelCsvProfiler.resolveColumns(table)).toBeNull();
    expect(() => profileTable(excelCsvProfiler, table)).toThrow(UnrecognisedSourceError);
  });
});

describe('Abuzar profiling — fixture-driven, unconfirmed until Phase 0', () => {
  it('recognises the documented column map', () => {
    const table = parseDelimitedText(fixture('abuzar-stock-export.csv'));

    expect(abuzarProfiler.resolveColumns(table)).toEqual({
      sourceKey: 0,
      product: 1,
      pack: 2,
      barcode: 3,
      batch: 4,
      expiry: 5,
      mrp: 6,
      cost: 7,
      quantity: 8,
      supplier: 9,
    });
    // The map is the single point of correction when the real format is seen.
    expect(Object.keys(ABUZAR_COLUMN_MAP)).toContain('ITEM_CODE');
    expect(abuzarProfiler.version).toBe('abuzar/1-unconfirmed');
  });

  it('keeps the incumbent item code as the source key', () => {
    const result = profileFixture('abuzar-stock-export.csv', abuzarProfiler);

    expect(result.rows.map((row) => row.sourceKey)).toEqual(['ABZ-0001', 'ABZ-0002', 'ABZ-0003']);
  });

  it('reads day-first and two-digit-year dates from the tab-delimited export', () => {
    const rows = profileFixture('abuzar-stock-export.csv', abuzarProfiler).rows;

    expect(rows[0]!.expiryDate?.toISOString()).toBe('2027-03-15T00:00:00.000Z');
    expect(rows[1]!.expiryDate?.toISOString()).toBe('2027-05-31T00:00:00.000Z');
    expect(rows[2]!.expiryDate?.toISOString()).toBe('2026-06-30T00:00:00.000Z');
    expect(rows[0]!.packFactor).toBe(BigInt(100));
  });

  it('raises exceptions for the gaps rather than rejecting the file', () => {
    const result = profileFixture('abuzar-stock-export.csv', abuzarProfiler);

    expect(bucketCounts(result)).toEqual({ MISSING_BATCH: 1, MISSING_MRP: 1 });
  });

  it('refuses a file whose identity columns are absent', () => {
    const table = parseDelimitedText(fixture('excel-clean.csv'));

    expect(abuzarProfiler.resolveColumns(table)).toBeNull();
    expect(() => profileTable(abuzarProfiler, table)).toThrow(UnrecognisedSourceError);
  });
});

describe('Party buckets, which need what the organization already knows', () => {
  const table = parseDelimitedText(
    'Supplier,Closing Balance\nMuller & Phipps,12500.00\nUnknown Traders,900.00\n'
  );

  it('does not evaluate a bucket it has no context for', () => {
    expect(bucketCounts(profileTable(excelCsvProfiler, table))).toEqual({});
  });

  it('raises PARTY_UNMATCHED as a warning for a party it does not know', () => {
    const result = profileTable(excelCsvProfiler, table, {
      knownPartyKeys: new Set([naturalKey(MIGRATION_TARGET_KEYS.PARTY, 'Muller & Phipps')]),
    });

    expect(bucketCounts(result)).toEqual({ PARTY_UNMATCHED: 1 });
    expect(result.exceptions[0]!.severity).toBe('WARNING');
    expect(result.rows[0]!.targetModelKey).toBe(MIGRATION_TARGET_KEYS.PARTY_BALANCE);
  });

  it('raises BALANCE_MISMATCH only when the declared balance actually differs', () => {
    const result = profileTable(excelCsvProfiler, table, {
      declaredPartyBalanceMinor: new Map([
        [naturalKey(MIGRATION_TARGET_KEYS.PARTY, 'Muller & Phipps'), BigInt(1_250_000)],
        [naturalKey(MIGRATION_TARGET_KEYS.PARTY, 'Unknown Traders'), BigInt(90_500)],
      ]),
    });

    expect(bucketCounts(result)).toEqual({ BALANCE_MISMATCH: 1 });
    expect(result.exceptions[0]!.rowIndex).toBe(1);
  });
});

describe('Bucket severity is a property of the bucket', () => {
  it('classifies every bucket, with PARTY_UNMATCHED the only warning', () => {
    expect(EXCEPTION_SEVERITY).toEqual({
      MISSING_BATCH: 'BLOCKING',
      MISSING_EXPIRY: 'BLOCKING',
      MISSING_MRP: 'BLOCKING',
      UNIT_AMBIGUOUS: 'BLOCKING',
      DUPLICATE_PRODUCT: 'BLOCKING',
      PARTY_UNMATCHED: 'WARNING',
      BALANCE_MISMATCH: 'BLOCKING',
      EXPIRED_STOCK: 'BLOCKING',
    });
  });
});

describe('Reading a raw cell never rounds, guesses, or substitutes', () => {
  it('reads money into exact minor units and refuses anything else', () => {
    expect(readMoneyMinor('Rs. 1,250.5')).toBe(BigInt(125050));
    expect(readMoneyMinor('845')).toBe(BigInt(84500));
    // Three decimals cannot be represented exactly; rounding would change a price.
    expect(readMoneyMinor('10.005')).toBeNull();
    expect(readMoneyMinor('abc')).toBeNull();
    expect(readMoneyMinor('-')).toBeNull();
  });

  it('refuses a fractional quantity instead of rounding it', () => {
    expect(readQuantity('1,200')).toBe(BigInt(1200));
    expect(readQuantity('12.00')).toBe(BigInt(12));
    expect(readQuantity('12.5')).toBeNull();
  });

  it('refuses an impossible date instead of rolling it over', () => {
    expect(readExpiryDate('2027-02-31')).toBeNull();
    expect(readExpiryDate('13/2027')).toBeNull();
    expect(readExpiryDate('sometime')).toBeNull();
  });

  it('refuses a pack label that names no countable unit', () => {
    expect(readPackFactor("1x20's")).toBe(BigInt(20));
    expect(readPackFactor('100ML')).toBe(BigInt(100));
    expect(readPackFactor('bottle')).toBeNull();
    expect(readPackFactor('0x10')).toBeNull();
  });
});

describe('Delimited text parsing', () => {
  it('detects the delimiter and honours RFC 4180 quoting', () => {
    const table = parseDelimitedText('Item,Supplier\n"Panadol, 500mg","Muller ""MP"" & Phipps"\n');

    expect(table.headers).toEqual(['Item', 'Supplier']);
    expect(table.rows).toEqual([['Panadol, 500mg', 'Muller "MP" & Phipps']]);
  });

  it('pads a short row rather than shifting its cells left', () => {
    const table = parseDelimitedText('Item,Batch No,Expiry\nPanadol,B1\n');

    expect(table.rows).toEqual([['Panadol', 'B1', '']]);
  });
});

describe('Quantity column meaning is chosen in the column mapping', () => {
  const table = () => parseDelimitedText('Product,Pack,Qty\nExample Tablet,30,29\nNo Pack,,5\n');
  it('keeps base units when explicitly chosen', () => {
    const { rows } = profileTable(excelCsvProfiler, table(), { quantityUnit: 'UNITS' });
    expect(rows[0]!.quantityCanonical).toBe(BigInt(29));
  });
  it('converts packs to units: 29 packs of 30 is 870', () => {
    const { rows, exceptions } = profileTable(excelCsvProfiler, table(), {
      quantityUnit: 'PACKS',
    });
    expect(rows[0]!.quantityCanonical).toBe(BigInt(870));
    // No pack factor: never assume 1; flagged instead.
    expect(rows[1]!.quantityCanonical).toBeNull();
    expect(exceptions.some((e) => e.rowIndex === 1 && e.bucket === 'UNIT_AMBIGUOUS')).toBe(true);
  });
});

describe('pack labels that are strengths, not counts', () => {
  it.each(['500mg', '30 g', '5%'])('does not multiply packs by %s', (label) => {
    const result = profileTable(
      excelCsvProfiler,
      parseDelimitedText(`Product,Pack,Qty\nExample,${label},2`),
      { quantityUnit: 'PACKS' }
    );
    expect(result.rows[0]!.quantityCanonical).toBeNull();
    expect(result.exceptions.some((e) => e.bucket === 'UNIT_AMBIGUOUS')).toBe(true);
  });
  it.each([
    ['10x10', 200],
    ['20 Tabs', 40],
    ['100ML', 200],
  ])('still converts countable pack %s', (label, units) => {
    const result = profileTable(
      excelCsvProfiler,
      parseDelimitedText(`Product,Pack,Qty\nExample,${label},2`),
      { quantityUnit: 'PACKS' }
    );
    expect(result.rows[0]!.quantityCanonical).toBe(BigInt(units));
  });
});

describe('mapped quantity column identity', () => {
  it('records the header of the mapped quantity column', () => {
    const result = profileTable(
      excelCsvProfiler,
      parseDelimitedText('Product,Pack,Qty\nExample,30,29'),
      { quantityUnit: 'PACKS' }
    );
    expect(result.quantityColumn).toBe('Qty');
  });
});

describe('unrecorded quantity mapping', () => {
  it('does not stage a raw count as units without a choice', () => {
    const result = profileTable(
      excelCsvProfiler,
      parseDelimitedText('Product,Pack,Qty\nExample,30,29')
    );
    expect(result.quantityUnit).toBeNull();
    expect(result.rows[0]!.quantityCanonical).toBeNull();
    expect(result.rows[0]!.rawPayload.__quantity_unit).toBeUndefined();
    expect(result.exceptions).toContainEqual(
      expect.objectContaining({
        bucket: 'UNIT_AMBIGUOUS',
        severity: 'BLOCKING',
        detail: expect.stringContaining('Choose whether quantity counts'),
      })
    );
  });
  it('does not accept quantity metadata supplied as a source column', () => {
    const result = profileTable(
      excelCsvProfiler,
      parseDelimitedText('Product,Pack,Qty,__quantity_unit\nExample,30,29,UNITS')
    );
    expect(result.rows[0]!.quantityCanonical).toBeNull();
    expect(result.rows[0]!.rawPayload.__quantity_unit).toBe('UNITS');
  });
  it('keeps an uploaded __quantity_unit column intact even with a recorded choice', () => {
    const result = profileTable(
      excelCsvProfiler,
      parseDelimitedText('Product,Pack,Qty,__quantity_unit\nExample,30,29,UNITS'),
      { quantityUnit: 'PACKS' }
    );
    expect(result.rows[0]!.quantityCanonical).toBe(BigInt(870));
    expect(result.rows[0]!.rawPayload.__quantity_unit).toBe('UNITS');
  });
});
