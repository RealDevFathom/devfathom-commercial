// @vitest-environment node
// Apply repeat-purchasing.fixture.sql to a NEW migrated disposable DB first.
// PHARMACY_REPEAT_PURCHASING_TEST_DATABASE_URL (or TEST_DATABASE_URL fallback)
// must name its SELECT-only NOSUPERUSER/NOBYPASSRLS runtime.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { readRepeatPurchasing, summarizeRepeatPurchasing } from './repeat-purchasing';

const url =
  process.env.PHARMACY_REPEAT_PURCHASING_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const filters = {
  branchIds: ['b1', 'b2'],
  from: '2026-01-01',
  to: '2026-01-31',
  asOf: '2026-05-01T00:00:00Z',
};
const seen: { sql: string; rows: number | null }[] = [];
let db: PrismaClient;
let spy: ReturnType<typeof vi.spyOn>;
const scoped = <T>(org: string, run: (tx: ScopedDb) => Promise<T>) =>
  db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.current_organization_id', ${org}, true)`;
    // Mirror ScopedDb's reuse of the request transaction.
    const scopedTx = new Proxy(tx, {
      get(target, key) {
        if (key === '$transaction')
          return (fn: (inner: ScopedDb) => Promise<T>) => fn(scopedTx as ScopedDb);
        return Reflect.get(target, key);
      },
    });
    return run(scopedTx as ScopedDb);
  });

describe.skipIf(!url)('repeat purchasing: actual restricted PostgreSQL', () => {
  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    const original = pg.Client.prototype.query;
    spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (
      this: pg.Client,
      ...args: unknown[]
    ) {
      const result = Reflect.apply(original, this, args) as Promise<pg.QueryResult>;
      if (!result || typeof result.then !== 'function') return result;
      return result.then((row) => {
        const arg = args[0];
        const sql = typeof arg === 'string' ? arg : (arg as { text: string }).text;
        seen.push({ sql, rows: row.rowCount });
        return row;
      });
    } as typeof original);
    const roles = await db.$queryRaw<
      { rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean }[]
    >`
      SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user`;
    expect(roles).toEqual([
      { rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false },
    ]);
  });
  afterAll(async () => {
    if (process.env.PAPERCLIP_RUN_SCRATCH_DIR)
      writeFileSync(
        join(process.env.PAPERCLIP_RUN_SCRATCH_DIR, 'repeat-aggregate-queries.json'),
        JSON.stringify(seen, null, 2)
      );
    spy?.mockRestore();
    await db?.$disconnect();
  });
  it('enforces FORCE RLS and SELECT-only privileges on every reader table', async () => {
    const tables = await db.$queryRaw<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; write: boolean }[]
    >`
      SELECT relname, relrowsecurity, relforcerowsecurity,
        has_table_privilege(current_user, oid, 'INSERT,UPDATE,DELETE,TRUNCATE') AS write
      FROM pg_class WHERE relname IN ('pharmacy_sales','pharmacy_sale_lines','pharmacy_sale_returns','pharmacy_sale_return_lines','pharmacy_refunds')`;
    expect(tables).toHaveLength(5);
    expect(tables.every((t) => t.relrowsecurity && t.relforcerowsecurity && !t.write)).toBe(true);
    expect(await db.pharmacySale.count()).toBe(0);
    expect(await scoped('org_b', (tx) => tx.pharmacySale.count())).toBe(1);
  });
  it('returns three scalar rows despite 1,203 lines and 1,201 refunds/return lines/returns', async () => {
    const start = seen.length;
    const result = await scoped('org_a', (tx) => readRepeatPurchasing(tx, 'org_a', filters));
    const data = seen.slice(start).filter((q) => q.sql.includes('pharmacy_'));
    expect(data).toHaveLength(1);
    expect(data[0].rows).toBe(3);
    expect(data[0].sql).toContain('WITH originals AS MATERIALIZED');
    expect(result.completedReceipts).toBe(3);
    expect(result.anonymousReceipts).toBe(1);
    expect(result.enrolledCustomers).toBe(1);
    expect(result.horizons.map((h) => h.repeated)).toEqual([1, 1, 1]);
    expect(JSON.stringify(result)).not.toMatch(/customerId|medicine|patient|c1|a-line/);
  });
  it('preserves first observation beyond 10,000 lifetime receipts', async () => {
    expect(
      await scoped('org_a', (tx) => tx.pharmacySale.count({ where: { branchId: 'history' } }))
    ).toBe(10004);
    const result = await scoped('org_a', (tx) =>
      readRepeatPurchasing(tx, 'org_a', { ...filters, branchIds: ['history'] })
    );
    expect(result.firstObservedBeforeEnrollment).toBe(1);
    expect(result.enrolledCustomers).toBe(1);
    expect(result.completedReceipts).toBe(3);
    expect(result.earliestObservedAt).toBe('2025-01-01T00:01:00.000Z');
    expect(result.horizons.map((h) => h.repeated)).toEqual([1, 1, 1]);
  });
  it('excludes omitted branches and forged tenants, with honest empty aggregates', async () => {
    const single = await scoped('org_a', (tx) =>
      readRepeatPurchasing(tx, 'org_a', { ...filters, branchIds: ['b1'] })
    );
    expect(single.horizons[0].repeated).toBe(0);
    const foreign = await scoped('org_a', (tx) =>
      readRepeatPurchasing(tx, 'org_b', { ...filters, branchIds: ['b3'] })
    );
    expect(foreign).toEqual(
      summarizeRepeatPurchasing([], 'org_b', { ...filters, branchIds: ['b3'] })
    );
  });
  it('restores a stricter caller statement budget after success', async () => {
    await scoped('org_a', async (tx) => {
      await tx.$queryRaw`SELECT set_config('statement_timeout', '5000', true)`;
      await readRepeatPurchasing(tx, 'org_a', filters);
      expect(await tx.$queryRaw`SELECT current_setting('statement_timeout') AS timeout`).toEqual([
        { timeout: '5s' },
      ]);
    });
  });
  it.each([
    { asOf: '2026-01-09T00:00:00Z', to: '2026-01-09' },
    { asOf: '2026-01-30T23:59:59.999Z', to: '2026-01-30' },
    { asOf: '2026-01-31T00:00:00Z', to: '2026-01-31' },
    { asOf: '2026-03-02T00:00:00Z', to: '2026-01-31' },
    { asOf: '2026-04-01T00:00:00Z', to: '2026-01-31' },
    { asOf: '2026-05-01T00:00:00Z', to: '2026-01-31' },
    { asOf: '2026-05-03T00:00:00Z', to: '2026-01-31' },
  ])('matches reference reversal/chronology/coverage semantics at $asOf', async (cutoff) => {
    const input = { ...filters, ...cutoff, branchIds: ['semantics'] };
    // Small, fixed oracle fixture only; production reader never fetches these payloads.
    const receipts = await scoped('org_a', (tx) =>
      tx.pharmacySale.findMany({
        where: { organizationId: 'org_a', branchId: 'semantics' },
        include: {
          lines: { include: { returnLines: { include: { saleReturn: true } } } },
          refunds: true,
        },
      })
    );
    expect(receipts).toHaveLength(34);
    const expected = summarizeRepeatPurchasing(receipts, 'org_a', input);
    const start = seen.length;
    const result = await scoped('org_a', (tx) => readRepeatPurchasing(tx, 'org_a', input));
    expect(result).toEqual(expected);
    expect(
      seen
        .slice(start)
        .filter((q) => q.sql.includes('pharmacy_'))
        .map((q) => q.rows)
    ).toEqual([3]);
  });
  it('cancels work exceeding a stricter database budget without partial rates', async () => {
    await expect(
      scoped('org_a', async (tx) => {
        await tx.$queryRaw`SELECT set_config('statement_timeout', '1', true)`;
        return readRepeatPurchasing(tx, 'org_a', { ...filters, branchIds: ['history'] });
      })
    ).rejects.toThrow(/statement timeout/);
  });
});
