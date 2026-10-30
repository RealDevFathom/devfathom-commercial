import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => false,
  recordTrpcAudit: vi.fn(),
}));

import { router, type TRPCContext } from '../trpc';
import { pharmacySafetyRouter } from './pharmacy-safety';

// Keep the production namespace so the real module middleware runs for this path.
const appRouter = router({ pharmacySafety: pharmacySafetyRouter });

function caller(userId: string, organizationId: string, capabilities: readonly string[]) {
  const findUnique = vi.fn().mockResolvedValue({
    organizationRole: {
      permissions: capabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
    },
    permissionOverrides: [],
  });
  const context = {
    db: { user: { findUnique } },
    entitlements: {
      organizationId,
      vertical: 'PHARMACY',
      enabledModules: ['pharmacy-core', 'pharmacy-counter'],
      modules: [],
    },
    session: {
      user: { id: userId, organizationId, role: 'EMPLOYEE', status: 'ACTIVE' },
    },
    requestMeta: { ip: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { api: appRouter.createCaller(context).pharmacySafety, findUnique, context };
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

    await expect(fixture.api.access()).resolves.toEqual({
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
    await expect(fixture.api.access()).resolves.toMatchObject({
      userId: 'cashier-a',
      organizationId: 'org-a',
    });
  });

  it('discovers counter access without licensing Safety, while preserving the Safety gate', async () => {
    const fixture = caller('cashier', 'org-a', ['pharmacy:counter', 'pharmacy:safety']);
    await expect(fixture.api.access()).resolves.toMatchObject({
      capabilities: ['pharmacy:counter', 'pharmacy:safety'],
    });
    await expect(fixture.api.branches()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    fixture.context.entitlements.enabledModules = [];
    await expect(fixture.api.access()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('honors explicit denies over a role grant', async () => {
    const fixture = caller('cashier', 'org-a', ['pharmacy:counter']);
    fixture.findUnique.mockResolvedValue({
      organizationRole: { permissions: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }] },
      permissionOverrides: [{ capability: 'pharmacy:counter', effect: 'DENY' }],
    });
    await expect(fixture.api.access()).resolves.toMatchObject({ capabilities: [] });
  });
});
