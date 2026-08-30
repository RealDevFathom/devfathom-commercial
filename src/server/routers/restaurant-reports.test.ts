import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  grants: new Set<string>(),
  modules: new Set<string>(),
  can: vi.fn(),
  overview: vi.fn(),
  payments: vi.fn(),
  workforce: vi.fn(),
  exportCsv: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn((_entitlements, key: string) => mocks.modules.has(key)),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/restaurant/reports', async () => ({
  ...(await vi.importActual<typeof import('@/lib/restaurant/reports')>('@/lib/restaurant/reports')),
  readOverviewReport: mocks.overview,
  readPaymentsReport: mocks.payments,
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
};
const input = { branchId: 'b1', from: '2026-01-01', to: '2026-01-02' };
function caller() {
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
      user: { id: 'u1', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org1' },
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
  mocks.overview.mockResolvedValue({ orderCount: 1 });
  mocks.payments.mockResolvedValue({ netSales: '1.00' });
  mocks.workforce.mockResolvedValue({ labourCostsVisible: true, labourCost: '10.00' });
  mocks.exportCsv.mockResolvedValue({
    filename: 'restaurant-workforce.csv',
    contentType: 'text/csv; charset=utf-8',
    content: 'scheduledShifts\n1',
  });
});

describe('restaurant report capability and branch matrix', () => {
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
