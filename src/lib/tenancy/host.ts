import 'server-only';

import type { OrganizationDeploymentMode, OrganizationStatus } from '@/generated/prisma/client';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import {
  classifyHost,
  configuredDefaultHosts,
  isSharedHost,
  normalizeHost,
} from '@/lib/tenancy/host-routing';

export {
  classifyHost,
  isSharedHost,
  normalizeHost,
  RESERVED_HOST_LABELS,
} from '@/lib/tenancy/host-routing';
export type { HostKind } from '@/lib/tenancy/host-routing';

export const TENANT_HOST_HEADER = 'x-devfathom-host';
export const REQUEST_ID_HEADER = 'x-devfathom-request-id';

export type TenantOrganization = {
  id: string;
  slug: string;
  displayName: string;
  legalName: string;
  status: OrganizationStatus;
  deploymentMode: OrganizationDeploymentMode;
  timezone: string;
  locale: string;
  currency: string;
  seatLimit: number;
};

const ORGANIZATION_SELECT = {
  id: true,
  slug: true,
  displayName: true,
  legalName: true,
  status: true,
  deploymentMode: true,
  timezone: true,
  locale: true,
  currency: true,
  seatLimit: true,
} as const;

export function requestHost(request: Request): string {
  return normalizeHost(
    request.headers.get(TENANT_HOST_HEADER) ??
      request.headers.get('x-forwarded-host') ??
      request.headers.get('host')
  );
}

export function isTenantLifecycleAccessible(status: OrganizationStatus): boolean {
  return status === 'ONBOARDING' || status === 'ACTIVE' || status === 'GRACE';
}

/**
 * Every URL form a deployment record may store for one host.
 *
 * D16: this used to be `url: { contains: host }` with `findFirst` and no
 * `orderBy`. Shared provisioning writes `https://<slug>.<baseDomain>`, so a
 * request for the bare apex matched EVERY tenant deployment row and returned a
 * nondeterministic organization — internet-reachable once a public apex/www host
 * exists. Matching the whole value makes one host resolve to at most one row.
 */
function deploymentUrlsFor(host: string): string[] {
  return ['https', 'http'].flatMap((protocol) => [
    `${protocol}://${host}`,
    `${protocol}://${host}/`,
  ]);
}

export async function resolveOrganizationByHost(
  hostValue: string | null | undefined
): Promise<TenantOrganization | null> {
  const classified = classifyHost(hostValue);
  // D4: a shared host carries no organization. Returning null here short-circuits
  // BEFORE the default-organization fallback below — without it every shared-host
  // login would silently authenticate against DEFAULT_ORGANIZATION_ID, because
  // AUTH_URL/NEXT_PUBLIC_APP_URL must point at the shared host for reset and
  // invite emails and both feed configuredDefaultHosts().
  if (classified.kind !== 'tenant') return null;

  const defaultOrganizationId = process.env.DEFAULT_ORGANIZATION_ID ?? 'org_devfathom';

  return withPlatformDb(async (tx) => {
    if (classified.slug) {
      const bySlug = await tx.organization.findUnique({
        where: { slug: classified.slug },
        select: ORGANIZATION_SELECT,
      });
      if (bySlug) return bySlug;
    }

    const domain = await tx.organizationDomain.findUnique({
      where: { host: classified.host },
      select: {
        verificationStatus: true,
        organization: { select: ORGANIZATION_SELECT },
      },
    });
    if (domain?.verificationStatus === 'VERIFIED') return domain.organization;

    const deployment = await tx.organizationDeployment.findFirst({
      where: { url: { in: deploymentUrlsFor(classified.host) }, status: 'READY' },
      orderBy: { updatedAt: 'desc' },
      select: { organization: { select: ORGANIZATION_SELECT } },
    });
    if (deployment) return deployment.organization;

    if (
      classified.host === 'localhost' ||
      classified.host === '127.0.0.1' ||
      configuredDefaultHosts().has(classified.host)
    ) {
      return tx.organization.findUnique({
        where: { id: defaultOrganizationId },
        select: ORGANIZATION_SELECT,
      });
    }

    return null;
  });
}

export async function resolveOrganizationForRequest(
  request: Request
): Promise<TenantOrganization | null> {
  return resolveOrganizationByHost(requestHost(request));
}

/**
 * Resolve an organization by id, with no host involved.
 *
 * D13: on a shared host there is no host organization to compare a session
 * against, so the host/session cross-check degenerates. The organization comes
 * from the authenticated token instead — never from request input — and the
 * lifecycle gate is then applied explicitly. `auth.ts` already proves
 * `withTenantDb(token.organizationId, …)` works without host context.
 */
export async function resolveOrganizationById(
  organizationId: string
): Promise<TenantOrganization | null> {
  if (!organizationId) return null;
  return withPlatformDb((tx) =>
    tx.organization.findUnique({
      where: { id: organizationId },
      select: ORGANIZATION_SELECT,
    })
  );
}

export class TenantHostError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 423
  ) {
    super(message);
    this.name = 'TenantHostError';
  }
}

/**
 * The organization a request may act on.
 *
 * Enterprise tenant, custom and dedicated hosts keep the original contract: the
 * host resolves an organization, and a session for a different one is a 409.
 *
 * D13: a shared host resolves no organization, so that cross-check has nothing
 * to compare and would reject every request. The session's organization becomes
 * authoritative there — it is an authenticated claim, not request input — and the
 * lifecycle gate that the host path applied is re-applied explicitly so a
 * suspended workspace still gets 423 rather than silently working.
 */
export async function requireOrganizationForRequest(
  request: Request,
  expectedOrganizationId?: string | null
): Promise<TenantOrganization> {
  if (isSharedHost(requestHost(request))) {
    if (!expectedOrganizationId) throw new TenantHostError('Workspace not found.', 404);
    const organization = await resolveOrganizationById(expectedOrganizationId);
    if (!organization) throw new TenantHostError('Workspace not found.', 404);
    if (!isTenantLifecycleAccessible(organization.status)) {
      throw new TenantHostError('This workspace is not currently active.', 423);
    }
    return organization;
  }

  const organization = await resolveOrganizationForRequest(request);
  if (!organization) throw new TenantHostError('Workspace not found.', 404);
  if (expectedOrganizationId && expectedOrganizationId !== organization.id) {
    throw new TenantHostError('This session belongs to a different workspace.', 409);
  }
  if (!isTenantLifecycleAccessible(organization.status)) {
    throw new TenantHostError('This workspace is not currently active.', 423);
  }
  return organization;
}
