import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: vi.fn(),
}));

import { can } from '@/lib/abac';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
const groupBy = vi.fn();
const db = {
  pharmacyBranch: { findMany: vi.fn().mockResolvedValue([{ id: 'branch-a' }]) },
  $executeRaw: vi.fn().mockResolvedValue(0),
  unfulfilledDemandEvent: { groupBy },
};
function caller() {
  return app.createCaller({
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'staff-a', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-a' },
    },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacySales;
}
beforeEach(() => {
  vi.mocked(can).mockReset().mockResolvedValue(false);
  groupBy.mockResolvedValue([
    {
      visitId: 'visit-a',
      visitType: 'WALK_OUT',
      outcome: 'WENT_ELSEWHERE',
      requestedMedicineId: 'medicine-a',
      requestedText: null,
      reason: 'STOCKOUT',
      _count: { _all: 1 },
      _sum: {
        quantity: 3,
        requestedQty: 3,
        estimatedValueMinor: 1300,
        estimatedMarginMinor: 100,
        estLossPkr: 13,
        lossProbability: 1,
      },
    },
  ]);
});
describe('demand financial permission', () => {
  it.each([false, true])(
    'redacts monetary aggregates unless reports:financial is granted (%s)',
    async (allowed) => {
      vi.mocked(can).mockResolvedValue(allowed);
      const result = await caller().demandAggregate({
        branchId: 'branch-a',
        from: new Date('2026-01-01'),
        to: new Date('2026-02-01'),
      });
      expect(can).toHaveBeenCalledWith(
        expect.anything(),
        'reports:financial',
        undefined,
        expect.objectContaining({ db, source: 'TRPC' })
      );
      expect(result.rows[0]?._sum).toMatchObject({
        quantity: 3,
        estimatedValueMinor: allowed ? 1300 : null,
        estimatedMarginMinor: allowed ? 100 : null,
        estLossPkr: allowed ? 13 : null,
      });
    }
  );
});
