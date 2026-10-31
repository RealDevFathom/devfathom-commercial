import { TRPCError } from '@trpc/server';
import { compare } from 'bcryptjs';
import { z } from 'zod';
import { clearRateLimit, rateLimit } from '@/lib/rate-limit';
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

async function verifyAccountPassword(
  db: ScopedDb,
  organizationId: string,
  userId: string,
  input: { currentPassword?: string }
): Promise<boolean> {
  if (!input.currentPassword) return false;
  const key = `pharmacy:pin-enroll-password:${organizationId}:${userId}`;
  if (!(await rateLimit(key, 5, 15 * 60_000)).ok) return false;
  const user = await db.user.findFirst({
    where: { id: userId, organizationId, status: 'ACTIVE' },
    select: { password: true },
  });
  // Accounts without a password cannot re-authenticate here; fail closed.
  const valid = !!user?.password && (await compare(input.currentPassword, user.password));
  if (valid) await clearRateLimit(key);
  return valid;
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
          // First enrollment has no PIN to prove; the account password re-authenticates
          // the session so an unattended session cannot mint the owner's approval PIN.
          currentPassword: z.string().min(1).max(256).optional(),
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
        if (!existing && !(await verifyAccountPassword(db, organizationId, userId, input)))
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Enter your account password to enroll a pharmacy PIN.',
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
