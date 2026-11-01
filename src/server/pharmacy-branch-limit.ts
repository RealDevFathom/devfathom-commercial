import { TRPCError } from '@trpc/server';

import { pharmacyBranchLimit as readBranchLimit } from '@/lib/pharmacy/branch-limit';
import type { TRPCContext } from '@/server/trpc';

type BranchLimitContext = Pick<TRPCContext, 'db' | 'session'>;

/**
 * The signed-in member's branch limit inside `organizationId` (see
 * `@/lib/pharmacy/branch-limit`): null means organization-wide.
 */
export function pharmacyBranchLimit(
  ctx: BranchLimitContext,
  organizationId: string
): Promise<string[] | null> {
  return readBranchLimit(ctx.db, ctx.session?.user, organizationId);
}

/** Refuse a branch outside a branch-scoped member's own assignments. */
export async function requirePharmacyBranchWithinLimit(
  ctx: BranchLimitContext,
  organizationId: string,
  branchId: string
): Promise<void> {
  const limit = await pharmacyBranchLimit(ctx, organizationId);
  if (limit && !limit.includes(branchId))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
}
