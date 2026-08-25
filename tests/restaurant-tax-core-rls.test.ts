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
      `GRANT SELECT, INSERT, UPDATE, DELETE ON restaurant_tax_official_sources, restaurant_tax_profile_versions,
       restaurant_tax_rule_versions, restaurant_tax_transaction_snapshots, restaurant_tax_rate_bucket_snapshots TO "${role}"`
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
       VALUES ($1,$2,$3,1,'PUBLISHED','2030-01-01','SYNTHETIC',now(),now(),now()),
              ($4,$5,$6,1,'PUBLISHED','2030-01-01','SYNTHETIC',now(),now(),now())`,
      [
        `profile_a_${suffix}`,
        orgA,
        `branch_a_${suffix}`,
        `profile_b_${suffix}`,
        orgB,
        `branch_b_${suffix}`,
      ]
    );
    await client.query(
      `INSERT INTO restaurant_tax_rule_versions
       (id,"organizationId","profileVersionId","officialSourceId","ruleCode","paymentCategory","priceMode",rate,status,"effectiveFrom","approvalReference","approvedAt","publishedAt","updatedAt")
       VALUES ($1,$2,$3,$4,'A','SYNTHETIC_CARD','EXCLUSIVE',0.1,'PUBLISHED','2030-01-01','SYNTHETIC',now(),now(),now()),
              ($5,$6,$7,$8,'B','SYNTHETIC_CARD','EXCLUSIVE',0.1,'PUBLISHED','2030-01-01','SYNTHETIC',now(),now(),now())`,
      [
        `rule_a_${suffix}`,
        orgA,
        `profile_a_${suffix}`,
        `source_a_${suffix}`,
        `rule_b_${suffix}`,
        orgB,
        `profile_b_${suffix}`,
        `source_b_${suffix}`,
      ]
    );
    await client.query(
      `INSERT INTO restaurant_tax_transaction_snapshots
       (id,"organizationId","branchId","transactionReference","profileVersionId",currency,subtotal,"discountTotal","serviceChargeTotal","taxTotal","grandTotal","settledAt")
       VALUES ($1,$2,$3,'original-a',$4,'XXX',100,10,5,9.5,104.5,now()),
              ($5,$6,$7,'original-b',$8,'XXX',100,10,5,9.5,104.5,now())`,
      [
        `snapshot_a_${suffix}`,
        orgA,
        `branch_a_${suffix}`,
        `profile_a_${suffix}`,
        `snapshot_b_${suffix}`,
        orgB,
        `branch_b_${suffix}`,
        `profile_b_${suffix}`,
      ]
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

  it('rejects every crafted cross-tenant tax relation under the restricted role', async () => {
    await client.query(`SET LOCAL ROLE "${role}"`);
    await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [orgA]);
    await expectPgCode('23503', () =>
      client.query(
        `INSERT INTO restaurant_tax_profile_versions
         (id,"organizationId","branchId","versionNumber","effectiveFrom","updatedAt") VALUES ($1,$2,$3,2,'2040-01-01',now())`,
        [`cross_profile_${suffix}`, orgA, `branch_b_${suffix}`]
      )
    );
    await expectPgCode('23503', () =>
      client.query(
        `INSERT INTO restaurant_tax_rule_versions
         (id,"organizationId","profileVersionId","officialSourceId","ruleCode","paymentCategory","priceMode",rate,"effectiveFrom","updatedAt")
         VALUES ($1,$2,$3,$4,'X','X','EXCLUSIVE',0.1,'2030-01-01',now())`,
        [`cross_rule_${suffix}`, orgA, `profile_b_${suffix}`, `source_b_${suffix}`]
      )
    );
    await expectPgCode('23503', () =>
      client.query(
        `INSERT INTO restaurant_tax_transaction_snapshots
         (id,"organizationId","branchId","transactionReference","profileVersionId",currency,subtotal,"taxTotal","grandTotal","settledAt")
         VALUES ($1,$2,$3,'cross-snapshot',$4,'XXX',1,0,1,now())`,
        [`cross_snapshot_${suffix}`, orgA, `branch_b_${suffix}`, `profile_b_${suffix}`]
      )
    );
    await expectPgCode('23503', () =>
      client.query(
        `INSERT INTO restaurant_tax_rate_bucket_snapshots
         (id,"organizationId","snapshotId","ruleVersionId","paymentCategory","priceMode",rate,"taxableAmount","taxAmount","grossAmount")
         VALUES ($1,$2,$3,$4,'X','EXCLUSIVE',0.1,1,0.1,1.1)`,
        [`cross_bucket_${suffix}`, orgA, `snapshot_b_${suffix}`, `rule_b_${suffix}`]
      )
    );
  });

  it('accepts one exact full reversal and rejects positive, over-value, duplicate, and cross-tenant reversals', async () => {
    await client.query(`SET LOCAL ROLE "${role}"`);
    await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [orgA]);
    const reversalInsert = (id: string, subtotal: number, target = `snapshot_a_${suffix}`) =>
      client.query(
        `INSERT INTO restaurant_tax_transaction_snapshots
         (id,"organizationId","branchId","transactionReference","profileVersionId",currency,subtotal,"discountTotal","serviceChargeTotal","taxTotal","grandTotal","settledAt","reversesSnapshotId","reversalReason")
         VALUES ($1,$2,$3,$1,$4,'XXX',$5,-10,-5,-9.5,-104.5,now(),$6,'synthetic correction')`,
        [id, orgA, `branch_a_${suffix}`, `profile_a_${suffix}`, subtotal, target]
      );
    await expectPgCode('23514', () => reversalInsert(`positive_${suffix}`, 100));
    await expectPgCode('23514', () => reversalInsert(`over_${suffix}`, -101));
    await expectPgCode('23503', () =>
      reversalInsert(`cross_tenant_${suffix}`, -100, `snapshot_b_${suffix}`)
    );
    await reversalInsert(`valid_reversal_${suffix}`, -100);
    await expectPgCode('23505', () => reversalInsert(`duplicate_${suffix}`, -100));
  });

  it('uses a database exclusion constraint across two concurrent connections', async () => {
    await client.query('RESET ROLE');
    const concurrentOrg = `tax_concurrent_${suffix}`;
    const concurrentBranch = `branch_concurrent_${suffix}`;
    await client.query(
      `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode","createdAt","updatedAt")
       VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',now(),now())`,
      [concurrentOrg]
    );
    await client.query(
      `INSERT INTO restaurant_branches (id,"organizationId",name,"updatedAt") VALUES ($1,$2,'Concurrent',now())`,
      [concurrentBranch, concurrentOrg]
    );
    await client.query('COMMIT');

    const first = new pg.Client({ connectionString: url });
    const second = new pg.Client({ connectionString: url });
    await Promise.all([first.connect(), second.connect()]);
    try {
      await Promise.all([first.query('BEGIN'), second.query('BEGIN')]);
      await Promise.all([
        first.query(`SELECT set_config('app.current_organization_id',$1,true)`, [concurrentOrg]),
        second.query(`SELECT set_config('app.current_organization_id',$1,true)`, [concurrentOrg]),
      ]);
      await first.query(
        `INSERT INTO restaurant_tax_profile_versions
         (id,"organizationId","branchId","versionNumber",status,"effectiveFrom","effectiveTo","approvalReference","approvedAt","publishedAt","updatedAt")
         VALUES ($1,$2,$3,1,'PUBLISHED','2040-01-01','2041-01-01','SYNTHETIC',now(),now(),now())`,
        [`concurrent_one_${suffix}`, concurrentOrg, concurrentBranch]
      );
      const overlapping = second.query(
        `INSERT INTO restaurant_tax_profile_versions
         (id,"organizationId","branchId","versionNumber",status,"effectiveFrom","effectiveTo","approvalReference","approvedAt","publishedAt","updatedAt")
         VALUES ($1,$2,$3,2,'PUBLISHED','2040-06-01','2041-06-01','SYNTHETIC',now(),now(),now())`,
        [`concurrent_two_${suffix}`, concurrentOrg, concurrentBranch]
      );
      await first.query('COMMIT');
      await expect(overlapping).rejects.toMatchObject({ code: '23P01' });
      await second.query('ROLLBACK');
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
    await client.query('BEGIN');
  });
});
