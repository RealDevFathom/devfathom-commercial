import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { PlatformRole } from '@/generated/prisma/client';
import {
  canReadPlatformRoute,
  platformNavigationFor,
  platformReadHrefForPathname,
  platformSafeFallback,
  type PlatformReadHref,
} from '@/lib/platform/read-policy';

const roles = ['SUPER_ADMIN', 'OPERATIONS', 'SALES', 'FINANCE', 'SUPPORT', 'AUDITOR'] as const;
const routes = [
  '/platform',
  '/platform/support',
  '/platform/audit',
  '/platform/operators',
  '/platform/commercial',
  '/platform/crm',
  '/platform/settings',
  '/platform/organizations',
  '/platform/deployments',
  '/platform/jobs',
  '/platform/health',
  '/platform/catalog',
] as const satisfies readonly PlatformReadHref[];

const expected: Record<PlatformRole, readonly PlatformReadHref[]> = {
  SUPER_ADMIN: routes,
  OPERATIONS: [
    '/platform/support',
    '/platform/organizations',
    '/platform/deployments',
    '/platform/jobs',
    '/platform/health',
    '/platform/catalog',
  ],
  SALES: ['/platform/commercial', '/platform/crm', '/platform/organizations', '/platform/catalog'],
  FINANCE: [
    '/platform/commercial',
    '/platform/crm',
    '/platform/organizations',
    '/platform/catalog',
  ],
  SUPPORT: [
    '/platform/support',
    '/platform/organizations',
    '/platform/deployments',
    '/platform/jobs',
    '/platform/health',
    '/platform/catalog',
  ],
  AUDITOR: [
    '/platform/audit',
    '/platform/commercial',
    '/platform/crm',
    '/platform/organizations',
    '/platform/deployments',
    '/platform/jobs',
    '/platform/health',
    '/platform/catalog',
  ],
};

describe('platform read route policy', () => {
  it('gates health before invoking its shared data reader', () => {
    const source = readFileSync('src/app/platform/(console)/health/page.tsx', 'utf8');
    const gate = "await requirePlatformRead('/platform/health')";
    expect(source).toContain(gate);
    expect(source.indexOf(gate)).toBeLessThan(source.indexOf('await readPlatformHealth('));
  });

  it.each([
    ['/platform', '/platform'],
    ['/platform/organizations', '/platform/organizations'],
    ['/platform/organizations/org-1', '/platform/organizations'],
    ['/platform/health', '/platform/health'],
    ['/platform/login', null],
    ['/platform/not-a-declared-route', null],
  ] as const)('maps %s to its declared read route', (pathname, href) => {
    expect(platformReadHrefForPathname(pathname)).toBe(href);
  });

  it.each(roles)('%s receives exactly its capability-backed routes', (role) => {
    for (const route of routes) {
      expect(canReadPlatformRoute(role, route), `${role} -> ${route}`).toBe(
        expected[role].includes(route)
      );
    }
    expect(
      platformNavigationFor(role)
        .map((route) => route.href)
        .sort()
    ).toEqual([...expected[role]].sort());
  });

  it.each([
    ['SUPER_ADMIN', '/platform'],
    ['OPERATIONS', '/platform/organizations'],
    ['SALES', '/platform/organizations'],
    ['FINANCE', '/platform/organizations'],
    ['SUPPORT', '/platform/organizations'],
    ['AUDITOR', '/platform/organizations'],
  ] as const)('%s has a deterministic safe fallback', (role, fallback) => {
    expect(platformSafeFallback(role)).toBe(fallback);
  });

  it.each([
    ['src/app/platform/(console)/page.tsx', '/platform'],
    ['src/app/platform/(console)/audit/page.tsx', '/platform/audit'],
    ['src/app/platform/(console)/operators/page.tsx', '/platform/operators'],
    ['src/app/platform/(console)/commercial/page.tsx', '/platform/commercial'],
    ['src/app/platform/(console)/crm/page.tsx', '/platform/crm'],
    ['src/app/platform/(console)/settings/page.tsx', '/platform/settings'],
    ['src/app/platform/(console)/organizations/page.tsx', '/platform/organizations'],
    ['src/app/platform/(console)/organizations/new/page.tsx', '/platform/organizations'],
    ['src/app/platform/(console)/organizations/[id]/page.tsx', '/platform/organizations'],
    ['src/app/platform/(console)/deployments/page.tsx', '/platform/deployments'],
    ['src/app/platform/(console)/jobs/page.tsx', '/platform/jobs'],
    ['src/app/platform/(console)/catalog/page.tsx', '/platform/catalog'],
  ] as const)('%s enforces read access before querying platform data', (file, href) => {
    const source = readFileSync(file, 'utf8');
    const gate = `await requirePlatformRead('${href}')`;
    expect(source).toContain(gate);
    expect(source.indexOf(gate)).toBeLessThan(source.indexOf('withPlatformDb('));
  });
});
