/**
 * WHA-1181 (5)/(9a) — restaurant provisioning run the way the platform control
 * plane runs it: inside `withPlatformDb`, where `app.current_organization_id` is
 * BLANK and `app.is_platform_admin` is true.
 *
 * This is the one thing a mocked client cannot check. Every table the reused
 * domain writers touch declares
 * `organizationId String @default(dbgenerated("current_setting('app.current_organization_id', true)"))`,
 * so an insert that omits the column takes its tenant from a GUC that is the
 * empty string there. A mock records the call and reports success; only a real
 * database shows the row landing under `''` and belonging to nobody.
 *
 * Skipped (never silently passed) when the database URLs are absent.
 */
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { RESTAURANT_CAPABILITIES, RESTAURANT_JOB_ROLE_TEMPLATES } from '@/lib/vertical-catalog';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.M8_TEST_OWNER_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL && OWNER_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha1181_${suffix}`;
const ids = {
  branchDefault: `branch_default_${suffix}`,
  branchSecond: `branch_second_${suffix}`,
  admin: `user_admin_${suffix}`,
};

type Deps = {
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  provisioning: typeof import('./organization-provisioning');
  jobRoles: typeof import('./job-roles');
};

let deps: Deps;

async function asOwner<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const owner = new Client({ connectionString: OWNER_DATABASE_URL });
  await owner.connect();
  try {
    return await work(owner);
  } finally {
    await owner.end();
  }
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL || !OWNER_DATABASE_URL) return;
  // The runtime role must NOT be the owner, or FORCE RLS proves nothing here.
  expect(OWNER_DATABASE_URL).not.toBe(TEST_DATABASE_URL);

  await asOwner(async (owner) => {
    await owner.query('BEGIN');
    await owner.query(`SET LOCAL app.is_platform_admin = 'true'`);
    await owner.query(
      `INSERT INTO "organizations"
        ("id", "slug", "legalName", "displayName", "status", "vertical", "deploymentMode",
         "createdAt", "updatedAt")
       VALUES ($1, $2, 'WHA1181 Diner Ltd', 'WHA1181 Diner', 'ONBOARDING', 'RESTAURANT', 'SHARED',
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [orgId, `wha1181-${suffix}`]
    );
    // `users.department` is a composite FK onto this table (WHA-278).
    await owner.query(
      `INSERT INTO "organization_departments"
        ("id", "organizationId", "key", "name", "createdAt", "updatedAt")
       VALUES ($2, $1, 'LEADERSHIP', 'Leadership', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [orgId, `dept_${suffix}`]
    );
    await owner.query(
      `INSERT INTO "users"
        ("id", "organizationId", "name", "email", "password", "role", "department", "title",
         "status", "createdAt", "updatedAt")
       VALUES ($1, $2, 'WHA1181 Owner', $3, 'x', 'ADMIN', 'LEADERSHIP',
               'Organization administrator', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.admin, orgId, `owner-${suffix}@wha1181.invalid`]
    );
    await owner.query(
      `INSERT INTO "restaurant_branches"
        ("id", "organizationId", "name", "timezone", "businessDayCutoff", "isDefault", "active",
         "createdAt", "updatedAt")
       VALUES ($1, $3, 'Clifton Flagship', 'UTC', '04:30', true, true,
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
              ($2, $3, 'Airport', 'UTC', '04:30', false, true,
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.branchDefault, ids.branchSecond, orgId]
    );
    await owner.query('COMMIT');
  }).catch(async (error) => {
    throw error;
  });

  const [scopedDb, provisioning, jobRoles] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./organization-provisioning'),
    import('./job-roles'),
  ]);
  deps = {
    withPlatformDb: scopedDb.withPlatformDb,
    withTenantDb: scopedDb.withTenantDb,
    provisioning,
    jobRoles,
  };
});

/** Run provisioning exactly as `commands.ts` does: through the platform client. */
function provisionAsPlatform() {
  return deps.withPlatformDb((tx) =>
    deps.provisioning.provisionRestaurantOrganization(tx, {
      organizationId: orgId,
      administrators: [
        { id: ids.admin, name: 'WHA1181 Owner', email: `owner-${suffix}@wha1181.invalid` },
      ],
    })
  );
}

describeIfDatabase('provisionRestaurantOrganization against PostgreSQL', () => {
  it('writes every row under the tenant, not under the platform client’s blank GUC', async () => {
    const result = await provisionAsPlatform();

    expect(result.jobRolesCreated.sort()).toEqual(
      RESTAURANT_JOB_ROLE_TEMPLATES.map((role) => role.key).sort()
    );
    expect(result.administrators).toHaveLength(1);
    expect(result.administrators[0]).toMatchObject({ created: true, roleProfileGranted: true });
    expect(result.administrators[0]!.primaryBranchId).toBe(ids.branchDefault);
    expect(result.stationsCreated.map((station) => station.branchId).sort()).toEqual(
      [ids.branchDefault, ids.branchSecond].sort()
    );

    // The actual assertion: no row landed under the empty string. Read as the
    // OWNER with platform-admin scope so a mis-tenanted row would be visible
    // rather than hidden behind the very RLS predicate this is checking.
    const { orphans, mine } = await asOwner(async (owner) => {
      await owner.query(`SET app.is_platform_admin = 'true'`);
      const orphanRows = await owner.query<{ table_name: string; count: string }>(
        `SELECT 'restaurant_job_roles' AS table_name, count(*)::text FROM restaurant_job_roles
           WHERE "organizationId" = ''
         UNION ALL
         SELECT 'restaurant_job_role_capabilities', count(*)::text
           FROM restaurant_job_role_capabilities WHERE "organizationId" = ''
         UNION ALL
         SELECT 'restaurant_staff_profiles', count(*)::text
           FROM restaurant_staff_profiles WHERE "organizationId" = ''
         UNION ALL
         SELECT 'restaurant_staff_job_roles', count(*)::text
           FROM restaurant_staff_job_roles WHERE "organizationId" = ''
         UNION ALL
         SELECT 'restaurant_staff_job_role_audits', count(*)::text
           FROM restaurant_staff_job_role_audits WHERE "organizationId" = ''
         UNION ALL
         SELECT 'restaurant_kitchen_stations', count(*)::text
           FROM restaurant_kitchen_stations WHERE "organizationId" = ''`
      );
      // And the positive half: this organization owns exactly what was seeded.
      const mineRows = await owner.query<{ table_name: string; count: string }>(
        `SELECT 'restaurant_job_roles' AS table_name, count(*)::text FROM restaurant_job_roles
           WHERE "organizationId" = $1
         UNION ALL
         SELECT 'restaurant_staff_profiles', count(*)::text
           FROM restaurant_staff_profiles WHERE "organizationId" = $1
         UNION ALL
         SELECT 'restaurant_staff_job_roles', count(*)::text
           FROM restaurant_staff_job_roles WHERE "organizationId" = $1
         UNION ALL
         SELECT 'restaurant_kitchen_stations', count(*)::text
           FROM restaurant_kitchen_stations WHERE "organizationId" = $1`,
        [orgId]
      );
      return {
        orphans: orphanRows.rows.filter((row) => row.count !== '0'),
        mine: Object.fromEntries(mineRows.rows.map((row) => [row.table_name, Number(row.count)])),
      };
    });
    expect(orphans).toEqual([]);
    expect(mine).toEqual({
      restaurant_job_roles: RESTAURANT_JOB_ROLE_TEMPLATES.length,
      restaurant_staff_profiles: 1,
      restaurant_staff_job_roles: 2,
      restaurant_kitchen_stations: 2,
    });
  });

  it('leaves the administrator holding the owner role, so access is inherited', async () => {
    const owned = await deps.withTenantDb(orgId, async (tx) => {
      const profile = await tx.restaurantStaffProfile.findFirstOrThrow({
        where: { userId: ids.admin },
        select: { id: true },
      });
      const holdings = await tx.restaurantStaffJobRole.findMany({
        where: { staffProfileId: profile.id },
        select: { branchId: true, jobRole: { select: { key: true } } },
      });
      const resolution = await deps.jobRoles.resolveStaffCapabilityDecision(
        tx,
        profile.id,
        ids.branchDefault
      );
      return { holdings, resolution };
    });

    expect(owned.holdings).toEqual(
      expect.arrayContaining([
        { branchId: ids.branchDefault, jobRole: { key: 'owner' } },
        { branchId: ids.branchSecond, jobRole: { key: 'owner' } },
      ])
    );
    expect(owned.holdings).toHaveLength(2);
    // The owner's follow-up in full: every capability is INHERITED FROM ROLE,
    // and the direct-exception layer is empty.
    const ownerTemplate = RESTAURANT_JOB_ROLE_TEMPLATES.find((role) => role.key === 'owner')!;
    expect([...owned.resolution.inherited].sort()).toEqual([...ownerTemplate.capabilities].sort());
    expect([...owned.resolution.allowed]).toEqual([]);
    expect([...owned.resolution.denied]).toEqual([]);
  });

  it('gives each branch exactly one default station, named Kitchen', async () => {
    const stations = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantKitchenStation.findMany({
        select: { branchId: true, name: true, isDefault: true },
        orderBy: { branchId: 'asc' },
      })
    );

    expect(stations).toHaveLength(2);
    for (const station of stations) {
      expect(station).toMatchObject({ name: 'Kitchen', isDefault: true });
    }
  });

  it('is idempotent: a second run writes nothing', async () => {
    const before = await deps.withTenantDb(orgId, async (tx) => ({
      roles: await tx.restaurantJobRole.count(),
      profiles: await tx.restaurantStaffProfile.count(),
      holdings: await tx.restaurantStaffJobRole.count(),
      assignments: await tx.restaurantBranchAssignment.count(),
      stations: await tx.restaurantKitchenStation.count(),
    }));

    expect(before.assignments).toBe(2);
    const second = await provisionAsPlatform();

    expect(second.jobRolesCreated).toEqual([]);
    expect(second.stationsCreated).toEqual([]);
    expect(second.administrators[0]).toMatchObject({
      created: false,
      roleProfileGranted: false,
    });
    await expect(
      deps.withTenantDb(orgId, async (tx) => ({
        roles: await tx.restaurantJobRole.count(),
        profiles: await tx.restaurantStaffProfile.count(),
        holdings: await tx.restaurantStaffJobRole.count(),
        assignments: await tx.restaurantBranchAssignment.count(),
        stations: await tx.restaurantKitchenStation.count(),
      }))
    ).resolves.toEqual(before);
  });

  it('re-grants an active owner role holding revoked since prior provisioning', async () => {
    const profileId = await deps.withTenantDb(orgId, async (tx) => {
      const profile = await tx.restaurantStaffProfile.findFirstOrThrow({
        where: { userId: ids.admin },
        select: { id: true },
      });
      await tx.restaurantStaffJobRole.deleteMany({ where: { staffProfileId: profile.id } });
      return profile.id;
    });

    // Re-provisioning DOES restore it: a missing holding is indistinguishable
    // from never having been provisioned, and the repair path exists precisely
    // to converge that. What must never happen is a duplicate.
    const again = await provisionAsPlatform();
    expect(again.administrators[0]).toMatchObject({ roleProfileGranted: true });

    const holdings = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantStaffJobRole.count({ where: { staffProfileId: profileId } })
    );
    expect(holdings).toBe(2);
  });

  it('skips the grant when the owner role has been deactivated', async () => {
    await deps.withTenantDb(orgId, async (tx) => {
      await tx.restaurantStaffJobRole.deleteMany({});
      await tx.restaurantJobRole.updateMany({ where: { key: 'owner' }, data: { active: false } });
    });

    const result = await provisionAsPlatform();

    // Reactivating a role somebody switched off would be a privilege change
    // performed by a provisioning function, not a repair.
    expect(result.administrators[0]).toMatchObject({ roleProfileGranted: false });
    await expect(deps.withTenantDb(orgId, (tx) => tx.restaurantStaffJobRole.count())).resolves.toBe(
      0
    );

    await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantJobRole.updateMany({ where: { key: 'owner' }, data: { active: true } })
    );
  });
  it('keeps every owner capability on all branches, preserves DENY, and assigns new branches idempotently', async () => {
    await provisionAsPlatform();
    const { operatorHasCapability } = await import('./checkout-routes');
    const { hasStaffBranchAccess } = await import('./branch-access');
    const { assignOwnersToBranch } = await import('./owner-branch-assignments');
    await deps.withTenantDb(orgId, async (tx) => {
      const profile = await tx.restaurantStaffProfile.findFirstOrThrow({
        where: { userId: ids.admin },
      });
      // An owner is organization-wide even if the local holding/assignment is missing.
      await tx.restaurantStaffJobRole.deleteMany({
        where: { staffProfileId: profile.id, branchId: ids.branchSecond },
      });
      await tx.restaurantBranchAssignment.deleteMany({
        where: { userId: ids.admin, branchId: ids.branchSecond },
      });
      for (const capability of RESTAURANT_CAPABILITIES) {
        expect(
          await operatorHasCapability(tx, profile.id, capability, new Date(), ids.branchSecond),
          capability
        ).toBe(true);
      }
      await deps.jobRoles.setStaffCapabilityOverride(tx, {
        staffProfileId: profile.id,
        branchId: ids.branchSecond,
        capability: 'payments:refund',
        effect: 'DENY',
      });
      expect(
        await operatorHasCapability(tx, profile.id, 'payments:refund', new Date(), ids.branchSecond)
      ).toBe(false);
      expect(await hasStaffBranchAccess(tx, profile.id, 'foreign_branch')).toBe(false);
      expect(
        await deps.jobRoles.resolveStaffCapabilities(tx, profile.id, 'foreign_branch')
      ).toEqual(new Set());
      const branch = await tx.restaurantBranch.create({ data: { name: 'New owner branch' } });
      await assignOwnersToBranch(tx, orgId, branch.id);
      await assignOwnersToBranch(tx, orgId, branch.id);
      expect(
        await tx.restaurantBranchAssignment.count({
          where: { branchId: branch.id, userId: ids.admin },
        })
      ).toBe(1);
      expect(
        await tx.restaurantStaffJobRole.count({
          where: { branchId: branch.id, staffProfileId: profile.id },
        })
      ).toBe(1);
      expect(
        await tx.restaurantStaffJobRoleAudit.count({
          where: { branchId: branch.id, staffProfileId: profile.id, change: 'GRANTED' },
        })
      ).toBe(1);
      await tx.restaurantBranch.update({ where: { id: branch.id }, data: { active: false } });
      expect(await hasStaffBranchAccess(tx, profile.id, branch.id)).toBe(false);
    });
  });

  it('allows a full-capability web administrator across branches without a floor owner role', async () => {
    const { operatorHasCapability } = await import('./checkout-routes');
    const { hasStaffBranchAccess } = await import('./branch-access');
    await deps.withTenantDb(orgId, async (tx) => {
      const role = await tx.organizationRole.create({
        data: {
          key: 'full-admin',
          name: 'Full admin',
          permissions: { create: { capability: '*', effect: 'ALLOW' } },
        },
      });
      const user = await tx.user.create({
        data: {
          name: 'Full admin',
          email: `full-${suffix}@h4.invalid`,
          role: 'ADMIN',
          department: 'LEADERSHIP',
          title: 'Admin',
          organizationRoleId: role.id,
        },
      });
      const profile = await tx.restaurantStaffProfile.create({
        data: { displayName: 'Full admin', userId: user.id, primaryBranchId: ids.branchDefault },
      });
      for (const capability of RESTAURANT_CAPABILITIES) {
        expect(
          await operatorHasCapability(tx, profile.id, capability, new Date(), ids.branchSecond),
          capability
        ).toBe(true);
      }
      // A coarse ADMIN with no actual capabilities still cannot cross branches.
      await tx.user.update({ where: { id: user.id }, data: { organizationRoleId: null } });
      expect(await hasStaffBranchAccess(tx, profile.id, ids.branchSecond)).toBe(false);
      expect(
        await operatorHasCapability(
          tx,
          profile.id,
          'payments:collect',
          new Date(),
          ids.branchSecond
        )
      ).toBe(false);
      const override = await tx.userPermissionOverride.create({
        data: {
          userId: user.id,
          capability: '*',
          effect: 'ALLOW',
          reason: 'Regression full administration',
        },
      });
      expect(await hasStaffBranchAccess(tx, profile.id, ids.branchSecond)).toBe(true);
      expect(
        await operatorHasCapability(
          tx,
          profile.id,
          'payments:collect',
          new Date(),
          ids.branchSecond
        )
      ).toBe(true);
      await tx.userPermissionOverride.update({
        where: { id: override.id },
        data: { expiresAt: new Date(0) },
      });
      expect(await hasStaffBranchAccess(tx, profile.id, ids.branchSecond)).toBe(false);
      await tx.user.update({ where: { id: user.id }, data: { organizationRoleId: role.id } });
      const { restaurantBranchesRouter } = await import('@/server/routers/restaurant-branches');
      const branchCaller = restaurantBranchesRouter.createCaller({
        db: tx,
        session: {
          user: { id: user.id, role: 'ADMIN', status: 'ACTIVE', organizationId: orgId },
        },
        organization: null,
        support: null,
        entitlements: {
          organizationId: orgId,
          enabledModules: ['restaurant-core'],
          limits: { 'restaurant.locations.max': 10 },
          modules: [],
        },
        requestMeta: { ip: null, userAgent: null },
        audit: { detail: {} },
      } as unknown as import('@/server/trpc').TRPCContext);
      const created = await branchCaller.create({
        name: 'Router created branch',
        code: 'H4-NEW',
        timezone: 'UTC',
        businessDayCutoff: '04:00',
        address: null,
        shiftSignInEnforced: false,
      });
      const dormant = await tx.restaurantBranch.create({
        data: { name: 'Dormant branch', active: false },
      });
      await branchCaller.setActive({ id: dormant.id, active: true });
      expect(
        await tx.restaurantBranchAssignment.count({
          where: { branchId: dormant.id, userId: user.id },
        })
      ).toBe(0);
      expect(
        await tx.restaurantStaffJobRole.count({
          where: { branchId: dormant.id, staffProfileId: profile.id },
        })
      ).toBe(0);
      for (const userId of [user.id, ids.admin]) {
        // Web role access stays dynamic; explicitly provisioned floor owners
        // continue to receive durable holdings and branch assignments.
        const expectedHoldings = userId === ids.admin ? 1 : 0;
        expect(
          await tx.restaurantBranchAssignment.count({ where: { branchId: created.id, userId } })
        ).toBe(expectedHoldings);
        expect(
          await tx.restaurantStaffJobRole.count({
            where: { branchId: created.id, staffProfile: { userId }, jobRole: { key: 'owner' } },
          })
        ).toBe(expectedHoldings);
      }
      for (const branchId of [created.id, dormant.id]) {
        expect(await hasStaffBranchAccess(tx, profile.id, branchId)).toBe(true);
        expect(
          await operatorHasCapability(tx, profile.id, 'payments:refund', new Date(), branchId)
        ).toBe(true);
      }
      await tx.user.update({ where: { id: user.id }, data: { organizationRoleId: null } });
      for (const branchId of [created.id, dormant.id]) {
        expect(await hasStaffBranchAccess(tx, profile.id, branchId)).toBe(false);
        expect(
          await operatorHasCapability(tx, profile.id, 'payments:refund', new Date(), branchId)
        ).toBe(false);
      }
    });
  });
});
