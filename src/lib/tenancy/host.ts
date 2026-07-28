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
