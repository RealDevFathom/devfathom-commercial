import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import {
  getTRPCErrorShape,
  TRPCError,
  transformTRPCResponse,
  type TRPCErrorShape,
} from '@trpc/server';
import { getHTTPStatusCode } from '@trpc/server/http';
import type { Session } from 'next-auth';
import { appRouter } from '@/server/routers/_app';
import { anonymousFallbackRouter } from '@/server/routers/anonymous-fallback';
import { createTRPCContext } from '@/server/trpc';
import { preflightTrelloImport } from '@/server/trello-import-transport';
import {
  isTenantLifecycleAccessible,
  requestHost,
  requireOrganizationForRequest,
  resolveExplicitOrganizationByHost,
  resolveOrganizationById,
  TenantHostError,
  type TenantOrganization,
} from '@/lib/tenancy/host';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import type { SupportIdentity } from '@/lib/tenancy/support-session';
import { responseForPasswordChange } from '@/lib/auth/session-state';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { anonymousToken, classifyAnonymousRequest } from '@/lib/auth/anonymous-access';
import { organizationForAnonymousToken } from '@/lib/auth/anonymous-tenant';
import { admitAnonymousRequest } from '@/lib/auth/anonymous-rate-limit';
import { clientIp } from '@/lib/rate-limit';
import { readBoundedBody } from '@/lib/http/read-bounded-body';

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

/**
 * Carries an already-serialized tRPC response out of the transaction callback it
 * is aborting. It is never surfaced to a caller and never reaches Next.
 */
class TransactionAborted {
  constructor(readonly response: Response) {}
}

/**
 * `httpBatchStreamLink` asks for `application/jsonl`, and the adapter answers it
 * with a `Response` wrapping a lazily-produced stream — built and returned
 * *before* the resolvers settle. Inside a transaction callback that is fatal:
 * the callback resolves, Prisma COMMITs, and the resolvers then run on, and can
 * still fail, with no transaction left to roll back. Inspecting the response the
 * adapter returned, as the rollback below does, cannot see a failure that has
 * not happened yet.
 *
 * So this endpoint refuses the streamed protocol before a transaction is opened
 * and before any resolver runs. Nothing in the app selects it —
 * `@/lib/trpc-provider` configures `httpBatchLink`, whose batch path awaits
 * every call before its response exists — so this closes a transport the
 * endpoint advertised but could never serve safely. Serving a streamed or
 * subscription transport later means moving the transaction, not relaxing this.
 */
const STREAMED_ACCEPT = 'application/jsonl';

function wantsStreamedResponse(req: Request) {
  // Mirrors `getAcceptHeader` in @trpc/server: an explicit `trpc-accept` decides
  // on its own, and `accept` is consulted only when that header is absent.
  const explicit = req.headers.get('trpc-accept');
  if (explicit !== null) return explicit === STREAMED_ACCEPT;
  return (
    req.headers
      .get('accept')
      ?.split(',')
      .some((type) => type.trim() === STREAMED_ACCEPT) ?? false
  );
}

/** An error serialized exactly as the router itself serializes one. */
function errorShape(error: TRPCError, path?: string): TRPCErrorShape {
  return getTRPCErrorShape({
    config: appRouter._def._config,
    error,
    type: 'unknown',
    path,
    input: undefined,
    ctx: undefined,
  });
}

/**
 * One envelope for a request that failed as a whole. That is tRPC's own shape
 * for the case — `caughtErrorToData` answers a failed *batch* with a single
 * envelope too — and `httpBatchLink` deliberately applies a non-array body to
 * every operation it sent, so each one rejects.
 */
function requestFailed(error: TRPCError): Response {
  const shape = errorShape(error);
  return new Response(
    JSON.stringify(transformTRPCResponse(appRouter._def._config, { error: shape })),
    {
      status: getHTTPStatusCode({ error: shape }),
      headers: { 'content-type': 'application/json' },
    }
  );
}

function isErrorEnvelope(entry: unknown): entry is { error: unknown } {
  return typeof entry === 'object' && entry !== null && 'error' in entry;
}

/**
 * The procedures this request named, in batch order — the same derivation
 * `getRequestInfo` makes, so a discarded entry can name its own procedure
 * rather than borrow the failing sibling's.
 */
function procedurePaths(req: Request): string[] {
  const prefix = `${TRPC_ENDPOINT}/`;
  const { pathname } = new URL(req.url);
  const start = pathname.indexOf(prefix);
  if (start < 0) return [];
  // The fetch adapter trims once from the URL pathname and again from its
  // endpoint-relative path, then decodes procedure names.
  const path = pathname.slice(start + prefix.length).replace(/\/{1,2}$/, '');
  return decodeURIComponent(path).split(',');
}

function isPlatformAiSettingsRequest(req: Request): boolean {
  const paths = procedurePaths(req);
  return paths.length > 0 && paths.every((path) => path.startsWith('aiSettings.'));
}

async function servePlatformAiSettings(req: Request) {
  if (wantsStreamedResponse(req)) {
    return requestFailed(
      new TRPCError({
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: `Streamed responses (${STREAMED_ACCEPT}) are not supported by this endpoint: its database transaction has to end with the request. Use a non-streaming batch link.`,
      })
    );
  }

  return withPlatformDb(
    async (platformDb) => {
      let procedureFailed = false;
      const response = await fetchRequestHandler({
        endpoint: TRPC_ENDPOINT,
        req,
        router: appRouter,
        // One platform transaction covers the whole HTTP batch. The procedures
        // reuse it, rather than committing independently before a sibling fails.
        createContext: () =>
          ({
            platformDb,
            requestMeta: { ip: clientIp(req), userAgent: req.headers.get('user-agent') },
          }) as never,
        onError: ({ error, path }) => {
          procedureFailed = true;
          if (error.code === 'INTERNAL_SERVER_ERROR') {
            console.error(`[trpc] ${path ?? 'request'} failed:`, error);
          }
        },
      });
      if (procedureFailed) throw new TransactionAborted(response);
      return response;
    },
    { timeout: 60_000 }
  ).catch((error: unknown) => {
    if (!(error instanceof TransactionAborted)) throw error;
    return req.method === 'POST' ? withoutDiscardedResults(req, error.response) : error.response;
  });
}

/** What a failed entry of an aborted response says about itself. */
type Failure = { path?: string; code?: string; message: string };

function describeFailures(failures: Failure[]): string {
  return failures
    .map(
      ({ path, code, message }) =>
        `${path ? `"${path}"` : 'an operation'} (${code ?? 'ERROR'}: ${message})`
    )
    .join('; ');
}

/**
 * Rewrite an aborted MUTATION batch's response to describe what actually
 * survived.
 *
 * tRPC serialized that response from what the procedures *did*; the ROLLBACK
 * then undid it. Every procedure in the batch ran against the one request-wide
 * transaction, so a sibling that succeeded really did share the failed
 * transaction, and every `result` entry now names a draft, action or document
 * that no longer exists. `httpBatchLink` resolves each entry of a batch
 * independently — an HTTP 207 does not reject a sibling whose envelope says
 * `result` — so a caller would receive an ID for a row that was discarded, and
 * no refetch can turn that into a truthful success after the fact.
 *
 * So each invalidated `result` becomes a real `TRPCError`, serialized through
 * the router's own error formatter and transformer, naming its own procedure,
 * and carrying the sibling failure that caused the rollback (procedure, code and
 * message — all already present in the same response) as its message and
 * `cause`. The aggregate status is recomputed from the resulting shapes by
 * tRPC's own rule. Entries that already carry an error are left byte-for-byte
 * alone: their message, code, status, procedure path and any authorization
 * detail are the original failure information and survive unchanged.
 *
 * Query batches never come here — see `serveInTenantScope`.
 */
async function withoutDiscardedResults(req: Request, response: Response): Promise<Response> {
  const config = appRouter._def._config;
  const rolledBack = (failures: Failure[]) => {
    const reason = failures.length ? describeFailures(failures) : 'another operation';
    return new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Rolled back: ${reason} failed in the same request, so this operation was discarded and nothing it wrote was saved. Retry the request.`,
      cause: new Error(reason),
    });
  };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Not JSON, so no entry in it can be trusted. Fail the request as a whole
    // rather than pass a body we cannot audit back to the caller.
    return requestFailed(rolledBack([]));
  }

  const batched = Array.isArray(body);
  const entries: unknown[] = Array.isArray(body) ? body : [body];
  const paths = procedurePaths(req);
  const named = paths.length === entries.length;

  // First pass: decode every original failure, so each discarded sibling can
  // say which one took it down.
  const shapes: (TRPCErrorShape | null)[] = [];
  const failures: Failure[] = [];
  for (const entry of entries) {
    if (!isErrorEnvelope(entry)) {
      shapes.push(null);
      continue;
    }
    let shape: TRPCErrorShape;
    try {
      shape = config.transformer.output.deserialize(entry.error) as TRPCErrorShape;
    } catch {
      return requestFailed(rolledBack([]));
    }
    shapes.push(shape);
    const data = shape.data as { path?: unknown; code?: unknown } | undefined;
    failures.push({
      path: typeof data?.path === 'string' ? data.path : undefined,
      code: typeof data?.code === 'string' ? data.code : undefined,
      message: shape.message,
    });
  }

  const discarded = rolledBack(failures);
  const rewritten: unknown[] = [];
  const finalShapes: TRPCErrorShape[] = [];
  for (const [index, entry] of entries.entries()) {
    const original = shapes[index];
    if (original) {
      finalShapes.push(original);
      rewritten.push(entry);
      continue;
    }
    const shape = errorShape(discarded, named ? paths[index] : undefined);
    finalShapes.push(shape);
    rewritten.push(transformTRPCResponse(config, { error: shape }));
  }

  // `content-length` described the body we just replaced.
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(batched ? rewritten : rewritten[0]), {
    status: getHTTPStatusCode(finalShapes.map((error) => ({ error }))),
    headers,
  });
}

/**
 * Serve the real router inside one tenant-scoped transaction, and keep that
 * transaction's outcome tied to the procedures' outcome.
 *
 * `fetchRequestHandler` never rejects: a resolver that throws is converted into
 * a *fulfilled* error `Response`. Because the adapter runs inside the
 * `withTenantDb` callback, that fulfilled response used to let the owning
 * transaction COMMIT. PostgreSQL aborts a transaction on its own only for SQL
 * errors, so an application-level failure — a failed event write, a thrown
 * invariant, a Prisma validation error — left every write the procedure had
 * already made durable. A draft and its idempotency action could survive
 * without the event that gives them meaning, and a retry would then find the
 * retained action and return it without repairing anything.
 *
 * Recording procedure errors through `onError` and throwing out of the callback
 * restores the boundary: Prisma issues ROLLBACK, and the response tRPC built is
 * returned afterwards untouched, so status codes, error shapes and the
 * transformer's serialization are exactly what they were before. The error is
 * neither swallowed nor downgraded — the caller still receives it.
 *
 * The unit of atomicity is the HTTP request, because the transaction is: a
 * batch commits only when every procedure in it succeeded. tRPC binds a batch to
 * a single procedure type — with `allowMethodOverride` off, a mutation runs
 * only on POST and a query only on GET — so the method decides what the
 * rollback can have discarded:
 *
 *   - GET (queries): the response goes back UNTOUCHED. A query's result is what
 *     it read, and a rollback does not unread it, so a failing query must not
 *     blank its siblings — one broken widget would empty every list on the page.
 *     The rollback still discards any partial write the failing query made.
 *   - POST (mutations): every sibling wrote into the transaction that just
 *     rolled back, so its `result` is no longer true. Discarding them together
 *     is the conservative direction — a client can retry, whereas a half-applied
 *     batch cannot be repaired — and `withoutDiscardedResults` reports each one
 *     as discarded, naming the failure that caused it. A rolled-back write must
 *     never come back wearing a `result`.
 */
async function serveInTenantScope(
  req: Request,
  organization: TenantOrganization,
  actor: { session: Session | null; support: SupportIdentity | null }
): Promise<Response> {
  if (wantsStreamedResponse(req)) {
    return requestFailed(
      new TRPCError({
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: `Streamed responses (${STREAMED_ACCEPT}) are not supported by this endpoint: its database transaction has to end with the request. Use a non-streaming batch link.`,
      })
    );
  }
  return withTenantDb(
    organization.id,
    async (scopedDb) => {
      let procedureFailed = false;
      const response = await fetchRequestHandler({
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
        onError: ({ error, path }) => {
          procedureFailed = true;
          // In production the errorFormatter tells the client only that an
          // unexpected failure happened; its message, cause and stack are kept here.
          if (error.code === 'INTERNAL_SERVER_ERROR') {
            console.error(`[trpc] ${path ?? 'request'} failed:`, error);
          }
        },
      });
      if (procedureFailed) throw new TransactionAborted(response);
      return response;
    },
    { timeout: 60_000, userId: actor.session?.user?.id }
  ).catch((error: unknown) => {
    if (!(error instanceof TransactionAborted)) throw error;
    return req.method === 'POST' ? withoutDiscardedResults(req, error.response) : error.response;
  });
}

/** Serve an allowlisted procedure inside a tenant's RLS scope, with no session. */
function runAnonymously(req: Request, organization: TenantOrganization) {
  // Explicitly no session. Every protected procedure refuses a null session in
  // its own middleware, so an allowlisted procedure is all that can run.
  return serveInTenantScope(req, organization, { session: null, support: null });
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

async function boundAnonymousPost(req: Request): Promise<Request | Response> {
  if (req.method !== 'POST' || !req.body) return req;

  const body = await readBoundedBody(req, 256 * 1024);
  if (body === null) {
    return requestFailed(
      new TRPCError({ code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' })
    );
  }
  return new Request(req.url, {
    method: req.method,
    headers: req.headers,
    signal: req.signal,
    body,
  });
}

async function handleAnonymous(req: Request): Promise<Response> {
  const routing = classifyAnonymousRequest(req);
  if (routing.kind === 'denied') return unauthorized();

  // Keep the existing limiter ahead of the body read whenever its key is already known.
  const tokenNeedsBody =
    routing.kind === 'token' &&
    req.method === 'POST' &&
    !new URL(req.url).searchParams.get('input');
  const tokenRequest = tokenNeedsBody ? await boundAnonymousPost(req) : req;
  if (tokenRequest instanceof Response) return tokenRequest;
  const token = routing.kind === 'token' ? await anonymousToken(tokenRequest) : null;

  // Throttle BEFORE any database work, so neither the platform-scope token
  // lookup nor the tenant transaction can be driven by an unauthenticated flood.
  const admitted = await admitAnonymousRequest({ kind: routing.kind, token, ip: clientIp(req) });
  if (!admitted.ok) {
    return Response.json(
      { error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'retry-after': String(admitted.retryAfter) } }
    );
  }

  const boundedRequest = tokenNeedsBody ? tokenRequest : await boundAnonymousPost(req);
  if (boundedRequest instanceof Response) return boundedRequest;

  if (routing.kind === 'token') {
    const organizationId = await organizationForAnonymousToken(token);
    const organization = organizationId ? await resolveOrganizationById(organizationId) : null;
    const target = servable(organization);
    return target ? runAnonymously(boundedRequest, target) : runFallback(boundedRequest);
  }

  // Host-routed: `passwordReset.request` carries an email, not a token, so the
  // host is the only thing that can name a tenant. The STRICT resolver is
  // deliberate — `resolveOrganizationByHost` would map a shared or default host
  // onto DEFAULT_ORGANIZATION_ID and mail a reset link for a tenant the caller
  // never named. An unnamed tenant means nothing is sent, and the caller still
  // gets the ordinary generic confirmation.
  const organization = servable(await resolveExplicitOrganizationByHost(requestHost(req)));
  return organization ? runAnonymously(boundedRequest, organization) : runFallback(boundedRequest);
}

async function handler(req: Request) {
  try {
    if (isPlatformAiSettingsRequest(req)) return servePlatformAiSettings(req);
    try {
      await preflightTrelloImport(req, procedurePaths(req));
    } catch (error) {
      if (error instanceof TRPCError) return requestFailed(error);
      throw error;
    }
    const actor = await resolveTenantActor({ request: req });
    if (!actor) return handleAnonymous(req);

    const organization = await requireOrganizationForRequest(
      req,
      actor.session.user.organizationId
    );
    return serveInTenantScope(req, organization, {
      session: actor.session,
      support: actor.support,
    });
  } catch (error) {
    const passwordChange = responseForPasswordChange(error);
    if (passwordChange) return passwordChange;
    if (error instanceof TenantHostError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

export { handler as GET, handler as POST };
