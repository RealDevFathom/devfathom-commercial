import 'server-only';

import type { OrganizationDeploymentMode, OrganizationStatus } from '@/generated/prisma/client';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';
import { classifyHost, configuredDefaultHosts, normalizeHost } from '@/lib/tenancy/host-routing';

export { classifyHost, normalizeHost } from '@/lib/tenancy/host-routing';
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

export async function resolveOrganizationByHost(
  hostValue: string | null | undefined
): Promise<TenantOrganization | null> {
  const classified = classifyHost(hostValue);
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
      where: { url: { contains: classified.host }, status: 'READY' },
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
 * Resolve a host to the organization that is EXPLICITLY bound to it, or null.
 *
 * A deliberate sibling of `resolveOrganizationByHost` rather than a flag on it:
 * that function's default-organization fallback is load-bearing for the signed-in
 * surface, and PR C / PR D depend on its behaviour staying exactly as it is.
 *
 * Two differences, both narrowing:
 *
 *  1. It never reaches DEFAULT_ORGANIZATION_ID. `resolveOrganizationByHost` maps
 *     `localhost`, `127.0.0.1`, and every host in `configuredDefaultHosts()` onto
 *     one default tenant. For an anonymous, host-routed action such as
 *     "email a password reset link", that fallback silently picks a tenant the
 *     caller never named.
 *  2. After an exact slug match fails, a configured default/shared host stops
 *     here. Otherwise the deployment lookup below — a SUBSTRING match
 *     (`url contains host`) resolved with `findFirst` — would let the shared host
 *     `staging.devfathom.com` match a tenant deployment at
 *     `acme-staging.devfathom.com` and hand the request to an arbitrary
 *     organization. The slug lookup runs first so `<slug>.localhost` development
 *     hosts, which land in `configuredDefaultHosts()` via NEXT_PUBLIC_APP_URL,
 *     still resolve to their own tenant.
 *
 * Callers must treat null as "no organization was named" and answer with the
 * same generic response they would give for an unknown account — never with an
 * error that distinguishes an unrecognised host from a recognised one.
 */
export async function resolveExplicitOrganizationByHost(
  hostValue: string | null | undefined
): Promise<TenantOrganization | null> {
  const classified = classifyHost(hostValue);
  if (classified.kind !== 'tenant') return null;

  return withPlatformDb(async (tx) => {
    if (classified.slug) {
      const bySlug = await tx.organization.findUnique({
        where: { slug: classified.slug },
        select: ORGANIZATION_SELECT,
      });
      if (bySlug) return bySlug;
    }

    if (
      classified.host === 'localhost' ||
      classified.host === '127.0.0.1' ||
      configuredDefaultHosts().has(classified.host)
    ) {
      return null;
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
      where: { url: { contains: classified.host }, status: 'READY' },
      select: { organization: { select: ORGANIZATION_SELECT } },
    });
    if (deployment) return deployment.organization;

    return null;
  });
}

/**
 * Load a tenant organization by id, for requests routed by something other than
 * the host — currently the anonymous token flows, where the token itself names
 * the tenant. Runs in the platform scope because the tenant is not yet known.
 */
export async function resolveOrganizationById(
  organizationId: string
): Promise<TenantOrganization | null> {
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

export async function requireOrganizationForRequest(
  request: Request,
  expectedOrganizationId?: string | null
): Promise<TenantOrganization> {
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
