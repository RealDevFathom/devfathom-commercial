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
  const scope = await resolveRestaurantActorBranchScope(ctx);
  const requiredBranchIds = [...new Set(branchIds)];
  if (scope.branchIds !== null && !requiredBranchIds.every((id) => scope.branchIds.includes(id))) {
    throw ACTOR_DENIED;
  }
  const user = ctx.session!.user;
  const organizationId = ctx.entitlements?.organizationId ?? user.organizationId;
  if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  await assertInOrganization(ctx.db.restaurantBranch, organizationId, requiredBranchIds, {
    active: true,
  });
  return { staffProfileId: scope.staffProfileId };
}

/** Resolve authorized read branches; `null` denotes an explicit all-branch grant. */
export async function resolveRestaurantActorBranchScope(ctx: TRPCContext) {
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

  const assigned = await ctx.db.restaurantBranchAssignment.findMany({
    where: { userId: user.id },
    select: { branchId: true },
  });
  const authorizedBranchIds = new Set(assigned.map(({ branchId }) => branchId));
  if (actor.primaryBranchId) authorizedBranchIds.add(actor.primaryBranchId);

  const configuresAllBranches = await can(
    subjectFromSession(user),
    'restaurant:configure',
    undefined,
    { db: ctx.db, source: 'TRPC', ip: ctx.requestMeta.ip }
  );
  if (configuresAllBranches) return { staffProfileId: actor.id, branchIds: null };

  const organizationId = ctx.entitlements?.organizationId ?? user.organizationId;
  if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  const branches = await ctx.db.restaurantBranch.findMany({
    where: { id: { in: [...authorizedBranchIds] }, active: true },
    select: { id: true },
  });
  return { staffProfileId: actor.id, branchIds: branches.map(({ id }) => id) };
}
