import { hash } from 'bcryptjs';
import { TRPCError } from '@trpc/server';
import type { PrismaClient } from '@/generated/prisma/client';
import { router, publicProcedure } from '../trpc';
import {
  anonymousTokenInput,
  passwordResetInput,
  passwordResetRequestInput,
} from '@/lib/auth/anonymous-inputs';
import { generateInviteToken, hashInviteToken } from '@/lib/invite-token';
import { rateLimit } from '@/lib/rate-limit';
import { ACTIVE_STATUSES } from '@/lib/abac';
import { appUrl, templates, sendEmail } from '@/lib/email';
import { RESET_GENERIC_MESSAGE } from '@/lib/auth/anonymous-access';

// Public (unauthenticated) procedures backing the forgot-password / reset flow.
// A raw, high-entropy token is emailed once; only its SHA-256 hash is stored
// (PasswordResetToken.tokenHash), mirroring the invite flow. To verify, we hash
// the presented raw token with the SAME sha256 (hashInviteToken) and look up by
// tokenHash — no plaintext token ever lives in the DB.

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

// One message for every way a reset link can fail. Shared with the fallback
// router the `/api/trpc` handler uses when a token names no tenant at all, so an
// anonymous caller cannot tell "no such token anywhere" from "a real token that
// has expired".
function invalidResetLink() {
  return new TRPCError({ code: 'BAD_REQUEST', message: RESET_GENERIC_MESSAGE });
}

// Resolve a presented raw token to a still-usable reset record (+ its user), or
// null when the token is missing, already consumed, or expired. We never reveal
// which of those it was — callers surface one generic error.
async function loadUsableToken(db: PrismaClient, token: string) {
  const record = await db.passwordResetToken.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          status: true,
          organization: { select: { isDemo: true } },
        },
      },
    },
  });

  if (!record || record.usedAt || record.user.organization.isDemo) return null;
  if (record.expiresAt.getTime() < Date.now()) return null;
  return record;
}

export const passwordResetRouter = router({
  // Step 1 — request a reset link. ALWAYS returns success to prevent account
  // enumeration: the response is identical whether or not the email exists.
  request: publicProcedure
    // D10: lookup-only normalization. A malformed address must be indistinguish-
    // able from an unknown one here, so this deliberately does not validate the
    // format — it would turn the endpoint into an enumeration oracle.
    .input(passwordResetRequestInput)
    .mutation(async ({ ctx, input }) => {
      if (ctx.organization?.isDemo) return { success: true };
      const email = input.email;
      const ip = ctx.requestMeta.ip ?? 'unknown';

      // Throttle per IP (broad) and per email so the endpoint can't be used to
      // flood inboxes or probe for accounts. Limiting still leaks nothing about
      // existence — both hit/miss paths are throttled identically.
      const ipGate = await rateLimit(`pwreset:ip:${ip}`, 10, 15 * 60_000);
      const emailGate = await rateLimit(`pwreset:email:${email}`, 5, 15 * 60_000);
      if (!ipGate.ok || !emailGate.ok) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many reset requests. Please try again later.',
        });
      }

      const user = await ctx.db.user.findFirst({
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
  validate: publicProcedure.input(anonymousTokenInput).query(async ({ ctx, input }) => {
    const record = await loadUsableToken(ctx.db, input.token);
    return { valid: Boolean(record) };
  }),

  // Step 2 — consume the token and set a new password. Rejects missing / used /
  // expired tokens with one generic error.
  reset: publicProcedure.input(passwordResetInput).mutation(async ({ ctx, input }) => {
    const record = await loadUsableToken(ctx.db, input.token);
    if (!record) throw invalidResetLink();

    // Hash BEFORE opening the transaction.
    //
    // bcrypt at cost 12 takes on the order of a quarter of a second, and an
    // interactive transaction pins one pooled connection for its whole
    // lifetime. Hashing inside it meant every concurrent reset held a
    // connection idle for that entire time, so a burst of resets could exhaust
    // the pool and stall unrelated tenant traffic. `loadUsableToken` already
    // rejects missing, used, and expired tokens without hashing, so the work
    // moved here is only ever spent on a token that looked usable.
    const hashed = await hash(input.newPassword, 12);

    await ctx.db.$transaction(async (tx) => {
      // Fresh, and read once: the same instant decides whether the token is
      // still live and stamps its consumption.
      const now = new Date();

      // ATOMIC CLAIM.
      //
      // `loadUsableToken` and this write are separate statements, so two
      // requests presenting the same token could both pass the read and both
      // set a password. A conditional update makes consumption atomic:
      // PostgreSQL serialises the two writers on the row, and the loser matches
      // zero rows and gets the same generic error as any other unusable link.
      //
      // `expiresAt` is re-checked here rather than trusted from the read.
      // Between the two statements the link can lapse, and expiry that is only
      // enforced on the read is enforced nowhere that the write can see.
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) throw invalidResetLink();

      // AUTH-01: bump tokenVersion + stamp passwordChangedAt so every existing
      // JWT session for this user is revoked on its next revalidation.
      await tx.user.update({
        where: { id: record.userId },
        data: {
          password: hashed,
          passwordChangedAt: new Date(),
          mustChangePassword: false,
          tokenVersion: { increment: 1 },
        },
      });
    });

    return { success: true };
  }),
});
