// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

const url = process.env.PHARMACY_TEST_OWNER_DATABASE_URL;
const client = new pg.Client({ connectionString: url });
const suffix = randomUUID().replaceAll('-', '');
const org = `qa979_${suffix}`;
const other = `${org}_other`;
const restaurant = `${org}_restaurant`;
const id = (key: string) => `${org}_${key}`;
const APPROVE = 'pharmacy:procurement-approve';
// The suite runs inside one transaction it rolls back, so the migration's own
// BEGIN/COMMIT are stripped; the set_config inside it still applies to the
// enclosing transaction exactly as it does to the migration's own. The column
// DDL is already applied by `prisma migrate`; it is left out here so the suite
// neither needs table ownership nor holds an exclusive lock on the table.
const migrationSql = readFileSync(
  'prisma/migrations/20261102140400_pharmacy_purchasing_authz/migration.sql',
  'utf8'
);
const migration = migrationSql
  .replace(/^BEGIN;$/m, '')
  .replace(/^COMMIT;$/m, '')
  .replace(/^ALTER TABLE .*;$/m, '');

async function approveGrant(roleId: string) {
  const rows = await client.query<{ effect: string; organizationId: string }>(
    `SELECT effect,"organizationId" FROM organization_role_permissions WHERE "organizationRoleId"=$1 AND capability=$2`,
    [roleId, APPROVE]
  );
  return rows.rows;
}

(url ? describe : describe.skip)('pharmacy procurement-approve backfill (#979)', () => {
  beforeAll(async () => {
    assertDisposableRlsDatabase(url!);
    await client.connect();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_platform_admin','true',true)`);
    for (const [organizationId, vertical] of [
      [org, 'PHARMACY'],
      [other, 'PHARMACY'],
      [restaurant, 'RESTAURANT'],
    ] as const) {
      await client.query(
        `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode",vertical,"createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',$2,now(),now())`,
        [organizationId, vertical]
      );
    }
    for (const [key, roleKey, isSystem, roleOrg] of [
      ['manager', 'manager', true, org],
      ['ownerop', 'owner-operator', true, org],
      ['denied', 'owner-operator', true, other],
      ['custom', 'manager', false, other],
      ['restaurant', 'manager', true, restaurant],
      ['procurement', 'procurement', true, org],
      ['cashier', 'cashier', true, org],
    ] as const) {
      await client.query(
        `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,$3,$3,$4,now())`,
        [id(key), roleOrg, roleKey, isSystem]
      );
    }
    // An explicit DENY on the new capability must survive the backfill.
    await client.query(
      `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,$4,'DENY')`,
      [id('denied_approve'), other, id('denied'), APPROVE]
    );
    // Reset the session flag so only the migration's own set_config can make
    // the backfill visible under FORCE RLS.
    await client.query(`SELECT set_config('app.is_platform_admin','',true)`);
    await client.query(migration);
    await client.query(`SELECT set_config('app.is_platform_admin','true',true)`);
  }, 60_000);
  afterAll(async () => {
    await client.query('ROLLBACK');
    await client.end();
  });

  it('grants approval to the system Manager and Owner / Operator roles in their own tenant', async () => {
    expect(await approveGrant(id('manager'))).toEqual([{ effect: 'ALLOW', organizationId: org }]);
    expect(await approveGrant(id('ownerop'))).toEqual([{ effect: 'ALLOW', organizationId: org }]);
  });

  it('keeps an existing DENY', async () => {
    expect(await approveGrant(id('denied'))).toEqual([{ effect: 'DENY', organizationId: other }]);
  });

  it('does not widen custom lookalikes, other verticals or other roles', async () => {
    for (const key of ['custom', 'restaurant', 'procurement', 'cashier']) {
      expect(await approveGrant(id(key))).toEqual([]);
    }
  });

  it('wraps the backfill in its own transaction so set_config applies', () => {
    expect(migrationSql).toMatch(/^BEGIN;$/m);
    expect(migrationSql).toMatch(/^COMMIT;$/m);
    expect(migrationSql.indexOf('BEGIN;')).toBeLessThan(migrationSql.indexOf('SELECT set_config'));
    expect(migration).not.toMatch(/ALTER TABLE/);
  });

  it('leaves a nullable licence filer column and is idempotent', async () => {
    const column = await client.query(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name='pharmacy_supplier_licences' AND column_name='recordedByUserId'`
    );
    expect(column.rows).toEqual([{ is_nullable: 'YES' }]);
    const before = await client.query(
      `SELECT * FROM organization_role_permissions WHERE "organizationId" IN ($1,$2,$3) ORDER BY id`,
      [org, other, restaurant]
    );
    await client.query(migration);
    const after = await client.query(
      `SELECT * FROM organization_role_permissions WHERE "organizationId" IN ($1,$2,$3) ORDER BY id`,
      [org, other, restaurant]
    );
    expect(after.rows).toEqual(before.rows);
  });
});
