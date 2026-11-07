import 'server-only';

import { cache } from 'react';
import { headers } from 'next/headers';
import {
  classifyHost,
  normalizeHost,
  resolveOrganizationByHost,
  TENANT_HOST_HEADER,
  type TenantOrganization,
} from '@/lib/tenancy/host';

export type UnknownTenantVertical = 'pharmacy' | 'restaurant' | 'hotel' | 'default';

type ResolveByHost = (host: string) => Promise<TenantOrganization | null>;

/**
 * True when the host names a tenant subdomain (a slug under the base domain or
 * `<slug>.localhost`) that resolves to no organization — a mistyped workspace
 * address. Shared, platform, slug-free and unclassifiable hosts are never
 * "unknown tenants", so their existing routing is untouched.
 *
 * The answer is a plain boolean: callers render one generic not-found page and
 * never reveal which workspaces exist.
 */
export async function isUnknownTenantHost(
  hostValue: string | null | undefined,
  resolve: ResolveByHost = resolveOrganizationByHost
): Promise<boolean> {
  const classified = classifyHost(hostValue);
  if (classified.kind !== 'tenant' || !classified.slug) return false;
  return (await resolve(classified.host)) === null;
}

/**
 * Presentation-only vertical hint read from the host labels
 * (`acme.pharmacy.example.com` → pharmacy). Never used for identity or access.
 */
export function unknownTenantVertical(hostValue: string | null | undefined): UnknownTenantVertical {
  const labels = normalizeHost(hostValue).split('.');
  if (labels.includes('pharmacy')) return 'pharmacy';
  if (labels.includes('restaurant')) return 'restaurant';
  if (labels.includes('hotel') || labels.includes('hospitality')) return 'hotel';
  return 'default';
}

async function currentHost(): Promise<string | null> {
  const requestHeaders = await headers();
  return (
    requestHeaders.get(TENANT_HOST_HEADER) ??
    requestHeaders.get('x-forwarded-host') ??
    requestHeaders.get('host')
  );
}

/** Request-scoped: the layout, metadata and not-found page share one lookup. */
export const currentUnknownTenantHost = cache(
  async (): Promise<{ unknown: boolean; vertical: UnknownTenantVertical }> => {
    const host = await currentHost().catch(() => null);
    const unknown = await isUnknownTenantHost(host);
    return { unknown, vertical: unknownTenantVertical(host) };
  }
);
