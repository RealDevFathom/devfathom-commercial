// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

const url = process.env.PHARMACY_TEST_OWNER_DATABASE_URL;
const suffix = randomUUID().replaceAll('-', '');
const org = `dev505_${suffix}`;
const other = `${org}_other`;
// organization_roles is unique on (organizationId, key): the tenant-authored
// lookalike needs its own organization beside the denied system Manager.
const customOrg = `${org}_custom`;
const restaurant = `${org}_restaurant`;
const id = (key: string) => `${org}_${key}`;
const INVENTORY = 'pharmacy:inventory';
// The suite runs inside one transaction it rolls back, so the migration's own
// BEGIN/COMMIT are stripped; the set_config inside it still applies to the
// enclosing transaction exactly as it does to the migration's own.
const migrationSql = readFileSync(
  'prisma/migrations/20261115140000_pharmacy_manager_inventory/migration.sql',
  'utf8'
);
const migration = migrationSql.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');

(url ? describe : describe.skip)('pharmacy Manager inventory backfill (DEV-505)', () => {
  const client = new pg.Client({ connectionString: url });

  async function inventoryGrant(roleId: string) {
    const rows = await client.query<{ effect: string; organizationId: string }>(
      `SELECT effect,"organizationId" FROM organization_role_permissions WHERE "organizationRoleId"=$1 AND capability=$2`,
      [roleId, INVENTORY]
    );
    return rows.rows;
  }

  beforeAll(async () => {
    assertDisposableRlsDatabase(url!);
    await client.connect();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_platform_admin','true',true)`);
    for (const [organizationId, vertical] of [
      [org, 'PHARMACY'],
      [other, 'PHARMACY'],
      [customOrg, 'PHARMACY'],
      [restaurant, 'RESTAURANT'],
    ] as const) {
      await client.query(
        `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode",vertical,"createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',$2,now(),now())`,
        [organizationId, vertical]
      );
    }
    for (const [key, roleKey, isSystem, roleOrg] of [
      ['manager', 'manager', true, org],
      ['denied', 'manager', true, other],
      ['custom', 'manager', false, customOrg],
      ['restaurant', 'manager', true, restaurant],
      ['cashier', 'cashier', true, org],
    ] as const) {
      await client.query(
        `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,$3,$3,$4,now())`,
        [id(key), roleOrg, roleKey, isSystem]
      );
    }
    // An explicit DENY on the capability must survive the backfill.
    await client.query(
      `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,$4,'DENY')`,
      [id('denied_inventory'), other, id('denied'), INVENTORY]
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

  it('grants inventory to the system Manager role in its own tenant', async () => {
    expect(await inventoryGrant(id('manager'))).toEqual([{ effect: 'ALLOW', organizationId: org }]);
  });

  it('keeps an existing DENY', async () => {
    expect(await inventoryGrant(id('denied'))).toEqual([{ effect: 'DENY', organizationId: other }]);
  });

  it('does not widen custom lookalikes, other verticals or other roles', async () => {
    for (const key of ['custom', 'restaurant', 'cashier']) {
      expect(await inventoryGrant(id(key))).toEqual([]);
    }
  });

  it('is idempotent', async () => {
    const read = () =>
      client.query(
        `SELECT * FROM organization_role_permissions WHERE "organizationId" IN ($1,$2,$3,$4) ORDER BY id`,
        [org, other, customOrg, restaurant]
      );
    const before = await read();
    await client.query(migration);
    expect((await read()).rows).toEqual(before.rows);
  });
});

describe('pharmacy Manager inventory backfill migration shape (DEV-505)', () => {
  it('wraps the backfill in its own transaction so set_config applies', () => {
    expect(migrationSql).toMatch(/^BEGIN;$/m);
    expect(migrationSql).toMatch(/^COMMIT;$/m);
    expect(migrationSql.indexOf('BEGIN;')).toBeLessThan(migrationSql.indexOf('SELECT set_config'));
    expect(migrationSql).toMatch(/ON CONFLICT \("organizationRoleId", "capability"\) DO NOTHING/);
  });
});
