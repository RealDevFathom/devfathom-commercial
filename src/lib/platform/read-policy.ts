import type { PlatformRole } from '@/generated/prisma/client';
import { canPlatformRole } from '@/lib/platform/capabilities';

export type PlatformNavGroup = 'Operations' | 'Revenue' | 'Governance';

export const PLATFORM_READ_ROUTES = [
  {
    label: 'Control room',
    href: '/platform',
    capability: 'platform:overview:read',
    group: 'Operations',
  },
  {
    label: 'Organizations',
    href: '/platform/organizations',
    capability: 'organizations:read',
    group: 'Operations',
  },
  // DEV-905: the super admin's pharmacy approval queue. Approval is the lifecycle
  // transition to ACTIVE, which only `organizations:security:write` may run, so the
  // queue is shown only to those who can act on it.
  {
    label: 'Pharmacy approvals',
    href: '/platform/approvals',
    capability: 'organizations:security:write',
    group: 'Operations',
  },
  {
    label: 'Deployments',
    href: '/platform/deployments',
    capability: 'deployments:read',
    group: 'Operations',
  },
  {
    label: 'Support sessions',
    href: '/platform/support',
    capability: 'support:write',
    group: 'Operations',
  },
  { label: 'Jobs', href: '/platform/jobs', capability: 'jobs:read', group: 'Operations' },
  { label: 'Health', href: '/platform/health', capability: 'jobs:read', group: 'Operations' },
  { label: 'Sales CRM', href: '/platform/crm', capability: 'crm:read', group: 'Revenue' },
  {
    label: 'Commercial',
    href: '/platform/commercial',
    capability: 'commercial:read',
    group: 'Revenue',
  },
  {
    label: 'Modules & plans',
    href: '/platform/catalog',
    capability: 'catalog:read',
    group: 'Revenue',
  },
  {
    label: 'Operators',
    href: '/platform/operators',
    capability: 'operators:read',
    group: 'Governance',
  },
  {
    label: 'Audit ledger',
    href: '/platform/audit',
    capability: 'audit:read',
    group: 'Governance',
  },
  {
    label: 'Platform settings',
    href: '/platform/settings',
    capability: 'settings:read',
    group: 'Governance',
  },
] as const satisfies ReadonlyArray<{
  label: string;
  href: string;
  capability: string;
  group: PlatformNavGroup;
}>;

export type PlatformReadRoute = (typeof PLATFORM_READ_ROUTES)[number];
export type PlatformReadHref = PlatformReadRoute['href'];

export function platformReadHrefForPathname(pathname: string): PlatformReadHref | null {
  if (pathname === '/platform') return '/platform';
  return (
    PLATFORM_READ_ROUTES.find(
      (route) =>
        route.href !== '/platform' &&
        (pathname === route.href || pathname.startsWith(`${route.href}/`))
    )?.href ?? null
  );
}

export function canReadPlatformRoute(role: PlatformRole, href: PlatformReadHref): boolean {
  const route = PLATFORM_READ_ROUTES.find((candidate) => candidate.href === href);
  return Boolean(route && canPlatformRole(role, route.capability));
}

export function platformNavigationFor(role: PlatformRole): readonly PlatformReadRoute[] {
  return PLATFORM_READ_ROUTES.filter((route) => canPlatformRole(role, route.capability));
}

export function platformSafeFallback(role: PlatformRole): PlatformReadHref | null {
  return platformNavigationFor(role)[0]?.href ?? null;
}
