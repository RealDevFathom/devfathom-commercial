import { describe, expect, it, vi, beforeEach } from 'vitest';

const read = vi.hoisted(() => vi.fn(async () => ({ alerts: [] })));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: vi.fn(),
  withPlatformDb: vi.fn(),
  createTenantDb: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => true,
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/lost-demand-procurement', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/lost-demand-procurement')>(
    '@/lib/pharmacy/lost-demand-procurement'
  )),
  loadLostDemandScopeAlerts: read,
}));

import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';
const app = router({ pharmacySales: pharmacySalesRouter });
const branchRead = vi.fn(async () => [{ id: 'b1' }]);
type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
function caller(grants: Rule[], modules = ['pharmacy-reports'], overrides: Rule[] = []) {
  return app.createCaller({
    db: {
      user: {
        findUnique: vi.fn(async () => ({
          organizationRole: { permissions: grants },
          permissionOverrides: overrides,
        })),
      },
      pharmacyBranch: { findMany: branchRead },
    },
    session: {
      expires: 'later',
      user: { id: 'cashier', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org' },
    },
    entitlements: { organizationId: 'org', enabledModules: modules, modules: [] },
    organization: { id: 'org', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacySales;
}
const allow = (capability: string): Rule => ({ capability, effect: 'ALLOW' });
beforeEach(() => vi.clearAllMocks());

describe('lost-demand operational report authorization', () => {
  it('refuses a counter-only cashier before reading branch or SKU data', async () => {
    await expect(
      caller([allow('pharmacy:counter')]).lostDemandAlerts({ branchId: 'b1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(branchRead).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
  it('honors an explicit report denial even with the solo-owner wildcard', async () => {
    await expect(
      caller(
        [allow('*')],
        ['pharmacy-reports'],
        [{ capability: 'reports:operational', effect: 'DENY' }]
      ).lostDemandAlerts({ branchId: 'b1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(read).not.toHaveBeenCalled();
  });
  it('licenses the read as reports without requiring counter and suppresses loss', async () => {
    await caller([allow('reports:operational')]).lostDemandAlerts({ branchId: 'b1' });
    expect(read).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: 'org', branchId: 'b1' }),
      { financial: false }
    );
  });
  it('refuses counter licensing when reports are disabled', async () => {
    await expect(
      caller([allow('*')], ['pharmacy-counter']).lostDemandAlerts({ branchId: 'b1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(read).not.toHaveBeenCalled();
  });
});
