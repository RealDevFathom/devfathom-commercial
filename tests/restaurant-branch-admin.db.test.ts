import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

const databaseUrl = process.env.WHA908_TEST_DATABASE_URL;
const describeIfDatabase = databaseUrl ? describe : describe.skip;
const runKey = `${process.pid}_${Date.now()}`;
const schema = `wha908_${runKey}`;
const runtimeRole = `wha908_runtime_${runKey}`;
const quoted = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

describeIfDatabase('WHA-908 PostgreSQL branch administration', () => {
  const owner = new pg.Client({ connectionString: databaseUrl });

  beforeAll(async () => {
    await owner.connect();
    await owner.query(`CREATE SCHEMA ${quoted(schema)}`);
    await owner.query(`SET search_path TO ${quoted(schema)}, public`);
    await owner.query(`
      CREATE TABLE restaurant_branches (
        id TEXT PRIMARY KEY,
        "organizationId" TEXT NOT NULL,
        name TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        active BOOLEAN NOT NULL DEFAULT true,
        "isDefault" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX "restaurant_branches_organizationId_default_key"
        ON restaurant_branches ("organizationId") WHERE "isDefault";
      INSERT INTO restaurant_branches
        (id, "organizationId", name, active, "isDefault", "createdAt")
      VALUES
        ('legacy-a1', 'legacy-a', 'Duplicate', true, true, '2026-01-01'),
        ('legacy-a2', 'legacy-a', 'Duplicate', true, false, '2026-01-02'),
        ('legacy-a3', 'legacy-a', 'Closed', false, false, '2026-01-03'),
        ('legacy-b1', 'legacy-b', 'Other tenant', true, false, '2026-01-01');
    `);
    const migration = await readFile(
      path.join(
        process.cwd(),
        'prisma/migrations/20260830170000_restaurant_branch_codes/migration.sql'
      ),
      'utf8'
    );
    await owner.query(migration);
    await owner.query(`
      ALTER TABLE restaurant_branches ENABLE ROW LEVEL SECURITY;
      ALTER TABLE restaurant_branches FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON restaurant_branches
        USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
        WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
      CREATE ROLE ${quoted(runtimeRole)} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA ${quoted(schema)} TO ${quoted(runtimeRole)};
      GRANT SELECT, INSERT, UPDATE ON restaurant_branches TO ${quoted(runtimeRole)};
      GRANT USAGE, SELECT ON SEQUENCE restaurant_branch_code_seq TO ${quoted(runtimeRole)};
    `);
  });

  afterAll(async () => {
    await owner.query('RESET ROLE').catch(() => undefined);
    await owner.query(`DROP SCHEMA IF EXISTS ${quoted(schema)} CASCADE`);
    await owner.query(`DROP ROLE IF EXISTS ${quoted(runtimeRole)}`);
    await owner.end();
  });

  it('backfills deterministically without truncation and preserves duplicate names', async () => {
    const result = await owner.query(
      `SELECT id, name, code, active, "isDefault" FROM restaurant_branches
       WHERE "organizationId" = 'legacy-a' ORDER BY "createdAt", id`
    );
    expect(result.rows).toEqual([
      expect.objectContaining({
        id: 'legacy-a1',
        name: 'Duplicate',
        code: 'BR-1',
        isDefault: true,
      }),
      expect.objectContaining({ id: 'legacy-a2', name: 'Duplicate', code: 'BR-2' }),
      expect.objectContaining({ id: 'legacy-a3', name: 'Closed', code: 'BR-3', active: false }),
    ]);
    const repaired = await owner.query(
      `SELECT code FROM restaurant_branches WHERE "organizationId"='legacy-b' AND "isDefault" AND active`
    );
    expect(repaired.rowCount).toBe(1);
  });

  it('enforces canonical codes per org while allowing the same code across orgs', async () => {
    await owner.query(
      `INSERT INTO restaurant_branches (id,"organizationId",name,code) VALUES
       ('same-a','code-a','A','SAME'), ('same-b','code-b','B','SAME')`
    );
    await expect(
      owner.query(
        `INSERT INTO restaurant_branches (id,"organizationId",name,code)
         VALUES ('same-a2','code-a','A2','same')`
      )
    ).rejects.toMatchObject({ code: expect.stringMatching(/23505|23514/) });
    await expect(
      owner.query(
        `INSERT INTO restaurant_branches (id,"organizationId",name,code)
         VALUES ('bad-code','code-a','Bad',' BAD ')`
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('enforces cross-tenant RLS for a restricted NOBYPASSRLS role', async () => {
    const role = await owner.query(`SELECT rolbypassrls FROM pg_roles WHERE rolname = $1`, [
      runtimeRole,
    ]);
    expect(role.rows[0]?.rolbypassrls).toBe(false);
    await owner.query(`SET ROLE ${quoted(runtimeRole)}`);
    await owner.query(`SET app.current_organization_id = 'legacy-a'`);
    const visible = await owner.query(`SELECT DISTINCT "organizationId" FROM restaurant_branches`);
    expect(visible.rows).toEqual([{ organizationId: 'legacy-a' }]);
    await expect(
      owner.query(
        `INSERT INTO restaurant_branches (id,"organizationId",name)
         VALUES ('cross-tenant','legacy-b','Forbidden')`
      )
    ).rejects.toMatchObject({ code: '42501' });
    await owner.query('RESET ROLE');
  });

  async function client() {
    const connection = new pg.Client({ connectionString: databaseUrl });
    await connection.connect();
    await connection.query(`SET search_path TO ${quoted(schema)}, public`);
    return connection;
  }

  async function createWithinLimit(connection: pg.Client, org: string, id: string, limit: number) {
    await connection.query('BEGIN');
    try {
      await connection.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [org]);
      const count = await connection.query(
        `SELECT count(*)::int AS count FROM restaurant_branches WHERE "organizationId"=$1 AND active`,
        [org]
      );
      if (count.rows[0].count >= limit) {
        await connection.query('ROLLBACK');
        return false;
      }
      await connection.query(
        `INSERT INTO restaurant_branches (id,"organizationId",name,"isDefault")
         VALUES ($1,$2,$1,$3)`,
        [id, org, count.rows[0].count === 0]
      );
      await connection.query('COMMIT');
      return true;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    }
  }

  async function reactivateWithinLimit(
    connection: pg.Client,
    org: string,
    id: string,
    limit: number
  ) {
    await connection.query('BEGIN');
    try {
      await connection.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [org]);
      const count = await connection.query(
        `SELECT count(*)::int AS count FROM restaurant_branches WHERE "organizationId"=$1 AND active`,
        [org]
      );
      if (count.rows[0].count >= limit) {
        await connection.query('ROLLBACK');
        return false;
      }
      await connection.query(`UPDATE restaurant_branches SET active=true WHERE id=$1`, [id]);
      await connection.query('COMMIT');
      return true;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    }
  }

  async function deactivateSafely(connection: pg.Client, org: string, id: string) {
    await connection.query('BEGIN');
    try {
      await connection.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [org]);
      const count = await connection.query(
        `SELECT count(*)::int AS count FROM restaurant_branches WHERE "organizationId"=$1 AND active`,
        [org]
      );
      const target = await connection.query(
        `SELECT "isDefault" FROM restaurant_branches WHERE id=$1 AND active`,
        [id]
      );
      if (count.rows[0].count <= 1 || target.rows[0]?.isDefault !== false) {
        await connection.query('ROLLBACK');
        return false;
      }
      await connection.query(`UPDATE restaurant_branches SET active=false WHERE id=$1`, [id]);
      await connection.query('COMMIT');
      return true;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    }
  }

  it('serializes concurrent create, reactivation, and deactivation invariants', async () => {
    await owner.query(`
      INSERT INTO restaurant_branches (id,"organizationId",name,active,"isDefault") VALUES
        ('reactive-main','reactive','Main',true,true),
        ('reactive-a','reactive','A',false,false),
        ('reactive-b','reactive','B',false,false),
        ('deactivate-main','deactivate','Main',true,true),
        ('deactivate-a','deactivate','A',true,false),
        ('deactivate-b','deactivate','B',true,false);
    `);
    const [first, second] = await Promise.all([client(), client()]);
    try {
      expect(
        (
          await Promise.all([
            createWithinLimit(first, 'create', 'create-a', 1),
            createWithinLimit(second, 'create', 'create-b', 1),
          ])
        ).filter(Boolean)
      ).toHaveLength(1);
      expect(
        (
          await Promise.all([
            reactivateWithinLimit(first, 'reactive', 'reactive-a', 2),
            reactivateWithinLimit(second, 'reactive', 'reactive-b', 2),
          ])
        ).filter(Boolean)
      ).toHaveLength(1);
      expect(
        (
          await Promise.all([
            deactivateSafely(first, 'deactivate', 'deactivate-a'),
            deactivateSafely(second, 'deactivate', 'deactivate-b'),
          ])
        ).filter(Boolean)
      ).toHaveLength(2);
      const remaining = await owner.query(
        `SELECT count(*)::int AS count FROM restaurant_branches WHERE "organizationId"='deactivate' AND active`
      );
      expect(remaining.rows[0].count).toBe(1);
    } finally {
      await first.end();
      await second.end();
    }
  });
});
