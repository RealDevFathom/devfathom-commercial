/**
 * #716 — the wizard's DevFathom catalogue adapter: catalogue rows profile without
 * invented lot exceptions, while every other sheet is refused so stock sheets
 * keep their MIG-02 batch/expiry/MRP checks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { exportRowsToCsv, PHARMACY_EXPORT_FILES, type ExportRow } from '../data-export-format';
import { devfathomCatalogueProfiler } from './devfathom-catalogue-profiler';
import { excelCsvProfiler } from './excel-csv-profiler';
import { profileTable, UnrecognisedSourceError } from './profiler';
import { parseDelimitedText } from './source-values';

const medicine = {
  medicine_code: 'm-1', product: 'Panadol 500mg', product_family: 'PHARMACEUTICAL',
  rx: false, otc: true, restricted: false, controlled: false, high_alert: false,
  lasa: false, cold_chain: false, saleable: true,
};

function catalogue(rows: ExportRow[]) {
  return parseDelimitedText(exportRowsToCsv(PHARMACY_EXPORT_FILES.medicines, rows));
}

describe('DevFathom catalogue adapter', () => {
  it('profiles catalogue rows one-for-one without batch, expiry or MRP exceptions', () => {
    const table = catalogue([
      { ...medicine, code: 'r-1', presentation_code: 'p-1', presentation: 'Tablet', pack: 10, pack_level: 'STRIP', barcode: '111' },
      { ...medicine, code: 'r-2', presentation_code: 'p-1', presentation: 'Tablet', pack: 200, pack_level: 'BOX', barcode: '222' },
      // Same name, different manufacturer and no pack: legitimate in a catalogue.
      { ...medicine, code: 'r-3', medicine_code: 'm-2', manufacturer: 'Other' },
      { ...medicine, code: 'r-4', medicine_code: 'm-3', manufacturer: 'Third' },
    ]);
    const profiled = profileTable(devfathomCatalogueProfiler, table);
    expect(profiled.rows.map((row) => row.sourceKey)).toEqual(['r-1', 'r-2', 'r-3', 'r-4']);
    expect(profiled.rows.map((row) => row.packFactor)).toEqual([BigInt(10), BigInt(200), null, null]);
    expect(profiled.exceptions).toEqual([]);
    // The ordinary stock profiler still demands lot evidence for the same file.
    const buckets = new Set(profileTable(excelCsvProfiler, table).exceptions.map((e) => e.bucket));
    expect([...buckets]).toEqual(expect.arrayContaining(['MISSING_BATCH', 'MISSING_EXPIRY', 'MISSING_MRP']));
  });

  it('still flags a barcode shared by two catalogue rows', () => {
    const table = catalogue([
      { ...medicine, code: 'r-1', presentation_code: 'p-1', presentation: 'Tablet', pack: 10, pack_level: 'STRIP', barcode: '111' },
      { ...medicine, code: 'r-2', medicine_code: 'm-2', presentation_code: 'p-2', presentation: 'Syrup', pack: 1, pack_level: 'BOTTLE', barcode: '111' },
    ]);
    expect(profileTable(devfathomCatalogueProfiler, table).exceptions).toEqual([
      expect.objectContaining({ rowIndex: 1, bucket: 'DUPLICATE_PRODUCT', severity: 'BLOCKING' }),
    ]);
  });

  it('refuses any sheet that is not an unmodified medicines.csv header row', () => {
    const stock = parseDelimitedText(
      readFileSync(join(process.cwd(), 'src/lib/pharmacy/migration/fixtures/excel-missing-fields.csv'), 'utf8')
    );
    expect(() => profileTable(devfathomCatalogueProfiler, stock)).toThrow(UnrecognisedSourceError);
    expect(() =>
      profileTable(devfathomCatalogueProfiler, parseDelimitedText('code,product,pack\nA,Panadol,10'))
    ).toThrow(UnrecognisedSourceError);
  });
});
