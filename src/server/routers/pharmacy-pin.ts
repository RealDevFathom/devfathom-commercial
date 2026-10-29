import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { ensurePharmacyStaffProfile } from '@/lib/pharmacy/pin-enrollment';
import { isPharmacyOwner } from '@/lib/pharmacy/owner';
import { assignedRegisterBranchIds } from '@/lib/pharmacy/controlled-register';
import { hashOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { issueOperatorCredential } from '@/lib/restaurant/credential-lifecycle';
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
  reset: protectedProcedure
    .use(async ({ ctx, next }) => {
      annotateAudit(ctx, { skipInput: true });
      return next();
    })
    .input(
      z
        .object({
          branchId: z.string().min(1),
          userId: z.string().min(1),
          pin: z.string().regex(/^\d{4,8}$/, 'Use 4–8 digits.'),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const { organizationId, userId: actorId } = pharmacyIdentity(ctx);
      const authenticatedAt = ctx.session!.user.passwordAuthenticatedAt;
      const age = Date.now() - (authenticatedAt ?? NaN);
      if (!Number.isFinite(age) || age < 0 || age > 5 * 60_000)
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Sign in again before resetting a PIN.',
        });
      return ctx.db.$transaction(async (tx) => {
        const db = tx as unknown as ScopedDb;
        const actor = await db.user.findUnique({
          where: { id: actorId, organizationId, status: 'ACTIVE' },
          select: { role: true },
        });
        if (
          !actor ||
          (actor.role !== 'ADMIN' && !(await isPharmacyOwner(db, organizationId, actorId)))
        )
          throw new TRPCError({ code: 'FORBIDDEN' });
        const actorBranches = await assignedRegisterBranchIds(db, organizationId, actorId);
        const targetBranches = await assignedRegisterBranchIds(db, organizationId, input.userId);
        // A device-free PIN applies to every target branch. Authorize the full impact.
        if (
          !actorBranches.includes(input.branchId) ||
          !targetBranches.includes(input.branchId) ||
          targetBranches.some((id) => !actorBranches.includes(id))
        )
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'The staff member is outside your branch scope.',
          });
        const profile = await ensurePharmacyStaffProfile(db, organizationId, input.userId);
        // Enrollment and resets serialize on the target user lock above.
        await db.restaurantOperatorCredential.updateMany({
          where: {
            organizationId,
            staffProfileId: profile.id,
            type: 'PIN',
            deviceId: null,
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        });
        const credential = await db.restaurantOperatorCredential.create({
          data: {
            organizationId,
            staffProfileId: profile.id,
            type: 'PIN',
            credentialHash: await hashOperatorCredential('PIN', input.pin),
          },
          select: { id: true },
        });
        await db.auditLog.create({
          data: {
            organizationId,
            actorId,
            source: 'TRPC',
            category: 'PHARMACY',
            action: 'PHARMACY:PIN_RESET',
            targetType: 'RestaurantOperatorCredential',
            targetId: credential.id,
            metadata: {
              branchId: input.branchId,
              affectedBranchIds: targetBranches,
              userId: input.userId,
              staffProfileId: profile.id,
              reauthentication: 'PASSWORD',
            },
          },
        });
        return { enrolled: true };
      });
    }),
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
    .input(z.object({ pin: z.string().regex(/^\d{4,8}$/, 'Use 4–8 digits.') }).strict())
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
        if (existing)
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Your PIN is already enrolled. Ask your administrator for a credential reset.',
          });
        const credential = await issueOperatorCredential(db, {
          staffProfileId: profile.id,
          type: 'PIN',
          secret: input.pin,
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantOperatorCredential',
          targetId: credential.id,
          description: 'Enrolled own pharmacy approval PIN',
          metadata: { staffProfileId: profile.id },
        });
        return { enrolled: true };
      });
    }),
});
