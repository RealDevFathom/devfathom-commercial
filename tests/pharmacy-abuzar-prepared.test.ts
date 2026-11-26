import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { syntheticExport } from './fixtures/abuzar-prepared';
import { describe, expect, it } from 'vitest';
import { readPreparedExport, sourceReport } from '../tools/abuzar-import/prepared';

describe('prepared Abuzar export', () => {
  it('reads the prepared files, reports each refused stock row and keeps private values out of the report', async () => {
    const data = await readPreparedExport(await syntheticExport());
    const report = sourceReport(data);
    expect(report.totals).toEqual({
      products: 2,
      stockUnits: '23',
      stockValueMinor: '4600',
      customerBalanceMinor: '1250',
      supplierBalanceMinor: '0',
    });
    expect(report.issues).toEqual(
      expect.arrayContaining([
        { table: 'products', row: 3, reason: 'missing selling price' },
        { table: 'stock', row: 2, reason: 'unverified batch' },
        { table: 'stock', row: 3, reason: 'negative quantity' },
        { table: 'stock', row: 4, reason: 'fractional quantity' },
      ])
    );
    expect(report.counts.history).toBe(1);
    expect(JSON.stringify(report)).not.toMatch(/Synthetic Private|03001234567/);
    expect(sourceReport(data)).toEqual(report);
  });
  it('refuses any file that differs from its manifest before returning records', async () => {
    const dir = await syntheticExport();
    await writeFile(join(dir, 'history.csv'), 'changed');
    await expect(readPreparedExport(dir)).rejects.toThrow(/checksum.*history/i);
  });
});
