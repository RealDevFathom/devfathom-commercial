import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** A system role in this tenant, never a caller-supplied role name. */
export async function isPharmacyOwner(db: ScopedDb, organizationId: string, userId: string) {
  return Boolean(
    await db.user.findFirst({
      where: {
        id: userId,
        organizationId,
        status: 'ACTIVE',
        organization: { vertical: 'PHARMACY' },
        organizationRole: { organizationId, key: 'owner', isSystem: true },
      },
      select: { id: true },
    })
  );
}

/** Count tenant-wide: an unassigned colleague still makes this a staffed pharmacy. */
export async function isSoloPharmacyOwner(db: ScopedDb, organizationId: string, userId: string) {
  if (!(await isPharmacyOwner(db, organizationId, userId))) return false;
  return (await db.user.count({ where: { organizationId, status: 'ACTIVE' } })) === 1;
}
