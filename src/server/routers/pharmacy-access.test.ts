import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

import type { TRPCContext } from '../trpc';
import { pharmacyAccessRouter } from './pharmacy-access';

type Permission = { capability: string; effect: 'ALLOW' | 'DENY' };

function caller(overrides: Permission[], rolePermissions: Permission[]) {
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: { permissions: rolePermissions },
        permissionOverrides: overrides,
      }),
    },
  };

  return pharmacyAccessRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org-1',
      vertical: 'PHARMACY',
      enabledModules: ['pharmacy-core'],
      modules: [{ key: 'pharmacy-core', name: 'Pharmacy Core', enabled: true }],
    },
    session: {
      expires: 'later',
      user: {
        id: 'cashier-1',
        role: 'EMPLOYEE',
        status: 'ACTIVE',
        organizationId: 'org-1',
      },
    },
    organization: { id: 'org-1', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('pharmacyAccess.navigation', () => {
  it('returns only effective rail capabilities and applies DENY across rule sources', async () => {
    const navigation = await caller(
      [
        { capability: 'pharmacy:counter', effect: 'ALLOW' },
        { capability: 'pharmacy:procurement', effect: 'ALLOW' },
      ],
      [
        { capability: 'pharmacy:procurement', effect: 'DENY' },
        { capability: 'reports:operational', effect: 'ALLOW' },
      ]
    ).navigation();

    expect(navigation).toEqual(['pharmacy:counter', 'reports:operational']);
  });

  it('does not turn wildcard ALLOWs into exact-only dispense or safety grants', async () => {
    const navigation = await caller([], [
      { capability: 'pharmacy:*', effect: 'ALLOW' },
    ]).navigation();

    expect(navigation).toEqual([
      'pharmacy:counter',
      'pharmacy:procurement',
      'pharmacy:inventory',
      'pharmacy:orders',
    ]);
    expect(navigation).not.toContain('pharmacy:dispense');
    expect(navigation).not.toContain('pharmacy:safety');
  });
});
