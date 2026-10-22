import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

const adminUrl = process.env.WHA763_TEST_ADMIN_DATABASE_URL;
const describeIfDatabase = adminUrl ? describe : describe.skip;
const migrationPath = join(
  process.cwd(),
  'prisma/migrations/20260830120000_revoke_btree_gist_public_execute/migration.sql'
);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const databases = [`wha763_fresh_${suffix}`, `wha763_preexisting_${suffix}`];

function databaseUrl(database: string) {
  const parsed = new URL(adminUrl!);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function expectPgCode(code: string, operation: () => Promise<unknown>) {
  try {
    await operation();
    throw new Error(`Expected PostgreSQL error ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describeIfDatabase('btree_gist PUBLIC EXECUTE revocation', () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  let migrationSql = '';

  afterAll(async () => {
    for (const database of databases) {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    }
    await admin.end();
  });

  it.each([
    { database: databases[0], state: 'fresh', restorePublicExecute: false },
    { database: databases[1], state: 'preexisting', restorePublicExecute: true },
  ])('normalizes $state extension state and preserves GiST behavior', async (fixture) => {
    if (!migrationSql) {
      const parsed = new URL(adminUrl!);
      expect(['localhost', '127.0.0.1', '::1', '[::1]', '']).toContain(parsed.hostname);
      await admin.connect();
      migrationSql = await readFile(migrationPath, 'utf8');
    }

    await admin.query(`CREATE DATABASE "${fixture.database}"`);
    const owner = new pg.Client({ connectionString: databaseUrl(fixture.database) });
    await owner.connect();

    try {
      await owner.query('CREATE EXTENSION btree_gist');
      if (fixture.restorePublicExecute) {
        await owner.query(`DO $grant$
          DECLARE member regprocedure;
          BEGIN
            FOR member IN
              SELECT p.oid::regprocedure
              FROM pg_extension e
              JOIN pg_depend d ON d.refobjid=e.oid AND d.classid='pg_proc'::regclass AND d.deptype='e'
              JOIN pg_proc p ON p.oid=d.objid
              WHERE e.extname='btree_gist'
            LOOP
              EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', member);
            END LOOP;
          END $grant$`);
      }

      await owner.query(migrationSql);
      await owner.query(`CREATE ROLE "runtime_${suffix}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await owner.query(`CREATE TABLE bookings (id integer, during tsrange NOT NULL)`);
      await owner.query(
        `ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap EXCLUDE USING gist (id WITH =, during WITH &&)`
      );
      await owner.query(`GRANT USAGE ON SCHEMA public TO "runtime_${suffix}"`);
      await owner.query(`GRANT SELECT, INSERT ON bookings TO "runtime_${suffix}"`);

      const members = await owner.query<{
        oid: number;
        signature: string;
        public_execute: boolean;
        runtime_execute: boolean;
      }>(
        `SELECT p.oid,
                p.oid::regprocedure::text AS signature,
                EXISTS (
                  SELECT 1
                  FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                  WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
                ) AS public_execute,
                has_function_privilege($1, p.oid, 'EXECUTE') AS runtime_execute
         FROM pg_extension e
         JOIN pg_depend d
           ON d.refclassid='pg_extension'::regclass AND d.refobjid=e.oid
          AND d.classid='pg_proc'::regclass AND d.deptype='e' AND d.objsubid=0
         JOIN pg_proc p ON p.oid=d.objid
         WHERE e.extname='btree_gist'`,
        [`runtime_${suffix}`]
      );
      expect(members.rowCount).toBeGreaterThan(0);
      expect(new Set(members.rows.map((member) => member.oid)).size).toBe(members.rowCount);
      expect(members.rows.every((member) => !member.public_execute && !member.runtime_execute)).toBe(
        true
      );
      expect(members.rows.some((member) => member.signature === 'int4_dist(integer,integer)')).toBe(
        true
      );
      expect(members.rows.some((member) => member.signature === 'int8_dist(bigint,bigint)')).toBe(
        true
      );

      await owner.query(`SET ROLE "runtime_${suffix}"`);
      await expectPgCode('42501', () => owner.query('SELECT int4_dist(1, 2)'));
      await expectPgCode('42501', () => owner.query('SELECT int8_dist(1::bigint, 2::bigint)'));
      await owner.query(`INSERT INTO bookings VALUES (1, '[2030-01-01,2030-02-01)')`);
      await owner.query(`INSERT INTO bookings VALUES (1, '[2030-02-01,2030-03-01)')`);
      await expectPgCode('23P01', () =>
        owner.query(`INSERT INTO bookings VALUES (1, '[2030-01-15,2030-02-15)')`)
      );
      await owner.query('RESET ROLE');

      const role = await owner.query(
        `SELECT rolsuper, rolbypassrls,
                NOT EXISTS (
                  SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid
                ) AS has_no_memberships
         FROM pg_roles WHERE rolname=$1`,
        [`runtime_${suffix}`]
      );
      expect(role.rows[0]).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        has_no_memberships: true,
      });
    } finally {
      await owner.end();
    }
  });

  it('fails closed when extension-member attribution is unavailable', async () => {
    const database = `wha763_missing_${suffix}`;
    databases.push(database);
    await admin.query(`CREATE DATABASE "${database}"`);
    const owner = new pg.Client({ connectionString: databaseUrl(database) });
    await owner.connect();
    try {
      await expectPgCode('P0001', () => owner.query(migrationSql));
    } finally {
      await owner.end();
    }
  });
});
