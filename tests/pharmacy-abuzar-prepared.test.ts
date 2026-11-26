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

it('stages native source identities for review with original catalogue price and shelf evidence', async () => {
  const { profileAbuzarProducts } = await import('@/lib/pharmacy/migration/abuzar-catalogue');
  const data = await readPreparedExport(await syntheticExport());
  const profile = profileAbuzarProducts(data.tables.products);
  expect(profile.rows[0]).toMatchObject({
    sourceKey: 'abuzar-item:A',
    mrpMinor: BigInt(4500),
    costMinor: BigInt(2000),
    packFactor: BigInt(10),
    rawPayload: { Shelf: 'S1', LegacyCode: '10', Class: 'NARCOTICS' },
  });
  expect(profile.rows[1]).toMatchObject({ sourceKey: 'abuzar-item:B', mrpMinor: null });
});

it('brings agreed credit and debt into a native khata balance without simulating a sale or repayment', async () => {
  const { readKhataBalance } = await import('@/lib/pharmacy/family-khata');
  const db = {
    pharmacyKhataEvent: {
      groupBy: async () => [
        { kind: 'OPENING_DEBIT', _sum: { amountMinor: 450 } },
        { kind: 'OPENING_CREDIT', _sum: { amountMinor: 125 } },
      ],
    },
  };
  expect(
    await readKhataBalance(
      db as never,
      { organizationId: 'a', branchId: 'b', actorId: 'c' },
      'family'
    )
  ).toBe(325);
});

it('reconciles each source row against persisted opening quantities, values and party balances', async () => {
  const { reconciliation } = await import('@/lib/pharmacy/migration/abuzar-reconciliation');
  const data = await readPreparedExport(await syntheticExport());
  const result = reconciliation(data, 'B1', {
    products: new Set(['A', 'B']),
    stock: new Map([['S1', { units: 22, value: '4400' }]]),
    balances: new Map([['K1', '1250']]),
  });
  expect(result.actual).toEqual({
    products: 2,
    stockUnits: '22',
    stockValueMinor: '4400',
    customerBalanceMinor: '1250',
    supplierBalanceMinor: '0',
  });
  expect(result.differences).toContainEqual({
    table: 'stock',
    row: 2,
    expectedUnits: '23',
    actualUnits: '22',
    expectedValueMinor: '4600',
    actualValueMinor: '4400',
  });
});

it('lists persisted source identities omitted from a later export', async () => {
  const { reconciliation } = await import('@/lib/pharmacy/migration/abuzar-reconciliation');
  const data = await readPreparedExport(await syntheticExport());
  const result = reconciliation(data, 'B1', {
    products: new Set(['A', 'B', 'C']),
    stock: new Map([['S9', { units: 5, value: '1000' }]]),
    balances: new Map(),
  });
  expect(result.actual.products).toBe(3);
  expect(result.actual.stockUnits).toBe('5');
  expect(result.differences).toContainEqual(
    expect.objectContaining({ table: 'stock', sourceId: 'S9' })
  );
});

it('packages long history into numbered uploads without repeating operational rows or losing references', async () => {
  const { packageForUpload } = await import('../tools/abuzar-import/packages');
  const data = await readPreparedExport(await syntheticExport());
  const template = data.tables.history[0]!;
  data.tables.history = Array.from({ length: 80 }, (_, i) => ({
    ...template,
    RowID: 'source-' + i,
    DocumentNo: 'doc-' + i,
  }));
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const parent = await mkdtemp(join(tmpdir(), 'synthetic-abuzar-parts-'));
  const result = await packageForUpload(data, parent, 17);
  const primary = await readPreparedExport(join(result.directory, 'opening'));
  expect(primary.tables.stock).toEqual(data.tables.stock);
  expect(primary.tables.history).toEqual([]);
  const history = [];
  for (const name of result.historyPackages) {
    const part = await readPreparedExport(join(result.directory, name));
    expect(part.tables.products).toEqual([]);
    expect(part.manifest.sourceFingerprint).toBe(data.manifest.sourceFingerprint);
    history.push(...part.tables.history);
  }
  expect(result.historyPackages.length).toBeGreaterThan(1);
  expect(history).toEqual(data.tables.history);
});
