import 'server-only';

import { TRPCError } from '@trpc/server';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** Shared by production provisioning and authenticated pharmacy self-enrollment. */
export async function ensurePharmacyStaffProfile(
  db: ScopedDb,
  organizationId: string,
  userId: string
) {
  // Serialize enrollment/provisioning for the same identity. Never accept a
  // client-supplied profile or reactivate a suspended/archived profile.
  const users = await db.$queryRaw<Array<{ id: string; name: string }>>`
    SELECT id, name FROM users WHERE id=${userId} AND "organizationId"=${organizationId}
      AND status='ACTIVE' FOR UPDATE`;
  const user = users[0];
  if (!user)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'An active pharmacy account is required.' });
  const profiles = await db.restaurantStaffProfile.findMany({
    where: { organizationId, userId },
    select: { id: true, status: true },
  });
  if (profiles.length > 1 || (profiles[0] && profiles[0].status !== 'ACTIVE'))
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Ask your administrator to review your staff profile.',
    });
  return (
    profiles[0] ??
    db.restaurantStaffProfile.create({
      data: { organizationId, userId, displayName: user.name, status: 'ACTIVE' },
      select: { id: true, status: true },
    })
  );
}
