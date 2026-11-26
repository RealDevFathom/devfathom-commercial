// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPreparedExport, sourceReport } from '../tools/abuzar-import/prepared';

async function syntheticExport() {
  const dir = await mkdtemp(join(tmpdir(), 'abuzar-synthetic-'));
  const tables = {
    products:
      'ICode,CustomICode,Name,PackUnits,Class,Shelf,SalePrice,PurPrice,Active\nA,10,Fixture A,10,NARCOTICS,S1,45.00,20.00,1\nB,11,Fixture B,5,,,,,1\n',
    parties: 'RowID,Kind,Name,Phone\nP1,customer,Synthetic Private,03001234567\n',
    stock:
      'RowID,Branch,ICode,Quantity,Batch,Expiry\nS1,B1,A,23,.,2028-01-01\nS2,B1,A,-2,,\nS3,B1,A,1.5,,\n',
    balances: 'RowID,Branch,PartyID,Amount\nK1,B1,P1,12.50\n',
    history:
      'RowID,Branch,Kind,DocumentNo,Date,ICode,Quantity,UnitPrice,Amount\nH1,B1,sale,123,2025-10-15,A,2,4.50,9.00\n',
  };
  const manifest = {
    version: 'abuzar/2',
    sourceFingerprint: 'a'.repeat(64),
    tables: Object.fromEntries(
      Object.entries(tables).map(([name, csv]) => [
        name,
        {
          rows: csv.trimEnd().split('\n').length - 1,
          sha256: createHash('sha256').update(csv).digest('hex'),
        },
      ])
    ),
  };
  for (const [name, csv] of Object.entries(tables)) await writeFile(join(dir, name + '.csv'), csv);
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}
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
