/**
 * #716 — the wizard's DevFathom stock-lots adapter: ordinary multi-lot stock from
 * an owner export re-imports without blocking DUPLICATE_PRODUCT exceptions, while
 * lot and location identity and every MIG-02 stock check are preserved.
 */
import { describe, expect, it } from 'vitest';

import { exportRowsToCsv, PHARMACY_EXPORT_FILES, type ExportRow } from '../data-export-format';
import { devfathomStockLotsProfiler, stockLotIdentity } from './devfathom-stock-lots-profiler';
import { excelCsvProfiler } from './excel-csv-profiler';
import { profileTable, UnrecognisedSourceError } from './profiler';
import { parseDelimitedText } from './source-values';

const lot = {
  product: 'Panadol 500mg',
  pack: 10,
  expiry: '2027-06-30',
  cost: '1.50',
  mrp: '25.00',
  supplier: 'Muller & Phipps',
  branch_code: 'MAIN',
  batch_state: 'ACTIVE',
  received_at: '2026-01-05T09:00:00.000Z',
  medicine_code: 'med-1',
};

function row(lotCode: string, batch: string, location: string, disposition: string, quantity: number): ExportRow {
  return {
    ...lot,
    code: `${lotCode}:${location}:${disposition}`,
    batch,
    quantity,
    sealed_packs: Math.floor(quantity / 10),
    loose_units: quantity % 10,
    location_code: location,
    location_name: location,
    disposition,
    lot_code: lotCode,
  };
}

function stockLots(rows: ExportRow[]) {
  return parseDelimitedText(exportRowsToCsv(PHARMACY_EXPORT_FILES.stockLots, rows));
}

describe('DevFathom stock-lots adapter', () => {
  it('profiles several lots, locations and dispositions of one product without duplicates', () => {
    const table = stockLots([
      row('lot-1', 'B1', 'SHELF-A', 'AVAILABLE', 40),
      row('lot-1', 'B1', 'SHELF-B', 'AVAILABLE', 20),
      row('lot-1', 'B1', 'SHELF-A', 'QUARANTINE', 5),
      row('lot-2', 'B2', 'SHELF-A', 'AVAILABLE', 30),
    ]);
    const profiled = profileTable(devfathomStockLotsProfiler, table);
    expect(profiled.exceptions.filter((e) => e.bucket === 'DUPLICATE_PRODUCT')).toEqual([]);
    expect(profiled.exceptions).toEqual([]);
    // Each migration row keeps its exported lot and location identity.
    expect(profiled.rows.map((r) => r.sourceKey)).toEqual([
      'lot-1:SHELF-A:AVAILABLE',
      'lot-1:SHELF-B:AVAILABLE',
      'lot-1:SHELF-A:QUARANTINE',
      'lot-2:SHELF-A:AVAILABLE',
    ]);
    expect(profiled.rows.map(stockLotIdentity)).toEqual([
      { lotCode: 'lot-1', locationCode: 'SHELF-A', disposition: 'AVAILABLE' },
      { lotCode: 'lot-1', locationCode: 'SHELF-B', disposition: 'AVAILABLE' },
      { lotCode: 'lot-1', locationCode: 'SHELF-A', disposition: 'QUARANTINE' },
      { lotCode: 'lot-2', locationCode: 'SHELF-A', disposition: 'AVAILABLE' },
    ]);
    expect(profiled.rows.map((r) => r.batchNumber)).toEqual(['B1', 'B1', 'B1', 'B2']);
    expect(profiled.rows.map((r) => r.quantityCanonical)).toEqual([
      BigInt(40),
      BigInt(20),
      BigInt(5),
      BigInt(30),
    ]);

    // The generic Excel/CSV profiler blocks the same file on product + pack.
    const generic = profileTable(excelCsvProfiler, table).exceptions;
    expect(generic.filter((e) => e.bucket === 'DUPLICATE_PRODUCT')).toHaveLength(3);
    expect(generic.every((e) => e.severity === 'BLOCKING')).toBe(true);
  });

  it('still flags two rows for the same lot, location and disposition', () => {
    const table = stockLots([
      row('lot-1', 'B1', 'SHELF-A', 'AVAILABLE', 40),
      { ...row('lot-1', 'B1', 'SHELF-A', 'AVAILABLE', 40), code: 'copied-row' },
    ]);
    expect(profileTable(devfathomStockLotsProfiler, table).exceptions).toEqual([
      expect.objectContaining({ rowIndex: 1, bucket: 'DUPLICATE_PRODUCT', severity: 'BLOCKING' }),
    ]);
  });

  it('keeps the MIG-02 lot checks: a row without batch or expiry is still an exception', () => {
    const table = stockLots([{ ...row('lot-1', '', 'SHELF-A', 'AVAILABLE', 40), expiry: null }]);
    const buckets = profileTable(devfathomStockLotsProfiler, table).exceptions.map((e) => e.bucket);
    expect(buckets).toEqual(expect.arrayContaining(['MISSING_BATCH', 'MISSING_EXPIRY']));
  });

  it('refuses any sheet that is not an unmodified stock-lots.csv header row', () => {
    expect(() =>
      profileTable(
        devfathomStockLotsProfiler,
        parseDelimitedText('code,product,pack,batch,expiry,mrp,quantity\nA,Panadol,10,B1,2027-01-01,25,10')
      )
    ).toThrow(UnrecognisedSourceError);
    const medicines = parseDelimitedText(exportRowsToCsv(PHARMACY_EXPORT_FILES.medicines, []));
    expect(() => profileTable(devfathomStockLotsProfiler, medicines)).toThrow(UnrecognisedSourceError);
  });
});
