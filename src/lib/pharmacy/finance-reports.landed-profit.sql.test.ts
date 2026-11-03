// @vitest-environment node
/** Isolated PostgreSQL/WASM fixtures. Set DEV77_PGLITE_MODULE to an installed
 * @electric-sql/pglite/dist/index.js; no application DB or persistent data is used. */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { landedProfit } from './finance-reports';

const modulePath = process.env.DEV77_PGLITE_MODULE;
const suite = modulePath ? describe : describe.skip;
interface MemoryPostgres {
  exec(sql: string): Promise<unknown>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  close(): Promise<void>;
}
let sql: MemoryPostgres;
const db = {
  $queryRaw: async (statement: Prisma.Sql) =>
    (await sql.query(statement.text, statement.values)).rows,
};
const scope = { organizationId: 'org-a', branchId: 'branch-a' };
const period = { from: new Date('2026-09-01T19:00:00Z'), to: new Date('2026-09-01T20:00:00Z') };
beforeAll(async () => {
  if (!modulePath) return;
  const { PGlite } = await import(modulePath);
  sql = new PGlite();
  await sql.exec(`CREATE TABLE finance_journal_entries (id text, "organizationId" text, "occurredAt" timestamp(3));
 CREATE TABLE finance_journal_lines ("entryId" text,"organizationId" text,"branchId" text,"accountCode" text,side text,"amountMinor" integer,"productId" text,"sourceLineId" text);
 CREATE TABLE pharmacy_sale_lines (id text,"organizationId" text,"branchId" text,"saleId" text);
 CREATE TABLE pharmacy_sales (id text,"organizationId" text,"branchId" text,"createdByUserId" text);
 CREATE TABLE pharmacy_medicines (id text,"organizationId" text,"productFamily" text);
 INSERT INTO pharmacy_medicines VALUES ('item-a','org-a','GENERAL'),('item-b','org-a','COSMETIC'),('item-a','org-other','PRIVATE');
 INSERT INTO pharmacy_sales VALUES ('sale-a','org-a','branch-a','staff-a'),('sale-b','org-a','branch-a','staff-b');
 INSERT INTO pharmacy_sale_lines VALUES ('line-a','org-a','branch-a','sale-a'),('line-b','org-a','branch-a','sale-b');`);
  let index = 0;
  async function post(
    organizationId: string,
    branch: string,
    at: string,
    revenue: number,
    discount: number,
    cogs: number,
    reversal = false,
    item = 'item-a',
    line = 'line-a'
  ) {
    const entry = `entry-${index++}`;
    await sql.query('INSERT INTO finance_journal_entries VALUES ($1,$2,$3)', [
      entry,
      organizationId,
      at,
    ]);
    for (const [account, amount, side] of [
      ['SALES_REVENUE', revenue, reversal ? 'DEBIT' : 'CREDIT'],
      ['SALES_DISCOUNT', discount, reversal ? 'CREDIT' : 'DEBIT'],
      ['COST_OF_GOODS_SOLD', cogs, reversal ? 'CREDIT' : 'DEBIT'],
    ]) {
      await sql.query('INSERT INTO finance_journal_lines VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
        entry,
        organizationId,
        branch,
        account,
        side,
        amount,
        item,
        line,
      ]);
    }
  }
  await post('org-a', 'branch-a', '2026-09-01 19:30:00', 1000, 100, 600);
  await post('org-a', 'branch-a', '2026-09-01 19:45:00', 100, 50, 100, true);
  await post('org-a', 'branch-a', '2026-09-01 19:00:00', 200, 0, 50, false, 'item-b', 'line-b');
  await post('org-other', 'branch-a', '2026-09-01 19:30:00', 9000, 0, 0);
  await post('org-a', 'branch-other', '2026-09-01 19:30:00', 8000, 0, 0);
  await post('org-a', 'branch-a', '2026-09-01 20:00:00', 7000, 0, 0);
  await post('org-a', 'branch-a', '2026-09-01 18:59:59.999', 6000, 0, 0);
}, 30000);
afterAll(async () => {
  if (sql) await sql.close();
});
suite('landed profit SQL fixtures', () => {
  it('reconciles item, category, PKT midnight and original sale staff including returns', async () => {
    const rows = await landedProfit(db as never, scope, period);
    expect(rows).toHaveLength(7);
    const profit = (dimension: string, key: string) =>
      rows.find((r) => r.dimension === dimension && r.key === key);
    expect(profit('item', 'item-a')).toMatchObject({
      revenueMinor: 900,
      discountMinor: 50,
      cogsMinor: 500,
      grossMarginMinor: 350,
    });
    expect(profit('item', 'item-b')).toMatchObject({ grossMarginMinor: 150 });
    expect(profit('category', 'GENERAL')).toMatchObject({ grossMarginMinor: 350 });
    expect(profit('category', 'COSMETIC')).toMatchObject({ grossMarginMinor: 150 });
    expect(profit('staff', 'staff-a')).toMatchObject({ grossMarginMinor: 350 });
    expect(profit('staff', 'staff-b')).toMatchObject({ grossMarginMinor: 150 });
    expect(profit('hour', '2026-09-02T00:00:00+05:00')).toMatchObject({
      revenueMinor: 1100,
      discountMinor: 50,
      cogsMinor: 550,
      grossMarginMinor: 500,
    });
  });
  it('keeps results independent of the PostgreSQL session timezone', async () => {
    const first = await landedProfit(db as never, scope, period);
    await sql.exec("SET TIME ZONE 'America/Los_Angeles'");
    expect(await landedProfit(db as never, scope, period)).toEqual(first);
  });
});
