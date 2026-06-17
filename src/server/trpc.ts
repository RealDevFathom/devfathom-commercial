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

// Protected procedure — requires authentication
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to access this resource',
    });
  }

  return next({
    ctx: {
      ...ctx,
      session: ctx.session,
    },
  });
});

// Admin-only procedure
export const adminProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You must be logged in to access this resource',
    });
  }

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
