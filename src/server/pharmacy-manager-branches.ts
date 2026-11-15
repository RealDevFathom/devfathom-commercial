import 'server-only';

import { can, subjectFromSession, type Action } from '@/lib/abac';
import { capabilityMatches } from '@/lib/abac/capabilities';
import { ACTIVE_STATUSES } from '@/lib/auth/session-state';
import type { TRPCContext } from './trpc';

/**
 * DEV-505: the branches a pharmacy Manager runs. A Manager is a member holding
 * `pharmacy:manage` (the Manager role template), and their reach is limited to
 * the active branches they are actively assigned to — never the whole tenant.
 *
 * `duty` is the capability the caller is standing in for (`pharmacy:close` for
 * day close, `reports:operational` for branch reports). An explicit DENY of that
 * capability, from the role or a live user override, wins over the manager grant,
 * exactly as DEV-31's day-close manager path already decides. The stored member
 * must still be active in this organization: a session claim can outlive a
 * suspension until it is revalidated. Anything missing returns no branches.
 */
export async function managerBranchIds(ctx: TRPCContext, duty: Action): Promise<string[]> {
  const user = ctx.session?.user;
  const organizationId = ctx.entitlements?.organizationId;
  if (!user?.id || !organizationId) return [];
  const options = { db: ctx.db, source: 'TRPC' as const, ip: ctx.requestMeta?.ip ?? null };
  if (!(await can(subjectFromSession(user), 'pharmacy:manage', undefined, options))) return [];
  const member = await ctx.db.user.findUnique({
    where: { id: user.id },
    select: {
      status: true,
      organizationId: true,
      organizationRole: {
        select: { permissions: { select: { capability: true, effect: true } } },
      },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  if (
    !member ||
    member.organizationId !== organizationId ||
    !member.status ||
    !ACTIVE_STATUSES.has(member.status)
  )
    return [];
  const rules = [...member.permissionOverrides, ...(member.organizationRole?.permissions ?? [])];
  if (
    rules.some((rule) => rule.effect === 'DENY' && capabilityMatches(rule.capability, duty, 'DENY'))
  )
    return [];
  const assignments = await ctx.db.pharmacyBranchAssignment.findMany({
    where: {
      organizationId,
      userId: user.id,
      active: true,
      branch: { organizationId, active: true },
    },
    select: { branchId: true },
  });
  return [...new Set(assignments.map((assignment) => assignment.branchId))];
}
