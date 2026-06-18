import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';

export const createTRPCContext = async () => {
  const session = await auth();

  return {
    db,
    session,
  };
};

export type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape }) {
    return shape;
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

// Reject sessions whose backing account has been deactivated. `status` is
// refreshed from the DB on each request by the NextAuth jwt() callback, so a
// deactivated/deleted user is locked out within the revalidation window even
// though sessions are stateless JWTs. Undefined status (legacy token, before
// the next jwt() refresh) is tolerated — it is populated on the next request.
function assertActive(user: { status?: string | null }) {
  if (user.status && user.status !== 'ACTIVE') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Your account is no longer active.' });
  }
}

// Protected procedure — requires an authenticated, active account
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to access this resource',
    });
  }

  assertActive(ctx.session.user);

  return next({
    ctx: {
      ...ctx,
      session: ctx.session,
    },
  });
});

// Admin-only procedure — requires an authenticated, active ADMIN. The role is
// re-read from the DB by the jwt() callback, so a demoted admin loses access
// within the revalidation window rather than after the 30-day token lifetime.
export const adminProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to access this resource',
    });
  }

  assertActive(ctx.session.user);

  if (ctx.session.user.role !== 'ADMIN') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only admins can access this resource',
    });
  }

  return next({
    ctx: {
      ...ctx,
      session: ctx.session,
    },
  });
});
