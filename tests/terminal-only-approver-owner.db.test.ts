/**
 * DEV-961 — only the owner may leave a staff member who can approve without a login.
 *
 * A staff profile with no web login keeps approving with its PIN while the authenticator
 * setting is on (it cannot set up an app). Against migrated PostgreSQL with FORCE row level
 * security, as the NOSUPERUSER NOBYPASSRLS runtime role, with the real job-role and staff
 * functions behind `restaurantStaff`:
 *  - a manager, or an administrator who is not the owner, cannot give a profile with no login an
 *    approver right (`coauth:approve`) nor remove the login from a profile that can approve,
 *    their own included; nothing changes;
 *  - the owner can, and each change writes an audit row and notifies every owner.
 *
 * Skipped (never silently passed) unless TEST_DATABASE_URL names a disposable database.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
if (databaseUrl) {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  if (!/(?:^|[_-])(test|e2e|tmp|disposable)(?:[_-]|$)/i.test(databaseName)) {
    throw new Error(
      'TEST_DATABASE_URL must name a dedicated disposable database (test, e2e, tmp, or disposable).'
    );
  }
  process.env.DATABASE_URL = databaseUrl;
}
const describeIfDatabase = databaseUrl ? describe : describe.skip;

vi.mock('server-only', () => ({}));

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
type Scoped = typeof import('@/lib/tenancy/scoped-db');
type Guard = typeof import('@/lib/restaurant/terminal-only-approvers');
type JobRoles = typeof import('@/lib/restaurant/job-roles');
type Staff = typeof import('@/lib/restaurant/staff');

const suffix = randomBytes(5).toString('hex');
const ORG = `org_d961_terminal_${suffix}`;
const BRANCH = `branch_d961_${suffix}`;
const OWNER = `user_d961_owner_${suffix}`;
const MANAGER = `user_d961_mgr_${suffix}`;
/** An administrator who is not the owner: role ADMIN, without the owner's all-capability grant. */
const ADMIN = `user_d961_admin_${suffix}`;

let withTenantDb: Scoped['withTenantDb'];
let withPlatformDb: Scoped['withPlatformDb'];
let guard: Guard;
let jobRoles: JobRoles;
let staff: Staff;
let disconnect: () => Promise<void>;
const ids = { approverRole: '', waiterRole: '', terminalOnly: '', managerProfile: '' };

const tenant = <T>(run: (db: ScopedDb) => Promise<T>, userId = OWNER) =>
  withTenantDb(ORG, run, { userId });

/** What `restaurantStaff.setStaffJobRoles` runs, as `actorUserId`. */
const setRoles = (actorUserId: string, staffProfileId: string, jobRoleIds: string[]) =>
  tenant(
    (db) =>
      guard.guardTerminalOnlyApprovers(
        db,
        { organizationId: ORG, actorUserId, action: 'restaurantStaff.setStaffJobRoles' },
        (tx) => jobRoles.setStaffJobRoles(tx, { staffProfileId, branchId: BRANCH, jobRoleIds })
      ),
    actorUserId
  );

/** What `restaurantStaff.update` runs to remove a login, as `actorUserId`. */
const removeLogin = (actorUserId: string, staffProfileId: string) =>
  tenant(async (db) => {
    await guard.assertMayRemoveLogin(db, {
      organizationId: ORG,
      actorUserId,
      staffProfileId,
    });
    return guard.guardTerminalOnlyApprovers(
      db,
      { organizationId: ORG, actorUserId, action: 'restaurantStaff.update' },
      (tx) => staff.updateStaffProfile(tx, staffProfileId, { userId: null })
    );
  }, actorUserId);

const auditRows = (profileId: string) =>
  tenant((db) =>
    db.auditLog.findMany({
      where: { targetType: 'RestaurantStaffProfile', targetId: profileId, category: 'AUTH' },
      select: { actorId: true, action: true, metadata: true },
    })
  );

const ownerNotices = (profileId: string) =>
  tenant((db) =>
    db.notification.findMany({
      where: { type: 'terminal_only_approver', entityId: profileId },
      select: { userId: true },
    })
  );

describeIfDatabase('DEV-961 terminal-only approvers are the owner’s decision', () => {
  beforeAll(async () => {
    const scoped = await import('@/lib/tenancy/scoped-db');
    withTenantDb = scoped.withTenantDb;
    withPlatformDb = scoped.withPlatformDb;
    guard = await import('@/lib/restaurant/terminal-only-approvers');
    jobRoles = await import('@/lib/restaurant/job-roles');
    staff = await import('@/lib/restaurant/staff');
    const { seedDepartments } = await import('@/lib/test-support/departments');
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    const { APPROVAL_APPROVER_RIGHTS_BY_VERTICAL } = await import('@/lib/vertical-catalog');
    // The vertical whose approvals use `coauth:approve` (verticals are named only in the catalog).
    const vertical = Object.entries(APPROVAL_APPROVER_RIGHTS_BY_VERTICAL).find(([, rights]) =>
      rights?.includes('coauth:approve')
    )![0] as never;
    const { db } = await import('@/lib/db');
    disconnect = () => db.$disconnect();
    await assertRlsEnforcingRole(withPlatformDb);

    await withPlatformDb((tx) =>
      tx.organization.create({
        data: {
          id: ORG,
          slug: ORG,
          legalName: ORG,
          displayName: ORG,
          status: 'ACTIVE',
          vertical,
          timezone: 'Asia/Karachi',
        },
      })
    );
    await tenant(async (tx) => {
      await seedDepartments(tx, [ORG], ['LEADERSHIP']);
      const ownerRole = await tx.organizationRole.findFirst({
        where: { key: 'owner', isSystem: true },
        select: { id: true },
      });
      const ownerRoleId =
        ownerRole?.id ??
        (
          await tx.organizationRole.create({
            data: {
              key: 'owner',
              name: 'Owner',
              isSystem: true,
              permissions: { create: [{ capability: '*', effect: 'ALLOW' }] },
            },
          })
        ).id;
      await tx.organizationRole.create({
        data: {
          id: `role_mgr_${suffix}`,
          key: `role_mgr_${suffix}`,
          name: 'Manager',
          permissions: {
            create: ['staff:manage', 'coauth:approve'].map((capability) => ({
              capability,
              effect: 'ALLOW' as const,
            })),
          },
        },
      });
      for (const [id, roleId] of [
        [OWNER, ownerRoleId],
        [MANAGER, `role_mgr_${suffix}`],
        [ADMIN, `role_mgr_${suffix}`],
      ] as const)
        await tx.user.create({
          data: {
            id,
            name: id,
            email: `${id}@example.test`,
            department: 'LEADERSHIP',
            title: 'Restaurant staff',
            role: id === MANAGER ? 'EMPLOYEE' : 'ADMIN',
            status: 'ACTIVE',
            organizationRoleId: roleId,
          },
        });
      await tx.restaurantBranch.create({
        data: { id: BRANCH, name: 'DEV-961 branch' },
      });
      const approverRole = await tx.restaurantJobRole.create({
        data: {
          key: `shift_lead_${suffix}`,
          name: 'Shift lead',
          capabilities: { create: [{ capability: 'coauth:approve' }] },
        },
      });
      const waiterRole = await tx.restaurantJobRole.create({
        data: {
          key: `waiter_${suffix}`,
          name: 'Waiter',
          capabilities: { create: [{ capability: 'orders:take' }] },
        },
      });
      ids.approverRole = approverRole.id;
      ids.waiterRole = waiterRole.id;
      const terminalOnly = await tx.restaurantStaffProfile.create({
        data: { displayName: 'Night shift lead', primaryBranchId: BRANCH },
      });
      ids.terminalOnly = terminalOnly.id;
      const managerProfile = await tx.restaurantStaffProfile.create({
        data: { displayName: 'Manager', userId: MANAGER, primaryBranchId: BRANCH },
      });
      ids.managerProfile = managerProfile.id;
    });
  }, 120_000);

  afterAll(async () => {
    if (databaseUrl) await disconnect();
  });

  it('lets a manager give a profile with no login a role that cannot approve', async () => {
    await expect(setRoles(MANAGER, ids.terminalOnly, [ids.waiterRole])).resolves.toMatchObject({
      added: [],
    });
  });

  it('refuses a manager giving a profile with no login an approver right, and changes nothing', async () => {
    await expect(
      setRoles(MANAGER, ids.terminalOnly, [ids.waiterRole, ids.approverRole])
    ).rejects.toThrow(guard.TERMINAL_ONLY_APPROVER_OWNER_ONLY);
    const held = await tenant((db) =>
      db.restaurantStaffJobRole.findMany({
        where: { staffProfileId: ids.terminalOnly },
        select: { jobRoleId: true },
      })
    );
    expect(held.map((row) => row.jobRoleId)).toEqual([ids.waiterRole]);
    expect(await auditRows(ids.terminalOnly)).toEqual([]);
    expect(await ownerNotices(ids.terminalOnly)).toEqual([]);
  });

  it('refuses a manager removing the login from a profile that can approve, their own included', async () => {
    await expect(removeLogin(MANAGER, ids.managerProfile)).rejects.toThrow(
      guard.TERMINAL_ONLY_APPROVER_OWNER_ONLY
    );
    const profile = await tenant((db) =>
      db.restaurantStaffProfile.findUniqueOrThrow({
        where: { id: ids.managerProfile },
        select: { userId: true },
      })
    );
    expect(profile.userId).toBe(MANAGER);
  });

  it('refuses an administrator who is not the owner, in both directions, and changes nothing', async () => {
    await expect(
      setRoles(ADMIN, ids.terminalOnly, [ids.waiterRole, ids.approverRole])
    ).rejects.toThrow(guard.TERMINAL_ONLY_APPROVER_OWNER_ONLY);
    await expect(removeLogin(ADMIN, ids.managerProfile)).rejects.toThrow(
      guard.TERMINAL_ONLY_APPROVER_OWNER_ONLY
    );
    const [held, profile] = await Promise.all([
      tenant((db) =>
        db.restaurantStaffJobRole.findMany({
          where: { staffProfileId: ids.terminalOnly },
          select: { jobRoleId: true },
        })
      ),
      tenant((db) =>
        db.restaurantStaffProfile.findUniqueOrThrow({
          where: { id: ids.managerProfile },
          select: { userId: true },
        })
      ),
    ]);
    expect(held.map((row) => row.jobRoleId)).toEqual([ids.waiterRole]);
    expect(profile.userId).toBe(MANAGER);
    expect(await auditRows(ids.terminalOnly)).toEqual([]);
    expect(await ownerNotices(ids.terminalOnly)).toEqual([]);
  });

  it('lets the owner give the right, with an audit row and a notice to every owner', async () => {
    const { added } = await setRoles(OWNER, ids.terminalOnly, [ids.waiterRole, ids.approverRole]);
    expect(added).toEqual([{ id: ids.terminalOnly, displayName: 'Night shift lead' }]);
    expect(await auditRows(ids.terminalOnly)).toEqual([
      {
        actorId: OWNER,
        action: 'restaurantStaff.setStaffJobRoles',
        metadata: expect.objectContaining({ terminalOnlyApprover: true, approvesWith: 'PIN' }),
      },
    ]);
    expect(await ownerNotices(ids.terminalOnly)).toEqual([{ userId: OWNER }]);
    const listed = await tenant((db) => guard.terminalOnlyApproverIds(db));
    expect([...listed]).toEqual([ids.terminalOnly]);
  });

  it('lets the owner remove the login from a profile that can approve, audited and notified', async () => {
    // The manager's profile approves through its own job role once its login is gone.
    await setRoles(OWNER, ids.managerProfile, [ids.approverRole]);
    const { added } = await removeLogin(OWNER, ids.managerProfile);
    expect(added).toEqual([{ id: ids.managerProfile, displayName: 'Manager' }]);
    expect(await auditRows(ids.managerProfile)).toEqual([
      expect.objectContaining({ actorId: OWNER, action: 'restaurantStaff.update' }),
    ]);
    expect(await ownerNotices(ids.managerProfile)).toEqual([{ userId: OWNER }]);
  });
});
