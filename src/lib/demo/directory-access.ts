import 'server-only';

import { can, subjectFromSession } from '@/lib/abac';
import { liveDemoAccessExpiry } from '@/lib/auth/session-state';
import {
  denyStaffBranchAccess,
  resolveCapabilityBranchAuthorization,
} from '@/lib/restaurant/staff-branch-authorization';
import type { TRPCContext } from '@/server/trpc';
import { demoSeatFromOrganizationId } from './config';
import { demoPersonaForUser, isCanonicalDemoOrganization } from './personas';

/** Console directories disclose only branches covered by the actor's existing read duty. */
export async function resolveDemoDirectoryScope(
  ctx: TRPCContext,
  directory: 'branches' | 'devices'
) {
  if (!ctx.organization?.isDemo) return null;
  const user = ctx.session?.user;
  const seat = demoSeatFromOrganizationId(ctx.organization.id);
  if (
    !seat ||
    !user ||
    user.organizationId !== ctx.organization.id ||
    !isCanonicalDemoOrganization(ctx.organization) ||
    !liveDemoAccessExpiry(user.demoAccessExpiresAt)
  )
    denyStaffBranchAccess();
  const persona = demoPersonaForUser(seat, user);
  const capability =
    persona === 'finance'
      ? 'money:read'
      : persona === 'inventory' && directory === 'branches'
        ? 'inventory:read'
        : null;
  if (!capability) return null;
  if (!(await can(subjectFromSession(user), capability, undefined, { db: ctx.db, source: 'TRPC' })))
    denyStaffBranchAccess();
  return resolveCapabilityBranchAuthorization(ctx.db, user, capability, {
    requireExactlyOneActiveActor: true,
  });
}
