import { TRPCError } from '@trpc/server';

import { can, subjectFromSession } from '@/lib/abac';
import { assertInOrganization } from '@/server/org-refs';
import type { TRPCContext } from '@/server/trpc';

/**
 * Enforce the Restaurant back-office branch boundary above tenant RLS.
 *
 * A branch is in scope when the active web user is linked to an ACTIVE staff
 * profile whose primary branch matches, has an explicit branch assignment, or
 * holds the organization-wide `restaurant:configure` capability. The branch row
 * must also exist, be active, and belong to the session organization. No caller
 * supplies an organization id.
 */
export async function requireRestaurantBranchScope(
  ctx: TRPCContext,
  branchId: string
): Promise<void> {
  const user = ctx.session?.user;
  if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' });

  const [primaryBranch, assignment] = await Promise.all([
    ctx.db.restaurantStaffProfile.findFirst({
      where: { userId: user.id, status: 'ACTIVE', primaryBranchId: branchId },
      select: { id: true },
    }),
    ctx.db.restaurantBranchAssignment.findFirst({
      where: { userId: user.id, branchId },
      select: { id: true },
    }),
  ]);
  const configuresAllBranches =
    Boolean(primaryBranch || assignment) ||
    (await can(subjectFromSession(user), 'restaurant:configure', undefined, {
      db: ctx.db,
      source: 'TRPC',
      ip: ctx.requestMeta.ip,
    }));
  if (!configuresAllBranches) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You are not authorized for this restaurant branch.',
    });
  }

  const organizationId = ctx.entitlements?.organizationId ?? user.organizationId;
  if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  await assertInOrganization(ctx.db.restaurantBranch, organizationId, [branchId], { active: true });
}
