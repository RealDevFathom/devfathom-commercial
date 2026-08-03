import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from '@/server/routers/_app';
import { anonymousFallbackRouter } from '@/server/routers/anonymous-fallback';
import { createTRPCContext } from '@/server/trpc';
import {
  isTenantLifecycleAccessible,
  requestHost,
  requireOrganizationForRequest,
  resolveExplicitOrganizationByHost,
  resolveOrganizationById,
  TenantHostError,
  type TenantOrganization,
} from '@/lib/tenancy/host';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { anonymousToken, classifyAnonymousRequest } from '@/lib/auth/anonymous-access';
import { organizationForAnonymousToken } from '@/lib/auth/anonymous-tenant';
import { admitAnonymousRequest } from '@/lib/auth/anonymous-rate-limit';
import { clientIp } from '@/lib/rate-limit';

/**
 * `/api/trpc` is the only tRPC transport in the app, and it required a session
 * before any router ran. That closed the invite and password-reset flows to the
 * people who need them most — see `@/lib/auth/anonymous-access` for the full
 * account. This handler now has two ways in:
 *
 *   1. A tenant actor, exactly as before. Unchanged.
 *   2. No session, an EXACT allowlist of five procedures, and a tenant derived
 *      from evidence the caller supplied — a globally unique token, or a host
 *      that is explicitly bound to one organization.
 *
 * Path 2 grants no new authority. The context is built with `session: null`, and
 * every protected/admin/HR/capability procedure refuses a null session in its
 * own middleware, so an allowlisted procedure is the only thing that can run.
 */

const TRPC_ENDPOINT = '/api/trpc';

function unauthorized() {
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}

/** Serve an allowlisted procedure inside a tenant's RLS scope, with no session. */
function runAnonymously(req: Request, organization: TenantOrganization) {
  return withTenantDb(
    organization.id,
    (scopedDb) =>
      fetchRequestHandler({
        endpoint: TRPC_ENDPOINT,
        req,
        router: appRouter,
        createContext: () =>
          createTRPCContext({
            req,
            // Explicitly no session.
            session: null,
            db: scopedDb,
            organization,
            support: null,
          }),
      }),
    { timeout: 60_000 }
  );
}

/**
 * Answer a request that could not be routed to any tenant, with the same generic
 * response the real router gives for a token that exists but is unusable.
 * Returning 401 here instead would tell an unauthenticated caller whether a
 * token string exists somewhere in the system.
 */
function runFallback(req: Request) {
  return fetchRequestHandler({
    endpoint: TRPC_ENDPOINT,
    req,
    router: anonymousFallbackRouter,
    createContext: () => ({}),
  });
}

/**
 * A tenant reached anonymously must still be one that may serve traffic. The
 * signed-in path gets this from `requireOrganizationForRequest`; the anonymous
 * path resolves its organization by other means, so it applies the same
 * lifecycle rule here. A workspace that may not serve traffic is treated as
 * unroutable rather than as a distinct error, so its status stays unobservable
 * without a session.
 */
function servable(organization: TenantOrganization | null): TenantOrganization | null {
  if (!organization) return null;
  return isTenantLifecycleAccessible(organization.status) ? organization : null;
}

async function handleAnonymous(req: Request): Promise<Response> {
  const routing = classifyAnonymousRequest(req);
  if (routing.kind === 'denied') return unauthorized();

  const token = routing.kind === 'token' ? await anonymousToken(req) : null;

  // Throttle BEFORE any database work, so neither the platform-scope token
  // lookup nor the tenant transaction can be driven by an unauthenticated flood.
  const admitted = admitAnonymousRequest({ kind: routing.kind, token, ip: clientIp(req) });
  if (!admitted.ok) {
    return Response.json(
      { error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'retry-after': String(admitted.retryAfter) } }
    );
  }

  if (routing.kind === 'token') {
    const organizationId = await organizationForAnonymousToken(token);
    const organization = organizationId ? await resolveOrganizationById(organizationId) : null;
    const target = servable(organization);
    return target ? runAnonymously(req, target) : runFallback(req);
  }

  // Host-routed: `passwordReset.request` carries an email, not a token, so the
  // host is the only thing that can name a tenant. The STRICT resolver is
  // deliberate — `resolveOrganizationByHost` would map a shared or default host
  // onto DEFAULT_ORGANIZATION_ID and mail a reset link for a tenant the caller
  // never named. An unnamed tenant means nothing is sent, and the caller still
  // gets the ordinary generic confirmation.
  const organization = servable(await resolveExplicitOrganizationByHost(requestHost(req)));
  return organization ? runAnonymously(req, organization) : runFallback(req);
}

async function handler(req: Request) {
  try {
    const actor = await resolveTenantActor({ request: req });
    if (!actor) return handleAnonymous(req);

    const organization = await requireOrganizationForRequest(
      req,
      actor.session.user.organizationId
    );
    return withTenantDb(
      organization.id,
      (scopedDb) =>
        fetchRequestHandler({
          endpoint: TRPC_ENDPOINT,
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
