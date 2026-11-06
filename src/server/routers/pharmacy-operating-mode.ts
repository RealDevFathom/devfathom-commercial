import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { PHARMACY_COUNT_MAX_VARIANCE_THRESHOLD_UNITS } from '@/lib/pharmacy/count-variance-policy';
import { verifyPharmacyUserPin } from '@/lib/pharmacy/solo-approval';
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
      message: 'Only the pharmacy owner may change pharmacy approval policy.',
    });
  }
}

export const pharmacyOperatingModeRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    await requireOwner(ctx);
    return ctx.db.organization.findFirstOrThrow({
      where: { id: ctx.entitlements.organizationId, vertical: 'PHARMACY' },
      select: { pharmacyOperatingMode: true, pharmacyCountVarianceThresholdUnits: true },
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
        await tx.$queryRaw`SELECT id FROM organizations WHERE id=${organizationId} FOR NO KEY UPDATE`;
        await requireOwner({ ...ctx, db: tx });
        const organization = await tx.organization.findFirstOrThrow({
          where: { id: organizationId, vertical: 'PHARMACY' },
          select: { pharmacyOperatingMode: true },
        });
        // Mode changes require the owner's credential even when staff were added
        // while SOLO was selected. Document self-approval still requires #683 eligibility.
        const valid = await verifyPharmacyUserPin({ organizationId, actorId }, input.pin);
        if (!valid)
          throw new TRPCError({
            code: 'FORBIDDEN',
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
  /** Count variance tolerance. Owner-only, PIN re-authenticated and audited, like mode. */
  setCountVarianceThreshold: protectedProcedure
    .input(
      z
        .object({
          thresholdUnits: z
            .number()
            .int()
            .nonnegative()
            .max(PHARMACY_COUNT_MAX_VARIANCE_THRESHOLD_UNITS),
          pin: z.string().regex(/^\d{4,8}$/),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await requireOwner(ctx);
      const organizationId = ctx.entitlements.organizationId;
      const actorId = ctx.session.user.id;
      return ctx.db.$transaction(async (transaction) => {
        const tx = transaction as ScopedDb;
        await tx.$queryRaw`SELECT id FROM organizations WHERE id=${organizationId} FOR NO KEY UPDATE`;
        await requireOwner({ ...ctx, db: tx });
        const organization = await tx.organization.findFirstOrThrow({
          where: { id: organizationId, vertical: 'PHARMACY' },
          select: { pharmacyCountVarianceThresholdUnits: true },
        });
        const valid = await verifyPharmacyUserPin({ organizationId, actorId }, input.pin);
        if (!valid)
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Owner PIN re-authentication failed.',
          });
        const updated = await tx.organization.update({
          where: { id: organizationId },
          data: { pharmacyCountVarianceThresholdUnits: input.thresholdUnits },
          select: { pharmacyCountVarianceThresholdUnits: true },
        });
        await tx.auditLog.create({
          data: {
            organizationId,
            actorId,
            source: 'TRPC',
            category: 'PHARMACY',
            action: 'PHARMACY:COUNT_VARIANCE_THRESHOLD_CHANGED',
            targetType: 'Organization',
            targetId: organizationId,
            metadata: {
              from: organization.pharmacyCountVarianceThresholdUnits,
              to: input.thresholdUnits,
              reauthentication: 'PIN',
            },
          },
        });
        return updated;
      });
    }),
});
