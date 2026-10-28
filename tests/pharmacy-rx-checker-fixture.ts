import { hash } from 'bcryptjs';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export const RX_CHECKER_PIN = '583917';

/** A real, independent STAFFED checker so Rx reference tests reach their own guards. */
export async function seedRxChecker(db: ScopedDb, branchId: string, userId: string) {
  const role = await db.organizationRole.create({
    data: {
      key: 'pharmacist',
      name: 'Independent pharmacist',
      isSystem: true,
      permissions: { create: { capability: 'pharmacy:dispense', effect: 'ALLOW' } },
    },
  });
  await db.user.create({
    data: {
      id: userId,
      name: 'Independent pharmacist',
      email: `${userId}@example.invalid`,
      department: 'LEADERSHIP',
      title: 'Pharmacist',
      organizationRoleId: role.id,
    },
  });
  await db.pharmacyBranchAssignment.create({ data: { userId, branchId } });
  const profile = await db.restaurantStaffProfile.create({
    data: { userId, displayName: 'Independent pharmacist' },
  });
  await db.restaurantOperatorCredential.create({
    data: {
      staffProfileId: profile.id,
      type: 'PIN',
      credentialHash: await hash(RX_CHECKER_PIN, 4),
    },
  });
}
