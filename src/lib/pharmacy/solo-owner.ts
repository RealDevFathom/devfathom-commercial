import { actorIsPharmacyOwner } from './procurement-access';
import { ACTIVE_STATUSES } from '@/lib/auth/session-state';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * PUR-01/PUR-02 solo rule (#979, PR J): a live tenant owner who is the
 * organization's only active member. There is nobody else to approve the order
 * they raised or to verify the licence they filed, so those segregation-of-duties
 * refusals give way for them, and only for them. A second active member ends
 * the exception. The capability checks still apply in full.
 */
export async function isSoloPharmacyOwner(
  db: ScopedDb,
  input: {
    organizationId: string;
    actorId: string;
    /** Retained for callers; live owner authority is resolved from the database. */
    role?: string | null;
    /** The session user's own organization, which must be this one. */
    actorOrganizationId?: string | null;
  }
): Promise<boolean> {
  if (input.actorOrganizationId !== input.organizationId) return false;
  if (!(await actorIsPharmacyOwner(db, input.organizationId, input.actorId))) return false;
  const members = await db.user.findMany({
    where: {
      organizationId: input.organizationId,
      status: { in: [...ACTIVE_STATUSES] as Array<'ACTIVE' | 'ON_LEAVE'> },
    },
    select: { id: true },
    take: 2,
  });
  return members.length === 1 && members[0]!.id === input.actorId;
}
