import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { csvRecords } from '../../src/lib/pharmacy/migration/starter-reference';
import { readMoneyMinor } from '../../src/lib/pharmacy/migration/source-values';

export const columns = {
  products: [
    'ICode',
    'CustomICode',
    'Name',
    'PackUnits',
    'Class',
    'Shelf',
    'SalePrice',
    'PurPrice',
    'Active',
  ],
  parties: ['RowID', 'Kind', 'Name', 'Phone'],
  stock: ['RowID', 'Branch', 'ICode', 'Quantity', 'Batch', 'Expiry'],
  balances: ['RowID', 'Branch', 'PartyID', 'Amount'],
  history: [
    'RowID',
    'Branch',
    'Kind',
    'DocumentNo',
    'Date',
    'ICode',
    'Quantity',
    'UnitPrice',
    'Amount',
  ],
} as const;
export type Table = keyof typeof columns;
export type Row<T extends Table> = Record<(typeof columns)[T][number], string>;
export type Tables = { [T in Table]: Row<T>[] };
export const tableNames = Object.keys(columns) as Table[];
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const tally = z.strictObject({ rows: z.number().int().min(0).max(500000), sha256: hash });
const manifestSchema = z.strictObject({
  version: z.literal('abuzar/2'),
  sourceFingerprint: hash,
  tables: z.strictObject({
    products: tally,
    parties: tally,
    stock: tally,
    balances: tally,
    history: tally,
  }),
});
export type Prepared = {
  manifest: z.infer<typeof manifestSchema>;
  tables: Tables;
  checksum: string;
};
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

async function bytes(dir: string, name: string, max: number) {
  const file = await open(
    join(dir, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > max)
      throw new Error('Expected a regular prepared file within the size limit.');
    const result = Buffer.alloc(stat.size);
    let read = 0;
    while (read < result.length) {
      const { bytesRead } = await file.read(result, read, result.length - read, read);
      if (!bytesRead) throw new Error('Prepared file changed during read.');
      read += bytesRead;
    }
    if ((await file.stat()).size !== stat.size)
      throw new Error('Prepared file changed during read.');
    return result;
  } finally {
    await file.close();
  }
}
const decode = (buf: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(buf);

export async function readPreparedExport(dir: string): Promise<Prepared> {
  return parsePreparedExport((name, limit) => bytes(dir, name, limit));
}

export async function parsePreparedExport(
  read: (name: string, limit: number) => Promise<Buffer>
): Promise<Prepared> {
  const manifest = manifestSchema.parse(JSON.parse(decode(await read('manifest.json', 16384))));
  const tables = {} as Tables;
  let budget = 96 * 1024 * 1024;
  for (const name of tableNames) {
    const file = await read(name + '.csv', Math.min(budget, 64 * 1024 * 1024));
    budget -= file.length;
    if (sha256(file) !== manifest.tables[name].sha256)
      throw new Error('Checksum mismatch for ' + name);
    const [header, ...records] = csvRecords(decode(file));
    if (!header || JSON.stringify(header) !== JSON.stringify(columns[name]))
      throw new Error('Unexpected columns in ' + name);
    if (records.length !== manifest.tables[name].rows)
      throw new Error('Row count mismatch for ' + name);
    const ids = new Set<string>();
    const rows = records.map((cells, index) => {
      if (cells.length !== header.length || cells.some((c) => c.length > 512 || c.includes('\0')))
        throw new Error('Invalid cells in ' + name + ' row ' + (index + 2));
      const id = cells[0]?.trim();
      if (!id || ids.has(id))
        throw new Error('Missing or repeated source identity in ' + name + ' row ' + (index + 2));
      ids.add(id);
      return Object.fromEntries(header.map((key, i) => [key, cells[i]!.trim()]));
    });
    Object.assign(tables, { [name]: rows });
  }
  return { manifest, tables, checksum: sha256(JSON.stringify(manifest)) };
}

export function amountMinor(raw: string) {
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const value = readMoneyMinor(raw.replace(/^-/, ''));
  return value === null ? null : raw.startsWith('-') ? -value : value;
}
export function packUnits(raw: string) {
  const value = Number(raw);
  return /^\d+$/.test(raw) && Number.isSafeInteger(value) && value > 0 && value <= 2147483647
    ? value
    : null;
}
export function unitMinor(raw: string, pack: number | null) {
  const minor = amountMinor(raw);
  if (!pack || minor === null || minor < 0n || minor > 2147483647n || minor % BigInt(pack) !== 0n)
    return null;
  return minor / BigInt(pack);
}
export function unverifiedBatch(row: Row<'stock'>) {
  return !row.Batch || row.Batch === '.' || !row.Expiry || row.Expiry === '2028-01-01';
}
export function stockReason(row: Row<'stock'>, product: Row<'products'> | undefined) {
  if (!product) return 'unknown product';
  if (/^-[\d.]+$/.test(row.Quantity)) return 'negative quantity';
  if (/^\d+\.\d*[1-9]\d*$/.test(row.Quantity)) return 'fractional quantity';
  if (!/^\d+(?:\.0+)?$/.test(row.Quantity) || Number(row.Quantity) > 2147483647)
    return 'invalid quantity';
  if (unitMinor(product.PurPrice, packUnits(product.PackUnits)) === null)
    return 'missing or inexact unit cost';
  return null;
}
export function sourceReport({ manifest, tables, checksum }: Prepared) {
  const issues: { table: Table; row: number; reason: string }[] = [];
  const products = new Map(tables.products.map((p) => [p.ICode, p]));
  const parties = new Map(tables.parties.map((p) => [p.RowID, p]));
  let stockUnits = 0n,
    stockValueMinor = 0n,
    customerBalanceMinor = 0n,
    supplierBalanceMinor = 0n;
  tables.products.forEach((p, i) => {
    const pack = packUnits(p.PackUnits);
    if (!pack) issues.push({ table: 'products', row: i + 2, reason: 'invalid pack size' });
    if (!p.SalePrice)
      issues.push({ table: 'products', row: i + 2, reason: 'missing selling price' });
    else if (unitMinor(p.SalePrice, pack) === null)
      issues.push({
        table: 'products',
        row: i + 2,
        reason: 'invalid or inexact unit selling price',
      });
  });
  tables.stock.forEach((s, i) => {
    const product = products.get(s.ICode);
    const reason = stockReason(s, product);
    if (reason) {
      issues.push({ table: 'stock', row: i + 2, reason });
      return;
    }
    if (unverifiedBatch(s)) issues.push({ table: 'stock', row: i + 2, reason: 'unverified batch' });
    const units = BigInt(Number(s.Quantity));
    stockUnits += units;
    stockValueMinor += units * unitMinor(product!.PurPrice, packUnits(product!.PackUnits))!;
  });
  tables.balances.forEach((b, i) => {
    const party = parties.get(b.PartyID);
    const amount = amountMinor(b.Amount);
    if (!party || !['customer', 'supplier'].includes(party.Kind) || amount === null) {
      issues.push({ table: 'balances', row: i + 2, reason: 'unknown party or invalid balance' });
      return;
    }
    if (party.Kind === 'customer') customerBalanceMinor += amount;
    else supplierBalanceMinor += amount;
  });
  return {
    version: manifest.version,
    checksum,
    counts: Object.fromEntries(tableNames.map((t) => [t, tables[t].length])),
    totals: {
      products: products.size,
      stockUnits: String(stockUnits),
      stockValueMinor: String(stockValueMinor),
      customerBalanceMinor: String(customerBalanceMinor),
      supplierBalanceMinor: String(supplierBalanceMinor),
    },
    issues,
  };
}
