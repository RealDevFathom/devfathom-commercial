// @vitest-environment node
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import { ensureDefaultJobRoles, grantJobRole, revokeJobRole } from './job-roles';
import { operatorHasCapability } from './operator-capabilities';
import { hasStaffBranchAccess } from './branch-access';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl) process.env.DATABASE_URL = testDatabaseUrl;
const describeIfDatabase = testDatabaseUrl ? describe : describe.skip;
const organizationId = `owner_assignment_${randomBytes(6).toString('hex')}`;

// Roll back each tenant fixture, including role grants and their audit rows.
const rollback = new Error('rollback owner assignment fixture');

describeIfDatabase('owner branch reach against PostgreSQL', () => {
  beforeAll(async () => {
    await withPlatformDb((db) =>
      db.organization.create({
        data: {
          id: organizationId,
          slug: organizationId,
          displayName: 'Owner assignment regression',
          legalName: 'Owner assignment regression',
          vertical: 'RESTAURANT',
          status: 'ACTIVE',
        },
      })
    );
  });

  afterAll(async () => {
    await withPlatformDb((db) => db.organization.deleteMany({ where: { id: organizationId } }));
  });

  it.each([
    'override expires',
    'override is removed',
    'role is unassigned',
    'wildcard permission is removed',
  ] as const)(
    'does not persist derived access when the %s',
    async (revocation) => {
      await expect(
        withTenantDb(organizationId, async (db) => {
          await db.organizationDepartment.create({ data: { key: 'OPS', name: 'Operations' } });
          const originalBranch = await db.restaurantBranch.create({ data: { name: 'Original' } });
          const newBranch = await db.restaurantBranch.create({ data: { name: 'New' } });
          const user = await db.user.create({
            data: {
              name: 'Temporary administrator',
              email: `${revocation.replaceAll(' ', '-')}-${organizationId}@example.invalid`,
              department: 'OPS',
              title: 'Staff',
              role: 'EMPLOYEE',
            },
          });
          const profile = await db.restaurantStaffProfile.create({
            data: {
              userId: user.id,
              displayName: user.name,
              primaryBranchId: originalBranch.id,
            },
          });
          await ensureDefaultJobRoles(db);
          const fromRole =
            revocation === 'role is unassigned' || revocation === 'wildcard permission is removed';
          const role = fromRole
            ? await db.organizationRole.create({
                data: {
                  key: 'temporary-administrator',
                  name: 'Temporary administrator',
                  permissions: { create: { capability: '*', effect: 'ALLOW' } },
                },
              })
            : null;
          if (role) {
            await db.user.update({ where: { id: user.id }, data: { organizationRoleId: role.id } });
          }
          const override = !fromRole
            ? await db.userPermissionOverride.create({
                data: {
                  userId: user.id,
                  capability: '*',
                  effect: 'ALLOW',
                  reason: 'Temporary branch administration',
                  expiresAt:
                    revocation === 'override expires' ? new Date(Date.now() + 60_000) : null,
                },
              })
            : null;

          // Exercise the branch-reactivation path: nothing is persisted for it.
          await db.restaurantBranch.update({
            where: { id: newBranch.id },
            data: { active: false },
          });
          await db.restaurantBranch.update({ where: { id: newBranch.id }, data: { active: true } });
          for (const branchId of [originalBranch.id, newBranch.id]) {
            expect(await hasStaffBranchAccess(db, profile.id, branchId)).toBe(true);
            expect(
              await operatorHasCapability(db, profile.id, 'payments:refund', new Date(), branchId)
            ).toBe(true);
          }
          expect(
            await db.restaurantStaffJobRole.count({ where: { staffProfileId: profile.id } })
          ).toBe(0);
          expect(await db.restaurantBranchAssignment.count({ where: { userId: user.id } })).toBe(0);

          if (revocation === 'role is unassigned') {
            await db.user.update({ where: { id: user.id }, data: { organizationRoleId: null } });
          } else if (revocation === 'wildcard permission is removed') {
            await db.organizationRolePermission.deleteMany({
              where: { organizationRoleId: role!.id, capability: '*' },
            });
          } else if (revocation === 'override expires') {
            await db.userPermissionOverride.update({
              where: { id: override!.id },
              data: { expiresAt: new Date(0) },
            });
          } else {
            await db.userPermissionOverride.delete({ where: { id: override!.id } });
          }
          expect(await hasStaffBranchAccess(db, profile.id, newBranch.id)).toBe(false);
          for (const branchId of [originalBranch.id, newBranch.id]) {
            expect(
              await operatorHasCapability(db, profile.id, 'payments:refund', new Date(), branchId)
            ).toBe(false);
          }
          throw rollback;
        })
      ).rejects.toBe(rollback);
    }
  );
  it.each(['owner holding is removed', 'owner role is deactivated'] as const)(
    'derives owner reach to new branches and leaves no access once the %s',
    async (revocation) => {
      await expect(
        withTenantDb(organizationId, async (db) => {
          await db.organizationDepartment.create({ data: { key: 'OPS', name: 'Operations' } });
          const originalBranch = await db.restaurantBranch.create({ data: { name: 'Original' } });
          const user = await db.user.create({
            data: {
              name: 'Floor owner',
              email: `owner-${revocation.replaceAll(' ', '-')}-${organizationId}@example.invalid`,
              department: 'OPS',
              title: 'Owner',
              role: 'EMPLOYEE',
            },
          });
          const profile = await db.restaurantStaffProfile.create({
            data: { userId: user.id, displayName: user.name, primaryBranchId: originalBranch.id },
          });
          await ensureDefaultJobRoles(db);
          const owner = await db.restaurantJobRole.findFirstOrThrow({ where: { key: 'owner' } });
          await grantJobRole(db, {
            staffProfileId: profile.id,
            jobRoleId: owner.id,
            branchId: originalBranch.id,
          });

          // A branch created or reactivated after the grant is reached dynamically.
          const newBranch = await db.restaurantBranch.create({ data: { name: 'New' } });
          await db.restaurantBranch.update({ where: { id: newBranch.id }, data: { active: false } });
          await db.restaurantBranch.update({ where: { id: newBranch.id }, data: { active: true } });
          expect(await hasStaffBranchAccess(db, profile.id, newBranch.id)).toBe(true);
          expect(
            await operatorHasCapability(db, profile.id, 'payments:refund', new Date(), newBranch.id)
          ).toBe(true);
          // No generated holding or branch assignment exists to outlive revocation.
          expect(
            await db.restaurantStaffJobRole.count({
              where: { staffProfileId: profile.id, branchId: newBranch.id },
            })
          ).toBe(0);
          expect(await db.restaurantBranchAssignment.count({ where: { userId: user.id } })).toBe(0);

          if (revocation === 'owner holding is removed') {
            await revokeJobRole(db, {
              staffProfileId: profile.id,
              jobRoleId: owner.id,
              branchId: originalBranch.id,
            });
          } else {
            await db.restaurantJobRole.update({ where: { id: owner.id }, data: { active: false } });
          }
          expect(await hasStaffBranchAccess(db, profile.id, newBranch.id)).toBe(false);
          expect(
            await operatorHasCapability(db, profile.id, 'payments:refund', new Date(), newBranch.id)
          ).toBe(false);
          throw rollback;
        })
      ).rejects.toBe(rollback);
    }
  );
});
