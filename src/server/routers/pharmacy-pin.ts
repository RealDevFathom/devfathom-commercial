import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { ensurePharmacyStaffProfile } from '@/lib/pharmacy/pin-enrollment';
import { verifyPharmacyUserPin } from '@/lib/pharmacy/solo-approval';
import {
  issueOperatorCredential,
  rotateOperatorCredential,
} from '@/lib/restaurant/credential-lifecycle';
import { annotateAudit } from '@/server/audit';
import { assertModuleLicensed, protectedProcedure, router, type TRPCContext } from '../trpc';

function pharmacyIdentity(ctx: TRPCContext) {
  const organizationId = ctx.entitlements.organizationId;
  if (
    ctx.organization?.vertical !== 'PHARMACY' ||
    ctx.organization.id !== organizationId ||
    ctx.session?.user.organizationId !== organizationId
  )
    throw new TRPCError({ code: 'FORBIDDEN', message: 'A pharmacy workspace is required.' });
  assertModuleLicensed(ctx, 'pharmacy-core');
  return { organizationId, userId: ctx.session.user.id };
}

export const pharmacyPinRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const { organizationId, userId } = pharmacyIdentity(ctx);
    const credential = await ctx.db.restaurantOperatorCredential.findFirst({
      where: {
        organizationId,
        type: 'PIN',
        deviceId: null,
        revokedAt: null,
        staffProfile: { organizationId, userId },
      },
      select: { id: true },
    });
    return { enrolled: !!credential };
  }),
  enroll: protectedProcedure
    // Suppress raw input before validation, including validation failures.
    .use(async ({ ctx, next }) => {
      annotateAudit(ctx, { skipInput: true });
      return next();
    })
    .input(
      z
        .object({
          pin: z.string().regex(/^\d{4,8}$/, 'Use 4–8 digits.'),
          currentPin: z
            .string()
            .regex(/^\d{4,8}$/)
            .optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const { organizationId, userId } = pharmacyIdentity(ctx);
      return ctx.db.$transaction(async (tx) => {
        const db = tx as unknown as ScopedDb;
        const profile = await ensurePharmacyStaffProfile(db, organizationId, userId);
        const existing = await db.restaurantOperatorCredential.findFirst({
          where: {
            organizationId,
            staffProfileId: profile.id,
            type: 'PIN',
            deviceId: null,
            revokedAt: null,
          },
          select: { id: true },
        });
        // The identity lock serializes rotations; lockout commits independently of this request.
        const verified =
          existing && input.currentPin
            ? await verifyPharmacyUserPin({ organizationId, actorId: userId }, input.currentPin)
            : false;
        if (existing && !verified)
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Enter your current pharmacy PIN to rotate it.',
          });
        const credential = existing
          ? await rotateOperatorCredential(db, { credentialId: existing.id, secret: input.pin })
          : await issueOperatorCredential(db, {
              staffProfileId: profile.id,
              type: 'PIN',
              secret: input.pin,
            });
        annotateAudit(ctx, {
          targetType: 'RestaurantOperatorCredential',
          targetId: credential.id,
          description: existing
            ? 'Rotated own pharmacy approval PIN'
            : 'Enrolled own pharmacy approval PIN',
          metadata: { staffProfileId: profile.id },
        });
        return { enrolled: true };
      });
    }),
});
