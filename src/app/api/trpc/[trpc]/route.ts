import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from '@/server/routers/_app';
import { createTRPCContext } from '@/server/trpc';
import { requireOrganizationForRequest, TenantHostError } from '@/lib/tenancy/host';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';

async function handler(req: Request) {
  try {
    const actor = await resolveTenantActor({ request: req });
    if (!actor) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const organization = await requireOrganizationForRequest(
      req,
      actor.session.user.organizationId
    );
    return withTenantDb(
      organization.id,
      (scopedDb) =>
        fetchRequestHandler({
          endpoint: '/api/trpc',
          req,
          router: appRouter,
          createContext: () =>
            createTRPCContext({
              req,
              session: actor.session,
              db: scopedDb,
              organization,
              support: actor.support,
            }),
        }),
      { timeout: 60_000 }
    );
  } catch (error) {
    if (error instanceof TenantHostError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

export { handler as GET, handler as POST };
