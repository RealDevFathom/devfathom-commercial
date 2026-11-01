import 'server-only';

import { TRPCError } from '@trpc/server';
import type { TRPCContext } from '@/server/trpc';

/**
 * Resolve the acting staff profile from the authenticated session only: exactly
 * one ACTIVE staff profile linked to the signed-in user in the active tenant.
 * No caller-supplied staff id is ever consulted. Fails closed (FORBIDDEN) when
 * the user has no profile or an ambiguous set of profiles.
 */
export async function requireSessionStaffProfileId(ctx: TRPCContext): Promise<string> {
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
