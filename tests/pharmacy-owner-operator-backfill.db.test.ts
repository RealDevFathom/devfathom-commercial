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
const org = `qa975_${suffix}`;
const other = `${org}_other`;
const restaurant = `${org}_restaurant`;
const id = (key: string) => `${org}_${key}`;
const migration = readFileSync(
  'prisma/migrations/20261101172600_pharmacy_owner_operator_operational_capabilities/migration.sql',
  'utf8'
)
  .replace(/^BEGIN;$/m, '')
  .replace(/^COMMIT;$/m, '');
// The six grants the Owner / Operator template carried before #975.
const previousTemplate = [
  'reports:operational',
  'reports:financial',
  'pharmacy:orders',
  'pharmacy:dispense',
  'pharmacy:catalogue-review',
  'pharmacy:safety',
];
const ownerOperator = PHARMACY_ROLE_TEMPLATES.find((role) => role.key === 'owner-operator')!;
// `pharmacy:procurement-approve` joined the template later and is backfilled by
// its own migration (20261101200000_pharmacy_purchasing_authz, covered by
// tests/pharmacy-procurement-approve-backfill.db.test.ts).
const template = {
  ...ownerOperator,
  capabilities: ownerOperator.capabilities.filter(
    (capability) => capability !== 'pharmacy:procurement-approve'
  ),
};

async function grants(roleId: string) {
  const rows = await client.query<{ capability: string; effect: string }>(
    `SELECT capability,effect FROM organization_role_permissions WHERE "organizationRoleId"=$1 ORDER BY capability`,
    [roleId]
  );
  return rows.rows;
}

(url ? describe : describe.skip)('pharmacy Owner / Operator backfill (#975)', () => {
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
      ['system', 'owner-operator', true, org],
      ['denied', 'owner-operator', true, other],
      ['custom', 'owner-operator', false, other],
      ['restaurant', 'owner-operator', true, restaurant],
      ['cashier', 'cashier', true, org],
    ] as const) {
      await client.query(
        `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,$3,$3,$4,now())`,
        [id(key), roleOrg, roleKey, isSystem]
      );
      const seeded = roleKey === 'owner-operator' ? previousTemplate : ['pharmacy:counter'];
      for (const capability of seeded) {
        await client.query(
          `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,$4,'ALLOW')`,
          [id(`${key}_${capability}`), roleOrg, id(key), capability]
        );
      }
    }
    // An explicit DENY on a newly templated capability must survive the backfill.
    await client.query(
      `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'pharmacy:close','DENY')`,
      [id('denied_close'), other, id('denied')]
    );
    await client.query(migration);
  }, 60_000);
  afterAll(async () => {
    await client.query('ROLLBACK');
    await client.end();
  });

  it('adds every missing template capability to the system Owner / Operator role', async () => {
    expect(template.capabilities).toEqual(expect.arrayContaining(previousTemplate));
    expect(await grants(id('system'))).toEqual(
      [...template.capabilities].sort().map((capability) => ({ capability, effect: 'ALLOW' }))
    );
  });

  it('keeps an existing DENY and adds the remaining grants', async () => {
    expect(await grants(id('denied'))).toEqual(
      [...template.capabilities].sort().map((capability) => ({
        capability,
        effect: capability === 'pharmacy:close' ? 'DENY' : 'ALLOW',
      }))
    );
  });

  it('does not widen custom lookalikes, other verticals or other roles', async () => {
    const previous = [...previousTemplate].sort().map((capability) => ({
      capability,
      effect: 'ALLOW',
    }));
    expect(await grants(id('custom'))).toEqual(previous);
    expect(await grants(id('restaurant'))).toEqual(previous);
    expect(await grants(id('cashier'))).toEqual([
      { capability: 'pharmacy:counter', effect: 'ALLOW' },
    ]);
  });

  it('writes each backfilled grant into the role organization and is idempotent', async () => {
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
