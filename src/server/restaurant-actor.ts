import { TRPCError } from '@trpc/server';

import { can, subjectFromSession } from '@/lib/abac';
import { assertInOrganization } from '@/server/org-refs';
import type { TRPCContext } from '@/server/trpc';

const ACTOR_DENIED = new TRPCError({
  code: 'FORBIDDEN',
  message: 'Your account is not linked to an active staff profile authorized for this branch.',
});

/** Resolve an authenticated web user to one eligible in-tenant restaurant actor. */
export async function resolveRestaurantActor(ctx: TRPCContext, branchIds: string[]) {
  const user = ctx.session?.user;
  if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' });

  const actors = await ctx.db.restaurantStaffProfile.findMany({
    where: { userId: user.id, status: 'ACTIVE' },
    select: { id: true, primaryBranchId: true },
    orderBy: { id: 'asc' },
    take: 2,
  });
  if (actors.length !== 1) throw ACTOR_DENIED;
  const actor = actors[0]!;

  const requiredBranchIds = [...new Set(branchIds)];
  const assigned = await ctx.db.restaurantBranchAssignment.findMany({
    where: { userId: user.id, branchId: { in: requiredBranchIds } },
    select: { branchId: true },
  });
  const authorizedBranchIds = new Set(assigned.map(({ branchId }) => branchId));
  if (actor.primaryBranchId) authorizedBranchIds.add(actor.primaryBranchId);

  const assignedToEveryBranch = requiredBranchIds.every((branchId) =>
    authorizedBranchIds.has(branchId)
  );
  if (!assignedToEveryBranch) {
    const configuresAllBranches = await can(
      subjectFromSession(user),
      'restaurant:configure',
      undefined,
      { db: ctx.db, source: 'TRPC', ip: ctx.requestMeta.ip }
    );
    if (!configuresAllBranches) throw ACTOR_DENIED;
  }

  const organizationId = ctx.entitlements?.organizationId ?? user.organizationId;
  if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  await assertInOrganization(ctx.db.restaurantBranch, organizationId, requiredBranchIds, {
    active: true,
  });
  return { staffProfileId: actor.id };
}
