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
  prepareClosePacket: vi.fn(),
  resolveCapabilityBranchAuthorization: vi.fn(),
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
vi.mock('@/lib/restaurant/close-readiness', async () => {
  const actual = await vi.importActual<typeof import('@/lib/restaurant/close-readiness')>(
    '@/lib/restaurant/close-readiness'
  );
  return { ...actual, prepareClosePacket: mocks.prepareClosePacket };
});
vi.mock('@/lib/restaurant/insight-rollups', async () => {
  const actual = await vi.importActual<typeof import('@/lib/restaurant/insight-rollups')>(
    '@/lib/restaurant/insight-rollups'
  );
  return { ...actual, enqueueInsightBackfill: mocks.enqueueInsightBackfill };
});
vi.mock('@/lib/restaurant/staff-branch-authorization', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/restaurant/staff-branch-authorization')
  >('@/lib/restaurant/staff-branch-authorization');
  return {
    ...actual,
    resolveCapabilityBranchAuthorization: mocks.resolveCapabilityBranchAuthorization,
  };
});

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { ClosePacketError } from '@/lib/restaurant/close-readiness';
import type { TRPCContext } from '../trpc';
import { restaurantInsightsRouter } from './restaurant-insights';

const db = {
  restaurantStaffProfile: { findFirst: vi.fn() },
  restaurantBranch: { findFirst: vi.fn() },
};

function caller(overrides: Partial<TRPCContext> = {}) {
  return restaurantInsightsRouter.createCaller({
    db: db as unknown as ScopedDb,
    entitlements: {
      organizationId: 'org_1',
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
    ...overrides,
  } as unknown as TRPCContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.grants.clear();
  mocks.can.mockImplementation((_subject, action) =>
    Promise.resolve(mocks.grants.has(String(action)))
  );
  mocks.resolveCapabilityBranchAuthorization.mockImplementation(async () => ({
    actorStaffProfileId: 'staff_1',
    actorBranchIds: ['branch_1', 'branch_2'],
    organizationWide: mocks.grants.has('restaurant:configure'),
    branchIds: mocks.grants.has('restaurant:configure')
      ? ['branch_1', 'branch_2']
      : ['branch_1'],
  }));
  db.restaurantStaffProfile.findFirst.mockResolvedValue({ primaryBranchId: 'branch_1' });
  db.restaurantBranch.findFirst.mockResolvedValue({ id: 'branch_1' });
  mocks.listInsightReports.mockResolvedValue([
    { branchId: 'branch_1', orderCount: 2, coverCount: 4 },
  ]);
  mocks.listLabourCosts.mockResolvedValue([]);
  mocks.readLabourCost.mockResolvedValue({ id: 'labour_1', branchId: 'branch_1' });
  mocks.enqueueInsightBackfill.mockResolvedValue({ chunks: [], enqueued: 0, deduplicated: 0 });
  mocks.prepareClosePacket.mockResolvedValue({ status: 'UNKNOWN', unattendedCloseReady: false });
});

describe('close packet query boundary', () => {
  const input = { branchId: 'branch_1', businessDate: '2026-09-11', asOf: '2026-09-12T12:00:00Z' };

  it.each(['reports:financial', 'reports:operational'])(
    'passes only server-checked access for %s, without AskFathom',
    async (capability) => {
      mocks.grants.add(capability);
      await expect(caller().prepareClosePacket(input)).resolves.toMatchObject({
        status: 'UNKNOWN',
      });
      expect(mocks.prepareClosePacket).toHaveBeenCalledWith(db, input, {
        organizationId: 'org_1',
        financial: capability === 'reports:financial',
        operational: capability === 'reports:operational',
        allowedRoutes: capability === 'reports:financial' ? ['reports'] : [],
      });
    }
  );

  it('requires authentication and at least one report permission', async () => {
    await expect(caller({ session: null }).prepareClosePacket(input)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(caller().prepareClosePacket(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.prepareClosePacket).not.toHaveBeenCalled();
  });

  it('rejects cross-branch and unresolved staff scope before the service', async () => {
    mocks.grants.add('reports:financial');
    await expect(
      caller().prepareClosePacket({ ...input, branchId: 'branch_2' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    mocks.resolveCapabilityBranchAuthorization.mockRejectedValueOnce({ code: 'FORBIDDEN' });
    await expect(caller().prepareClosePacket(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.resolveCapabilityBranchAuthorization).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: 'user_1' }),
      'reports:financial',
      { organizationId: 'org_1' }
    );
    expect(mocks.prepareClosePacket).not.toHaveBeenCalled();
  });

  it('permits configure-scoped branch review and existing route capabilities', async () => {
    for (const grant of [
      'reports:financial',
      'reports:operational',
      'restaurant:configure',
      'money:read',
      'orders:read',
    ])
      mocks.grants.add(grant);
    await caller().prepareClosePacket({ ...input, branchId: 'branch_2' });
    expect(mocks.prepareClosePacket).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ branchId: 'branch_2' }),
      expect.objectContaining({
        financial: true,
        operational: true,
        allowedRoutes: ['bills', 'drawers', 'closes', 'orders', 'reports'],
      })
    );
  });

  it.each([
    { organizationId: 'other_org' },
    { financial: true },
    { asOf: 'bad' },
    { businessDate: '2026-02-30' },
    { businessDate: '2026-9-1' },
    { branchId: '' },
  ])('rejects invalid or forged inputs %j', async (override) => {
    mocks.grants.add('reports:operational');
    await expect(
      caller().prepareClosePacket({ ...input, ...override } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.prepareClosePacket).not.toHaveBeenCalled();
  });

  it('maps service validation and branch errors without a mutation endpoint', async () => {
    mocks.grants.add('reports:financial');
    mocks.prepareClosePacket.mockRejectedValueOnce(
      new ClosePacketError('Branch not found.', 'NOT_FOUND')
    );
    await expect(caller().prepareClosePacket(input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    mocks.prepareClosePacket.mockRejectedValueOnce(new ClosePacketError('Future date.', 'INVALID'));
    await expect(caller().prepareClosePacket(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(restaurantInsightsRouter._def.procedures.prepareClosePacket._def.type).toBe('query');
  });
});

describe('restaurant insights branch and capability guards', () => {
  it('allows ACTIVE staff to read an effectively authorized branch', async () => {
    mocks.grants.add('reports:operational');
    const rows = await caller().listOperationalReports({ branchId: 'branch_1' });
    expect(rows).toEqual([{ branchId: 'branch_1', orderCount: 2, coverCount: 4 }]);
    expect(mocks.listInsightReports).toHaveBeenCalledWith(
      db,
      'operational',
      expect.objectContaining({ branchId: 'branch_1' })
    );
  });

  it('allows a report-capable manager to read an authorized secondary branch', async () => {
    mocks.grants.add('reports:operational');
    mocks.resolveCapabilityBranchAuthorization.mockResolvedValueOnce({
      actorStaffProfileId: 'staff_1',
      actorBranchIds: ['branch_1', 'branch_2'],
      organizationWide: false,
      branchIds: ['branch_1', 'branch_2'],
    });

    await expect(
      caller().listOperationalReports({ branchId: 'branch_2' })
    ).resolves.toHaveLength(1);
    expect(mocks.resolveCapabilityBranchAuthorization).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: 'user_1' }),
      'reports:operational',
      { organizationId: 'org_1' }
    );
    expect(mocks.listInsightReports).toHaveBeenCalledWith(
      db,
      'operational',
      expect.objectContaining({ branchId: 'branch_2' })
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
    mocks.resolveCapabilityBranchAuthorization.mockRejectedValueOnce({ code: 'FORBIDDEN' });
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
    mocks.resolveCapabilityBranchAuthorization.mockResolvedValueOnce({
      actorStaffProfileId: 'staff_1',
      actorBranchIds: ['branch_2'],
      organizationWide: false,
      branchIds: ['branch_2'],
    });
    await expect(caller().readLabourCost({ id: 'labour_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('backfill command', () => {
  it('is strict and configure-gated', async () => {
    mocks.grants.add('restaurant:configure');
    await expect(
      caller().backfill({
        branchId: 'branch_1',
        from: '2026-01-01',
        to: '2026-01-02',
        requestId: 'repair_1',
      })
    ).resolves.toMatchObject({ enqueued: 0 });
    await expect(
      caller().backfill({
        branchId: 'branch_1',
        from: '2026-01-01',
        to: '2026-01-02',
        requestId: 'repair_1',
        extra: true,
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
