import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { ensureAdministratorStaffProfile } from './administrator-staff-profile';
import { grantJobRole } from './job-roles';

export const FLOOR_INVITE_ROLES = ['cashier', 'kitchen', 'server'];

/** Acceptance runs in the token's tenant scope; no credential is issued here. */
export async function provisionInvitedFloorStaff(
  db: ScopedDb,
  user: {
    id: string;
    organizationId: string;
    name: string;
    email: string;
    organizationRole: { key: string } | null;
    organization: { vertical?: string };
  }
) {
  const key = user.organizationRole?.key;
  if (user.organization.vertical !== 'RESTAURANT' || !key || !FLOOR_INVITE_ROLES.includes(key))
    return;
  const profile = await ensureAdministratorStaffProfile(db, {
    organizationId: user.organizationId,
    userId: user.id,
    displayName: user.name,
    email: user.email,
  });
  if (profile.primaryBranchId) {
    const role = await db.restaurantJobRole.findFirst({
      where: { key, active: true },
      select: { id: true },
    });
    if (!role) throw new Error('The invited floor role is not configured.');
    await grantJobRole(db, {
      staffProfileId: profile.staffProfileId,
      branchId: profile.primaryBranchId,
      jobRoleId: role.id,
    });
  }
}

/** A missing PIN is the setup state: never manufacture a temporary secret. */
export async function pendingOwnPinProfile(db: ScopedDb, userId: string) {
  return db.restaurantStaffProfile.findFirst({
    where: {
      userId,
      status: 'ACTIVE',
      user: {
        organization: { vertical: 'RESTAURANT' },
        organizationRole: { key: { in: FLOOR_INVITE_ROLES } },
      },
      credentials: { none: { type: 'PIN', revokedAt: null } },
    },
    select: { id: true },
  });
}
