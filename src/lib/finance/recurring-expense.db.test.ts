import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { postDueRecurringExpenses } from './recurring-expense-posting';
import { workspaceMonthRange } from '@/lib/timezone';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

const ownerUrl = process.env.PHARMACY_DB_TEST_OWNER_URL;
const runtimeUrl = process.env.PHARMACY_DB_TEST_RUNTIME_URL;

async function checkRole(client: pg.Client) {
  const { rows } = await client.query(
    "SELECT current_setting('server_version_num')::int / 10000 AS major, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
  );
  expect(rows).toEqual([{ major: 16, rolsuper: false, rolbypassrls: false }]);
}

describe.skipIf(!ownerUrl || !runtimeUrl)('recurring expenses on PostgreSQL', () => {
  it('backfills the current civil day while preserving the bytes of every posted row', async () => {
    const owner = new pg.Client({ connectionString: ownerUrl });
    const schema = 'recurring_test_' + randomUUID().replaceAll('-', '');
    await owner.connect();
    try {
      await checkRole(owner);
      await owner.query(`CREATE SCHEMA ${schema}`);
      await owner.query(`SET search_path TO ${schema}, public`);
      await owner.query(`
        CREATE TABLE organizations (id text PRIMARY KEY, timezone text NOT NULL);
        CREATE TABLE recurring_expenses (id text PRIMARY KEY, "organizationId" text NOT NULL,
          "nextDueDate" timestamp(3) NOT NULL, UNIQUE ("organizationId", id));
        CREATE TABLE transactions (LIKE public.transactions INCLUDING DEFAULTS);
        INSERT INTO organizations VALUES ('east', 'Asia/Karachi'), ('west', 'America/New_York');
        INSERT INTO recurring_expenses VALUES
          ('local', 'east', '2026-01-30 19:00'), ('legacy', 'west', '2026-01-01'),
          ('drifted', 'west', '2026-03-28');
        INSERT INTO transactions (id, "organizationId", type, amount, description, date, "updatedAt")
          VALUES ('old', 'west', 'EXPENSE', 14.37, 'Previous charge', '2025-12-31', now());
      `);
      const snapshot = () =>
        owner.query('SELECT record_send(t) AS bytes FROM transactions t ORDER BY id');
      const before = await snapshot();
      const sql = await readFile(
        'prisma/migrations/20261126010000_recurring_expense_cycles/migration.sql',
        'utf8'
      );
      await owner.query(sql);
      // A later February due date must never replace the original January anchor.
      await owner.query(
        `UPDATE recurring_expenses SET "nextDueDate" = '2026-02-27 19:00' WHERE id = 'local'`
      );
      await owner.query(sql);
      expect((await snapshot()).rows).toEqual(before.rows);
      expect(
        (await owner.query('SELECT id, "billingDay" FROM recurring_expenses ORDER BY id')).rows
      ).toEqual([
        { id: 'drifted', billingDay: 28 },
        { id: 'legacy', billingDay: 1 },
        { id: 'local', billingDay: 31 },
      ]);
    } finally {
      await owner.query('ROLLBACK');
      await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await owner.end();
    }
  });

  it.each([
    ['America/New_York', '2027-01-01T05:00:00Z'],
    ['Asia/Karachi', '2026-12-31T19:00:00Z'],
    ['UTC', '2027-01-01T00:00:00Z'],
  ])(
    'two concurrent tenant transactions in %s post only once, in January',
    async (zone, midnight) => {
      const runtime = new pg.Client({ connectionString: runtimeUrl });
      const org = 'recurring_' + randomUUID();
      await runtime.connect();
      try {
        await checkRole(runtime);
        expect(process.env.DATABASE_URL === runtimeUrl).toBe(true);
        const key = await runtime.query(`SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conrelid=to_regclass('recurring_expense_postings') AND contype='p'`);
        expect(key.rows).toEqual([
          { definition: 'PRIMARY KEY ("organizationId", "recurringExpenseId", "dueDate")' },
        ]);
        const date = new Date('2027-01-01');
        const now = new Date(midnight);
        await runtime.query("SELECT set_config('app.current_organization_id', $1, false)", [org]);
        await runtime.query(
          `INSERT INTO organizations (id, slug, "legalName", "displayName", timezone, "updatedAt")
        VALUES ($1, $1, 'Synthetic org', 'Synthetic org', $2, now())`,
          [org, zone]
        );
        await runtime.query(
          `INSERT INTO recurring_expenses (id, name, amount, category, interval, "nextDueDate", "billingDay", "updatedAt")
        VALUES ($1, 'Synthetic charge', 12.37, 'SOFTWARE', 'monthly', $2, 1, now())`,
          [org, date]
        );

        const run = (at: Date) =>
          withTenantDb(org, (tx) => postDueRecurringExpenses(tx, org, zone, at));
        expect((await run(new Date(now.getTime() - 1))).posted).toBe(0);

        const pids = new Set<number>();
        let ready!: () => void;
        const bothConnected = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const runs = await Promise.all(
          [0, 1].map(() =>
            withTenantDb(org, async (tx) => {
              const [connection] = await tx.$queryRaw<
                { pid: number }[]
              >`SELECT pg_backend_pid() AS pid`;
              pids.add(connection!.pid);
              if (pids.size === 2) ready();
              await bothConnected;
              return postDueRecurringExpenses(tx, org, zone, now);
            })
          )
        );
        expect(pids.size).toBe(2);
        expect(runs.map((run) => run.posted).sort()).toEqual([0, 1]);
        await runtime.query('UPDATE recurring_expenses SET "nextDueDate" = $1 WHERE id = $2', [
          date,
          org,
        ]);
        expect((await run(now)).posted).toBe(0);
        expect(
          (
            await runtime.query(
              `SELECT amount::text, to_char(date,'YYYY-MM-DD HH24:MI') AS posted
        FROM transactions WHERE "organizationId"=$1`,
              [org]
            )
          ).rows
        ).toEqual([{ amount: '12.37', posted: midnight.slice(0, 16).replace('T', ' ') }]);
        const periodAmount = async (offset: number) => {
          const { from, to } = workspaceMonthRange(zone, now, offset);
          const result = await runtime.query(
            `SELECT COALESCE(sum(amount), 0)::text AS total FROM transactions
          WHERE "organizationId"=$1 AND date >= $2 AND date < $3`,
            [org, from, to]
          );
          return result.rows[0].total;
        };
        expect(await periodAmount(-1)).toBe('0');
        expect(await periodAmount(0)).toBe('12.37');
        expect(
          (
            await runtime.query(
              'SELECT "nextDueDate"::date::text AS due FROM recurring_expenses WHERE id=$1',
              [org]
            )
          ).rows
        ).toEqual([{ due: '2027-02-01' }]);
      } finally {
        await runtime.end();
      }
    }
  );
});
