/**
 * WHA-874 restricted-role acceptance for the shared Restaurant branch guard.
 *
 * Requires a migrated disposable TEST_DATABASE_URL reached as LOGIN,
 * NOSUPERUSER, NOBYPASSRLS plus WHA874_TEST_OWNER_DATABASE_URL for fixture
 * setup. Production, preview, and shared fixture databases are forbidden.
 */
import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { seedDepartments } from '@/lib/test-support/departments';
import { ALL_VERTICALS } from '@/lib/vertical-catalog';
import type { TRPCContext } from '@/server/trpc';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.WHA874_TEST_OWNER_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const describeIfDatabase = TEST_DATABASE_URL && OWNER_DATABASE_URL ? describe : describe.skip;
const restaurantVertical = ALL_VERTICALS.find((vertical) => vertical !== 'AGENCY')!;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ids = {
  orgA: `org_wha874_a_${suffix}`,
  orgB: `org_wha874_b_${suffix}`,
  branchA: `branch_wha874_a_${suffix}`,
  branchB: `branch_wha874_b_${suffix}`,
  branchOther: `branch_wha874_other_${suffix}`,
  gmRole: `role_wha874_gm_${suffix}`,
  accountantRole: `role_wha874_accountant_${suffix}`,
  configuratorRole: `role_wha874_config_${suffix}`,
  gm: `user_wha874_gm_${suffix}`,
  accountant: `user_wha874_accountant_${suffix}`,
  configurator: `user_wha874_config_${suffix}`,
  gmStaff: `staff_wha874_gm_${suffix}`,
  accountantStaff: `staff_wha874_accountant_${suffix}`,
};

type Deps = {
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  requireRestaurantBranchScope: (typeof import('./restaurant-branch-scope'))['requireRestaurantBranchScope'];
};

let deps: Deps;
let dbA: ScopedDb;
let dbB: ScopedDb;

function context(db: ScopedDb, userId: string, organizationId: string): TRPCContext {
  return {
    db,
    session: {
      expires: 'later',
      user: {
        id: userId,
        organizationId,
        role: 'EMPLOYEE',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
    entitlements: {
      organizationId,
      enabledModules: ['restaurant-core', 'restaurant-pos'],
      activeSeats: 3,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
  } as unknown as TRPCContext;
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL || !OWNER_DATABASE_URL) return;
  expect(OWNER_DATABASE_URL).not.toBe(TEST_DATABASE_URL);

  const owner = new Client({ connectionString: OWNER_DATABASE_URL });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    await owner.query(`SET LOCAL app.is_platform_admin = 'true'`);
    await owner.query(
      `INSERT INTO "organizations"
        ("id", "slug", "legalName", "displayName", "vertical", "status", "deploymentMode", "createdAt", "updatedAt")
       VALUES
        ($1, $2, 'WHA-874 A', 'WHA-874 A', $5, 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($3, $4, 'WHA-874 B', 'WHA-874 B', $5, 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.orgA, `wha874-a-${suffix}`, ids.orgB, `wha874-b-${suffix}`, restaurantVertical]
    );
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await owner.end();
  }

  const [scoped, branchScope] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./restaurant-branch-scope'),
  ]);
  deps = {
    createTenantDb: scoped.createTenantDb,
    withTenantDb: scoped.withTenantDb,
    requireRestaurantBranchScope: branchScope.requireRestaurantBranchScope,
  };

  await deps.withTenantDb(ids.orgA, async (tx) => {
    await seedDepartments(tx, [ids.orgA], ['LEADERSHIP']);
    await tx.restaurantBranch.createMany({
      data: [
        { id: ids.branchA, name: 'Primary' },
        { id: ids.branchB, name: 'Assigned' },
      ],
    });
    for (const role of [
      {
        id: ids.gmRole,
        key: `gm-${suffix}`,
        name: 'General Manager',
        capabilities: ['money:read'],
      },
      {
        id: ids.accountantRole,
        key: `accountant-${suffix}`,
        name: 'Accountant',
        capabilities: ['money:read'],
      },
      {
        id: ids.configuratorRole,
        key: `configurator-${suffix}`,
        name: 'Configurator',
        capabilities: ['money:read', 'restaurant:configure'],
      },
    ]) {
      await tx.organizationRole.create({
        data: {
          id: role.id,
          key: role.key,
          name: role.name,
          permissions: {
            create: role.capabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
          },
        },
      });
    }
    for (const user of [
      { id: ids.gm, roleId: ids.gmRole, name: 'General Manager' },
      { id: ids.accountant, roleId: ids.accountantRole, name: 'Accountant' },
      { id: ids.configurator, roleId: ids.configuratorRole, name: 'Configurator' },
    ]) {
      await tx.user.create({
        data: {
          id: user.id,
          name: user.name,
          email: `${user.id}@example.test`,
          department: 'LEADERSHIP',
          title: user.name,
          organizationRoleId: user.roleId,
        },
      });
    }
    await tx.restaurantStaffProfile.createMany({
      data: [
        {
          id: ids.gmStaff,
          displayName: 'General Manager',
          userId: ids.gm,
          primaryBranchId: ids.branchA,
          status: 'ACTIVE',
        },
        {
          id: ids.accountantStaff,
          displayName: 'Accountant',
          userId: ids.accountant,
          status: 'ACTIVE',
        },
      ],
    });
    await tx.restaurantBranchAssignment.create({
      data: { userId: ids.accountant, branchId: ids.branchB },
    });
  });

  await deps.withTenantDb(ids.orgB, async (tx) => {
    await seedDepartments(tx, [ids.orgB], ['LEADERSHIP']);
    await tx.restaurantBranch.create({ data: { id: ids.branchOther, name: 'Other tenant' } });
  });

  dbA = deps.createTenantDb(ids.orgA);
  dbB = deps.createTenantDb(ids.orgB);
}, 60_000);

describeIfDatabase('Restaurant Finance branch scope under restricted PostgreSQL', () => {
  it('runs as LOGIN NOSUPERUSER NOBYPASSRLS', async () => {
    const sql = new Client({ connectionString: TEST_DATABASE_URL });
    await sql.connect();
    try {
      const role = await sql.query<{
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>('SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
      expect(role.rows[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });
    } finally {
      await sql.end();
    }
  });

  it('keeps named readers on their exact primary or assigned branch', async () => {
    const gm = context(dbA, ids.gm, ids.orgA);
    await expect(deps.requireRestaurantBranchScope(gm, ids.branchA)).resolves.toBeUndefined();
    await expect(deps.requireRestaurantBranchScope(gm, ids.branchB)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const accountant = context(dbA, ids.accountant, ids.orgA);
    await expect(
      deps.requireRestaurantBranchScope(accountant, ids.branchB)
    ).resolves.toBeUndefined();
    await expect(deps.requireRestaurantBranchScope(accountant, ids.branchA)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('allows a configurator across its tenant and reveals nothing in the second tenant', async () => {
    const configurator = context(dbA, ids.configurator, ids.orgA);
    await expect(
      deps.requireRestaurantBranchScope(configurator, ids.branchA)
    ).resolves.toBeUndefined();
    await expect(
      deps.requireRestaurantBranchScope(configurator, ids.branchB)
    ).resolves.toBeUndefined();

    expect(await dbB.restaurantBranchAssignment.count({ where: { userId: ids.gm } })).toBe(0);
    expect(await dbB.restaurantStaffProfile.count({ where: { userId: ids.gm } })).toBe(0);
    await expect(
      deps.requireRestaurantBranchScope(context(dbB, ids.gm, ids.orgB), ids.branchOther)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
