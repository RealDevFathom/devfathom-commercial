import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** System owner identity bound to a live pharmacy tenant, never the ADMIN title. */
export async function isPharmacyOwner(db: ScopedDb, organizationId: string, userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId, organizationId, status: 'ACTIVE' },
    select: {
      status: true,
      organizationId: true,
      organization: { select: { vertical: true } },
      organizationRole: { select: { organizationId: true, key: true, isSystem: true } },
    },
  });
  return (
    user?.status === 'ACTIVE' &&
    user.organizationId === organizationId &&
    user.organization?.vertical === 'PHARMACY' &&
    user.organizationRole?.organizationId === organizationId &&
    user.organizationRole.key === 'owner' &&
    user.organizationRole.isSystem === true
  );
}
