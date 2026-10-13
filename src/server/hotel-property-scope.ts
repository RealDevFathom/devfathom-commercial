import 'server-only';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { Prisma } from '@/generated/prisma/client';
import { can, subjectFromSession, type Action } from '@/lib/abac';
import { evaluateSessionUser } from '@/lib/auth/session-state';
import { hasModule } from '@/lib/entitlements';
import { HOSPITALITY_CAPABILITIES, HOSPITALITY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import type { TRPCContext } from '@/server/trpc';

type HotelCapability = Extract<Action, `hotel:${string}`>;

export const hotelCapabilityInput = z.custom<HotelCapability>(
  (value) => typeof value === 'string' && HOSPITALITY_CAPABILITIES.includes(value),
  'Choose a Hotel capability.'
);

export const hotelPropertySelectionInput = z.object({
  branchId: z.string().trim().min(1).max(128),
});

export const hotelRoleKeys = HOSPITALITY_ROLE_TEMPLATES.map((role) => role.key);

function forbidden(): never {
  throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this property.' });
}

/**
 * Resolve one explicitly requested property. Call again for EVERY operation:
 * this result is not a grant, selection token, JWT claim or cached permission.
 * Organization capability/overrides remain a ceiling; the assigned role can
 * only narrow them. Missing assignment, unknown role and missing grants deny.
 * Requires the additive Prisma schema to be generated before runtime use.
 */
export async function requireHotelPropertyScope(
  ctx: Omit<TRPCContext, 'db'> & { db: Prisma.TransactionClient },
  requestedBranchId: string,
  capability: HotelCapability
) {
  const user = ctx.session?.user;
  if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  const verdict = evaluateSessionUser(user);
  if (!verdict.ok) {
    throw new TRPCError({
      code: verdict.kind === 'session-ended' ? 'UNAUTHORIZED' : 'FORBIDDEN',
      message: verdict.message,
    });
  }
  const organizationId = ctx.entitlements.organizationId;
  if (user.organizationId !== organizationId) forbidden();
  if (!hasModule(ctx.entitlements, 'hotel-core')) forbidden();
  if (
    !(await can(subjectFromSession(user), capability, undefined, {
      db: ctx.db,
      source: 'TRPC',
      ip: ctx.requestMeta.ip,
    }))
  )
    forbidden();

  const { branchId } = hotelPropertySelectionInput.parse({ branchId: requestedBranchId });
  const assignment = await ctx.db.hotelPropertyAssignment.findFirst({
    where: {
      organizationId,
      branchId,
      userId: user.id,
      active: true,
      user: { organizationId, status: { in: ['ACTIVE', 'ON_LEAVE'] } },
      property: { organizationId, active: true },
      role: { organizationId, key: { in: hotelRoleKeys } },
    },
    include: {
      property: { select: { branchId: true, organizationId: true, name: true } },
      role: { include: { permissions: true } },
    },
  });
  if (!assignment) forbidden();
  const rules = assignment.role.permissions.filter(
    (rule) =>
      rule.capability === '*' || rule.capability === 'hotel:*' || rule.capability === capability
  );
  if (
    rules.some((rule) => rule.effect === 'DENY') ||
    !rules.some((rule) => rule.effect === 'ALLOW')
  ) {
    forbidden();
  }
  return assignment.property;
}
