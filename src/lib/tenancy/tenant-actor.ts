import 'server-only';

import { cache } from 'react';
import { headers } from 'next/headers';
import type { Session } from 'next-auth';
import { auth } from '@/lib/auth';
import {
  isTenantLifecycleAccessible,
  requireOrganizationForRequest,
  resolveOrganizationByHost,
  TenantHostError,
  TENANT_HOST_HEADER,
  type TenantOrganization,
} from '@/lib/tenancy/host';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { getSupportSession, type SupportIdentity } from '@/lib/tenancy/support-session';

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

async function organizationForServerComponent(
  expectedOrganizationId: string
): Promise<TenantOrganization> {
  const requestHeaders = await headers();
  const organization = await resolveOrganizationByHost(
    requestHeaders.get(TENANT_HOST_HEADER) ??
      requestHeaders.get('x-forwarded-host') ??
      requestHeaders.get('host')
  );
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
    if (error instanceof TenantHostError) return null;
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
  // An explicit, audited support cookie takes precedence over a tenant JWT.
  // This keeps every action attributed to the operator even when the browser
  // already has a tenant session, and avoids decoding a stale JWT first.
  const support = await getSupportSession(options.request);
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

  const session = 'session' in options ? options.session : await auth();

  if (isUsableSession(session)) {
    const organization = await organizationForActor(session.user.organizationId, options.request);
    if (!organization) return null;
    return { session, organization, support: null };
  }

  return null;
}

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
