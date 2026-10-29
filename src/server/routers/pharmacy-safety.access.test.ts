import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: () => true,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => false,
  recordTrpcAudit: vi.fn(),
}));

import type { TRPCContext } from '../trpc';
import { pharmacySafetyRouter } from './pharmacy-safety';

function caller(userId: string, organizationId: string, capabilities: readonly string[]) {
  const findUnique = vi.fn().mockResolvedValue({
    organizationRole: {
      permissions: capabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
    },
    permissionOverrides: [],
  });
  const context = {
    db: { user: { findUnique } },
    entitlements: { organizationId, modules: [] },
    session: {
      user: { id: userId, organizationId, role: 'EMPLOYEE', status: 'ACTIVE' },
    },
    requestMeta: { ip: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { access: pharmacySafetyRouter.createCaller(context).access, findUnique };
}

describe('pharmacy safety access discovery', () => {
  it.each([
    ['cashier', ['pharmacy:counter', 'pharmacy:orders'], ['pharmacy:counter']],
    ['pharmacist', ['pharmacy:dispense', 'pharmacy:catalogue-review'], ['pharmacy:dispense']],
    ['auditor', ['reports:operational'], ['reports:operational']],
    [
      'solo-owner',
      ['pharmacy:*', 'reports:operational', 'reports:financial'],
      [
        'pharmacy:counter',
        'pharmacy:inventory',
        'pharmacy:procurement',
        'reports:operational',
        'reports:financial',
      ],
    ],
  ])('derives the %s rail capabilities through ABAC', async (userId, grants, expected) => {
    const fixture = caller(userId as string, 'org-a', grants as string[]);

    await expect(fixture.access()).resolves.toEqual({
      userId,
      organizationId: 'org-a',
      capabilities: expected,
    });
    expect(fixture.findUnique).toHaveBeenCalledTimes(7);
    expect(fixture.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: userId } })
    );
  });

  it('binds the response to the authenticated identity and tenant', async () => {
    const fixture = caller('cashier-a', 'org-a', ['pharmacy:counter']);
    await expect(fixture.access()).resolves.toMatchObject({
      userId: 'cashier-a',
      organizationId: 'org-a',
    });
  });
});
