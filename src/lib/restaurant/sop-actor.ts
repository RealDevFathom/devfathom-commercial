import 'server-only';

import { TRPCError } from '@trpc/server';
import type { TRPCContext } from '@/server/trpc';

/** Identity comes only from the authenticated user in the active tenant. */
export async function requireSopActor(ctx: TRPCContext): Promise<string> {
  const user = ctx.session?.user;
  const organizationId = ctx.entitlements.organizationId;
  if (!user || !organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  const profiles = await ctx.db.restaurantStaffProfile.findMany({
    where: { userId: user.id, organizationId, status: 'ACTIVE' },
    select: { id: true },
    take: 2,
  });
  if (profiles.length !== 1) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'A unique active staff profile is required.',
    });
  }
  return profiles[0].id;
}
