// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

const url = process.env.PHARMACY_TEST_OWNER_DATABASE_URL;
const client = new pg.Client({ connectionString: url });
const suffix = randomUUID().replaceAll('-', '');
const org = `qa622_${suffix}`;
/** Already holds a tenant-authored role under the same key. */
const taken = `${org}_taken`;
const restaurant = `${org}_restaurant`;
const migration = readFileSync(
  'prisma/migrations/20261116100200_pharmacy_pharmacist_cashier_role/migration.sql',
  'utf8'
)
  .replace(/^BEGIN;$/m, '')
  .replace(/^COMMIT;$/m, '');
const template = PHARMACY_ROLE_TEMPLATES.find((role) => role.key === 'pharmacist-cashier')!;

async function role(organizationId: string) {
  const rows = await client.query<{
    id: string;
    name: string;
    description: string | null;
    isSystem: boolean;
  }>(
    `SELECT id,name,description,"isSystem" FROM organization_roles WHERE "organizationId"=$1 AND key='pharmacist-cashier'`,
    [organizationId]
  );
  return rows.rows;
}

async function grants(roleId: string) {
  const rows = await client.query<{ capability: string; effect: string }>(
    `SELECT capability,effect FROM organization_role_permissions WHERE "organizationRoleId"=$1 ORDER BY capability`,
    [roleId]
  );
  return rows.rows;
}

(url ? describe : describe.skip)('pharmacy Pharmacist and cashier role (DEV-622)', () => {
  beforeAll(async () => {
    assertDisposableRlsDatabase(url!);
    await client.connect();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_platform_admin','true',true)`);
    for (const [organizationId, vertical] of [
      [org, 'PHARMACY'],
      [taken, 'PHARMACY'],
      [restaurant, 'RESTAURANT'],
    ] as const) {
      await client.query(
        `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode",vertical,"createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED',$2,now(),now())`,
        [organizationId, vertical]
      );
    }
    // A tenant-authored role that already uses the key, with one narrow grant.
    await client.query(
      `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,'pharmacist-cashier','Our own till role',false,now())`,
      [`${taken}_custom`, taken]
    );
    await client.query(
      `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'pharmacy:counter','ALLOW')`,
      [`${taken}_custom_counter`, taken, `${taken}_custom`]
    );
    await client.query(migration);
  }, 60_000);
  afterAll(async () => {
    await client.query('ROLLBACK');
    await client.end();
  });

  it('creates the system role with the template grants and description', async () => {
    const [created] = await role(org);
    expect(created).toMatchObject({
      name: template.name,
      description: template.description,
      isSystem: true,
    });
    expect(await grants(created!.id)).toEqual(
      [...template.capabilities].sort().map((capability) => ({ capability, effect: 'ALLOW' }))
    );
  });

  it('assigns the role to nobody', async () => {
    const [created] = await role(org);
    const users = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM users WHERE "organizationRoleId"=$1`,
      [created!.id]
    );
    expect(users.rows[0]!.count).toBe(0);
  });

  it('leaves a tenant role that already uses the key, and other verticals, untouched', async () => {
    expect(await role(taken)).toEqual([
      { id: `${taken}_custom`, name: 'Our own till role', description: null, isSystem: false },
    ]);
    expect(await grants(`${taken}_custom`)).toEqual([
      { capability: 'pharmacy:counter', effect: 'ALLOW' },
    ]);
    expect(await role(restaurant)).toEqual([]);
  });

  it('writes every row into the role organization and is idempotent', async () => {
    const tenants = await client.query<{ mismatched: number }>(
      `SELECT count(*)::int AS mismatched FROM organization_role_permissions p JOIN organization_roles r ON r.id=p."organizationRoleId" WHERE r."organizationId" IN ($1,$2,$3) AND p."organizationId"<>r."organizationId"`,
      [org, taken, restaurant]
    );
    expect(tenants.rows[0]!.mismatched).toBe(0);
    const snapshot = () =>
      client.query(
        `SELECT r.id, r.key, p.capability FROM organization_roles r LEFT JOIN organization_role_permissions p ON p."organizationRoleId"=r.id WHERE r."organizationId" IN ($1,$2,$3) ORDER BY r.id, p.capability`,
        [org, taken, restaurant]
      );
    const before = await snapshot();
    await client.query(migration);
    expect((await snapshot()).rows).toEqual(before.rows);
  });
});
