import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required; tax RLS tests never skip');

const client = new pg.Client({ connectionString: url });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const role = `tax_runtime_${suffix}`;
const orgA = `tax_org_a_${suffix}`;
const orgB = `tax_org_b_${suffix}`;

async function expectPgCode(code: string, operation: () => Promise<unknown>) {
  await client.query('SAVEPOINT expected_failure');
  try {
    await operation();
    throw new Error(`Expected PostgreSQL error ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT expected_failure');
    await client.query('RELEASE SAVEPOINT expected_failure');
  }
}

describe('tax core real-PostgreSQL RLS and immutability', () => {
  beforeAll(async () => {
    const hostname = new URL(url).hostname;
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
      throw new Error('Refusing to run tax RLS probes against a non-local database');
    }
    await client.connect();
    await client.query('BEGIN');
    await client.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS`);
    await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON restaurant_tax_official_sources, restaurant_tax_profile_versions TO "${role}"`
    );
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client.query(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',now(),now()), ($2,$2,$2,$2,'ACTIVE','SHARED',now(),now())`,
      [orgA, orgB]
    );
    await client.query(
      `INSERT INTO restaurant_branches (id,"organizationId",name,"updatedAt") VALUES ($1,$2,'A',now()),($3,$4,'B',now())`,
      [`branch_a_${suffix}`, orgA, `branch_b_${suffix}`, orgB]
    );
    await client.query(
      `INSERT INTO restaurant_tax_official_sources (id,"organizationId","authorityCode","documentTitle","sourceUrl","contentHash","retrievedAt")
       VALUES ($1,$2,'SYNTHETIC','Fixture','https://example.invalid/a',$3,now()),($4,$5,'SYNTHETIC','Fixture','https://example.invalid/b',$6,now())`,
      [
        `source_a_${suffix}`,
        orgA,
        `hash_a_${suffix}`,
        `source_b_${suffix}`,
        orgB,
        `hash_b_${suffix}`,
      ]
    );
    await client.query(
      `INSERT INTO restaurant_tax_profile_versions (id,"organizationId","branchId","versionNumber",status,"effectiveFrom","approvalReference","approvedAt","publishedAt","updatedAt")
       VALUES ($1,$2,$3,1,'PUBLISHED','2030-01-01','SYNTHETIC',now(),now(),now())`,
      [`profile_a_${suffix}`, orgA, `branch_a_${suffix}`]
    );
  });

  afterAll(async () => {
    await client.query('ROLLBACK');
    await client.end();
  });

  it('uses a LOGIN NOSUPERUSER NOBYPASSRLS runtime role and sees one tenant only', async () => {
    const roleFlags = await client.query(
      'SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=$1',
      [role]
    );
    expect(roleFlags.rows[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });
    await client.query(`SET LOCAL ROLE "${role}"`);
    await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [orgA]);
    expect((await client.query('SELECT id FROM restaurant_tax_official_sources')).rowCount).toBe(1);
  });

  it('rejects cross-tenant writes and published/source mutation', async () => {
    await expectPgCode('42501', () =>
      client.query(
        `INSERT INTO restaurant_tax_official_sources (id,"organizationId","authorityCode","documentTitle","sourceUrl","contentHash","retrievedAt") VALUES ($1,$2,'X','X','https://example.invalid/x',$1,now())`,
        [`cross_${suffix}`, orgB]
      )
    );
    await expectPgCode('55000', () =>
      client.query(
        `UPDATE restaurant_tax_official_sources SET "documentTitle"='changed' WHERE "organizationId"=$1`,
        [orgA]
      )
    );
    await expectPgCode('55000', () =>
      client.query(
        `UPDATE restaurant_tax_profile_versions SET "versionNumber"=2 WHERE "organizationId"=$1`,
        [orgA]
      )
    );
  });

  it('has forced RLS on every tax table', async () => {
    await client.query('RESET ROLE');
    const result = await client.query(
      `SELECT count(*)::int AS count FROM pg_class WHERE relkind='r' AND relname LIKE 'restaurant_tax_%' AND relrowsecurity AND relforcerowsecurity`
    );
    expect(result.rows[0].count).toBe(5);
  });
});
