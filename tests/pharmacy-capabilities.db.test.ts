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
const restaurant = `${org}_restaurant`;
const lookalike = `${org}_lookalike`;
const late = `${org}_late`;
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
const administratorReportsMigration = readFileSync(
  'prisma/migrations/20261029000258_pharmacy_administrator_reports/migration.sql',
  'utf8'
);
// DEV-32/DEV-739 rollout phase 1: day close is for managers and owners only. Removes
// the close ALLOW #654's Pharmacist template had granted. Existing system Managers gain
// close only in phase 2, after the branch-assignment close gate is serving (see
// docs/operations/pharmacy-day-close-rollout.md).
const dayCloseMigration = readFileSync(
  'prisma/migrations/20261104120000_pharmacy_pharmacist_day_close_revoke/migration.sql',
  'utf8'
)
  .replace(/^BEGIN;$/m, '')
  .replace(/^COMMIT;$/m, '');
// Rollout phase 2 (not a migration in this release; see the runbook). Tested here so
// the SQL that will ship as the phase 2 migration is the SQL that was tested.
const dayClosePhase2 = readFileSync('docs/operations/sql/pharmacy-day-close-phase2.sql', 'utf8')
  .replace(/^BEGIN;$/m, '')
  .replace(/^COMMIT;$/m, '');
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
    // PostgreSQL 16 no longer gives a CREATEROLE user an implicit right to SET ROLE
    // to roles it creates. Make the test owner an explicit member before exercising RLS.
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
    // Legacy pharmacy bootstrap roles are not canonical Owner templates. Both historical keys
    // need operational reports, while a tenant-authored lookalike and an explicit DENY stay put.
    for (const [key, roleKey, isSystem, roleOrg] of [
      ['administrator', 'administrator', true, org],
      ['admin', 'admin', true, other],
      ['custom_administrator', 'administrator', false, third],
    ] as const) {
      await client.query(
        `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,$3,$3,$4,now())`,
        [id(key), roleOrg, roleKey, isSystem]
      );
    }
    await client.query(
      `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'reports:operational','DENY')`,
      [id('admin_reports_deny'), other, id('admin')]
    );
    // Day-close reconciliation (DEV-32/DEV-739). Each role starts with the stated
    // 'pharmacy:close' row (or none). Only system roles in PHARMACY organizations
    // change; an explicit DENY is never removed or overridden.
    await client.query(
      `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode",vertical,"createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED','RESTAURANT',now(),now())`,
      [restaurant]
    );
    // (organizationId, key) is unique, so tenant-authored lookalikes keyed
    // 'pharmacist'/'manager' (isSystem=false) live in their own PHARMACY org.
    await client.query(
      `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode",vertical,"createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED','PHARMACY',now(),now())`,
      [lookalike]
    );
    for (const [key, roleKey, isSystem, roleOrg, close] of [
      // A Pharmacist provisioned from #654's template carries the ALLOW: removed.
      ['templated_pharmacist', 'pharmacist', true, other, 'ALLOW'],
      // An explicit DENY stays a DENY.
      ['denied_pharmacist', 'pharmacist', true, third, 'DENY'],
      // Tenant-authored lookalike and another vertical are untouched.
      ['custom_pharmacist', 'pharmacist', false, lookalike, 'ALLOW'],
      ['restaurant_pharmacist', 'pharmacist', true, restaurant, 'ALLOW'],
      // Phase 1 grants no Manager anything; a Manager's DENY stays a DENY.
      ['other_manager', 'manager', true, other, null],
      ['denied_manager', 'manager', true, third, 'DENY'],
      ['custom_manager', 'manager', false, lookalike, null],
      ['restaurant_manager', 'manager', true, restaurant, null],
    ] as const) {
      await client.query(
        `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,$3,$4,$5,now())`,
        [id(key), roleOrg, roleKey, key, isSystem]
      );
      await client.query(
        `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'pharmacy:dispense','ALLOW')`,
        [id(`${key}_dispense`), roleOrg, id(key)]
      );
      if (close)
        await client.query(
          `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'pharmacy:close',$4)`,
          [id(`${key}_close`), roleOrg, id(key), close]
        );
    }
    await client.query(migration);
    await client.query(managerProcurementMigration);
    await client.query(administratorReportsMigration);
    await client.query(dayCloseMigration);
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
      // An installed Manager gains the template's 'pharmacy:close' only in rollout
      // phase 2, after the branch-assignment close gate is live (DEV-739).
      const expected = [
        ...template.capabilities.filter(
          (capability) => !(template.key === 'manager' && capability === 'pharmacy:close')
        ),
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
      `SELECT * FROM organization_role_permissions WHERE "organizationId" IN ($1,$2,$3,$4,$5) ORDER BY id`,
      [org, other, third, restaurant, lookalike]
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
    const administrator = await client.query(
      `SELECT capability,effect FROM organization_role_permissions WHERE "organizationRoleId"=$1`,
      [id('administrator')]
    );
    expect(administrator.rows).toEqual([{ capability: 'reports:operational', effect: 'ALLOW' }]);
    const deniedAdministrator = await client.query(
      `SELECT capability,effect FROM organization_role_permissions WHERE "organizationRoleId"=$1`,
      [id('admin')]
    );
    expect(deniedAdministrator.rows).toEqual([
      { capability: 'reports:operational', effect: 'DENY' },
    ]);
    const customAdministrator = await client.query(
      `SELECT capability FROM organization_role_permissions WHERE "organizationRoleId"=$1`,
      [id('custom_administrator')]
    );
    expect(customAdministrator.rows).toEqual([]);
    const dispense = { capability: 'pharmacy:dispense', effect: 'ALLOW' };
    const close = (effect: 'ALLOW' | 'DENY') => ({ capability: 'pharmacy:close', effect });
    const procurement = { capability: 'pharmacy:procurement', effect: 'ALLOW' };
    for (const [key, expected] of [
      ['templated_pharmacist', [dispense]],
      ['denied_pharmacist', [close('DENY'), dispense]],
      ['custom_pharmacist', [close('ALLOW'), dispense]],
      ['restaurant_pharmacist', [close('ALLOW'), dispense]],
      // System Managers also hold #375's procurement backfill (20261022100000).
      ['other_manager', [dispense, procurement]],
      ['denied_manager', [close('DENY'), dispense, procurement]],
      ['custom_manager', [dispense]],
      ['restaurant_manager', [dispense]],
    ] as const) {
      const rows = await client.query(
        `SELECT capability,effect FROM organization_role_permissions WHERE "organizationRoleId"=$1 ORDER BY capability`,
        [id(key)]
      );
      expect({ key, rows: rows.rows }).toEqual({ key, rows: expected });
    }
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
    await client.query(administratorReportsMigration);
    await client.query(dayCloseMigration);
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
          `SELECT * FROM organization_role_permissions WHERE "organizationId" IN ($1,$2,$3,$4,$5) ORDER BY id`,
          [org, other, third, restaurant, lookalike]
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
    // Day close: managers and owners only (DEV-32/DEV-739), never a pharmacist or cashier.
    // An installed Manager role is granted in rollout phase 2; a Manager provisioned
    // from the current template already holds it (pharmacy-sales.branch-scope.test.ts).
    for (const [key, allowed] of [
      ['pharmacist', false],
      ['cashier', false],
      ['manager', false],
      ['owner', true],
      ['owner-operator', true],
    ] as const) {
      expect({
        key,
        allowed: await can(subject(key), 'pharmacy:close', undefined, { db }),
      }).toEqual({ key, allowed });
    }
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

  it('rollout phase 2 grants installed Managers, removes late Pharmacist grants, keeps DENYs', async () => {
    const closeRows = (role: string) =>
      client
        .query(
          `SELECT capability,effect FROM organization_role_permissions WHERE "organizationRoleId"=$1 AND capability='pharmacy:close'`,
          [id(role)]
        )
        .then((result) => result.rows);
    await client.query(`SELECT set_config('app.is_platform_admin','true',true)`);
    // A previous revision provisioned a Pharmacist from the old template during phase 1.
    await client.query(
      `INSERT INTO organizations (id,slug,"legalName","displayName",status,"deploymentMode",vertical,"createdAt","updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE','SHARED','PHARMACY',now(),now())`,
      [late]
    );
    await client.query(
      `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,'pharmacist','Pharmacist',true,now())`,
      [id('late_pharmacist'), late]
    );
    await client.query(
      `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,'pharmacy:close','ALLOW')`,
      [id('late_pharmacist_close'), late, id('late_pharmacist')]
    );
    await client.query(dayClosePhase2);
    expect(await closeRows('late_pharmacist')).toEqual([]);
    expect(await closeRows('templated_pharmacist')).toEqual([]);
    expect(await closeRows('denied_pharmacist')).toEqual([
      { capability: 'pharmacy:close', effect: 'DENY' },
    ]);
    expect(await closeRows('manager')).toEqual([{ capability: 'pharmacy:close', effect: 'ALLOW' }]);
    expect(await closeRows('other_manager')).toEqual([
      { capability: 'pharmacy:close', effect: 'ALLOW' },
    ]);
    expect(await closeRows('denied_manager')).toEqual([
      { capability: 'pharmacy:close', effect: 'DENY' },
    ]);
    expect(await closeRows('custom_manager')).toEqual([]);
    expect(await closeRows('restaurant_manager')).toEqual([]);
    expect(await closeRows('custom_pharmacist')).toEqual([
      { capability: 'pharmacy:close', effect: 'ALLOW' },
    ]);
    expect(await closeRows('restaurant_pharmacist')).toEqual([
      { capability: 'pharmacy:close', effect: 'ALLOW' },
    ]);
    // An installed Manager now matches its template exactly.
    const managerTemplate = PHARMACY_ROLE_TEMPLATES.find((role) => role.key === 'manager')!;
    expect(
      (
        await client.query(
          `SELECT capability FROM organization_role_permissions WHERE "organizationRoleId"=$1 ORDER BY capability`,
          [id('manager')]
        )
      ).rows.map((row) => row.capability)
    ).toEqual([...managerTemplate.capabilities].sort());
    const orgs = [org, other, third, restaurant, lookalike, late];
    const snapshot = () =>
      client
        .query(
          `SELECT * FROM organization_role_permissions WHERE "organizationId" = ANY($1) ORDER BY id`,
          [orgs]
        )
        .then((result) => result.rows);
    const once = await snapshot();
    await client.query(dayClosePhase2);
    expect(await snapshot()).toEqual(once);

    // The real can(), as the restricted runtime role: an installed Manager now closes.
    await client.query(`SET LOCAL ROLE "${runtimeRole}"`);
    await client.query(
      `SELECT set_config('app.is_platform_admin','false',true),set_config('app.current_organization_id',$1,true)`,
      [org]
    );
    const db = {
      user: {
        findUnique: async ({ where }: { where: { id: string } }) => ({
          organizationRole: {
            permissions: (
              await client.query(
                `SELECT p.capability,p.effect FROM users u JOIN organization_role_permissions p ON p."organizationRoleId"=u."organizationRoleId" WHERE u.id=$1`,
                [where.id]
              )
            ).rows,
          },
          permissionOverrides: (
            await client.query(
              `SELECT capability,effect FROM user_permission_overrides WHERE "userId"=$1 AND ("expiresAt" IS NULL OR "expiresAt">now())`,
              [where.id]
            )
          ).rows,
        }),
      },
    } as unknown as AuthzDb;
    for (const [key, allowed] of [
      ['manager', true],
      ['pharmacist', false],
      ['cashier', false],
    ] as const) {
      expect({
        key,
        allowed: await can(
          { id: id(`user_${key}`), role: 'EMPLOYEE', department: 'Pharmacy', status: 'ACTIVE' },
          'pharmacy:close',
          undefined,
          { db }
        ),
      }).toEqual({ key, allowed });
    }
    await client.query('RESET ROLE');
  });
});
