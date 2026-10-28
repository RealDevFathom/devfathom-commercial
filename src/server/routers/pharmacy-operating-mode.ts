import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { authorizeSoloApproval, verifySoloOwnerPin } from '@/lib/pharmacy/solo-approval';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '../trpc';
import { protectedProcedure, router } from '../trpc';

async function requireOwner(ctx: TRPCContext) {
  if (!ctx.session) throw new TRPCError({ code: 'UNAUTHORIZED' });
  const user = await ctx.db.user.findFirst({
    where: {
      id: ctx.session.user.id,
      organizationId: ctx.entitlements.organizationId,
      status: 'ACTIVE',
    },
    select: { organizationRole: { select: { key: true, isSystem: true } } },
  });
  if (user?.organizationRole?.key !== 'owner' || !user.organizationRole.isSystem) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only the pharmacy owner may change operating mode.',
    });
  }
}

export const pharmacyOperatingModeRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    await requireOwner(ctx);
    return ctx.db.organization.findFirstOrThrow({
      where: { id: ctx.entitlements.organizationId, vertical: 'PHARMACY' },
      select: { pharmacyOperatingMode: true },
    });
  }),
  set: protectedProcedure
    .input(
      z.object({ mode: z.enum(['SOLO', 'STAFFED']), pin: z.string().regex(/^\d{4,8}$/) }).strict()
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx);
      const organizationId = ctx.entitlements.organizationId;
      const actorId = ctx.session.user.id;
      return ctx.db.$transaction(async (transaction) => {
        const tx = transaction as ScopedDb;
        const organization = await tx.organization.findFirstOrThrow({
          where: { id: organizationId, vertical: 'PHARMACY' },
          select: { pharmacyOperatingMode: true },
        });
        if (organization.pharmacyOperatingMode === input.mode) return organization;
        // Entering SOLO cannot use SOLO eligibility before the mode is changed.
        // Reuse #683's credential verifier; leaving SOLO uses the full audited helper.
        const valid =
          organization.pharmacyOperatingMode === 'SOLO'
            ? await authorizeSoloApproval(
                tx,
                { organizationId, actorId, branchId: null },
                { type: 'OrganizationOperatingMode', id: organizationId },
                input.pin
              )
            : await verifySoloOwnerPin(tx, { organizationId, actorId, branchId: null }, input.pin, {
                requireSoloEligibility: false,
              });
        if (!valid)
          throw new TRPCError({
            code: 'UNAUTHORIZED',
            message: 'Owner PIN re-authentication failed.',
          });
        const updated = await tx.organization.update({
          where: { id: organizationId },
          data: { pharmacyOperatingMode: input.mode },
          select: { pharmacyOperatingMode: true },
        });
        await tx.auditLog.create({
          data: {
            organizationId,
            actorId,
            source: 'TRPC',
            category: 'PHARMACY',
            action: 'PHARMACY:OPERATING_MODE_CHANGED',
            targetType: 'Organization',
            targetId: organizationId,
            metadata: {
              from: organization.pharmacyOperatingMode,
              to: input.mode,
              reauthentication: 'PIN',
            },
          },
        });
        return updated;
      });
    }),
});
