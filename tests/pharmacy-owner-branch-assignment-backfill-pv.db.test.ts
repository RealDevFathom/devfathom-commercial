// @vitest-environment node
/**
 * #479 follow-up: the owner branch-assignment backfill runs as a NOSUPERUSER,
 * NOBYPASSRLS role with the platform-admin flag off, so the migration's own
 * set_config is what lets it see every tenant. All fixtures roll back.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

const url = process.env.PHARMACY_TEST_OWNER_DATABASE_URL;
const client = new pg.Client({ connectionString: url });
const suffix = randomUUID().replaceAll('-', '');
const org = `pvob_${suffix}`;
const other = `${org}_other`;
const restaurant = `${org}_restaurant`;
const runtimeRole = `pvob_${suffix}`;
const id = (key: string) => `${org}_${key}`;
const rawMigration = readFileSync(
  'prisma/migrations/20261101180000_pharmacy_owner_branch_assignment_backfill/migration.sql',
  'utf8'
);
const migration = rawMigration.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');

async function insertOrg(organizationId: string, vertical: 'PHARMACY' | 'RESTAURANT') {
  await client.query(
    `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode",vertical,"createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',$2,now(),now())`,
    [organizationId, vertical]
  );
  await client.query(
    `INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'Pharmacy','Pharmacy',now())`,
    [`${organizationId}_department`, organizationId]
  );
}

async function insertRole(key: string, organizationId: string, roleKey: string, isSystem: boolean) {
  await client.query(
    `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,$3,$3,$4,now())`,
    [id(`role_${key}`), organizationId, roleKey, isSystem]
  );
}

async function insertUser(
  key: string,
  organizationId: string,
  roleKey: string | null,
  status = 'ACTIVE',
  role: 'ADMIN' | 'EMPLOYEE' = 'EMPLOYEE'
) {
  await client.query(
    `INSERT INTO users (id,"organizationId","organizationRoleId",name,email,department,title,status,role,"updatedAt") VALUES ($1,$2,$3,$1,$1,'Pharmacy','Staff',$4::"UserStatus",$5::"Role",now())`,
    [id(`user_${key}`), organizationId, roleKey ? id(`role_${roleKey}`) : null, status, role]
  );
}

async function insertBranch(key: string, organizationId: string, active = true) {
  await client.query(
    `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode",active,"createdAt","updatedAt") VALUES ($1,$2,$3,$3,'Test','Lahore','PB',$4,now(),now())`,
    [id(`branch_${key}`), organizationId, key.toUpperCase(), active]
  );
}

async function assignments(userKey: string) {
  const rows = await client.query(
    `SELECT "branchId", active FROM pharmacy_branch_assignments WHERE "userId"=$1 ORDER BY "branchId"`,
    [id(`user_${userKey}`)]
  );
  return rows.rows.map((row) => [row.branchId, row.active]);
}

async function applyAsMigrator() {
  // Start with tenant context cleared and the platform flag off: only the migration's
  // own set_config may open row level security.
  await client.query(
    `SELECT set_config('app.is_platform_admin','false',true), set_config('app.current_organization_id','',true)`
  );
  await client.query(`SET LOCAL ROLE "${runtimeRole}"`);
  const [role] = (
    await client.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')
  ).rows;
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  await client.query(migration);
  await client.query('RESET ROLE');
  await client.query(`SELECT set_config('app.is_platform_admin','true',true)`);
}

(url ? describe : describe.skip)('pharmacy owner branch assignment backfill (#479)', () => {
  beforeAll(async () => {
    assertDisposableRlsDatabase(url!);
    await client.connect();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_platform_admin','true',true)`);
    await client.query(`CREATE ROLE "${runtimeRole}" NOSUPERUSER NOBYPASSRLS`);
    await client.query(`GRANT "${runtimeRole}" TO CURRENT_USER`);
    await client.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
    await client.query(
      `GRANT SELECT ON organizations, organization_roles, organization_role_permissions, users, pharmacy_branches TO "${runtimeRole}"`
    );
    await client.query(`GRANT SELECT, INSERT ON pharmacy_branch_assignments TO "${runtimeRole}"`);

    await insertOrg(org, 'PHARMACY');
    await insertOrg(other, 'PHARMACY');
    await insertOrg(restaurant, 'RESTAURANT');

    await insertBranch('main', org);
    await insertBranch('second', org);
    await insertBranch('closed', org, false);
    await insertBranch('other_main', other);

    await insertRole('owner', org, 'owner', true);
    await insertRole('owner_operator', org, 'owner-operator', true);
    await insertRole('admin', org, 'admin', true);
    await insertRole('administrator', org, 'administrator', true);
    await insertRole('fake_owner', org, 'owner', false);
    await insertRole('pharmacist', org, 'pharmacist', true);
    await insertRole('other_owner', other, 'owner', true);
    await insertRole('restaurant_owner', restaurant, 'owner', true);

    // Owner with no assignment at all: the population the QA finding describes.
    await insertUser('owner', org, 'owner', 'ACTIVE', 'ADMIN');
    await insertUser('owner_on_leave', org, 'owner', 'ON_LEAVE', 'ADMIN');
    await insertUser('owner_inactive', org, 'owner', 'INACTIVE', 'ADMIN');
    await insertUser('owner_operator', org, 'owner_operator', 'ACTIVE', 'ADMIN');
    // Owner with a deliberately deactivated MAIN row: it must stay deactivated.
    await insertUser('owner_revoked', org, 'owner', 'ACTIVE', 'ADMIN');
    // Admins keep only what was explicitly given to them.
    await insertUser('admin', org, 'admin', 'ACTIVE', 'ADMIN');
    await insertUser('administrator', org, 'administrator', 'ACTIVE', 'ADMIN');
    await insertUser('admin_no_role', org, null, 'ACTIVE', 'ADMIN');
    // A tenant-authored role reusing key 'owner' is not an Owner.
    await insertUser('fake_owner', org, 'fake_owner', 'ACTIVE', 'ADMIN');
    await insertUser('pharmacist', org, 'pharmacist');
    await insertUser('other_owner', other, 'other_owner', 'ACTIVE', 'ADMIN');
    await insertUser('restaurant_owner', restaurant, 'restaurant_owner', 'ACTIVE', 'ADMIN');

    await client.query(
      `INSERT INTO pharmacy_branch_assignments (id,"organizationId","branchId","userId",active,"updatedAt") VALUES ($1,$2,$3,$4,false,now()),($5,$2,$6,$7,true,now())`,
      [
        id('revoked_main'),
        org,
        id('branch_main'),
        id('user_owner_revoked'),
        id('admin_main'),
        id('branch_second'),
        id('user_admin'),
      ]
    );
    // A DENY on a system Owner role is not read or changed by the backfill.
    await client.query(
      `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'pharmacy:safety','DENY')`,
      [id('owner_deny'), org, id('role_owner')]
    );

    await applyAsMigrator();
  }, 60_000);

  afterAll(async () => {
    await client.query('ROLLBACK');
    await client.end();
  });

  it('is wrapped in its own transaction around the platform-admin set_config', () => {
    const lines = rawMigration.split('\n');
    const begin = lines.indexOf('BEGIN;');
    const setConfig = lines.findIndex((line) => line.includes('set_config'));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(setConfig).toBe(begin + 1);
    expect(rawMigration).toContain("set_config('app.is_platform_admin', 'true', true)");
    expect(lines.filter((line) => line.trim()).at(-1)).toBe('COMMIT;');
  });

  it('assigns active and on-leave system Owners to every active branch of their own pharmacy', async () => {
    const all = [
      [id('branch_main'), true],
      [id('branch_second'), true],
    ];
    expect(await assignments('owner')).toEqual(all);
    expect(await assignments('owner_on_leave')).toEqual(all);
    expect(await assignments('owner_operator')).toEqual(all);
    expect(await assignments('other_owner')).toEqual([[id('branch_other_main'), true]]);
  });

  it('never assigns an inactive branch, an inactive owner, or a non-pharmacy tenant', async () => {
    expect(await assignments('owner_inactive')).toEqual([]);
    expect(await assignments('restaurant_owner')).toEqual([]);
    const closed = await client.query(
      `SELECT count(*)::int AS n FROM pharmacy_branch_assignments WHERE "branchId"=$1`,
      [id('branch_closed')]
    );
    expect(closed.rows[0].n).toBe(0);
  });

  it('gives admins and administrators no extra branches beyond explicit ones', async () => {
    expect(await assignments('admin')).toEqual([[id('branch_second'), true]]);
    expect(await assignments('administrator')).toEqual([]);
    expect(await assignments('admin_no_role')).toEqual([]);
  });

  it('leaves tenant-authored owner lookalikes and other system roles untouched', async () => {
    expect(await assignments('fake_owner')).toEqual([]);
    expect(await assignments('pharmacist')).toEqual([]);
  });

  it('keeps a deactivated assignment row and an existing DENY unchanged', async () => {
    expect(await assignments('owner_revoked')).toEqual([
      [id('branch_main'), false],
      [id('branch_second'), true],
    ]);
    const revoked = await client.query(
      `SELECT id, active FROM pharmacy_branch_assignments WHERE id=$1`,
      [id('revoked_main')]
    );
    expect(revoked.rows).toEqual([{ id: id('revoked_main'), active: false }]);
    const deny = await client.query(
      `SELECT effect FROM organization_role_permissions WHERE id=$1`,
      [id('owner_deny')]
    );
    expect(deny.rows).toEqual([{ effect: 'DENY' }]);
  });

  it('is idempotent', async () => {
    const before = await client.query(
      `SELECT id, "branchId", "userId", active FROM pharmacy_branch_assignments WHERE "organizationId" IN ($1,$2) ORDER BY id`,
      [org, other]
    );
    await applyAsMigrator();
    const after = await client.query(
      `SELECT id, "branchId", "userId", active FROM pharmacy_branch_assignments WHERE "organizationId" IN ($1,$2) ORDER BY id`,
      [org, other]
    );
    expect(after.rows).toEqual(before.rows);
  });
});
