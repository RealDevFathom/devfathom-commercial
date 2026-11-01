import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { seedDepartments } from '@/lib/test-support/departments';
import { hashOperatorCredential } from '@/lib/restaurant/operator-credentials';

/** Real active manager and PIN; approval tests still exercise the live policy. */
export async function seedPharmacyChecker(
  db: ScopedDb,
  organizationId: string,
  id: string,
  pin?: string
) {
  await seedDepartments(db, [organizationId], ['LEADERSHIP']);
  const role = await db.organizationRole.upsert({
    where: { organizationId_key: { organizationId, key: 'manager' } },
    update: {},
    create: { organizationId, key: 'manager', name: 'Manager', isSystem: true },
  });
  await db.user.upsert({
    where: { id },
    update: {},
    create: {
      id,
      organizationId,
      organizationRoleId: role.id,
      name: 'Checker',
      email: `${id}@example.test`,
      title: 'Manager',
      department: 'LEADERSHIP',
      role: 'EMPLOYEE',
      status: 'ACTIVE',
    },
  });
  if (pin) {
    const profile = await db.restaurantStaffProfile.create({
      data: { organizationId, userId: id, displayName: 'Checker', status: 'ACTIVE' },
    });
    await db.restaurantOperatorCredential.create({
      data: {
        organizationId,
        staffProfileId: profile.id,
        type: 'PIN',
        credentialHash: await hashOperatorCredential('PIN', pin),
      },
    });
  }
  return id;
}
