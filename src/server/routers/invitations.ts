import { z } from 'zod';
import { hash } from 'bcryptjs';
import { TRPCError } from '@trpc/server';
import type { PrismaClient } from '@/generated/prisma/client';
import { router, publicProcedure } from '../trpc';
import { passwordSchema } from '@/lib/password-policy';
import { hashInviteToken } from '@/lib/invite-token';

// Public (unauthenticated) procedures backing the /invite/[token] page. An
// invited user has status INVITED and a null password — they cannot sign in
// until they accept here, which sets their password and flips them to ACTIVE.

const tokenInput = z.object({ token: z.string().min(1) });

// Resolve a raw token to its still-valid invitation (+ the user it belongs to),
// or throw a uniform error. We never reveal whether an email exists — only a
// correct, unexpired, unused token returns anything.
async function loadPendingInvitation(db: PrismaClient, token: string) {
  const invitation = await db.invitation.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    include: {
      user: {
        select: { id: true, name: true, email: true, title: true, department: true, role: true },
      },
    },
  });

  if (!invitation || invitation.acceptedAt) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'This invitation is invalid or has already been used.' });
  }
  if (invitation.expiresAt.getTime() < Date.now()) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'This invitation has expired.' });
  }
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

      await ctx.db.$transaction([
        ctx.db.user.update({
          where: { id: invitation.userId },
          data: {
            password: hashed,
            status: 'ACTIVE',
            phone: input.phone,
            bio: input.bio ?? undefined,
            ...(input.skills ? { skills: input.skills } : {}),
          },
        }),
        ctx.db.invitation.update({
          where: { id: invitation.id },
          data: { acceptedAt: new Date() },
        }),
      ]);

      return { email: invitation.user.email };
    }),
});
