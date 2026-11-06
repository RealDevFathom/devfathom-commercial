import 'server-only';

import type { TRPCContext } from '@/server/trpc';
import { requireSessionStaffProfileId } from './session-staff';

/**
 * Identity comes only from the authenticated user in the active tenant. Pass the
 * branch of the SOP record (derived server-side) so a multi-branch employee acts
 * as their profile for that branch.
 */
export async function requireSopActor(ctx: TRPCContext, branchId?: string | null): Promise<string> {
  return requireSessionStaffProfileId(ctx, { branchId });
}
