// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe.sequential : describe.skip;
const orgs = [randomUUID(), randomUUID()];
const tables = [
  'stored_value_entries',
  'stored_value_journals',
  'pharmacy_wallet_audits',
  'pharmacy_wallet_cnic_failures',
] as const;

async function transaction<T>(
  org: string | null,
  platform: boolean,
  purge: string | null,
  work: (db: Client) => Promise<T>
) {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query(
      `SELECT set_config('app.current_organization_id',$1,true),
      set_config('app.is_platform_admin',$2,true), set_config('app.purging_organization_id',$3,true)`,
      [org ?? '', String(platform), purge ?? '']
    );
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    await db.end();
  }
}

suite('migrated wallet statement RLS and append-only purge boundaries', () => {
  beforeAll(async () => {
    await transaction(null, false, null, async (db) => {
      const {
        rows: [role],
      } = await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user');
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      const { rows } = await db.query(
        `SELECT reloptions FROM pg_class WHERE oid='stored_value_customer_statements'::regclass`
      );
      expect(rows[0].reloptions).toContain('security_invoker=true');
    });
    for (const org of orgs)
      await transaction(org, false, null, async (db) => {
        const accounts = [randomUUID(), randomUUID()];
        const journal = randomUUID();
        await db.query(
          `INSERT INTO stored_value_accounts (id,"organizationId",kind,"updatedAt") VALUES ($1,$3,'CUSTOMER_LIABILITY',now()),($2,$3,'CASH_CLEARING',now())`,
          [...accounts, org]
        );
        await db.query(
          `INSERT INTO stored_value_journals (id,"organizationId",kind,"idempotencyKey","actorId",reason) VALUES ($1,$2,'ADJUSTMENT',$1,'synthetic-actor','Synthetic correction')`,
          [journal, org]
        );
        await db.query(
          `INSERT INTO stored_value_entries (id,"organizationId","journalId","accountId","amountMinor") VALUES ($1,$3,$4,$5,100),($2,$3,$4,$6,-100)`,
          [randomUUID(), randomUUID(), org, journal, ...accounts]
        );
        await db.query(
          `INSERT INTO pharmacy_wallet_audits (id,"organizationId","actorId",action) VALUES ($1,$2,'synthetic-actor','TEST')`,
          [randomUUID(), org]
        );
        await db.query(
          `INSERT INTO pharmacy_wallet_cnic_failures (id,"organizationId","customerId","cashierId") VALUES ($1,$2,'synthetic-customer','synthetic-actor')`,
          [randomUUID(), org]
        );
      });
  });
  it.each([null, '', '   '])(
    'rejects an adjustment with missing or blank reason %s',
    async (reason) => {
      await expect(
        transaction(orgs[0], false, null, (db) =>
          db.query(
            `INSERT INTO stored_value_journals (id,"organizationId",kind,"idempotencyKey","actorId",reason) VALUES ($1,$2,'ADJUSTMENT',$1,'synthetic-actor',$3)`,
            [randomUUID(), orgs[0], reason]
          )
        )
      ).rejects.toThrow(/stored_value_journals_adjustment_reason_check/);
    }
  );
  it.each([0, 1])('reveals only tenant %i through an unfiltered statement view', async (index) => {
    await transaction(orgs[index], false, null, async (db) => {
      const { rows } = await db.query('SELECT * FROM stored_value_customer_statements');
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.organizationId === orgs[index])).toBe(true);
      expect(rows.map((row) => Number(row.runningBalanceMinor)).sort((a, b) => a - b)).toEqual([
        -100, 100,
      ]);
    });
  });
  it('returns no statements without tenant scope even for platform context', async () => {
    await transaction(null, true, null, async (db) => {
      expect((await db.query('SELECT * FROM stored_value_customer_statements')).rows).toEqual([]);
    });
  });
  it.each(tables)(
    'keeps %s immutable outside exact platform purge and forbids all updates',
    async (table) => {
      for (const [platform, purge] of [
        [false, null],
        [true, null],
        [false, orgs[0]],
        [true, orgs[1]],
      ] as const) {
        await expect(
          transaction(orgs[0], platform, purge, (db) =>
            db.query(`DELETE FROM "${table}" WHERE "organizationId"=$1`, [orgs[0]])
          )
        ).rejects.toThrow(/append-only/);
      }
      for (const platform of [false, true])
        await expect(
          transaction(orgs[0], platform, orgs[0], (db) =>
            db.query(
              `UPDATE "${table}" SET "organizationId"="organizationId" WHERE "organizationId"=$1`,
              [orgs[0]]
            )
          )
        ).rejects.toThrow(/append-only/);
    }
  );
  it('purges only the named tenant with actual platform worker settings, preserving the neighbour', async () => {
    await transaction(orgs[0], true, orgs[0], async (db) => {
      for (const table of tables)
        expect(
          (await db.query(`DELETE FROM "${table}" WHERE "organizationId"=$1`, [orgs[0]])).rowCount
        ).toBeGreaterThan(0);
    });
    for (const org of orgs)
      await transaction(org, false, null, async (db) => {
        for (const table of tables)
          expect((await db.query(`SELECT * FROM "${table}"`)).rowCount).toBe(
            org === orgs[0] ? 0 : table === 'stored_value_entries' ? 2 : 1
          );
      });
  });
});
