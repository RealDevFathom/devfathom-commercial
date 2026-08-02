import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from '@/server/routers/_app';
import { createTRPCContext } from '@/server/trpc';
import {
  requireOrganizationForRequest,
  resolveOrganizationById,
  TenantHostError,
} from '@/lib/tenancy/host';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { organizationForAnonymousToken } from '@/lib/auth/anonymous-tenant';

/**
 * D19 — procedures reachable with no session at all.
 *
 * This transport returned 401 before any router ran, and it is the only tRPC
 * transport, so the `publicProcedure`s backing invite acceptance and password
 * reset were unreachable anonymously. Verified against a running server: both
 * `passwordReset.request` and `invitations.get` answered
 * `401 {"error":"Unauthorized"}` — and `forgot-password-form.tsx` swallowed the
 * failure and showed its neutral confirmation regardless, so a user asking for a
 * reset link was told to check an inbox that would never receive one.
 *
 * Each procedure below carries a token whose hash is GLOBALLY unique, so the
 * token itself identifies the tenant — no host and no session required. A caller
 * without a valid token resolves to no organization and gets the same 401 as
 * before, so this opens no new surface.
 *
 * `passwordReset.request` is NOT here: it carries an email rather than a token
 * and, on the shared host, one address can belong to several organizations. It
 * has its own anonymous endpoint at /api/password-reset.
 */
const ANONYMOUS_PROCEDURES = new Set([
  'invitations.get',
  'invitations.accept',
  'passwordReset.validate',
  'passwordReset.reset',
]);

/** The procedure names in this request; tRPC batches them comma-separated. */
function requestedProcedures(request: Request): string[] {
  const { pathname } = new URL(request.url);
  const path = pathname.replace(/^\/api\/trpc\/?/, '');
  return path ? path.split(',').filter(Boolean) : [];
}

/**
 * Pull the `token` field out of a tRPC input payload, batched or not. Used only
 * to route the request to a tenant; the procedure re-validates the token itself.
 */
function tokenFromInput(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  for (const entry of Object.values(payload as Record<string, unknown>)) {
    const value =
      entry && typeof entry === 'object' && 'json' in (entry as Record<string, unknown>)
        ? (entry as { json?: unknown }).json
        : entry;
    if (value && typeof value === 'object') {
      const token = (value as Record<string, unknown>).token;
      if (typeof token === 'string' && token) return token;
    }
  }
  return null;
}

async function anonymousToken(request: Request): Promise<string | null> {
  const queryInput = new URL(request.url).searchParams.get('input');
  if (queryInput) {
    try {
      return tokenFromInput(JSON.parse(queryInput));
    } catch {
      return null;
    }
  }
  if (request.method !== 'POST') return null;
  try {
    // Clone so the adapter still receives an unread body.
    return tokenFromInput(await request.clone().json());
  } catch {
    return null;
  }
}

function unauthorized() {
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}

async function handler(req: Request) {
  try {
    const actor = await resolveTenantActor({ request: req });

    if (!actor) {
      const procedures = requestedProcedures(req);
      const anonymousAllowed =
        procedures.length > 0 && procedures.every((name) => ANONYMOUS_PROCEDURES.has(name));
      if (!anonymousAllowed) return unauthorized();

      const organizationId = await organizationForAnonymousToken(await anonymousToken(req));
      if (!organizationId) return unauthorized();
      const organization = await resolveOrganizationById(organizationId);
      if (!organization) return unauthorized();

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
                // Explicitly no session: these procedures are public, and every
                // protected/admin/capability procedure still refuses a null one.
                session: null,
                db: scopedDb,
                organization,
                support: null,
              }),
          }),
        { timeout: 60_000 }
      );
    }

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
