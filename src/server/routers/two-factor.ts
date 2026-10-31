import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { annotateAudit } from '../audit';
import type { PrismaClient } from '@/generated/prisma/client';
import {
  generateTotpSecret,
  verifyTotp,
  totpAuthUri,
  generateRecoveryCodes,
  hashRecoveryCode,
} from '@/lib/totp';

// IMP-AUTH-02 — TOTP 2FA enrolment/management. The login-time enforcement lives in
// auth.ts (authorize); this router only handles a signed-in user turning 2FA on/off
// for their OWN account. Enrolment is two-phase: beginEnrollment stashes a secret
// (twoFactorEnabledAt stays null = inactive), confirmEnrollment activates it only
// after the user proves they can generate a valid code.

export const twoFactorRouter = router({
  getStatus: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.user.findUnique({
      where: { id: ctx.session.user.id },
      select: { twoFactorEnabledAt: true },
    });
    return { enabled: !!user?.twoFactorEnabledAt };
  }),

  // Phase 1: mint a secret and return it (+ otpauth URI) for the authenticator app.
  // Not active until confirmEnrollment succeeds.
  beginEnrollment: protectedProcedure.mutation(async ({ ctx }) => {
    const user = await ctx.db.user.findUnique({
      where: { id: ctx.session.user.id },
      select: { email: true, twoFactorEnabledAt: true },
    });
    if (!user) throw new TRPCError({ code: 'NOT_FOUND' });
    if (user.twoFactorEnabledAt)
      throw new TRPCError({ code: 'BAD_REQUEST', message: '2FA is already enabled.' });

    const secret = generateTotpSecret();
    await ctx.db.user.update({
      where: { id: ctx.session.user.id },
      data: { twoFactorSecret: secret },
    });
    return { secret, otpauthUri: totpAuthUri(user.email, secret) };
  }),

  // Phase 2: verify a code against the stashed secret, then activate 2FA and issue
  // one-time recovery codes (returned ONCE, in plaintext).
  confirmEnrollment: protectedProcedure
    .input(z.object({ token: z.string().min(6).max(10) }))
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
        select: { twoFactorSecret: true, twoFactorEnabledAt: true },
      });
      if (!user?.twoFactorSecret)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Start enrolment first.' });
      if (user.twoFactorEnabledAt)
        throw new TRPCError({ code: 'BAD_REQUEST', message: '2FA is already enabled.' });
      if (!verifyTotp(user.twoFactorSecret, input.token))
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'That code is incorrect. Try again.' });

      const { codes, hashes } = generateRecoveryCodes();
      await ctx.db.$transaction([
        ctx.db.user.update({
          where: { id: ctx.session.user.id },
          data: { twoFactorEnabledAt: new Date() },
        }),
        // Replace any stale codes from a prior enrolment, then issue fresh ones.
        ctx.db.twoFactorRecoveryCode.deleteMany({ where: { userId: ctx.session.user.id } }),
        ctx.db.twoFactorRecoveryCode.createMany({
          data: hashes.map((codeHash) => ({ userId: ctx.session.user.id, codeHash })),
        }),
      ]);
      annotateAudit(ctx, {
        targetType: 'User',
        targetId: ctx.session.user.id,
        description: 'Enabled two-factor authentication',
        metadata: { twoFactor: 'enabled' },
      });
      return { recoveryCodes: codes };
    }),

  // Turn 2FA off — requires a fresh code (or recovery code) to prove possession,
  // so a hijacked session alone can't strip the second factor.
  disable: protectedProcedure
    .input(z.object({ token: z.string().min(6).max(20) }))
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
        select: { twoFactorSecret: true, twoFactorEnabledAt: true },
      });
      if (!user?.twoFactorEnabledAt || !user.twoFactorSecret)
        throw new TRPCError({ code: 'BAD_REQUEST', message: '2FA is not enabled.' });

      const okTotp = verifyTotp(user.twoFactorSecret, input.token);
      const okRecovery = okTotp
        ? false
        : await consumeRecoveryCode(ctx.db, ctx.session.user.id, input.token);
      if (!okTotp && !okRecovery)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid code.' });

      await ctx.db.$transaction([
        ctx.db.user.update({
          where: { id: ctx.session.user.id },
          data: { twoFactorSecret: null, twoFactorEnabledAt: null },
        }),
        ctx.db.twoFactorRecoveryCode.deleteMany({ where: { userId: ctx.session.user.id } }),
      ]);
      annotateAudit(ctx, {
        targetType: 'User',
        targetId: ctx.session.user.id,
        description: 'Disabled two-factor authentication',
        metadata: { twoFactor: 'disabled' },
      });
      return { success: true };
    }),

  // How many unused recovery codes remain (so the UI can nudge a regen when low).
  recoveryStatus: protectedProcedure.query(async ({ ctx }) => {
    const remaining = await ctx.db.twoFactorRecoveryCode.count({
      where: { userId: ctx.session.user.id, usedAt: null },
    });
    return { remaining };
  }),
});

// Hash the presented code and atomically consume a matching unused row. Returns
// true iff a code was consumed. (auth.ts inlines the equivalent to avoid importing
// a router module into the auth entrypoint.)
export async function consumeRecoveryCode(
  db: PrismaClient,
  userId: string,
  code: string
): Promise<boolean> {
  const codeHash = hashRecoveryCode(code);
  const match = await db.twoFactorRecoveryCode.findFirst({
    where: { userId, codeHash, usedAt: null },
    select: { id: true },
  });
  if (!match) return false;
  // Mark used; updateMany with the usedAt:null guard makes the consume single-use
  // even under a race (count 0 → someone else already used it).
  const res = await db.twoFactorRecoveryCode.updateMany({
    where: { id: match.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  return res.count === 1;
}
