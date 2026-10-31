import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const mocks = vi.hoisted(() => ({ can: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ids = {
  orgA: `org_wha856_a_${suffix}`,
  orgB: `org_wha856_b_${suffix}`,
  admin: `user_wha856_admin_${suffix}`,
  manager: `user_wha856_manager_${suffix}`,
  ordinary: `user_wha856_ordinary_${suffix}`,
  foreign: `user_wha856_foreign_${suffix}`,
  branchA: `branch_wha856_a_${suffix}`,
  branchB: `branch_wha856_b_${suffix}`,
  foreignBranch: `branch_wha856_foreign_${suffix}`,
  managerProfile: `staff_wha856_manager_${suffix}`,
  ordinaryProfile: `staff_wha856_ordinary_${suffix}`,
  foreignProfile: `staff_wha856_foreign_${suffix}`,
  target: `staff_wha856_target_${suffix}`,
  role: `role_wha856_manager_${suffix}`,
};

const sessionUser = (id: string) => ({
  id,
  role: 'EMPLOYEE' as const,
  status: 'ACTIVE' as const,
  organizationId: ids.orgA,
});
let client: pg.Client;
let deps: {
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  authorization: typeof import('./staff-branch-authorization');
};

describeIfDatabase('staff branch authorization (real PostgreSQL)', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    const role = await client.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(`SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(role.rows).toEqual([{ rolcanlogin: true, rolsuper: false, rolbypassrls: false }]);

    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await client.query(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", "updatedAt") VALUES
       ($1,$1,$1,$1,now()), ($2,$2,$2,$2,now())`,
      [ids.orgA, ids.orgB]
    );
    for (const org of [ids.orgA, ids.orgB]) {
      await client.query(
        `INSERT INTO organization_departments (id, "organizationId", key, name, "updatedAt")
         VALUES ($1,$2,'ops','Operations',now())`,
        [`dept_${org}`, org]
      );
    }
    await client.query(
      `INSERT INTO users (id, "organizationId", name, email, role, department, title, "updatedAt") VALUES
       ($1,$5,'Admin',$1||'@test.invalid','EMPLOYEE','ops','Admin',now()),
       ($2,$5,'Manager',$2||'@test.invalid','EMPLOYEE','ops','Manager',now()),
       ($3,$5,'Ordinary',$3||'@test.invalid','EMPLOYEE','ops','Staff',now()),
       ($4,$6,'Foreign',$4||'@test.invalid','EMPLOYEE','ops','Manager',now())`,
      [ids.admin, ids.manager, ids.ordinary, ids.foreign, ids.orgA, ids.orgB]
    );
    await client.query(
      `INSERT INTO restaurant_branches (id, "organizationId", name, "updatedAt") VALUES
       ($1,$4,'A',now()), ($2,$4,'B',now()), ($3,$5,'Foreign',now())`,
      [ids.branchA, ids.branchB, ids.foreignBranch, ids.orgA, ids.orgB]
    );
    await client.query(
      `INSERT INTO restaurant_staff_profiles
       (id, "organizationId", "userId", "displayName", "primaryBranchId", "updatedAt") VALUES
       ($1,$5,$6,'Manager',$3,now()), ($2,$5,$7,'Ordinary',$3,now()),
       ($4,$5,NULL,'Two branch target',$3,now()), ($8,$9,$10,'Foreign',$11,now())`,
      [
        ids.managerProfile,
        ids.ordinaryProfile,
        ids.branchA,
        ids.target,
        ids.orgA,
        ids.manager,
        ids.ordinary,
        ids.foreignProfile,
        ids.orgB,
        ids.foreign,
        ids.foreignBranch,
      ]
    );
    await client.query(
      `INSERT INTO restaurant_job_roles (id,"organizationId",key,name,"updatedAt") VALUES
       ($1,$2,'manager','Manager',now())`,
      [ids.role, ids.orgA]
    );
    await client.query(
      `INSERT INTO restaurant_job_role_capabilities (id,"organizationId","jobRoleId",capability)
       VALUES ($1,$2,$3,'staff:manage')`,
      [`cap_${suffix}`, ids.orgA, ids.role]
    );
    await client.query(
      `INSERT INTO restaurant_staff_job_roles
       (id,"organizationId","staffProfileId","jobRoleId","branchId") VALUES
       ($1,$2,$3,$4,$5), ($6,$2,$7,$4,$5), ($8,$2,$7,$4,$9)`,
      [
        `holding_manager_${suffix}`,
        ids.orgA,
        ids.managerProfile,
        ids.role,
        ids.branchA,
        `holding_target_a_${suffix}`,
        ids.target,
        `holding_target_b_${suffix}`,
        ids.branchB,
      ]
    );
    deps = {
      ...(await import('@/lib/tenancy/scoped-db')),
      authorization: await import('./staff-branch-authorization'),
    };
    mocks.can.mockImplementation(async (subject: { id: string }) => subject.id === ids.admin);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    await client.query(`DELETE FROM organizations WHERE id = ANY($1::text[])`, [
      [ids.orgA, ids.orgB],
    ]);
    await client.end();
  });

  it('covers organization admin, branch manager, ordinary staff, and list filtering', async () => {
    const db = deps.createTenantDb(ids.orgA);
    await expect(
      deps.authorization.resolveStaffBranchAuthorization(db, sessionUser(ids.admin), ids.orgA)
    ).resolves.toMatchObject({ organizationWide: true, branchIds: [ids.branchA, ids.branchB] });
    await expect(
      deps.authorization.resolveStaffBranchAuthorization(db, sessionUser(ids.manager), ids.orgA)
    ).resolves.toMatchObject({ organizationWide: false, branchIds: [ids.branchA] });
    await expect(
      deps.authorization.resolveStaffBranchAuthorization(db, sessionUser(ids.ordinary), ids.orgA)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('fails uniformly for unauthorized, foreign, arbitrary branches and profiles', async () => {
    const db = deps.createTenantDb(ids.orgA);
    const authorization = await deps.authorization.resolveStaffBranchAuthorization(
      db,
      sessionUser(ids.manager),
      ids.orgA
    );
    const expected = { code: 'FORBIDDEN', message: expect.stringContaining('not authorized') };
    for (const branchId of [ids.branchB, ids.foreignBranch, `arbitrary_${suffix}`]) {
      expect(() => deps.authorization.assertAuthorizedBranch(authorization, branchId)).toThrowError(
        expect.objectContaining(expected)
      );
    }
    for (const profileId of [ids.foreignProfile, `arbitrary_${suffix}`]) {
      await expect(
        deps.authorization.assertAuthorizedStaffProfile(db, authorization, profileId)
      ).rejects.toMatchObject(expected);
    }
  });

  it('denies a global mutation of a target with an unauthorized branch holding', async () => {
    const db = deps.createTenantDb(ids.orgA);
    const authorization = await deps.authorization.resolveStaffBranchAuthorization(
      db,
      sessionUser(ids.manager),
      ids.orgA
    );
    await expect(
      deps.authorization.assertAuthorizedStaffProfile(db, authorization, ids.target)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      deps.authorization.assertStaffProfileExists(db, ids.target)
    ).resolves.toBeUndefined();
    const holdings = await db.restaurantStaffJobRole.findMany({
      where: { staffProfileId: ids.target },
      orderBy: { branchId: 'asc' },
      select: { branchId: true },
    });
    expect(holdings).toEqual([{ branchId: ids.branchA }, { branchId: ids.branchB }]);
  });
  it('resolves session actors against real tenant branch bindings and rejects foreign scope', async () => {
    const { resolveRestaurantActor } = await import('@/server/restaurant-actor');
    const context = (id: string) =>
      ({
        db: deps.createTenantDb(ids.orgA),
        session: { user: sessionUser(id) },
        entitlements: { organizationId: ids.orgA },
        requestMeta: { ip: null },
      }) as unknown as import('@/server/trpc').TRPCContext;
    await expect(resolveRestaurantActor(context(ids.manager), [ids.branchA])).resolves.toEqual({
      staffProfileId: ids.managerProfile,
    });
    await expect(resolveRestaurantActor(context(ids.manager), [ids.branchB])).rejects.toMatchObject(
      { code: 'FORBIDDEN' }
    );
    await expect(
      resolveRestaurantActor(context(ids.manager), [ids.foreignBranch])
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A DENY capability override at another branch is not a branch link.
    await client.query(
      `INSERT INTO restaurant_staff_capability_grants (id,"organizationId","staffProfileId","branchId",capability,effect) VALUES ($1,$2,$3,$4,$5,'DENY')`,
      [`deny_${suffix}`, ids.orgA, ids.managerProfile, ids.branchB, 'sop:verify']
    );
    await expect(resolveRestaurantActor(context(ids.manager), [ids.branchB])).rejects.toMatchObject(
      { code: 'FORBIDDEN' }
    );
    // A role holding can bind a branch other than the primary branch.
    await client.query(
      `INSERT INTO restaurant_staff_job_roles (id,"organizationId","staffProfileId","jobRoleId","branchId") VALUES ($1,$2,$3,$4,$5)`,
      [`extra_${suffix}`, ids.orgA, ids.managerProfile, ids.role, ids.branchB]
    );
    await expect(resolveRestaurantActor(context(ids.manager), [ids.branchB])).resolves.toEqual({
      staffProfileId: ids.managerProfile,
    });
  });
});
