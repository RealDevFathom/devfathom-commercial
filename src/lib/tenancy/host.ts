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
/** DEV-961: set by the proxy on every request (overwriting any client value): the HTTP method. */
export const REQUEST_METHOD_HEADER = 'x-devfathom-request-method';

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
  isDemo: boolean;
  vertical?: string;
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
  isDemo: true,
  vertical: true,
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
 * A deployment URL is stored as a whole URL, written either by provisioning
 * (`https://<vercel-host>`) or by a platform operator through the admin form,
 * so the same host legitimately appears under either scheme and with or without
 * a trailing slash. Enumerating those forms lets the lookup compare whole
 * values instead of matching a substring.
 */
function deploymentUrlCandidates(host: string): readonly string[] {
  return [
    `https://${host}`,
    `https://${host}/`,
    `http://${host}`,
    `http://${host}/`,
    host,
    `${host}/`,
  ];
}

/**
 * Prisma compiles `equals` + `mode: 'insensitive'` to `url ILIKE $n`, which is
 * genuinely case-insensitive but also treats the BOUND PARAMETER as a pattern:
 * `%` and `_` inside it are wildcards. The host arrives from a request header,
 * so `Host: %.apps.example.test` would otherwise fan out to whatever tenant
 * deployment happens to match. Hosts are restricted to the DNS character set
 * before they are ever used to build a candidate, and the rows that come back
 * are re-checked against the candidate set in application code, so the match is
 * exact regardless of which operator Prisma chooses.
 */
const DEPLOYMENT_HOST_PATTERN = /^[a-z0-9.-]+$/;

export type TenantHostResolutionWarning = {
  event: 'tenant_host_resolution_ambiguous';
  hostname: string;
  matchCount: number;
  organizationCount: number;
  organizationIds: string[];
  deploymentIds: string[];
};

export type ExplicitHostResolverOptions = {
  /**
   * Injected so tests can assert the ambiguity warning. Deliberately a plain
   * callback rather than an audit write: this resolver runs on unauthenticated
   * traffic and must stay read-only, so it must not depend on audit storage
   * being reachable to make a routing decision.
   */
  warn?: (warning: TenantHostResolutionWarning) => void;
};

function warnToConsole(warning: TenantHostResolutionWarning): void {
  console.warn(`[tenancy] ${warning.event}`, JSON.stringify(warning));
}

export async function resolveOrganizationByHost(
  hostValue: string | null | undefined
): Promise<TenantOrganization | null> {
  const classified = classifyHost(hostValue);
  if (classified.kind === 'platform' || classified.kind === 'unknown') return null;

  const defaultOrganizationId = process.env.DEFAULT_ORGANIZATION_ID ?? 'org_devfathom';

  return withPlatformDb(async (tx) => {
    if (classified.kind === 'tenant' && classified.slug) {
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
      where: { url: { in: [...deploymentUrlCandidates(classified.host)] }, status: 'READY' },
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
  const host = requestHost(request);
  if (classifyHost(host).kind === 'shared') return null;
  return resolveOrganizationByHost(host);
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
 *     here. Otherwise the deployment lookup below would let the shared host
 *     `staging.devfathom.com` reach a tenant deployment and hand the request to
 *     an arbitrary organization. The slug lookup runs first so `<slug>.localhost`
 *     development hosts, which land in `configuredDefaultHosts()` via
 *     NEXT_PUBLIC_APP_URL, still resolve to their own tenant.
 *
 * The deployment lookup itself is exact and fails closed. It never matches a
 * substring, so `staging.devfathom.com` cannot reach a deployment recorded at
 * `acme-staging.devfathom.com`; and it never picks a winner among several
 * organizations, because "the most recently updated deployment wins" is a
 * routing decision no caller asked for. Two organizations claiming one host is a
 * misconfiguration or an attempted takeover, and either way the safe answer is
 * to name no tenant at all.
 *
 * Callers must treat null as "no organization was named" and answer with the
 * same generic response they would give for an unknown account — never with an
 * error that distinguishes an unrecognised host from a recognised one.
 */
export async function resolveExplicitOrganizationByHost(
  hostValue: string | null | undefined,
  options: ExplicitHostResolverOptions = {}
): Promise<TenantOrganization | null> {
  const classified = classifyHost(hostValue);
  if (classified.kind !== 'tenant') return null;
  const warn = options.warn ?? warnToConsole;

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

    if (!DEPLOYMENT_HOST_PATTERN.test(classified.host)) return null;

    const candidates = deploymentUrlCandidates(classified.host);
    const candidateSet = new Set(candidates);
    const deployments = await tx.organizationDeployment.findMany({
      where: {
        status: 'READY',
        OR: candidates.map((url) => ({ url: { equals: url, mode: 'insensitive' as const } })),
      },
      select: {
        id: true,
        url: true,
        organizationId: true,
        organization: { select: ORGANIZATION_SELECT },
      },
      // Stable, so an ambiguous host reports the same rows on every request and
      // the warning below is reproducible. It is explicitly NOT a tie-break.
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    });

    const matches = deployments.filter(
      (deployment) =>
        deployment.url !== null && candidateSet.has(deployment.url.trim().toLowerCase())
    );

    const byOrganization = new Map<string, (typeof matches)[number]>();
    for (const match of matches) {
      if (!byOrganization.has(match.organizationId))
        byOrganization.set(match.organizationId, match);
    }

    if (byOrganization.size === 0) return null;

    if (byOrganization.size > 1) {
      warn({
        event: 'tenant_host_resolution_ambiguous',
        hostname: classified.host,
        matchCount: matches.length,
        organizationCount: byOrganization.size,
        organizationIds: [...byOrganization.keys()],
        deploymentIds: matches.map((match) => match.id),
      });
      return null;
    }

    return [...byOrganization.values()][0]!.organization;
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
