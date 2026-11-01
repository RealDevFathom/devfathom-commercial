import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { ensurePharmacyStaffProfile } from '@/lib/pharmacy/pin-enrollment';
import { can, subjectFromSession } from '@/lib/abac';
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
          // Only the PIN's owner may choose its secret. Resetting another member's PIN
          // revokes it and leaves them to re-enroll their own through `enroll`; otherwise
          // the resetter would know a second-person approval PIN and could witness or
          // approve their own controlled sale under that member's identity.
          pin: z
            .string()
            .regex(/^\d{4,8}$/, 'Use 4–8 digits.')
            .optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const { organizationId, userId: actorId } = pharmacyIdentity(ctx);
      const selfReset = input.userId === actorId;
      if (input.pin !== undefined && !selfReset)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            "You cannot choose another member's PIN. Reset revokes it; they enroll a new one themselves.",
        });
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
          select: { id: true },
        });
        if (
          !actor ||
          !(await can(subjectFromSession(ctx.session!.user), 'pharmacy:pin-reset', undefined, {
            db,
            source: 'TRPC',
            ip: ctx.requestMeta.ip,
          }))
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
        const revoked = await db.restaurantOperatorCredential.updateMany({
          where: {
            organizationId,
            staffProfileId: profile.id,
            type: 'PIN',
            deviceId: null,
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        });
        const credential =
          selfReset && input.pin !== undefined
            ? await db.restaurantOperatorCredential.create({
                data: {
                  organizationId,
                  staffProfileId: profile.id,
                  type: 'PIN',
                  credentialHash: await hashOperatorCredential('PIN', input.pin),
                },
                select: { id: true },
              })
            : null;
        await db.auditLog.create({
          data: {
            organizationId,
            actorId,
            source: 'TRPC',
            category: 'PHARMACY',
            action: 'PHARMACY:PIN_RESET',
            targetType: credential ? 'RestaurantOperatorCredential' : 'RestaurantStaffProfile',
            targetId: credential?.id ?? profile.id,
            metadata: {
              branchId: input.branchId,
              affectedBranchIds: targetBranches,
              userId: input.userId,
              staffProfileId: profile.id,
              revokedCount: revoked.count,
              outcome: credential ? 'ROTATED_OWN_PIN' : 'REVOKED_AWAITING_SELF_ENROLLMENT',
              reauthentication: 'PASSWORD',
            },
          },
        });
        return { enrolled: credential !== null };
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
