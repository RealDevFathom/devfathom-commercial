import 'server-only';

import type { TRPCContext } from '@/server/trpc';
import { requireSessionStaffProfileId } from './session-staff';

/** Identity comes only from the authenticated user in the active tenant. */
export async function requireSopActor(ctx: TRPCContext): Promise<string> {
  return requireSessionStaffProfileId(ctx);
}
