/**
 * DEV-851 — a pharmacy's whole legacy product catalogue (the pilot export held
 * 18,933 products) can be staged through the migration import tool.
 *
 * Everything here is SYNTHETIC. The checked-in fixture and the generated
 * catalogue use the legacy export's headers (Name, aliasname, PackUnits,
 * saleprice, purprice, QTY, ...) with invented products; no customer file is in
 * the repository.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { excelCsvProfiler } from './excel-csv-profiler';
import { parseOwnerUpload } from './owner-import-upload';
import { profileTable } from './profiler';
import { readMoneyMinor, readPackFactor } from './source-values';
import {
  STAGING_MAX_FILE_BYTES,
  STAGING_MAX_ROWS,
  STAGING_MAX_UPLOAD_BYTES,
  stagingUploadInput,
} from './staging-input';
import { parseStagingUpload, stagingSourceBytes } from './staging-upload';
import { encodeStagingFile } from '@/components/pharmacy/staging-file-encoding';
import { syntheticLegacyCatalogue } from './fixtures/synthetic-legacy-catalogue';

const FIXTURE = readFileSync(
  join(process.cwd(), 'src/lib/pharmacy/migration/fixtures/legacy-catalogue-export-synthetic.csv')
);
describe('legacy catalogue export headers', () => {
  it('maps Name, PackUnits, saleprice, purprice and QTY without manual picking', async () => {
    const table = await parseStagingUpload('legacy.csv', FIXTURE);

    expect(excelCsvProfiler.resolveColumns(table)).toEqual({
      product: 0,
      pack: 3,
      mrp: 4,
      cost: 5,
      quantity: 6,
    });
  });

  it('reads whole counts and prices written with four zero decimals, never rounding', () => {
    expect(readPackFactor('10.0000')).toBe(BigInt(10));
    expect(readPackFactor('10.5000')).toBeNull();
    expect(readMoneyMinor('250.0000')).toBe(BigInt(25000));
    expect(readMoneyMinor('212.5000')).toBe(BigInt(21250));
    expect(readMoneyMinor('10.0050')).toBeNull();
    expect(readMoneyMinor('10.005')).toBeNull();
  });

  it('stages products with pack sizes, prices and legacy codes kept as evidence', async () => {
    const table = await parseStagingUpload('legacy.csv', FIXTURE);
    const result = profileTable(excelCsvProfiler, table, { quantityUnit: 'PACKS' });

    expect(
      result.rows.map((row) => [row.productName, row.packFactor, row.mrpMinor, row.costMinor])
    ).toEqual([
      ['SYNTH ALPHA TAB 500MG', BigInt(10), BigInt(25000), BigInt(21250)],
      ['SYNTH BETA SYRUP 120ML', BigInt(1), BigInt(14550), BigInt(12000)],
      ['SYNTH GAMMA CAP 20MG', BigInt(14), null, BigInt(30125)],
      ['SYNTH DELTA DROPS 10ML', BigInt(1), BigInt(9900), BigInt(8000)],
      ['SYNTH EPSILON TAB 5MG', BigInt(30), BigInt(61000), BigInt(54000)],
      ['SYNTH ALPHA TAB 500MG', BigInt(10), BigInt(25000), BigInt(21250)],
    ]);
    expect(result.rows.map((row) => row.rawPayload.aliasname)).toEqual([
      'LC-00001',
      'LC-00002',
      'LC-00003',
      '',
      'LC-00005',
      'LC-00006',
    ]);
    // A missing sale price is an exception, never a default.
    expect(
      result.exceptions.filter((e) => e.bucket === 'MISSING_MRP').map((e) => e.rowIndex)
    ).toEqual([2]);
    // The repeated product is reported for review, not merged or dropped.
    expect(
      result.exceptions.filter((e) => e.bucket === 'DUPLICATE_PRODUCT').map((e) => e.rowIndex)
    ).toEqual([5]);
  });
});

describe('catalogue-sized staging upload', () => {
  const catalogue = Buffer.from(syntheticLegacyCatalogue(18_933));

  it('accepts the 18,933-row pilot size that the opening-stock limits refuse', async () => {
    await expect(parseOwnerUpload('legacy.csv', catalogue)).rejects.toThrow();

    const table = await parseStagingUpload('legacy.csv', catalogue);
    expect(table.rows).toHaveLength(18_933);
    const result = profileTable(excelCsvProfiler, table, { quantityUnit: 'PACKS' });
    expect(result.rows).toHaveLength(18_933);
    expect(result.rows.every((row) => row.productName && row.packFactor && row.mrpMinor)).toBe(
      true
    );
  });

  it('fits one request once compressed, and restores the exact original bytes', async () => {
    const encoded = await encodeStagingFile(new Uint8Array(catalogue));
    expect(encoded?.encoding).toBe('gzip');
    expect(Buffer.from(encoded!.content, 'base64').length).toBeLessThanOrEqual(
      STAGING_MAX_UPLOAD_BYTES
    );
    expect(
      stagingUploadInput.parse({ ...encoded, fileName: 'legacy.csv', branchId: 'b' })
    ).toBeTruthy();
    expect(stagingSourceBytes(encoded!).equals(catalogue)).toBe(true);
    expect(gunzipSync(Buffer.from(encoded!.content, 'base64')).equals(catalogue)).toBe(true);
  });

  it('refuses more rows than one staged batch holds', async () => {
    const tooMany = Buffer.from(syntheticLegacyCatalogue(STAGING_MAX_ROWS + 1));
    await expect(parseStagingUpload('legacy.csv', tooMany)).rejects.toThrow(
      `Use at most ${STAGING_MAX_ROWS} data rows per file.`
    );
  });

  it('bounds decompression, so a small upload cannot expand past the file limit', () => {
    const bomb = gzipSync(Buffer.alloc(STAGING_MAX_FILE_BYTES + 1, 0x61));
    expect(bomb.length).toBeLessThan(STAGING_MAX_UPLOAD_BYTES);
    expect(() =>
      stagingSourceBytes({ content: bomb.toString('base64'), encoding: 'gzip' })
    ).toThrow('8 MiB');
  });

  it('refuses a damaged compressed upload', () => {
    expect(() =>
      stagingSourceBytes({ content: Buffer.from('not gzip').toString('base64'), encoding: 'gzip' })
    ).toThrow('damaged');
  });

  it('keeps an uncompressed upload as sent', () => {
    expect(stagingSourceBytes({ content: FIXTURE.toString('base64') }).equals(FIXTURE)).toBe(true);
  });
});
