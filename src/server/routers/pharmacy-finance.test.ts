import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  branchFindMany: vi.fn(),
  branchFindFirst: vi.fn(),
  reportFindFirst: vi.fn(),
  reportFindMany: vi.fn(),
  reportUpdate: vi.fn(),
  settingUpsert: vi.fn(),
  transaction: vi.fn(),
  comparison: vi.fn(),
}));
vi.mock('@/lib/pharmacy/finance-reports', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/finance-reports')>(
    '@/lib/pharmacy/finance-reports'
  )),
  grossMarginComparison: mocks.comparison,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import type { TRPCContext } from '../trpc';
import { pharmacyFinanceRouter } from './pharmacy-finance';

function caller(role = 'ADMIN') {
  return pharmacyFinanceRouter.createCaller({
    db: {
      $transaction: mocks.transaction,
      pharmacyBranch: { findMany: mocks.branchFindMany, findFirst: mocks.branchFindFirst },
      pharmacyPharmacovigilanceReport: {
        findFirst: mocks.reportFindFirst,
        findMany: mocks.reportFindMany,
        update: mocks.reportUpdate,
      },
      pharmacyOwnerDigestSetting: { upsert: mocks.settingUpsert },
    },
    entitlements: {
      organizationId: 'org_1',
      enabledModules: ['pharmacy-reports'],
      modules: [],
    },
    session: {
      expires: 'later',
      user: { id: 'user_admin', role, status: 'ACTIVE', organizationId: 'org_1' },
    },
    organization: { id: 'org_1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

import { hasModule } from '@/lib/entitlements';
const input = { branchId: 'branch_1', from: '2026-09-01T00:00:00Z', to: '2026-09-03T00:00:00Z' };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.can.mockResolvedValue(true);
  vi.mocked(hasModule).mockReturnValue(true);
  mocks.branchFindFirst.mockResolvedValue({ id: 'branch_1' });
  mocks.transaction.mockImplementation(async (callback) => callback({ ledger: true }));
  mocks.comparison.mockResolvedValue({ differenceMinor: 42 });
});
describe('finance comparison boundary', () => {
  it('requires ADMIN plus operational and financial capability', async () => {
    await caller().marginComparison(input);
    expect(mocks.can.mock.calls.map((call) => call[1])).toEqual([
      'admin:access',
      'reports:operational',
      'reports:financial',
    ]);
  });
  it.each([0, 1, 2])('denies failed capability %i before branch reads', async (index) => {
    mocks.can.mockImplementation(
      async (_subject, action) =>
        action !== ['admin:access', 'reports:operational', 'reports:financial'][index]
    );
    await expect(caller().marginComparison(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.branchFindFirst).not.toHaveBeenCalled();
    expect(mocks.comparison).not.toHaveBeenCalled();
  });
  it('enforces owner role even when capability mock allows', async () => {
    await expect(caller('EMPLOYEE').marginComparison(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.comparison).not.toHaveBeenCalled();
  });
  it('requires Pharmacy reports entitlement', async () => {
    vi.mocked(hasModule).mockReturnValue(false);
    await expect(caller().marginComparison(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.branchFindFirst).not.toHaveBeenCalled();
  });
  it('rejects foreign, inactive or absent branch', async () => {
    mocks.branchFindFirst.mockResolvedValue(null);
    await expect(caller().marginComparison(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.branchFindFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', id: 'branch_1', active: true },
      select: { id: true },
    });
    expect(mocks.comparison).not.toHaveBeenCalled();
  });
  it('passes tenant-scoped arguments to the single-statement read', async () => {
    await expect(caller().marginComparison(input)).resolves.toEqual({ differenceMinor: 42 });
    expect(mocks.comparison).toHaveBeenCalledWith(
      expect.objectContaining({ pharmacyBranch: expect.any(Object) }),
      { organizationId: 'org_1', branchId: 'branch_1' },
      { from: new Date(input.from), to: new Date(input.to) }
    );
  });
  it.each([
    { from: '2026-09-01' },
    { to: '2027-09-01T00:00:00Z' },
    { to: input.from },
    { branchId: '' },
  ])('rejects invalid bounds/scope %j', async (change) => {
    await expect(caller().marginComparison({ ...input, ...change })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.comparison).not.toHaveBeenCalled();
  });
});
