// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { can } from '@/lib/abac';
import type { AuthzDb } from '@/lib/authz';
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

const url = process.env.PHARMACY_TEST_OWNER_DATABASE_URL;
const client = new pg.Client({ connectionString: url });
const suffix = randomUUID().replaceAll('-', '');
const org = `qa130_${suffix}`;
const other = `${org}_other`;
const third = `${org}_third`;
const runtimeRole = `qa130_${suffix}`;
const id = (key: string) => `${org}_${key}`;
const migration = readFileSync(
  'prisma/migrations/20261021110000_canonical_pharmacy_capabilities/migration.sql',
  'utf8'
)
  .replace(/^BEGIN;$/m, '')
  .replace(/^COMMIT;$/m, '');
const managerProcurementMigration = readFileSync(
  'prisma/migrations/20261022100000_pharmacy_manager_procurement/migration.sql',
  'utf8'
);
const expiry = new Date('2035-01-02T00:00:00.000Z');
const expired = new Date('2020-01-02T00:00:00.000Z');
const legacy: Record<string, string[]> = {
  owner: ['pharmacy.*', 'pharmacy:orders'],
  pharmacist: ['pharmacy.dispense', 'pharmacy:catalogue-review'],
  manager: ['pharmacy.manage', 'pharmacy:orders'],
  cashier: ['pharmacy.counter', 'pharmacy:orders'],
  procurement: ['pharmacy.procurement'],
  inventory: ['pharmacy.inventory'],
  finance: ['pharmacy.finance'],
  auditor: ['pharmacy.audit'],
};

(url ? describe : describe.skip)('pharmacy canonical grant migration on PostgreSQL', () => {
  beforeAll(async () => {
    assertDisposableRlsDatabase(url!);
    await client.connect();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.is_platform_admin','true',true)`);
    await client.query(`CREATE ROLE "${runtimeRole}" NOSUPERUSER NOBYPASSRLS`);
    // PostgreSQL 16 requires explicit membership before a CREATEROLE principal
    // may SET ROLE; NOINHERIT keeps the grant from adding ambient authority.
    await client.query(`GRANT "${runtimeRole}" TO CURRENT_USER`);
    await client.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
    await client.query(
      `GRANT SELECT ON organization_roles, organization_role_permissions, user_permission_overrides, users TO "${runtimeRole}"`
    );
    for (const organizationId of [org, other, third]) {
      await client.query(
        `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode",vertical,"createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED','PHARMACY',now(),now())`,
        [organizationId]
      );
    }
    await client.query(
      `INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'Pharmacy','Pharmacy',now())`,
      [id('department'), org]
    );
    for (const template of PHARMACY_ROLE_TEMPLATES) {
      await client.query(
        `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,$3,$3,true,now())`,
        [id(template.key), org, template.key]
      );
      await client.query(
        `INSERT INTO users (id,"organizationId","organizationRoleId",name,email,department,title,"updatedAt") VALUES ($1,$2,$3,$1,$1,'Pharmacy','Staff',now())`,
        [id(`user_${template.key}`), org, id(template.key)]
      );
      for (const capability of legacy[template.key] ?? template.capabilities) {
        await client.query(
          `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,$4,'ALLOW')`,
          [id(`${template.key}_${capability}`), org, id(template.key), capability]
        );
      }
    }
    // Collision: an existing canonical DENY must survive a legacy ALLOW.
    await client.query(
      `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'pharmacy:counter','DENY')`,
      [id('deny'), org, id('cashier')]
    );
    await client.query(
      `INSERT INTO user_permission_overrides (id,"organizationId","userId",capability,effect,reason,"expiresAt","updatedAt") VALUES ($1,$3,$4,'pharmacy.dispense','ALLOW','legacy',now()+interval '1 day',now()),($2,$3,$4,'pharmacy:dispense','DENY','canonical',$5,now())`,
      [id('override_old'), id('override_new'), org, id('user_auditor'), expiry]
    );
    // Both collision directions, expired grants, and wildcard/dispense no-fanout.
    for (const [key, grants] of [
      ['owner', [['pharmacy.*', 'ALLOW', expiry]]],
      ['pharmacist', [['pharmacy.dispense', 'ALLOW', expiry]]],
      [
        'manager',
        [
          ['pharmacy.manage', 'DENY', expiry],
          ['pharmacy:manage', 'ALLOW', null],
        ],
      ],
      ['inventory', [['pharmacy.inventory', 'ALLOW', expired]]],
      ['procurement', [['pharmacy.procurement', 'DENY', expired]]],
    ] as const) {
      for (const [capability, effect, expiresAt] of grants) {
        await client.query(
          `INSERT INTO user_permission_overrides (id,"organizationId","userId",capability,effect,reason,"expiresAt","updatedAt") VALUES ($1,$2,$3,$4,$5,'legacy',$6,now())`,
          [
            id(`override_${key}_${capability}`),
            org,
            id(`user_${key}`),
            capability,
            effect,
            expiresAt,
          ]
        );
      }
    }
    // Owner backfill: an existing report DENY survives; a custom pharmacy.* role is not widened.
    // A custom role that merely reuses key 'owner' (isSystem=false) is not an Owner.
    for (const [key, roleKey, isSystem, roleOrg] of [
      ['other_owner', 'owner', true, other],
      ['other_custom', 'custom-all', false, other],
      ['other_fake_owner', 'owner', false, third],
    ] as const) {
      await client.query(
        `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,$3,$4,$5,now())`,
        [id(key), roleOrg, roleKey, `${key}`, isSystem]
      );
      await client.query(
        `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'pharmacy.*','ALLOW')`,
        [id(`${key}_star`), roleOrg, id(key)]
      );
    }
    await client.query(
      `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'reports:financial','DENY')`,
      [id('other_owner_deny'), other, id('other_owner')]
    );
    await client.query(migration);
    await client.query(managerProcurementMigration);
  }, 60_000);
  afterAll(async () => {
    await client.query('ROLLBACK');
    await client.end();
  });

  it('migrates each installed template, preserves collisions, and is idempotent', async () => {
    for (const template of PHARMACY_ROLE_TEMPLATES) {
      const rows = await client.query(
        `SELECT capability,effect FROM organization_role_permissions WHERE "organizationRoleId"=$1 ORDER BY capability`,
        [id(template.key)]
      );
      // Owner's redundant explicit order grant remains harmless and is not removed.
      const expected = [
        ...template.capabilities,
        ...(template.key === 'owner' ? ['pharmacy:orders'] : []),
      ].sort();
      expect(rows.rows.map((r) => r.capability)).toEqual(expected);
      if (template.key === 'cashier')
        expect(rows.rows.find((r) => r.capability === 'pharmacy:counter').effect).toBe('DENY');
    }
    const overrides = await client.query(
      `SELECT capability,effect,"expiresAt",reason FROM user_permission_overrides WHERE "userId"=$1`,
      [id('user_auditor')]
    );
    expect(overrides.rows).toEqual([
      { capability: 'pharmacy:dispense', effect: 'DENY', expiresAt: expiry, reason: 'canonical' },
    ]);
    for (const [key, capability, effect, expiresAt] of [
      ['pharmacist', 'pharmacy:dispense', 'ALLOW', expiry],
      ['manager', 'pharmacy:manage', 'DENY', expiry],
      ['inventory', 'pharmacy:inventory', 'ALLOW', expired],
      ['procurement', 'pharmacy:procurement', 'DENY', expired],
    ]) {
      const result = await client.query(
        `SELECT capability,effect,"expiresAt",reason FROM user_permission_overrides WHERE "userId"=$1`,
        [id(`user_${key}`)]
      );
      expect(result.rows).toEqual([{ capability, effect, expiresAt, reason: 'legacy' }]);
    }
    const before = await client.query(
      `SELECT * FROM user_permission_overrides WHERE "organizationId"=$1 ORDER BY id`,
      [org]
    );
    const rolesBefore = await client.query(
      `SELECT * FROM organization_role_permissions WHERE "organizationId" IN ($1,$2,$3) ORDER BY id`,
      [org, other, third]
    );
    const ownerOther = await client.query(
      `SELECT capability,effect FROM organization_role_permissions WHERE "organizationRoleId"=$1 ORDER BY capability`,
      [id('other_owner')]
    );
    expect(ownerOther.rows).toEqual([
      { capability: 'pharmacy:*', effect: 'ALLOW' },
      { capability: 'reports:financial', effect: 'DENY' },
      { capability: 'reports:operational', effect: 'ALLOW' },
    ]);
    const custom = await client.query(
      `SELECT capability FROM organization_role_permissions WHERE "organizationRoleId"=$1`,
      [id('other_custom')]
    );
    // Legacy pharmacy.* on a non-owner role expands to an explicit list without safety.
    expect(custom.rows.map((r) => r.capability).sort()).toEqual(
      [
        'pharmacy:catalogue-review',
        'pharmacy:counter',
        'pharmacy:dispense',
        'pharmacy:inventory',
        'pharmacy:manage',
        'pharmacy:orders',
        'pharmacy:procurement',
      ].sort()
    );
    const fakeOwner = await client.query(
      `SELECT capability FROM organization_role_permissions WHERE "organizationRoleId"=$1`,
      [id('other_fake_owner')]
    );
    expect(fakeOwner.rows.map((r) => r.capability).sort()).toEqual(
      custom.rows.map((r) => r.capability).sort()
    );
    const ownerOverride = await client.query(
      `SELECT capability FROM user_permission_overrides WHERE "userId"=$1 ORDER BY capability`,
      [id('user_owner')]
    );
    expect(ownerOverride.rows.map((r) => r.capability)).not.toContain('pharmacy:safety');
    expect(ownerOverride.rows.map((r) => r.capability)).not.toContain('pharmacy:*');
    expect(ownerOverride.rows).toHaveLength(7);
    await client.query('DROP TABLE pharmacy_capability_aliases');
    await client.query(migration);
    await client.query(managerProcurementMigration);
    expect(
      (
        await client.query(
          `SELECT * FROM user_permission_overrides WHERE "organizationId"=$1 ORDER BY id`,
          [org]
        )
      ).rows
    ).toEqual(before.rows);
    expect(
      (
        await client.query(
          `SELECT * FROM organization_role_permissions WHERE "organizationId" IN ($1,$2,$3) ORDER BY id`,
          [org, other, third]
        )
      ).rows
    ).toEqual(rolesBefore.rows);
  });

  it('enforces tenant RLS and authorizes migrated grants without coarse ADMIN authority', async () => {
    await client.query(`SET LOCAL ROLE "${runtimeRole}"`);
    await client.query(
      `SELECT set_config('app.is_platform_admin','false',true),set_config('app.current_organization_id',$1,true)`,
      [org]
    );
    const role = await client.query(
      'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const db = {
      user: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          const permissions = await client.query(
            `SELECT p.capability,p.effect FROM users u JOIN organization_role_permissions p ON p."organizationRoleId"=u."organizationRoleId" WHERE u.id=$1`,
            [where.id]
          );
          const overrides = await client.query(
            `SELECT capability,effect FROM user_permission_overrides WHERE "userId"=$1 AND ("expiresAt" IS NULL OR "expiresAt">now())`,
            [where.id]
          );
          return {
            organizationRole: { permissions: permissions.rows },
            permissionOverrides: overrides.rows,
          };
        },
      },
    } as unknown as AuthzDb;
    const subject = (key: string) => ({
      id: id(`user_${key}`),
      role: 'EMPLOYEE',
      department: 'Pharmacy',
      status: 'ACTIVE',
    });
    expect(await can(subject('pharmacist'), 'pharmacy:dispense', undefined, { db })).toBe(true);
    expect(await can(subject('pharmacist'), 'pharmacy:safety', undefined, { db })).toBe(false);
    expect(await can(subject('owner'), 'reports:financial', undefined, { db })).toBe(true);
    expect(await can(subject('manager'), 'pharmacy:procurement', undefined, { db })).toBe(true);
    expect(await can(subject('cashier'), 'pharmacy:orders', undefined, { db })).toBe(true);
    expect(await can(subject('cashier'), 'pharmacy:procurement', undefined, { db })).toBe(false);
    expect(await can(subject('auditor'), 'pharmacy:dispense', undefined, { db })).toBe(false);
    await client.query(`SELECT set_config('app.current_organization_id',$1,true)`, [other]);
    expect(await can(subject('pharmacist'), 'pharmacy:dispense', undefined, { db })).toBe(false);
    const forced = await client.query(
      `SELECT relname,relforcerowsecurity FROM pg_class WHERE relname IN ('organization_role_permissions','user_permission_overrides')`
    );
    expect(forced.rows).toHaveLength(2);
    expect(forced.rows.every((r) => r.relforcerowsecurity)).toBe(true);
    await client.query('RESET ROLE');
  });
});
