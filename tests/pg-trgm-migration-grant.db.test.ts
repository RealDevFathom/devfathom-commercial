// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { assertDisposableRlsDatabase } from './disposable-rls-database';

const url = process.env.TEST_DATABASE_URL;
const preparation = readFileSync('prisma/prepare-extensions.sql', 'utf8');
const guard = readFileSync(
  'prisma/migrations/20261029000368_pg_trgm_migration_grant_guard/migration.sql',
  'utf8'
);
const btreeGuard = readFileSync(
  'prisma/migrations/20260830120000_btree_gist_public_execute_acl/migration.sql',
  'utf8'
);

// An isolated database is needed to exercise extension-absent bootstrap without
// dropping extensions or changing ACLs in the supplied test database. The URL
// must authenticate as a superuser to model inaccessible service-owned functions.
describe.skipIf(!url)('pg_trgm preparation and migration on PostgreSQL', () => {
  const suffix = randomUUID().replaceAll('-', '');
  const database = `trgm_test_${suffix}`;
  const migrator = `trgm_migrator_${suffix}`;
  const runtime = `trgm_runtime_${suffix}`;
  const admin = new pg.Client({ connectionString: url });
  let client: pg.Client;
  let databaseCreated = false;

  beforeAll(async () => {
    assertDisposableRlsDatabase(url!);
    await admin.connect();
    const attributes = await admin.query(
      'SELECT rolsuper FROM pg_roles WHERE rolname = current_user'
    );
    expect(attributes.rows[0].rolsuper, 'extension-owner fixtures require a superuser').toBe(true);
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
    databaseCreated = true;
    const target = new URL(url!);
    target.pathname = `/${database}`;
    client = new pg.Client({ connectionString: target.toString() });
    await client.connect();
  });

  afterAll(async () => {
    try {
      await client?.end();
      if (databaseCreated) await admin.query(`DROP DATABASE "${database}"`);
    } finally {
      await admin.end();
    }
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    await client.query(`
      CREATE ROLE "${migrator}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
      CREATE ROLE "${runtime}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
      GRANT USAGE ON SCHEMA public TO "${migrator}", "${runtime}";
      GRANT CREATE ON DATABASE "${database}" TO "${migrator}";
    `);
    await client.query(`SELECT set_config('devfathom.migration_role', $1, true)`, [migrator]);
  });

  afterEach(async () => {
    // Also removes the cluster roles, extension installs, ACL changes and records.
    await client.query('ROLLBACK');
  });

  async function prepareManaged() {
    await client.query('CREATE EXTENSION btree_gist; CREATE EXTENSION pg_trgm');
    await client.query(`SET LOCAL ROLE "${migrator}"`);
    await client.query(preparation);
  }

  async function expectRuntimeSearch() {
    await client.query(`SET LOCAL ROLE "${runtime}"`);
    const result = await client.query(`SELECT 'aspirin' OPERATOR(public.%) 'aspirin' AS matches`);
    expect(result.rows).toEqual([{ matches: true }]);
  }

  it('bootstraps absent extensions, delegates only similarity_op, and remains idempotent', async () => {
    expect(
      (
        await client.query('SELECT extname FROM pg_extension WHERE extname IN ($1, $2)', [
          'btree_gist',
          'pg_trgm',
        ])
      ).rows
    ).toEqual([]);
    await client.query(preparation);
    await client.query(preparation);
    await client.query(btreeGuard);
    const grants = await client.query(
      `
      SELECT procedure.oid::regprocedure::text AS identity, acl.is_grantable
        FROM pg_proc AS procedure
        CROSS JOIN LATERAL aclexplode(procedure.proacl) AS acl
        JOIN pg_roles AS role ON role.oid = acl.grantee
       WHERE role.rolname = $1
    `,
      [migrator]
    );
    expect(grants.rows).toEqual([{ identity: 'similarity_op(text,text)', is_grantable: true }]);
    await client.query(`SET LOCAL ROLE "${migrator}"`);
    await client.query(guard);
    await client.query(`GRANT EXECUTE ON FUNCTION public.similarity_op(text,text) TO "${runtime}"`);
    await expectRuntimeSearch();
  });

  it('accepts a recorded managed owner while PUBLIC permits runtime execution', async () => {
    await prepareManaged();
    const skips = await client.query(`
      SELECT reason FROM platform_ops.platform_db_hardening WHERE extension_name = 'pg_trgm'
    `);
    expect(skips.rows).toEqual([{ reason: 'managed-owner' }]);
    await client.query(guard);
    await expectRuntimeSearch();
  });

  it('rejects a managed owner without PUBLIC execution, even if the migrator can execute', async () => {
    await prepareManaged();
    await client.query('RESET ROLE');
    await client.query(`
      REVOKE EXECUTE ON FUNCTION public.similarity_op(text,text) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.similarity_op(text,text) TO "${migrator}";
      SET LOCAL ROLE "${migrator}";
    `);
    await expect(client.query(guard)).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('cannot grant EXECUTE'),
    });
  });

  it('requires delegation after hardening removes PUBLIC execution', async () => {
    await client.query(preparation);
    await client.query(
      `REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION public.similarity_op(text,text) FROM "${migrator}"`
    );
    await client.query(`SET LOCAL ROLE "${migrator}"`);
    await expect(client.query(guard)).rejects.toMatchObject({ code: 'P0001' });
  });

  it('does not apply the managed exception to an assumable function owner', async () => {
    await prepareManaged();
    await client.query('RESET ROLE');
    const membership = await client.query(
      `SELECT format('GRANT %I TO %I WITH INHERIT FALSE, SET TRUE', current_user, $1::text) AS sql`,
      [migrator]
    );
    await client.query(membership.rows[0].sql);
    await client.query(`SET LOCAL ROLE "${migrator}"`);
    await expect(client.query(guard)).rejects.toMatchObject({ code: 'P0001' });
  });

  it('fails clearly when pg_trgm is absent', async () => {
    await expect(client.query(guard)).rejects.toMatchObject({
      code: 'P0001',
      message: 'pg_trgm similarity_op(text,text) is unavailable',
    });
  });
});
