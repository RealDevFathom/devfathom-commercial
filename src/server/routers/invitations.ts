import { z } from 'zod';
import { hash } from 'bcryptjs';
import { TRPCError } from '@trpc/server';
import type { PrismaClient } from '@/generated/prisma/client';
import { router, publicProcedure } from '../trpc';
import { passwordSchema } from '@/lib/password-policy';
import { hashInviteToken } from '@/lib/invite-token';
import { INVITATION_GENERIC_MESSAGE } from '@/lib/auth/anonymous-access';

// Public (unauthenticated) procedures backing the /invite/[token] page. An
// invited user has status INVITED and a null password — they cannot sign in
// until they accept here, which sets their password and flips them to ACTIVE.
//
// These are now reachable with no session at all (see the `/api/trpc` handler),
// so every rejection answers with ONE message. The previous copy distinguished
// "invalid or already used" from "expired", which told an unauthenticated caller
// whether a token had ever existed. `INVITATION_GENERIC_MESSAGE` is shared with
// the fallback router the transport uses when a token names no tenant, so all
// three outcomes are indistinguishable.

const tokenInput = z.object({ token: z.string().min(1) });

function invalidInvitation() {
  return new TRPCError({ code: 'NOT_FOUND', message: INVITATION_GENERIC_MESSAGE });
}

// Resolve a raw token to its still-valid invitation (+ the user it belongs to),
// or throw the uniform error.
async function loadPendingInvitation(db: PrismaClient, token: string) {
  const invitation = await db.invitation.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    include: {
      user: {
        select: { id: true, name: true, email: true, title: true, department: true, role: true },
      },
    },
  });

  if (!invitation || invitation.acceptedAt) throw invalidInvitation();
  if (invitation.expiresAt.getTime() < Date.now()) throw invalidInvitation();
  return invitation;
}

export const invitationsRouter = router({
  // Fetch the read-only details to render on the accept page.
  get: publicProcedure.input(tokenInput).query(async ({ ctx, input }) => {
    const { user } = await loadPendingInvitation(ctx.db, input.token);
    return {
      name: user.name,
      email: user.email,
      title: user.title,
      department: user.department,
      role: user.role,
    };
  }),

  // Accept: set the user's own password + optional profile, activate the account.
  // Identity fields (name/email/title/department/role) are admin-controlled and
  // intentionally NOT accepted here.
  accept: publicProcedure
    .input(
      z.object({
        token: z.string().min(1),
        password: passwordSchema,
        phone: z.string().trim().min(1, 'Phone number is required'),
        bio: z.string().optional(),
        skills: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const invitation = await loadPendingInvitation(ctx.db, input.token);

      // CLAIM THE TOKEN FIRST, then hash.
      //
      // The read above and the write below are separate statements, so two
      // requests presenting the same token could both pass the read and both
      // proceed. A conditional update on `acceptedAt IS NULL` makes consumption
      // atomic: PostgreSQL serialises the two writers on the row, and the loser
      // matches zero rows and is rejected with the same generic error as any
      // other unusable token.
      //
      // Ordering matters for cost as well as correctness. bcrypt at cost 12 is
      // deliberately expensive, and it is the only expensive thing an anonymous
      // caller can reach here. Claiming first means a replayed or already-used
      // token is refused by one indexed UPDATE, and never spends a hash.
      return ctx.db.$transaction(async (tx) => {
        const claimed = await tx.invitation.updateMany({
          where: { id: invitation.id, acceptedAt: null },
          data: { acceptedAt: new Date() },
        });
        if (claimed.count !== 1) throw invalidInvitation();

        const hashed = await hash(input.password, 12);
        await tx.user.update({
          where: { id: invitation.userId },
          data: {
            password: hashed,
            status: 'ACTIVE',
            phone: input.phone,
            bio: input.bio ?? undefined,
            ...(input.skills ? { skills: input.skills } : {}),
          },
        });

        return { email: invitation.user.email };
      });
    }),
});
