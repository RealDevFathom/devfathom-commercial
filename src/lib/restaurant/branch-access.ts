import 'server-only';

import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** Branch membership is independent of action authorization. Owner floor roles and
 * linked full-administration grants span the tenant; action-level DENYs still apply. */
export async function hasStaffBranchAccess(db: ScopedDb, staffProfileId: string, branchId: string) {
  const profile = await db.restaurantStaffProfile.findFirst({
    where: {
      id: staffProfileId,
      status: 'ACTIVE',
      OR: staffBranchMembership(branchId),
    },
    select: { organizationId: true },
  });
  if (!profile) return false;
  return (
    (await db.restaurantBranch.count({
      where: { id: branchId, organizationId: profile.organizationId, active: true },
    })) === 1
  );
}

export function staffBranchMembership(branchId: string): Prisma.RestaurantStaffProfileWhereInput[] {
  return [
    { primaryBranchId: branchId },
    { jobRoles: { some: { branchId } } },
    { directCapabilityGrants: { some: { branchId } } },
    { jobRoles: { some: { jobRole: { key: 'owner', active: true } } } },
    { user: { restaurantBranchAssignments: { some: { branchId } } } },
    {
      user: {
        status: 'ACTIVE',
        organizationRole: { permissions: { some: { capability: '*', effect: 'ALLOW' } } },
      },
    },
    {
      user: {
        status: 'ACTIVE',
        permissionOverrides: {
          some: {
            capability: '*',
            effect: 'ALLOW',
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
        },
      },
    },
  ];
}
