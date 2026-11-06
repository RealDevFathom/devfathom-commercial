import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

// #479: PV endpoints require an active branch assignment. Existing pharmacies whose
// bootstrap administrator was provisioned without one must keep PV access, exactly as a
// newly provisioned pharmacy now gets MAIN. Nobody else gains branch scope.
const url = process.env.PHARMACY_TEST_OWNER_DATABASE_URL;
const client = new pg.Client({ connectionString: url });
const suffix = randomUUID().replaceAll('-', '');
const pharmacy = `pbab_${suffix}`;
const restaurant = `${pharmacy}_rest`;
const id = (key: string) => `${pharmacy}_${key}`;
// The suite runs inside one rolled-back transaction, so strip the file's own
// BEGIN/COMMIT (the deployed file keeps them so set_config holds under FORCE RLS).
const migration = readFileSync(
  'prisma/migrations/20261106120000_pharmacy_bootstrap_admin_branch_backfill/migration.sql',
  'utf8'
)
  .replace(/^BEGIN;$/m, '')
  .replace(/^COMMIT;$/m, '');

async function assignments(userKey: string) {
  const rows = await client.query(
    `SELECT "branchId",active FROM pharmacy_branch_assignments WHERE "userId"=$1 ORDER BY "branchId"`,
    [id(userKey)]
  );
  return rows.rows as { branchId: string; active: boolean }[];
}

(url ? describe : describe.skip)('pharmacy bootstrap admin branch backfill on PostgreSQL', () => {
  beforeAll(async () => {
    assertDisposableRlsDatabase(url!);
    await client.connect();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_platform_admin','true',true)`);
    for (const [organizationId, vertical] of [
      [pharmacy, 'PHARMACY'],
      [restaurant, 'RESTAURANT'],
    ]) {
      await client.query(
        `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode",vertical,"createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',$2,now(),now())`,
        [organizationId, vertical]
      );
      await client.query(
        `INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'Pharmacy','Pharmacy',now())`,
        [`${organizationId}_dept`, organizationId]
      );
    }
    for (const [key, code, organizationId] of [
      ['main', 'MAIN', pharmacy],
      ['second', 'B2', pharmacy],
      ['rest_main', 'MAIN', restaurant],
    ] as const) {
      await client.query(
        `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","updatedAt") VALUES ($1,$2,$3,$1,'a','Karachi','PK-SD',now())`,
        [id(key), organizationId, code]
      );
    }
    for (const [key, roleKey, isSystem, organizationId] of [
      ['admin', 'admin', true, pharmacy],
      ['owner', 'owner', true, pharmacy],
      ['custom', 'administrator', false, pharmacy],
      ['cashier', 'cashier', true, pharmacy],
      ['rest_admin', 'admin', true, restaurant],
    ] as const) {
      await client.query(
        `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,$3,$3,$4,now())`,
        [id(`role_${key}`), organizationId, roleKey, isSystem]
      );
    }
    for (const [key, role, organizationId, status] of [
      ['admin', 'admin', pharmacy, 'ACTIVE'],
      ['owner_removed', 'owner', pharmacy, 'ACTIVE'],
      ['owner_assigned', 'owner', pharmacy, 'ACTIVE'],
      ['owner_inactive', 'owner', pharmacy, 'INACTIVE'],
      ['custom', 'custom', pharmacy, 'ACTIVE'],
      ['cashier', 'cashier', pharmacy, 'ACTIVE'],
      ['rest_admin', 'rest_admin', restaurant, 'ACTIVE'],
    ] as const) {
      await client.query(
        `INSERT INTO users (id,"organizationId","organizationRoleId",name,email,department,title,status,"updatedAt") VALUES ($1,$2,$3,$1,$1,'Pharmacy','Staff',$4,now())`,
        [id(key), organizationId, id(`role_${role}`), status]
      );
    }
    // A deliberate removal (inactive row) and an existing scope must both be respected.
    await client.query(
      `INSERT INTO pharmacy_branch_assignments (id,"organizationId","branchId","userId",active,"updatedAt") VALUES ($1,$2,$3,$4,false,now()),($5,$2,$6,$7,true,now())`,
      [
        id('a1'),
        pharmacy,
        id('main'),
        id('owner_removed'),
        id('a2'),
        id('second'),
        id('owner_assigned'),
      ]
    );
    await client.query(migration);
  }, 60_000);
  afterAll(async () => {
    await client.query('ROLLBACK');
    await client.end();
  });

  it('assigns an unassigned system admin to the active MAIN branch only', async () => {
    expect(await assignments('admin')).toEqual([{ branchId: id('main'), active: true }]);
  });

  it('respects deliberate removals and existing scope', async () => {
    expect(await assignments('owner_removed')).toEqual([{ branchId: id('main'), active: false }]);
    expect(await assignments('owner_assigned')).toEqual([{ branchId: id('second'), active: true }]);
  });

  it('leaves inactive users, lookalike, non-owner and non-pharmacy roles untouched', async () => {
    for (const key of ['owner_inactive', 'custom', 'cashier', 'rest_admin'])
      expect(await assignments(key)).toEqual([]);
  });

  it('is idempotent', async () => {
    const before = await client.query(
      `SELECT * FROM pharmacy_branch_assignments WHERE "organizationId" IN ($1,$2) ORDER BY id`,
      [pharmacy, restaurant]
    );
    await client.query(migration);
    const after = await client.query(
      `SELECT * FROM pharmacy_branch_assignments WHERE "organizationId" IN ($1,$2) ORDER BY id`,
      [pharmacy, restaurant]
    );
    expect(after.rows).toEqual(before.rows);
  });
});
