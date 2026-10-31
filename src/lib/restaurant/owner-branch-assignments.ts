import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { grantJobRole } from './job-roles';

/** Called within provisioning/branch creation transactions. Never grants a full
 * owner role to an ordinary branch manager or revives an inactive role/profile.
 * User overrides remain derived access: persisting ownership or assignments here
 * would outlive their expiry or revocation. */
export async function assignOwnersToBranch(db: ScopedDb, organizationId: string, branchId: string) {
  const profiles = await db.restaurantStaffProfile.findMany({
    where: {
      organizationId,
      status: 'ACTIVE',
      OR: [
        { jobRoles: { some: { jobRole: { key: 'owner', active: true } } } },
        {
          user: {
            status: 'ACTIVE',
            organizationRole: { permissions: { some: { capability: '*', effect: 'ALLOW' } } },
          },
        },
      ],
    },
    select: { id: true, userId: true },
  });
  const role = await db.restaurantJobRole.findFirst({
    where: { organizationId, key: 'owner', active: true },
    select: { id: true },
  });
  for (const profile of profiles) {
    if (profile.userId) {
      await db.restaurantBranchAssignment.upsert({
        where: { branchId_userId: { branchId, userId: profile.userId } },
        create: { organizationId, branchId, userId: profile.userId },
        update: {},
      });
    }
    if (role) await grantJobRole(db, { staffProfileId: profile.id, jobRoleId: role.id, branchId });
  }
}
