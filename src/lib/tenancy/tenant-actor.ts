import 'server-only';

import {
  demoSeatFromOrganizationId,
  isCanonicalDemoOrganization,
} from '@/lib/tenancy/demo-identity';

import { cache } from 'react';
import { SUPPLIER_DOCUMENT_UPLOAD_URL } from '@/lib/pharmacy/supplier-document-contract';
import { tenantHostUrl, normalizeHost } from '@/lib/tenancy/host-routing';
import { headers } from 'next/headers';
import { getServerActionRequestMetadata } from 'next/dist/server/lib/server-action-request-meta';
import type { Session } from 'next-auth';
import {
  isSharedHost,
  isTenantLifecycleAccessible,
  requestHost,
  REQUEST_METHOD_HEADER,
  requireOrganizationForRequest,
  resolveOrganizationById,
  resolveOrganizationByHost,
  TenantHostError,
  TENANT_HOST_HEADER,
  type TenantOrganization,
} from '@/lib/tenancy/host';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { getSupportSession, type SupportIdentity } from '@/lib/tenancy/support-session';
import { getDemoSeatCount, isDemoEnabled } from '@/lib/demo/config';
import { demoPersonaForUser } from '@/lib/demo/personas';
import {
  ApprovalAuthenticatorSetupRequiredError,
  evaluateSessionUser,
  isApprovalAuthenticatorSetupApiExempt,
  isPasswordChangeApiExempt,
  isSessionUsable,
  liveDemoAccessExpiry,
  PasswordChangeRequiredError,
  type SessionDenialKind,
} from '@/lib/auth/session-state';

export type TenantActor = {
  session: Session;
  organization: TenantOrganization;
  support: SupportIdentity | null;
};

type ResolveTenantActorOptions = {
  request?: Request;
  /**
   * Route handlers wrapped by `auth()` already have the resolved session. Pass
   * it here to avoid evaluating Auth.js a second time after request scope ends.
   */
  session?: Session | null;
};

async function requestSession(): Promise<Session | null> {
  const { auth } = await import('@/lib/auth');
  return auth();
}

/**
 * DEV-961: whether the current request, which carries no `Request` (a server component or a
 * server action), is anything but a page render. A page renders only for GET or HEAD. Every
 * other method is refused, and so is anything Next itself would run as a server action, decided
 * by Next's own function (`next/dist/server/lib/server-action-request-meta.js`, lines 24-48 in
 * Next 16.4.6): a POST with a `Next-Action` header (a fetch action), or a POST whose body is
 * `application/x-www-form-urlencoded` or `multipart/form-data` (a plain form submission, which
 * Next decodes as an action from its `$ACTION_ID_` field with no header at all,
 * `app-render/action-handler.js` lines 689-733). The method comes from the proxy, which
 * always overwrites `REQUEST_METHOD_HEADER`; where it is missing the request is checked as a
 * POST, so a form body or an action header is still refused. Outside a request (a job, a
 * script) there is nothing to refuse.
 */
async function isNonPageRequest(): Promise<boolean> {
  let requestHeaders: Headers;
  try {
    requestHeaders = new Headers(await headers());
  } catch {
    return false;
  }
  const method = (requestHeaders.get(REQUEST_METHOD_HEADER) ?? '').toUpperCase();
  if (method && method !== 'GET' && method !== 'HEAD') return true;
  return getServerActionRequestMetadata({
    headers: requestHeaders,
    method: method || 'POST',
  } as Parameters<typeof getServerActionRequestMetadata>[0]).isPossibleServerAction;
}

async function currentRequestHost(): Promise<string | null> {
  const requestHeaders = await headers();
  return (
    requestHeaders.get(TENANT_HOST_HEADER) ??
    requestHeaders.get('x-forwarded-host') ??
    requestHeaders.get('host')
  );
}

async function organizationForServerComponent(
  expectedOrganizationId: string
): Promise<TenantOrganization> {
  const host = await currentRequestHost();

  // D13: mirrors requireOrganizationForRequest for pages. On a shared host the
  // session's organization is authoritative and the lifecycle gate is explicit;
  // everywhere else the host must still agree with the session.
  if (isSharedHost(host)) {
    const shared = await resolveOrganizationById(expectedOrganizationId);
    if (!shared) throw new TenantHostError('Workspace not found.', 404);
    if (!isTenantLifecycleAccessible(shared.status)) {
      throw new TenantHostError('This workspace is not currently active.', 423);
    }
    return shared;
  }

  const organization = await resolveOrganizationByHost(host);
  if (!organization) throw new TenantHostError('Workspace not found.', 404);
  if (organization.id !== expectedOrganizationId) {
    throw new TenantHostError('This session belongs to a different workspace.', 409);
  }
  if (!isTenantLifecycleAccessible(organization.status)) {
    throw new TenantHostError('This workspace is not currently active.', 423);
  }
  return organization;
}

async function organizationForActor(
  expectedOrganizationId: string,
  request?: Request
): Promise<TenantOrganization | null> {
  try {
    return request
      ? await requireOrganizationForRequest(request, expectedOrganizationId)
      : await organizationForServerComponent(expectedOrganizationId);
  } catch (error) {
    if (error instanceof TenantHostError) {
      // This route reports the host denial as plain text. Other callers keep
      // treating a host mismatch as no member session.
      const path = request && new URL(request.url).pathname;
      if (path !== SUPPLIER_DOCUMENT_UPLOAD_URL && path !== `${SUPPLIER_DOCUMENT_UPLOAD_URL}/`)
        return null;
    }
    throw error;
  }
}

function isUsableSession(session: Session | null | undefined): session is Session {
  return Boolean(session?.user?.id && session.user.organizationId);
}

/**
 * Resolve the effective tenant actor for pages and route handlers.
 *
 * Normal Auth.js sessions remain the primary path. A short-lived, opaque
 * platform support session is accepted only when its organization matches the
 * current host and its impersonated tenant administrator is still active.
 */
async function resolveTenantActorUncached(
  options: ResolveTenantActorOptions
): Promise<TenantActor | null> {
  // D14: `df_support_session` is deliberately domain-wide (`domain: '.<base>'`)
  // and takes precedence over the tenant JWT, so an operator with a live support
  // session who visits the shared host would otherwise be handed a surprising
  // impersonated actor for a workspace they did not open. Support access is
  // scoped to a tenant host; the shared host ignores the cookie entirely.
  const host = options.request
    ? requestHost(options.request)
    : await currentRequestHost().catch(() => null);
  const onSharedHost = isSharedHost(host);

  // An explicit, audited support cookie takes precedence over a tenant JWT.
  // This keeps every action attributed to the operator even when the browser
  // already has a tenant session, and avoids decoding a stale JWT first.
  const support = onSharedHost ? null : await getSupportSession(options.request);
  if (support) {
    const organization = await organizationForActor(support.organizationId, options.request);
    if (!organization) return null;
    const user = await withTenantDb(organization.id, (tenantDb) =>
      tenantDb.user.findUnique({
        where: { id: support.tenantUserId },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          department: true,
          title: true,
          avatar: true,
          status: true,
        },
      })
    );
    if (!user) return null;

    return {
      organization,
      support,
      session: {
        expires: support.expiresAt.toISOString(),
        user: {
          id: user.id,
          organizationId: organization.id,
          organizationSlug: organization.slug,
          organizationStatus: organization.status,
          name: user.name,
          email: user.email,
          role: user.role,
          department: user.department,
          title: user.title,
          image: user.avatar,
          status: user.status,
          isSupportSession: true,
          supportSessionId: support.supportSessionId,
          platformUserId: support.platformUserId,
          supportReason: support.reason,
        },
      },
    };
  }

  const session = 'session' in options ? options.session : await requestSession();

  if (isUsableSession(session)) {
    // #16: a revoked/deleted/unverifiable session is not an actor. Enforcing it
    // here — rather than at each of the six call sites — means no route handler
    // can forget the check, so the API is closed to a revoked token even when it
    // never loads a page. Audited support sessions keep their own validity model
    // (`getSupportSession` already enforces expiry and revocation).
    if (!isSessionUsable(session.user)) return null;
    if (
      session.user.mustChangePassword === true &&
      options.request &&
      new URL(options.request.url).pathname.startsWith('/api/') &&
      !isPasswordChangeApiExempt(options.request)
    ) {
      throw new PasswordChangeRequiredError();
    }
    // DEV-961: until a member who can approve sets up their approval authenticator, every
    // request that is not a page render refuses them here: every route handler (under /api
    // or not: exports, downloads, uploads) and every server action. Only the set-up screen's
    // own tRPC calls and sign-out are exempt. A page render (GET or HEAD with no server action)
    // is not refused here: the (app) layout sends it to the set-up screen. This is the one place every route handler and
    // server action resolves its signed-in member (`tests/approval-authenticator-route-gate`
    // enumerates them); API tokens are gated the same way in `authenticateApiRequest`.
    if (
      session.user.approvalAuthenticatorSetupRequired === true &&
      (options.request
        ? !isApprovalAuthenticatorSetupApiExempt(options.request)
        : await isNonPageRequest())
    ) {
      throw new ApprovalAuthenticatorSetupRequiredError();
    }
    const organization = await organizationForActor(session.user.organizationId, options.request);
    if (!organization) return null;
    if (organization.isDemo || session.user.demoAccessExpiresAt !== undefined) {
      const seat = demoSeatFromOrganizationId(organization.id, getDemoSeatCount());
      if (
        !isDemoEnabled() ||
        !isCanonicalDemoOrganization(organization, getDemoSeatCount()) ||
        !seat ||
        !demoPersonaForUser(seat, session.user) ||
        !liveDemoAccessExpiry(session.user.demoAccessExpiresAt)
      )
        return null;
    }
    return { session, organization, support: null };
  }

  return null;
}

/**
 * Why the current server-component request has no usable tenant session.
 * Only consulted on the failure path, so the extra Auth.js evaluation costs
 * nothing for signed-in traffic.
 */
export const resolveTenantSessionDenial = cache(async (): Promise<SessionDenialKind | null> => {
  const session = await requestSession();
  if (!session?.user?.id) return null;
  const verdict = evaluateSessionUser(session.user);
  return verdict.ok ? null : verdict.kind;
});

// Layouts and pages can render in parallel in the App Router. Auth.js may rotate
// a JWT while resolving it, so evaluating auth() independently in both branches
// can leave one branch without a usable session. React's request cache shares
// one server-component actor resolution for the whole render while explicit
// route-handler contexts remain uncached.
const resolveServerComponentTenantActor = cache(() => resolveTenantActorUncached({}));

export function resolveTenantActor(
  options: ResolveTenantActorOptions = {}
): Promise<TenantActor | null> {
  if (!options.request && !('session' in options)) {
    return resolveServerComponentTenantActor();
  }
  return resolveTenantActorUncached(options);
}

/** Only a verified session and a live database slug may choose a login host. */
export async function resolveTenantMismatchLoginPath(): Promise<string | null> {
  const session = await requestSession();
  if (!isUsableSession(session) || !isSessionUsable(session.user)) return null;
  const host = await currentRequestHost();
  if (isSharedHost(host)) return null;
  const hostOrganization = await resolveOrganizationByHost(host);
  if (!hostOrganization || hostOrganization.id === session.user.organizationId) return null;
  const organization = await resolveOrganizationById(session.user.organizationId);
  if (!organization || !isTenantLifecycleAccessible(organization.status)) return null;
  const normalizedHost = normalizeHost(host);
  if (normalizedHost.endsWith('.localhost')) {
    const port = host?.match(/:(\d+)$/)?.[1];
    return `http://${organization.slug}.localhost${port ? `:${port}` : ''}/login`;
  }
  return tenantHostUrl(organization.slug);
}
