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
        select: {
          id: true,
          name: true,
          email: true,
          title: true,
          department: true,
          role: true,
          status: true,
          organization: { select: { isDemo: true } },
        },
      },
    },
  });

  if (
    !invitation ||
    invitation.acceptedAt ||
    invitation.user.status !== 'INVITED' ||
    invitation.user.organization.isDemo
  ) {
    throw invalidInvitation();
  }
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
      const hashed = await hash(input.password, 12);

      // Hash BEFORE opening the transaction.
      //
      // bcrypt at cost 12 takes on the order of a quarter of a second, and an
      // interactive transaction pins one pooled connection for its whole
      // lifetime. Hashing inside it meant every concurrent acceptance held a
      // connection idle for that entire time, so a burst of invitations could
      // exhaust the pool and stall unrelated tenant traffic. The read above
      // already rejects missing, accepted, and expired tokens without hashing,
      // so the work moved here is only ever spent on a token that looked usable.
      return ctx.db.$transaction(async (tx) => {
        // Fresh, and read once: the same instant decides whether the invitation
        // is still live and stamps the acceptance.
        const now = new Date();

        // ATOMIC CLAIM.
        //
        // The read above and this write are separate statements, so two requests
        // presenting the same token could both pass the read and both proceed. A
        // conditional update makes consumption atomic: PostgreSQL serialises the
        // two writers on the row, and the loser matches zero rows and is rejected
        // with the same generic error as any other unusable token.
        //
        // `expiresAt` is re-checked here rather than trusted from the read.
        // Between the two statements the invitation can lapse, and expiry that is
        // only enforced on the read is enforced nowhere that the write can see.
        const claimed = await tx.invitation.updateMany({
          where: { id: invitation.id, acceptedAt: null, expiresAt: { gt: now } },
          data: { acceptedAt: now },
        });
        if (claimed.count !== 1) throw invalidInvitation();

        // The invitee must still be awaiting onboarding at the instant we
        // activate them. An administrator may have deactivated the account
        // after the public read above; a conditional write prevents that stale
        // request from undoing the administrator's decision.
        const activated = await tx.user.updateMany({
          where: { id: invitation.userId, status: 'INVITED' },
          data: {
            password: hashed,
            status: 'ACTIVE',
            phone: input.phone,
            bio: input.bio ?? undefined,
            ...(input.skills ? { skills: input.skills } : {}),
          },
        });
        if (activated.count !== 1) throw invalidInvitation();

        return { email: invitation.user.email };
      });
    }),
});
