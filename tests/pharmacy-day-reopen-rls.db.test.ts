import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertDisposableRlsDatabase } from './disposable-rls-database';

// DEV-631: a reopen of a closed business day is an append-only, tenant- and
// branch-scoped record of who reopened it, when and why. These probes run the
// migrated schema under a restricted runtime role, not mocks or migration text.
const url = process.env.PHARMACY_TEST_OWNER_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? '';
// Skipped, never silently passed, without a disposable database.
const describeIfDatabase = url ? describe : describe.skip;
const client = new pg.Client({ connectionString: url });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const role = `pharmacy_runtime_${suffix}`;
const orgA = `reopen_org_a_${suffix}`;
const orgB = `reopen_org_b_${suffix}`;
const branch = (org: string, key: string) => `${org}_branch_${key}`;
const close = (org: string, key: string) => `${org}_close_${key}`;
const businessDate = '2026-11-02';

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

async function asTenant(organizationId: string, branchId = '') {
  await client.query(`SELECT set_config('app.current_organization_id',$1,true)`, [organizationId]);
  await client.query(`SELECT set_config('app.current_branch_id',$1,true)`, [branchId]);
}

function insertReopen(id: string, organizationId: string, branchKey: string, reason = 'Early') {
  return client.query(
    `INSERT INTO pharmacy_day_reopens (id,"organizationId","branchId","businessDate","closeId",reason,"actorId")
     VALUES ($1,$2,$3,$4,$5,$6,'owner')`,
    [
      id,
      organizationId,
      branch(organizationId, branchKey),
      businessDate,
      close(organizationId, branchKey),
      reason,
    ]
  );
}

describeIfDatabase('pharmacy day reopen PostgreSQL RLS and append-only record', () => {
  beforeAll(async () => {
    assertDisposableRlsDatabase(url);
    await client.connect();
    await client.query('BEGIN');
    await client.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS`);
    await client.query(`GRANT "${role}" TO CURRENT_USER`);
    await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await client.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON pharmacy_day_reopens,pharmacy_daily_closes TO "${role}"`
    );
    await client.query(`SELECT set_config('app.is_platform_admin','true',true)`);
    await client.query(
      `INSERT INTO organizations (id,slug,"legalName","displayName","updatedAt") VALUES ($1,$1,$1,$1,now()),($2,$2,$2,$2,now())`,
      [orgA, orgB]
    );
    for (const org of [orgA, orgB]) {
      for (const key of ['main', 'second']) {
        await client.query(
          `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","updatedAt")
           VALUES ($1,$2,$3,$3,'1 Main Road','Lahore','PB',now())`,
          [branch(org, key), org, `${key}_${suffix}`]
        );
        await client.query(
          `INSERT INTO pharmacy_daily_closes (id,"organizationId","branchId","businessDate",sequence,"grossSalesMinor","refundTotalMinor","netSalesMinor","cashExpectedMinor","cashCountedMinor","cashVarianceMinor","sourceHash","actorId")
           VALUES ($1,$2,$3,$4,1,0,0,0,0,0,0,'hash','owner')`,
          [close(org, key), org, branch(org, key), businessDate]
        );
      }
    }
    await client.query(`SELECT set_config('app.is_platform_admin','false',true)`);
    await client.query(`SET LOCAL ROLE "${role}"`);
    const runtimeRole = await client.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );
    expect(runtimeRole.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  afterAll(async () => {
    await client.query('ROLLBACK');
    await client.end();
  });

  it("records a reopen in the tenant's scope and hides it from another tenant", async () => {
    await asTenant(orgA, branch(orgA, 'main'));
    await insertReopen(`reopen_a_${suffix}`, orgA, 'main', 'Closed early by mistake');
    const own = await client.query(`SELECT id, reason, "actorId" FROM pharmacy_day_reopens`);
    expect(own.rows).toEqual([
      { id: `reopen_a_${suffix}`, reason: 'Closed early by mistake', actorId: 'owner' },
    ]);
    await asTenant(orgB);
    const other = await client.query(`SELECT id FROM pharmacy_day_reopens`);
    expect(other.rows).toEqual([]);
  });

  it('rejects a reopen written for another tenant or another branch', async () => {
    await asTenant(orgA, branch(orgA, 'main'));
    await expectPgCode('42501', () => insertReopen(`reopen_foreign_${suffix}`, orgB, 'main'));
    await expectPgCode('42501', () => insertReopen(`reopen_branch_${suffix}`, orgA, 'second'));
  });

  it('binds a reopen to the exact close of its branch and date, once', async () => {
    await asTenant(orgA);
    const reopenWith = (branchKey: string, date: string, closeKey: string) =>
      client.query(
        `INSERT INTO pharmacy_day_reopens (id,"organizationId","branchId","businessDate","closeId",reason,"actorId")
         VALUES ($1,$2,$3,$4,$5,'Early','owner')`,
        [`reopen_mismatch_${suffix}`, orgA, branch(orgA, branchKey), date, close(orgA, closeKey)]
      );
    // The second branch's close, named against another date or another branch.
    await expectPgCode('23503', () => reopenWith('second', '2026-11-03', 'second'));
    await expectPgCode('23503', () => reopenWith('main', businessDate, 'second'));
    await expectPgCode('23505', () => insertReopen(`reopen_again_${suffix}`, orgA, 'main'));
  });

  it('refuses a blank reason and keeps the record append-only', async () => {
    await asTenant(orgA);
    await expectPgCode('23514', () => insertReopen(`reopen_blank_${suffix}`, orgA, 'second', '  '));
    // pharmacy_reject_money_mutation: the record of who, when and why never changes.
    await expectPgCode('55000', () =>
      client.query(`UPDATE pharmacy_day_reopens SET reason='Rewritten' WHERE id=$1`, [
        `reopen_a_${suffix}`,
      ])
    );
    await expectPgCode('55000', () =>
      client.query(`DELETE FROM pharmacy_day_reopens WHERE id=$1`, [`reopen_a_${suffix}`])
    );
  });
});
