import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  grants: new Set<string>(),
  modules: new Set<string>(),
  can: vi.fn(),
  overview: vi.fn(),
  payments: vi.fn(),
  financialComparison: vi.fn(),
  foodCost: vi.fn(),
  dishProfitability: vi.fn(),
  catering: vi.fn(),
  wastage: vi.fn(),
  stockMovements: vi.fn(),
  workforce: vi.fn(),
  exportCsv: vi.fn(),
  annotateAudit: vi.fn(),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/restaurant/financial-comparison', () => ({
  readFinancialComparison: mocks.financialComparison,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn((_entitlements, key: string) => mocks.modules.has(key)),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: mocks.recordTrpcAudit,
  annotateAudit: mocks.annotateAudit,
}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/restaurant/reports', async () => ({
  ...(await vi.importActual<typeof import('@/lib/restaurant/reports')>('@/lib/restaurant/reports')),
  readOverviewReport: mocks.overview,
  readPaymentsReport: mocks.payments,
  readFoodCostReport: mocks.foodCost,
  readDishProfitabilityReport: mocks.dishProfitability,
  readCateringReport: mocks.catering,
  readWastageReport: mocks.wastage,
  readStockMovementReport: mocks.stockMovements,
  readWorkforceReport: mocks.workforce,
  exportRestaurantReportCsv: mocks.exportCsv,
}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '../trpc';
import { restaurantReportsRouter } from './restaurant-reports';

const db = {
  restaurantBranch: { findMany: vi.fn() },
  restaurantStaffProfile: { findFirst: vi.fn() },
  restaurantBranchAssignment: { findMany: vi.fn() },
  restaurantStockLocation: { findFirst: vi.fn(), findMany: vi.fn() },
};
const input = { branchId: 'b1', from: '2026-01-01', to: '2026-01-02' };
function caller(organizationId = 'org1') {
  return restaurantReportsRouter.createCaller({
    db: db as unknown as ScopedDb,
    entitlements: {
      enabledModules: ['restaurant-core'],
      modules: [],
      activeSeats: 1,
      seatLimit: 1,
    },
    session: {
      expires: 'later',
      user: { id: 'u1', role: 'ADMIN', status: 'ACTIVE', organizationId },
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
  mocks.modules.clear();
  for (const key of [
    'restaurant-core',
    'restaurant-pos',
    'restaurant-menu',
    'restaurant-inventory',
    'restaurant-purchasing',
    'restaurant-workforce',
    'restaurant-sop',
  ])
    mocks.modules.add(key);
  mocks.can.mockImplementation((_subject, action) =>
    Promise.resolve(mocks.grants.has(String(action)))
  );
  db.restaurantStaffProfile.findFirst.mockResolvedValue({ primaryBranchId: 'b1' });
  db.restaurantBranchAssignment.findMany.mockResolvedValue([]);
  db.restaurantBranch.findMany.mockResolvedValue([{ id: 'b1', name: 'One' }]);
  db.restaurantStockLocation.findFirst.mockResolvedValue({ id: 'location-1' });
  db.restaurantStockLocation.findMany.mockResolvedValue([
    {
      id: 'location-1',
      name: 'Main',
      isActive: true,
      branch: { id: 'b1', name: 'One' },
    },
  ]);
  mocks.overview.mockResolvedValue({ orderCount: 1 });
  mocks.payments.mockResolvedValue({ netSales: '1.00' });
  mocks.financialComparison.mockResolvedValue({ moneyUnit: 'DECIMAL_MAJOR' });
  mocks.foodCost.mockResolvedValue({ totals: { theoreticalCost: '2.00' } });
  mocks.dishProfitability.mockResolvedValue({ menuEngineering: [] });
  mocks.catering.mockResolvedValue({ totals: { orderCount: 1 } });
  mocks.wastage.mockResolvedValue({ totals: { cost: '2.00' } });
  mocks.stockMovements.mockResolvedValue({ totals: { movementCount: 1 } });
  mocks.workforce.mockResolvedValue({ labourCostsVisible: true, labourCost: '10.00' });
  mocks.exportCsv.mockResolvedValue({
    filename: 'restaurant-workforce.csv',
    contentType: 'text/csv; charset=utf-8',
    content: 'scheduledShifts\n1',
  });
  mocks.annotateAudit.mockImplementation((ctx, detail) => {
    Object.assign(ctx.audit.detail, detail);
  });
});

describe('restaurant financialComparison query authorization', () => {
  it('passes through unavailable counted cash and the server discount-rate contract', async () => {
    mocks.grants.add('reports:financial');
    const report = {
      moneyUnit: 'DECIMAL_MAJOR',
      drivers: {
        cashCounted: {
          current: null,
          previous: '100.00',
          absoluteChange: null,
          percentageChange: null,
        },
      },
      cashCountCoverage: { current: { status: 'INCOMPLETE', missingCountSessionCount: 1 } },
      discountRate: {
        unit: 'PERCENT',
        current: '10.00',
        previous: null,
        percentagePointChange: null,
        unavailableReason: { previous: 'No observed closed branch-days.' },
      },
    };
    mocks.financialComparison.mockResolvedValueOnce(report);
    await expect(caller().financialComparison(input)).resolves.toEqual(report);
  });

  it('registers a financial query for an active primary branch using server tenant scope', async () => {
    mocks.grants.add('reports:financial');
    await expect(caller().financialComparison(input)).resolves.toEqual({
      moneyUnit: 'DECIMAL_MAJOR',
    });
    expect(mocks.financialComparison).toHaveBeenCalledWith(
      db,
      { branchIds: ['b1'], from: input.from, to: input.to },
      { organizationId: 'org1' }
    );
    expect(db.restaurantBranch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org1', id: { in: ['b1'] }, active: true },
      })
    );
  });

  it('supports explicit assignments and uses a second server organization', async () => {
    mocks.grants.add('reports:financial');
    db.restaurantStaffProfile.findFirst.mockResolvedValue(null);
    db.restaurantBranchAssignment.findMany.mockResolvedValue([{ branchId: 'b2' }]);
    db.restaurantBranch.findMany.mockResolvedValue([{ id: 'b2', name: 'Two' }]);
    await caller('org2').financialComparison({ ...input, branchId: 'b2' });
    expect(db.restaurantBranch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org2', id: { in: ['b2'] }, active: true },
      })
    );
    expect(mocks.financialComparison).toHaveBeenCalledWith(
      db,
      { branchIds: ['b2'], from: input.from, to: input.to },
      { organizationId: 'org2' }
    );
  });

  it('denies operational-only access before any branch or report read', async () => {
    mocks.grants.add('reports:operational');
    await expect(caller().financialComparison(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.restaurantBranch.findMany).not.toHaveBeenCalled();
    expect(mocks.financialComparison).not.toHaveBeenCalled();
  });

  it('denies when Restaurant POS is unavailable', async () => {
    mocks.grants.add('reports:financial');
    mocks.modules.delete('restaurant-pos');
    await expect(caller().financialComparison(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.financialComparison).not.toHaveBeenCalled();
  });

  it('denies all-branch access without configure permission', async () => {
    mocks.grants.add('reports:financial');
    await expect(
      caller().financialComparison({ from: input.from, to: input.to })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.financialComparison).not.toHaveBeenCalled();
  });

  it('allows configurators only the returned active branches', async () => {
    mocks.grants.add('reports:financial');
    mocks.grants.add('restaurant:configure');
    db.restaurantBranch.findMany.mockResolvedValue([
      { id: 'b1', name: 'One' },
      { id: 'b2', name: 'Two' },
    ]);
    await caller().financialComparison({ from: input.from, to: input.to });
    expect(mocks.financialComparison).toHaveBeenCalledWith(
      db,
      { branchIds: ['b1', 'b2'], from: input.from, to: input.to },
      { organizationId: 'org1' }
    );
    expect(db.restaurantBranch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org1', active: true } })
    );
  });

  it.each(['other-org-branch', 'inactive', 'unassigned'])(
    'denies unavailable branch %s without report data',
    async (branchId) => {
      mocks.grants.add('reports:financial');
      await expect(caller().financialComparison({ ...input, branchId })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(mocks.financialComparison).not.toHaveBeenCalled();
    }
  );

  it('rejects client organizationId instead of trusting it', async () => {
    mocks.grants.add('reports:financial');
    await expect(
      caller().financialComparison({ ...input, organizationId: 'org2' } as typeof input)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.financialComparison).not.toHaveBeenCalled();
  });

  it('maps service range errors to BAD_REQUEST', async () => {
    mocks.grants.add('reports:financial');
    const { RestaurantReportError } = await import('@/lib/restaurant/reports');
    mocks.financialComparison.mockRejectedValueOnce(
      new RestaurantReportError('Combined range exceeds 90 days.')
    );
    await expect(caller().financialComparison(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Combined range exceeds 90 days.',
    });
  });
});

describe('restaurant report capability and branch matrix', () => {
  it('audits an all-branch CSV export with server-resolved branch IDs', async () => {
    mocks.grants.add('reports:operational');
    mocks.grants.add('restaurant:configure');
    db.restaurantBranch.findMany.mockResolvedValue([
      { id: 'b2', name: 'Two' },
      { id: 'b1', name: 'One' },
    ]);

    await expect(
      caller().exportCsv({ from: input.from, to: input.to, section: 'overview' })
    ).resolves.toMatchObject({
      contentType: 'text/csv; charset=utf-8',
    });

    expect(mocks.recordTrpcAudit).toHaveBeenCalledTimes(1);
    expect(mocks.recordTrpcAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'exportCsv',
        type: 'query',
        outcome: 'SUCCESS',
        input: { from: input.from, to: input.to, section: 'overview' },
        ctx: expect.objectContaining({
          audit: {
            detail: {
              metadata: {
                branchIds: ['b2', 'b1'],
                section: 'overview',
                from: input.from,
                to: input.to,
              },
            },
          },
          session: expect.objectContaining({
            user: expect.objectContaining({ id: 'u1', organizationId: 'org1' }),
          }),
        }),
      })
    );
    expect(mocks.exportCsv).toHaveBeenCalledWith(
      db,
      'overview',
      { branchIds: ['b2', 'b1'], from: input.from, to: input.to },
      { includeLabourCosts: false }
    );
  });

  it('audits a single-branch CSV export with only its authorized resolved ID', async () => {
    mocks.grants.add('reports:operational');

    await expect(caller().exportCsv({ ...input, section: 'overview' })).resolves.toMatchObject({
      contentType: 'text/csv; charset=utf-8',
    });

    expect(mocks.recordTrpcAudit).toHaveBeenCalledTimes(1);
    expect(mocks.recordTrpcAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'SUCCESS',
        ctx: expect.objectContaining({
          audit: {
            detail: {
              metadata: {
                branchIds: ['b1'],
                section: 'overview',
                from: input.from,
                to: input.to,
              },
            },
          },
        }),
      })
    );
  });

  it('audits a denied cross-branch CSV export once without service calls or leaked data', async () => {
    mocks.grants.add('reports:operational');
    db.restaurantStaffProfile.findFirst.mockResolvedValue({ primaryBranchId: null });
    db.restaurantBranch.findMany.mockResolvedValue([]);

    const result = caller().exportCsv({ ...input, section: 'overview' });

    await expect(result).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.exportCsv).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
    expect(mocks.recordTrpcAudit).toHaveBeenCalledTimes(1);
    expect(mocks.recordTrpcAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'exportCsv',
        type: 'query',
        outcome: 'FAILURE',
        input: { ...input, section: 'overview' },
        ctx: expect.objectContaining({ audit: { detail: {} } }),
      })
    );
  });

  it('requires operational capability before any report query', async () => {
    await expect(caller().overview(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.overview).not.toHaveBeenCalled();
  });
  it('allows active primary and explicit assigned branches', async () => {
    mocks.grants.add('reports:operational');
    await expect(caller().overview(input)).resolves.toMatchObject({ orderCount: 1 });
    db.restaurantStaffProfile.findFirst.mockResolvedValue({ primaryBranchId: 'other' });
    db.restaurantBranchAssignment.findMany.mockResolvedValue([{ branchId: 'b1' }]);
    await expect(caller().overview(input)).resolves.toMatchObject({ orderCount: 1 });
  });
  it('denies cross-branch reads and allows configurators only for existing branches', async () => {
    mocks.grants.add('reports:operational');
    db.restaurantStaffProfile.findFirst.mockResolvedValue(null);
    db.restaurantBranch.findMany.mockResolvedValue([]);
    await expect(caller().overview(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    mocks.grants.add('restaurant:configure');
    db.restaurantBranch.findMany.mockResolvedValue([{ id: 'b1', name: 'One' }]);
    await expect(caller().overview(input)).resolves.toMatchObject({ orderCount: 1 });
    db.restaurantBranch.findMany.mockResolvedValue([]);
    await expect(caller().overview(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('keeps payments behind reports:financial', async () => {
    mocks.grants.add('reports:operational');
    await expect(caller().payments(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    mocks.grants.add('reports:financial');
    await expect(caller().payments(input)).resolves.toMatchObject({ netSales: '1.00' });
  });
  it('keeps food cost and dish profitability behind financial permission and every source module', async () => {
    mocks.grants.add('reports:financial');

    await expect(caller().foodCost(input)).resolves.toMatchObject({
      totals: { theoreticalCost: '2.00' },
    });
    await expect(caller().dishProfitability(input)).resolves.toMatchObject({
      menuEngineering: [],
    });
    expect(mocks.foodCost).toHaveBeenCalledWith(db, {
      branchIds: ['b1'],
      from: input.from,
      to: input.to,
    });

    for (const moduleKey of ['restaurant-pos', 'restaurant-menu', 'restaurant-inventory']) {
      mocks.modules.delete(moduleKey);
      await expect(caller().foodCost(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(caller().dishProfitability(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      mocks.modules.add(moduleKey);
    }
  });
  it('requires reports:financial plus catering:read for catering reads and identical-filter exports', async () => {
    mocks.grants.add('reports:financial');
    await expect(caller().catering(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.catering).not.toHaveBeenCalled();

    mocks.grants.add('catering:read');
    await expect(caller().catering(input)).resolves.toMatchObject({ totals: { orderCount: 1 } });
    await caller().exportCsv({ ...input, section: 'catering' });

    const resolved = { branchIds: ['b1'], from: input.from, to: input.to };
    expect(mocks.catering).toHaveBeenCalledWith(db, resolved);
    expect(mocks.exportCsv).toHaveBeenCalledWith(db, 'catering', resolved, {
      includeLabourCosts: false,
    });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          branchIds: ['b1'],
          section: 'catering',
          from: input.from,
          to: input.to,
        }),
      })
    );
  });
  it('denies POS-derived direct reads and exports when Restaurant POS is disabled', async () => {
    mocks.grants.add('reports:operational');
    mocks.grants.add('reports:financial');
    mocks.modules.delete('restaurant-pos');
    await expect(caller().overview(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().payments(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().exportCsv({ ...input, section: 'overview' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller().exportCsv({ ...input, section: 'payments' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.overview).not.toHaveBeenCalled();
    expect(mocks.payments).not.toHaveBeenCalled();
    expect(mocks.exportCsv).not.toHaveBeenCalled();
  });
  it('scopes stock-report reads and location options to an authorized branch', async () => {
    mocks.grants.add('reports:operational');
    const stockInput = { ...input, stockLocationId: 'location-1' };

    await expect(caller().wastage(stockInput)).resolves.toMatchObject({
      totals: { cost: '2.00' },
    });
    await expect(caller().stockMovements(stockInput)).resolves.toMatchObject({
      totals: { movementCount: 1 },
    });
    await expect(caller().stockLocations({ branchId: 'b1' })).resolves.toEqual([
      expect.objectContaining({ id: 'location-1', name: 'Main' }),
    ]);

    const resolved = {
      branchIds: ['b1'],
      from: input.from,
      to: input.to,
      stockLocationId: 'location-1',
    };
    expect(mocks.wastage).toHaveBeenCalledWith(db, resolved);
    expect(mocks.stockMovements).toHaveBeenCalledWith(db, resolved);
    expect(db.restaurantStockLocation.findFirst).toHaveBeenCalledWith({
      where: { id: 'location-1', branchId: { in: ['b1'] } },
      select: { id: true },
    });
  });

  it('fails closed for an out-of-scope stock location and disabled inventory module', async () => {
    mocks.grants.add('reports:operational');
    db.restaurantStockLocation.findFirst.mockResolvedValue(null);
    await expect(
      caller().wastage({ ...input, stockLocationId: 'other-location' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.wastage).not.toHaveBeenCalled();

    mocks.modules.delete('restaurant-inventory');
    await expect(caller().stockMovements(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().stockLocations({ branchId: 'b1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller().exportCsv({ ...input, section: 'wastage' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.stockMovements).not.toHaveBeenCalled();
    expect(mocks.exportCsv).not.toHaveBeenCalled();
  });

  it('exports stock reports with the same authorized location filter and audit evidence', async () => {
    mocks.grants.add('reports:operational');
    await caller().exportCsv({
      ...input,
      section: 'stock-movements',
      stockLocationId: 'location-1',
    });

    expect(mocks.exportCsv).toHaveBeenCalledWith(
      db,
      'stock-movements',
      {
        branchIds: ['b1'],
        from: input.from,
        to: input.to,
        stockLocationId: 'location-1',
      },
      { includeLabourCosts: false }
    );
    expect(mocks.recordTrpcAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          audit: {
            detail: {
              metadata: expect.objectContaining({ stockLocationId: 'location-1' }),
            },
          },
        }),
      })
    );
  });
  it('requires operational, financial, and workforce rates grants for labour costs', async () => {
    for (const missing of [
      'reports:operational',
      'reports:financial',
      'workforce:rates',
    ] as const) {
      mocks.grants.clear();
      for (const grant of ['reports:operational', 'reports:financial', 'workforce:rates']) {
        if (grant !== missing) mocks.grants.add(grant);
      }
      await expect(caller().workforceFinancial(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.workforce).not.toHaveBeenCalled();
    }

    mocks.grants.add('reports:operational');
    mocks.grants.add('reports:financial');
    mocks.grants.add('workforce:rates');
    await expect(caller().workforceFinancial(input)).resolves.toMatchObject({
      labourCostsVisible: true,
      labourCost: '10.00',
    });
    expect(mocks.workforce).toHaveBeenCalledWith(
      db,
      { branchIds: ['b1'], from: input.from, to: input.to },
      { includeLabourCosts: true }
    );
  });

  it('denies direct workforce reads and exports when Restaurant Workforce is disabled', async () => {
    mocks.grants.add('reports:operational');
    mocks.grants.add('reports:financial');
    mocks.grants.add('workforce:rates');
    mocks.modules.delete('restaurant-workforce');

    await expect(caller().workforce(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().workforceFinancial(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().exportCsv({ ...input, section: 'workforce' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.workforce).not.toHaveBeenCalled();
    expect(mocks.exportCsv).not.toHaveBeenCalled();
  });
});
