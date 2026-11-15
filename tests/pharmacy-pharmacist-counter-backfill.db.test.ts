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
const org = `qa1241_${suffix}`;
const other = `${org}_other`;
const restaurant = `${org}_restaurant`;
const id = (key: string) => `${org}_${key}`;
const migration = readFileSync(
  'prisma/migrations/20261115140000_pharmacy_pharmacist_counter_capability/migration.sql',
  'utf8'
)
  .replace(/^BEGIN;$/m, '')
  .replace(/^COMMIT;$/m, '');
// The base grants the Pharmacist template carried before #1241.
const previousTemplate = ['pharmacy:catalogue-review', 'pharmacy:close', 'pharmacy:dispense'];
const pharmacist = PHARMACY_ROLE_TEMPLATES.find((role) => role.key === 'pharmacist')!;

async function grants(roleId: string) {
  const rows = await client.query<{ capability: string; effect: string }>(
    `SELECT capability,effect FROM organization_role_permissions WHERE "organizationRoleId"=$1 ORDER BY capability`,
    [roleId]
  );
  return rows.rows;
}

const allow = (capabilities: string[]) =>
  [...capabilities].sort().map((capability) => ({ capability, effect: 'ALLOW' }));

(url ? describe : describe.skip)('pharmacy Pharmacist counter backfill (#1241)', () => {
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
      ['system', 'pharmacist', true, org],
      ['denied', 'pharmacist', true, other],
      ['custom', 'pharmacist', false, other],
      ['restaurant', 'pharmacist', true, restaurant],
      ['finance', 'finance', true, org],
    ] as const) {
      await client.query(
        `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,$3,$3,$4,now())`,
        [id(key), roleOrg, roleKey, isSystem]
      );
      const seeded = roleKey === 'pharmacist' ? previousTemplate : ['reports:financial'];
      for (const capability of seeded) {
        await client.query(
          `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,$4,'ALLOW')`,
          [id(`${key}_${capability}`), roleOrg, id(key), capability]
        );
      }
    }
    // An explicit DENY on the newly templated capability must survive the backfill.
    await client.query(
      `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'pharmacy:counter','DENY')`,
      [id('denied_counter'), other, id('denied')]
    );
    await client.query(migration);
  }, 60_000);
  afterAll(async () => {
    await client.query('ROLLBACK');
    await client.end();
  });

  it('adds pharmacy:counter to the system Pharmacist role', async () => {
    expect(pharmacist.capabilities).toContain('pharmacy:counter');
    expect(await grants(id('system'))).toEqual(allow([...previousTemplate, 'pharmacy:counter']));
  });

  it('keeps an existing DENY', async () => {
    expect(await grants(id('denied'))).toEqual(
      [...previousTemplate, 'pharmacy:counter'].sort().map((capability) => ({
        capability,
        effect: capability === 'pharmacy:counter' ? 'DENY' : 'ALLOW',
      }))
    );
  });

  it('does not widen custom lookalikes, other verticals or other roles', async () => {
    expect(await grants(id('custom'))).toEqual(allow(previousTemplate));
    expect(await grants(id('restaurant'))).toEqual(allow(previousTemplate));
    expect(await grants(id('finance'))).toEqual(allow(['reports:financial']));
  });

  it('writes the grant into the role organization and is idempotent', async () => {
    const tenants = await client.query<{ mismatched: number }>(
      `SELECT count(*)::int AS mismatched FROM organization_role_permissions p JOIN organization_roles r ON r.id=p."organizationRoleId" WHERE r."organizationId" IN ($1,$2,$3) AND p."organizationId"<>r."organizationId"`,
      [org, other, restaurant]
    );
    expect(tenants.rows[0]!.mismatched).toBe(0);
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
