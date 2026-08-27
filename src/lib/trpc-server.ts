import 'server-only';
import { createServerSideHelpers } from '@trpc/react-query/server';
import superjson from 'superjson';
import { appRouter } from '@/server/routers/_app';
import { createTRPCContext } from '@/server/trpc';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';

/**
 * Server-side tRPC helpers for React Server Component prefetch.
 *
 * `helpers.queryClient` shares query-key shape with the client
 * `createTRPCReact` hooks, so data prefetched here hydrates into the existing
 * `useQuery` calls via `<HydrationBoundary state={helpers.dehydrate()}>` — no
 * client component needs to change.
 *
 * The router declares a transformer (superjson), so `createServerSideHelpers`
 * requires `transformer` here too (`TransformerOptions` is mandatory when the
 * router has one) — this keeps dehydration consistent with the client's
 * `httpBatchLink({ transformer: superjson })`.
 *
 * `createTRPCContext()` is arg-less and RSC-safe — it resolves the session via
 * `auth()` (which reads cookies, allowed in a Server Component).
 */
export async function createSSRHelpers() {
  // App Router can render a child page while its parent layout is resolving the
  // same rotating Auth.js JWT. If this optional prefetch branch cannot obtain
  // an actor, let the authenticated client query normally instead of failing
  // the whole page; the parent layout remains the authoritative auth guard.
  const actor = await resolveTenantActor();
  if (!actor) return null;

  const ctx = await createTRPCContext({
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
  const helpers = createServerSideHelpers({ router: appRouter, ctx, transformer: superjson });
  return {
    helpers,
    session: ctx.session,
    organization: ctx.organization,
    entitlements: ctx.entitlements,
  };
}
