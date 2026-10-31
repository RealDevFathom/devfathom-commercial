// @vitest-environment node
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import { ensureDefaultJobRoles } from './job-roles';
import { operatorHasCapability } from './operator-capabilities';
import { hasStaffBranchAccess } from './branch-access';
import { assignOwnersToBranch } from './owner-branch-assignments';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl) process.env.DATABASE_URL = testDatabaseUrl;
const describeIfDatabase = testDatabaseUrl ? describe : describe.skip;
const organizationId = `owner_assignment_${randomBytes(6).toString('hex')}`;

// Roll back each tenant fixture, including role grants and their audit rows.
const rollback = new Error('rollback owner assignment fixture');

describeIfDatabase('owner branch assignments against PostgreSQL', () => {
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

  it.each(['expires', 'is removed'] as const)(
    'does not persist override-derived access when the wildcard grant %s',
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
          const override = await db.userPermissionOverride.create({
            data: {
              userId: user.id,
              capability: '*',
              effect: 'ALLOW',
              reason: 'Temporary branch administration',
              expiresAt: revocation === 'expires' ? new Date(Date.now() + 60_000) : null,
            },
          });

          // Exercise both initial assignment and the branch-reactivation path.
          await assignOwnersToBranch(db, organizationId, newBranch.id);
          await db.restaurantBranch.update({
            where: { id: newBranch.id },
            data: { active: false },
          });
          await db.restaurantBranch.update({ where: { id: newBranch.id }, data: { active: true } });
          await assignOwnersToBranch(db, organizationId, newBranch.id);
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

          if (revocation === 'expires') {
            await db.userPermissionOverride.update({
              where: { id: override.id },
              data: { expiresAt: new Date(0) },
            });
          } else {
            await db.userPermissionOverride.delete({ where: { id: override.id } });
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
});
