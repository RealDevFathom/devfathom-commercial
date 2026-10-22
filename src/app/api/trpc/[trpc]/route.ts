import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { auth } from '@/lib/auth';
import { appRouter } from '@/server/routers/_app';
import { createTRPCContext } from '@/server/trpc';

const handler = auth((req) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => createTRPCContext({ req, session: req.auth }),
  })
);

export { handler as GET, handler as POST };
