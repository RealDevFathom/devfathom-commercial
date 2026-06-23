import { z } from 'zod';
import { hash } from 'bcryptjs';
import { TRPCError } from '@trpc/server';
import type { PrismaClient } from '@/generated/prisma/client';
import { router, publicProcedure } from '../trpc';
import { passwordSchema } from '@/lib/password-policy';
import { generateInviteToken, hashInviteToken } from '@/lib/invite-token';
import { rateLimit } from '@/lib/rate-limit';
import { ACTIVE_STATUSES } from '@/lib/abac';
import { appUrl, templates, sendEmail } from '@/lib/email';

// Public (unauthenticated) procedures backing the forgot-password / reset flow.
// A raw, high-entropy token is emailed once; only its SHA-256 hash is stored
// (PasswordResetToken.tokenHash), mirroring the invite flow. To verify, we hash
// the presented raw token with the SAME sha256 (hashInviteToken) and look up by
// tokenHash — no plaintext token ever lives in the DB.

const tokenInput = z.object({ token: z.string().min(1) });
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

// Resolve a presented raw token to a still-usable reset record (+ its user), or
// null when the token is missing, already consumed, or expired. We never reveal
// which of those it was — callers surface one generic error.
async function loadUsableToken(db: PrismaClient, token: string) {
  const record = await db.passwordResetToken.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    include: { user: { select: { id: true, name: true, email: true, status: true } } },
  });

  if (!record || record.usedAt) return null;
  if (record.expiresAt.getTime() < Date.now()) return null;
  return record;
}

export const passwordResetRouter = router({
  // Step 1 — request a reset link. ALWAYS returns success to prevent account
  // enumeration: the response is identical whether or not the email exists.
  request: publicProcedure
    .input(z.object({ email: z.string().trim().min(1).max(320) }))
    .mutation(async ({ ctx, input }) => {
      const email = input.email.toLowerCase();
      const ip = ctx.requestMeta.ip ?? 'unknown';

      // Throttle per IP (broad) and per email so the endpoint can't be used to
      // flood inboxes or probe for accounts. Limiting still leaks nothing about
      // existence — both hit/miss paths are throttled identically.
      const ipGate = rateLimit(`pwreset:ip:${ip}`, 10, 15 * 60_000);
      const emailGate = rateLimit(`pwreset:email:${email}`, 5, 15 * 60_000);
      if (!ipGate.ok || !emailGate.ok) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many reset requests. Please try again later.',
        });
      }

      const user = await ctx.db.user.findUnique({
        where: { email },
        select: { id: true, name: true, email: true, status: true, password: true },
      });

      // Only mint a token for a real, activated account that can actually sign
      // in (ACTIVE / ON_LEAVE, with a password set). Otherwise we silently no-op
      // and still return success below.
      if (user && user.password && ACTIVE_STATUSES.has(user.status)) {
        const { token, tokenHash } = generateInviteToken();
        await ctx.db.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash,
            expiresAt: new Date(Date.now() + RESET_TTL_MS),
          },
        });

        const resetUrl = `${appUrl()}/reset-password/${token}`;
        const mail = templates.passwordReset({
          name: user.name,
          resetUrl,
          expiresLabel: 'in 1 hour',
        });
        // Best-effort send — never fail the request on an email hiccup, and never
        // surface delivery status to the caller (it would leak existence).
        try {
          await sendEmail({
            to: { email: user.email, name: user.name },
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
          });
        } catch (err) {
          console.error('[passwordReset.request] email failed for', email, err);
        }
      }

      return { success: true };
    }),

  // Lightweight pre-check so the reset page can show an "expired link" state
  // before the user types anything. Reveals only whether the token is usable.
  validate: publicProcedure.input(tokenInput).query(async ({ ctx, input }) => {
    const record = await loadUsableToken(ctx.db, input.token);
    return { valid: Boolean(record) };
  }),

  // Step 2 — consume the token and set a new password. Rejects missing / used /
  // expired tokens with one generic error.
  reset: publicProcedure
    .input(z.object({ token: z.string().min(1), newPassword: passwordSchema }))
    .mutation(async ({ ctx, input }) => {
      const record = await loadUsableToken(ctx.db, input.token);
      if (!record) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This reset link is invalid or has expired. Please request a new one.',
        });
      }

      const hashed = await hash(input.newPassword, 12);

      // AUTH-01: bump tokenVersion + stamp passwordChangedAt so every existing
      // JWT session for this user is revoked on its next revalidation. Mark the
      // token used in the SAME transaction so it can't be replayed.
      await ctx.db.$transaction([
        ctx.db.user.update({
          where: { id: record.userId },
          data: {
            password: hashed,
            passwordChangedAt: new Date(),
            tokenVersion: { increment: 1 },
          },
        }),
        ctx.db.passwordResetToken.update({
          where: { id: record.id },
          data: { usedAt: new Date() },
        }),
      ]);

      return { success: true };
    }),
});
