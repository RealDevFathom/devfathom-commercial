import 'server-only';

import { TRPCError } from '@trpc/server';
import type { TRPCContext } from '@/server/trpc';

type SessionStaffCandidate = {
  id: string;
  primaryBranchId?: string | null;
  jobRoles?: Array<{ jobRoleId: string }>;
};

/**
 * Choose the acting profile among the signed-in user's ACTIVE staff profiles.
 *
 * `userId` is not unique on staff profiles: a multi-branch employee can hold one
 * per branch. With a branch context the choice uses the same order as the SOP
 * execution scope (`executionScope` in `restaurant-sop-execution.ts`), so the
 * visibility check and the recorded actor always agree on one profile:
 *   1. the profile whose primary branch is this branch,
 *   2. then one holding an active job role at this branch,
 *   3. then the oldest profile by id.
 * Candidates must be ordered by id ascending. Without a branch context, only an
 * unambiguous single profile is accepted.
 */
export function pickSessionStaffProfile(
  candidates: SessionStaffCandidate[],
  branchId?: string | null
): string | null {
  if (candidates.length === 1) return candidates[0].id;
  if (candidates.length === 0 || !branchId) return null;
  return (
    candidates.find((row) => row.primaryBranchId === branchId)?.id ??
    candidates.find((row) => (row.jobRoles?.length ?? 0) > 0)?.id ??
    candidates[0].id
  );
}

/**
 * Resolve the acting staff profile from the authenticated session only: an
 * ACTIVE staff profile linked to the signed-in user in the active tenant. No
 * caller-supplied staff id is ever consulted.
 *
 * Pass the branch of the record being acted on (derived server-side) so a user
 * with profiles at several branches acts as the profile for that branch. Fails
 * closed (FORBIDDEN) when the user has no active profile, or several profiles
 * and no branch context to choose between them.
 */
export async function requireSessionStaffProfileId(
  ctx: TRPCContext,
  options: { branchId?: string | null } = {}
): Promise<string> {
  const user = ctx.session?.user;
  const organizationId = ctx.entitlements.organizationId;
  if (!user || !organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  const branchId = options.branchId ?? null;
  const where = { userId: user.id, organizationId, status: 'ACTIVE' as const };
  // Without a branch, two rows already prove ambiguity. With a branch, every
  // active profile is a candidate for the branch-specific choice.
  const profiles: SessionStaffCandidate[] = branchId
    ? await ctx.db.restaurantStaffProfile.findMany({
        where,
        orderBy: { id: 'asc' },
        select: {
          id: true,
          primaryBranchId: true,
          jobRoles: {
            where: { branchId, jobRole: { active: true } },
            select: { jobRoleId: true },
          },
        },
      })
    : await ctx.db.restaurantStaffProfile.findMany({
        where,
        select: { id: true },
        take: 2,
      });
  const staffProfileId = pickSessionStaffProfile(profiles, branchId);
  if (!staffProfileId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: branchId
        ? 'An active staff profile linked to your account is required.'
        : 'A unique active staff profile is required.',
    });
  }
  return staffProfileId;
}
