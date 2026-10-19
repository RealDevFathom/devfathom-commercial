import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  grants: new Set<string>(),
  can: vi.fn(),
  listInsightReports: vi.fn(),
  readInsightReport: vi.fn(),
  exportInsightReports: vi.fn(),
  importLabourCost: vi.fn(),
  listLabourCosts: vi.fn(),
  readLabourCost: vi.fn(),
  exportLabourCosts: vi.fn(),
  enqueueInsightBackfill: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/lib/restaurant/insights', async () => {
  const actual = await vi.importActual<typeof import('@/lib/restaurant/insights')>(
    '@/lib/restaurant/insights'
  );
  return {
    ...actual,
    listInsightReports: mocks.listInsightReports,
    readInsightReport: mocks.readInsightReport,
    exportInsightReports: mocks.exportInsightReports,
    importLabourCost: mocks.importLabourCost,
    listLabourCosts: mocks.listLabourCosts,
    readLabourCost: mocks.readLabourCost,
    exportLabourCosts: mocks.exportLabourCosts,
  };
});
vi.mock('@/lib/restaurant/insight-rollups', async () => {
  const actual = await vi.importActual<typeof import('@/lib/restaurant/insight-rollups')>(
    '@/lib/restaurant/insight-rollups'
  );
  return { ...actual, enqueueInsightBackfill: mocks.enqueueInsightBackfill };
});

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '../trpc';
import { restaurantInsightsRouter } from './restaurant-insights';

const db = {
  restaurantBranch: { findFirst: vi.fn() },
  restaurantStaffProfile: { findFirst: vi.fn() },
};

function caller() {
  return restaurantInsightsRouter.createCaller({
    db: db as unknown as ScopedDb,
    entitlements: {
      enabledModules: ['restaurant-insights'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
    },
    session: {
      expires: 'later',
      user: { id: 'user_1', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org_1' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.grants.clear();
  mocks.can.mockImplementation((_subject, action) =>
    Promise.resolve(mocks.grants.has(String(action)))
  );
  db.restaurantBranch.findFirst.mockResolvedValue({ id: 'branch_1' });
  db.restaurantStaffProfile.findFirst.mockResolvedValue({ primaryBranchId: 'branch_1' });
  mocks.listInsightReports.mockResolvedValue([
    { branchId: 'branch_1', orderCount: 2, coverCount: 4 },
  ]);
  mocks.listLabourCosts.mockResolvedValue([]);
  mocks.readLabourCost.mockResolvedValue({ id: 'labour_1', branchId: 'branch_1' });
  mocks.enqueueInsightBackfill.mockResolvedValue({ chunks: [], enqueued: 0, deduplicated: 0 });
});

describe('restaurant insights branch and capability guards', () => {
  it('allows ACTIVE staff to read only their primary branch', async () => {
    mocks.grants.add('reports:operational');
    const rows = await caller().listOperationalReports({ branchId: 'branch_1' });
    expect(rows).toEqual([{ branchId: 'branch_1', orderCount: 2, coverCount: 4 }]);
    expect(mocks.listInsightReports).toHaveBeenCalledWith(
      db,
      'operational',
      expect.objectContaining({ branchId: 'branch_1' })
    );
  });

  it('denies cross-branch and consolidated reads without restaurant:configure', async () => {
    mocks.grants.add('reports:operational');
    await expect(caller().listOperationalReports({ branchId: 'branch_2' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller().listOperationalReports({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.listInsightReports).not.toHaveBeenCalled();
  });

  it('denies a report-capable user without ACTIVE primary-branch or configure proof', async () => {
    mocks.grants.add('reports:financial');
    db.restaurantStaffProfile.findFirst.mockResolvedValue(null);
    await expect(caller().listFinancialReports({ branchId: 'branch_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('allows consolidated access only with restaurant:configure', async () => {
    mocks.grants.add('reports:financial');
    mocks.grants.add('restaurant:configure');
    await expect(caller().listFinancialReports({})).resolves.toHaveLength(1);
  });
});

describe('strict report inputs and payload boundary', () => {
  it('rejects unknown input keys', async () => {
    mocks.grants.add('reports:operational');
    await expect(
      caller().listOperationalReports({ branchId: 'branch_1', unknown: true } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('ordinary operational payload contains no labour data', async () => {
    mocks.grants.add('reports:operational');
    const [row] = await caller().listOperationalReports({ branchId: 'branch_1' });
    expect(row).not.toHaveProperty('labourCost');
    expect(row).not.toHaveProperty('labourHours');
  });
});

describe('labour dual-capability default deny', () => {
  it('requires reports:financial AND workforce:rates', async () => {
    mocks.grants.add('reports:financial');
    await expect(caller().listLabourCosts({ branchId: 'branch_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.listLabourCosts).not.toHaveBeenCalled();
  });

  it('allows labour reads only after both capabilities and branch proof', async () => {
    mocks.grants.add('reports:financial');
    mocks.grants.add('workforce:rates');
    await expect(caller().listLabourCosts({ branchId: 'branch_1' })).resolves.toEqual([]);
  });

  it('keeps read-by-id branch guarded after loading the fact', async () => {
    mocks.grants.add('reports:financial');
    mocks.grants.add('workforce:rates');
    db.restaurantStaffProfile.findFirst.mockResolvedValue({ primaryBranchId: 'branch_2' });
    await expect(caller().readLabourCost({ id: 'labour_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('backfill command', () => {
  it('is strict and configure-gated', async () => {
    mocks.grants.add('restaurant:configure');
    await expect(
      caller().backfill({ branchId: 'branch_1', from: '2026-01-01', to: '2026-01-02' })
    ).resolves.toMatchObject({ enqueued: 0 });
    await expect(
      caller().backfill({
        branchId: 'branch_1',
        from: '2026-01-01',
        to: '2026-01-02',
        extra: true,
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('fails closed before enqueue when the requested branch is tenant-invisible', async () => {
    mocks.grants.add('restaurant:configure');
    db.restaurantBranch.findFirst.mockResolvedValue(null);
    await expect(
      caller().backfill({ branchId: 'branch_other', from: '2026-01-01', to: '2026-01-02' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.enqueueInsightBackfill).not.toHaveBeenCalled();
  });
});
