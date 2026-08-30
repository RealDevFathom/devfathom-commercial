import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  grants: new Set<string>(),
  can: vi.fn(),
  overview: vi.fn(),
  payments: vi.fn(),
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
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/restaurant/reports', async () => ({
  ...(await vi.importActual<typeof import('@/lib/restaurant/reports')>('@/lib/restaurant/reports')),
  readOverviewReport: mocks.overview,
  readPaymentsReport: mocks.payments,
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
  mocks.can.mockImplementation((_subject, action) =>
    Promise.resolve(mocks.grants.has(String(action)))
  );
  db.restaurantStaffProfile.findFirst.mockResolvedValue({ primaryBranchId: 'b1' });
  db.restaurantBranchAssignment.findMany.mockResolvedValue([]);
  db.restaurantBranch.findMany.mockResolvedValue([{ id: 'b1', name: 'One' }]);
  mocks.overview.mockResolvedValue({ orderCount: 1 });
  mocks.payments.mockResolvedValue({ netSales: '1.00' });
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
});
