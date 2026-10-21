/**
 * TEST-ONLY (see `eslint.config.mjs`). A hospitality tenant a database suite
 * can act inside.
 *
 * `hotel_properties` carries a RESTRICTIVE policy: a tenant connection reaches
 * a property only as an acting user (`app.current_user_id`) who holds an active
 * assignment at it. A suite therefore cannot create its property from inside a
 * tenant transaction — the first assignment cannot exist before the row does —
 * which is exactly the circularity provisioning closes from the control plane.
 * So this seeds the way `organization.create` does: under `withPlatformDb`, the
 * organization, its department catalog, a member, an Owner role with a `*`
 * ALLOW grant, the properties and the member's assignment to each of them. The
 * suite then runs its tenant work with `withTenantDb(organizationId, run,
 * { userId })`, and raw-pg suites set the same two GUCs by hand.
 */
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { defaultDepartmentRowsForVertical } from '@/lib/vertical-catalog';

export type HotelTenantFixture = {
  organizationId: string;
  userId: string;
  roleId: string;
  /** `branchId` per requested property, in request order. */
  branchIds: string[];
};

export type HotelTenantFixtureOptions = {
  /** Unique per run; it names every row the fixture writes. */
  organizationId: string;
  /** One property per name; the first is the suite's main property. */
  properties: readonly { name: string; branchId?: string }[];
  status?: 'ONBOARDING' | 'ACTIVE' | 'PURGING';
  userId?: string;
  roleId?: string;
};

export async function seedHotelTenant(
  withPlatformDb: <T>(run: (db: ScopedDb) => Promise<T>) => Promise<T>,
  options: HotelTenantFixtureOptions
): Promise<HotelTenantFixture> {
  const organizationId = options.organizationId;
  const userId = options.userId ?? `${organizationId}_user`;
  const roleId = options.roleId ?? `${organizationId}_owner`;
  // A hospitality tenant by definition; the fixture never branches on it.
  const vertical = 'HOSPITALITY' as const;

  return withPlatformDb(async (db) => {
    await db.organization.create({
      data: {
        id: organizationId,
        slug: organizationId.replaceAll('_', '-').toLowerCase(),
        legalName: `${organizationId} (synthetic)`,
        displayName: organizationId,
        vertical,
        status: options.status ?? 'ACTIVE',
        deploymentMode: 'SHARED',
        currency: 'PKR',
        timezone: 'Asia/Karachi',
        ...(options.status === 'PURGING'
          ? { purgeScheduledAt: new Date(Date.now() - 86_400_000) }
          : {}),
      },
    });
    await db.organizationDepartment.createMany({
      data: defaultDepartmentRowsForVertical(vertical).map((department) => ({
        id: `${organizationId}_dept_${department.key.toLowerCase()}`,
        organizationId,
        key: department.key,
        name: department.name,
        sortOrder: department.sortOrder,
      })),
    });
    await db.organizationRole.create({
      data: {
        id: roleId,
        organizationId,
        key: 'owner',
        name: 'Owner',
        isSystem: true,
        permissions: { create: [{ organizationId, capability: '*', effect: 'ALLOW' }] },
      },
    });
    await db.user.create({
      data: {
        id: userId,
        organizationId,
        organizationRoleId: roleId,
        name: 'Synthetic Owner',
        email: `${userId}@example.test`,
        role: 'ADMIN',
        department: 'FRONT_OFFICE',
        title: 'General Manager',
        status: 'ACTIVE',
      },
    });
    const branchIds: string[] = [];
    for (const [index, property] of options.properties.entries()) {
      const branchId = property.branchId ?? `${organizationId}_property_${index + 1}`;
      await db.hotelProperty.create({
        data: {
          branchId,
          organizationId,
          name: property.name,
          addressLine: `${index + 1} Fixture Street`,
          city: 'Lahore',
          timezone: 'Asia/Karachi',
          bookingEngineSlug: `${organizationId.replaceAll('_', '-').toLowerCase()}-${index + 1}`,
        },
      });
      await db.hotelPropertyAssignment.create({
        data: {
          id: `${branchId}_assignment`,
          organizationId,
          branchId,
          userId,
          organizationRoleId: roleId,
          active: true,
        },
      });
      branchIds.push(branchId);
    }
    return { organizationId, userId, roleId, branchIds };
  });
}
