import 'server-only';

import { TRPCError } from '@trpc/server';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** Resolve audit/ownership identity exclusively from the authenticated web session. */
export async function requireSopSessionStaff(
  db: ScopedDb,
  userId: string | undefined
): Promise<string> {
  if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  const profiles = await db.restaurantStaffProfile.findMany({
    where: { userId, status: 'ACTIVE' },
    select: { id: true },
    take: 2,
  });
  if (profiles.length !== 1) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'A unique active staff profile linked to your session is required.',
    });
  }
  return profiles[0]!.id;
}
