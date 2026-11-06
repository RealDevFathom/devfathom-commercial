import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertDisposableRlsDatabase } from './disposable-rls-database';

/**
 * #729 — churn score tables against REAL PostgreSQL under an unprivileged role
 * (NOSUPERUSER / NOBYPASSRLS): forced tenant + branch RLS, composite tenant
 * foreign keys, CHECK bounds and the daily idempotency key.
 */
const url = process.env.PHARMACY_TEST_OWNER_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? '';
// Skipped, never silently passed, without a disposable database.
const describeIfDatabase = url ? describe : describe.skip;
const client = new pg.Client({ connectionString: url });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const role = `pharmacy_churn_runtime_${suffix}`;
const org = { a: `churn_org_a_${suffix}`, b: `churn_org_b_${suffix}` };
const branch = {
  a: `churn_branch_a_${suffix}`,
  a2: `churn_branch_a2_${suffix}`,
  b: `churn_branch_b_${suffix}`,
};
const customer = { a: `churn_customer_a_${suffix}`, b: `churn_customer_b_${suffix}` };

async function expectPgCode(code: string, operation: () => Promise<unknown>) {
  await client.query('SAVEPOINT expected_failure');
  try {
    await operation();
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT expected_failure');
    await client.query('RELEASE SAVEPOINT expected_failure');
    expect(error).toMatchObject({ code });
    return;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_failure');
  await client.query('RELEASE SAVEPOINT expected_failure');
  throw new Error(`Expected PostgreSQL error ${code}`);
}

function insertScore(
  id: string,
  organizationId: string,
  branchId: string,
  customerId: string,
  churnScore = 82
) {
  return client.query(
    `INSERT INTO pharmacy_customer_churn_scores
       (id,"organizationId","branchId","customerId","businessDate","modelVersion","recencyDays",
        frequency,"monetaryMinor","recencyScore","frequencyScore","monetaryScore","churnScore","riskBand")
     VALUES ($1,$2,$3,$4,'2026-11-02',1,120,1,800,2,1,1,$5,'HIGH')`,
    [id, organizationId, branchId, customerId, churnScore]
  );
}

describeIfDatabase('pharmacy churn scoring PostgreSQL RLS and integrity (#729)', () => {
  beforeAll(async () => {
    assertDisposableRlsDatabase(url);
    await client.connect();
    await client.query('BEGIN');
    await client.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS`);
    await client.query(`GRANT "${role}" TO CURRENT_USER`);
    await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await client.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON pharmacy_customer_churn_scores,pharmacy_churn_scoring_runs TO "${role}"`
    );
    await client.query(`SELECT set_config('app.is_platform_admin','true',true)`);
    await client.query(
      `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode",vertical,"createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED','PHARMACY',now(),now()),($2,$2,$2,$2,'ACTIVE','SHARED','PHARMACY',now(),now())`,
      [org.a, org.b]
    );
    for (const [id, organizationId] of [
      [branch.a, org.a],
      [branch.a2, org.a],
      [branch.b, org.b],
    ])
      await client.query(
        `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","updatedAt") VALUES ($1,$2,$1,$1,'Synthetic','Lahore','PB',now())`,
        [id, organizationId]
      );
    for (const [id, organizationId] of [
      [customer.a, org.a],
      [customer.b, org.b],
    ]) {
      await client.query(
        `INSERT INTO pharmacy_patients (id,"organizationId","displayName","updatedAt") VALUES ($1,$2,'Synthetic',now())`,
        [id, organizationId]
      );
      await client.query(
        `INSERT INTO pharmacy_customers (id,"organizationId","patientId","displayName","updatedAt") VALUES ($1,$2,$1,'Synthetic',now())`,
        [id, organizationId]
      );
    }
    await insertScore(`score_b_${suffix}`, org.b, branch.b, customer.b);
    await insertScore(`score_a2_${suffix}`, org.a, branch.a2, customer.a);
    await client.query(`SELECT set_config('app.is_platform_admin','false',true)`);
    await client.query(`SET LOCAL ROLE "${role}"`);
    const runtimeRole = await client.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );
    expect(runtimeRole.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await client.query(`SELECT set_config('app.current_organization_id',$1,true)`, [org.a]);
  });

  afterAll(async () => {
    await client.query('ROLLBACK');
    await client.end();
  });

  it('hides other tenants and rejects explicit tenant substitution', async () => {
    await insertScore(`score_a_${suffix}`, org.a, branch.a, customer.a);
    const visible = await client.query(
      `SELECT id FROM pharmacy_customer_churn_scores WHERE id LIKE $1`,
      [`%${suffix}`]
    );
    expect(visible.rows.map((row) => row.id).sort()).toEqual(
      [`score_a2_${suffix}`, `score_a_${suffix}`].sort()
    );
    await expectPgCode('42501', () =>
      insertScore(`score_sub_${suffix}`, org.b, branch.b, customer.b)
    );
    const updated = await client.query(
      `UPDATE pharmacy_customer_churn_scores SET "churnScore"=0 WHERE id=$1`,
      [`score_b_${suffix}`]
    );
    expect(updated.rowCount).toBe(0);
  });

  it('confines a branch-scoped session to its branch', async () => {
    await client.query(`SELECT set_config('app.current_branch_id',$1,true)`, [branch.a]);
    try {
      const visible = await client.query(
        `SELECT "branchId" FROM pharmacy_customer_churn_scores WHERE id LIKE $1`,
        [`%${suffix}`]
      );
      expect(visible.rows.every((row) => row.branchId === branch.a)).toBe(true);
      await expectPgCode('42501', () =>
        insertScore(`score_other_branch_${suffix}`, org.a, branch.a2, customer.a)
      );
    } finally {
      await client.query(`SELECT set_config('app.current_branch_id','',true)`);
    }
  });

  it('cannot reference another tenant branch or customer', async () => {
    await expectPgCode('23503', () =>
      insertScore(`score_cross_customer_${suffix}`, org.a, branch.a2, customer.b)
    );
    await expectPgCode('23503', () =>
      insertScore(`score_cross_branch_${suffix}`, org.a, branch.b, customer.a)
    );
  });

  it('bounds stored scores to 0–100', async () => {
    await expectPgCode('23514', () =>
      insertScore(`score_high_${suffix}`, org.a, branch.a2, customer.a, 101)
    );
  });

  it('allows one scoring run per branch and business date', async () => {
    const run = () =>
      client.query(
        `INSERT INTO pharmacy_churn_scoring_runs (id,"organizationId","branchId","businessDate","modelVersion","scoredCustomers") VALUES ($1,$2,$3,'2026-11-02',1,0)`,
        [`run_${randomUUID()}`, org.a, branch.a]
      );
    await run();
    await expectPgCode('23505', run);
  });
});
