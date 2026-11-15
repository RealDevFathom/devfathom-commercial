import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

const mocks = vi.hoisted(() => ({
  repeatRead: vi.fn().mockResolvedValue({ horizons: [] }),
  can: vi.fn<typeof import('@/lib/abac').can>(async () => false),
  branchFindMany: vi.fn(),
  supplierFindMany: vi.fn(),
  settingUpsert: vi.fn(),
  userFindUnique: vi.fn(),
  branchFindFirst: vi.fn(),
  assignmentFindMany: vi.fn(),
  userFindFirst: vi.fn(),
  userCount: vi.fn(),
  credentialFindFirst: vi.fn(),
  credentialUpdate: vi.fn(),
  verifyPin: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  auditCreate: vi.fn(),
  reportFindFirst: vi.fn(),
  reportFindMany: vi.fn(),
  reportCreate: vi.fn(),
  reportUpdate: vi.fn(),
  reportUpdateManyAndReturn: vi.fn(),
  stockDashboard: vi.fn(),
  stockDigest: vi.fn(),
  anomalyRead: vi.fn(),
  expiryRead: vi.fn(),
  returnsRead: vi.fn(),
  creditsRead: vi.fn(),
  refresh: vi.fn(),
  createDraft: vi.fn(),
  comparisonRead: vi.fn(),
  comparisonTx: {},
  transaction: vi.fn(),
  saleFindMany: vi.fn(),
}));
vi.mock('@/lib/pharmacy/branch-comparison', () => ({
  readPharmacyBranchComparison: mocks.comparisonRead,
}));

vi.mock('@/lib/restaurant/operator-credentials', async () => ({
  ...(await vi.importActual<typeof import('@/lib/restaurant/operator-credentials')>(
    '@/lib/restaurant/operator-credentials'
  )),
  verifyOperatorCredential: mocks.verifyPin,
}));

vi.mock('@/lib/pharmacy/stock-signals-operations', () => ({
  roleDashboard: mocks.stockDashboard,
  ownerDigest: mocks.stockDigest,
  refreshStockSignals: mocks.refresh,
  createDraftAction: mocks.createDraft,
}));
vi.mock('@/lib/pharmacy/anomaly-signals-operations', () => ({
  readPharmacyAnomalySignals: mocks.anomalyRead,
  refreshPharmacyAnomalySignals: mocks.refresh,
  acknowledgePharmacyAnomalySignal: vi.fn(),
  snoozePharmacyAnomalySignal: vi.fn(),
}));
vi.mock('@/lib/pharmacy/expiry-advisor-operations', () => ({
  readExpiryAdvice: mocks.expiryRead,
  proposeExpiryReturn: mocks.createDraft,
}));
vi.mock('@/lib/pharmacy/purchasing-console', () => ({
  listPurchaseReturns: mocks.returnsRead,
  listSupplierCredits: mocks.creditsRead,
}));

vi.mock('@/lib/pharmacy/repeat-purchasing', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/repeat-purchasing')>(
    '@/lib/pharmacy/repeat-purchasing'
  )),
  readRepeatPurchasing: mocks.repeatRead,
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

import { hasModule } from '@/lib/entitlements';
import type { TRPCContext } from '../trpc';
import { pharmacyReportsRouter } from './pharmacy-reports';

function context(role = 'ADMIN', audit: TRPCContext['audit'] = { detail: {} }) {
  const db = {
    $queryRaw: mocks.queryRaw,
    $executeRaw: mocks.executeRaw,
    auditLog: { create: mocks.auditCreate },
    user: {
      findFirst: mocks.userFindFirst,
      findUnique: mocks.userFindUnique,
      count: mocks.userCount,
    },
    pharmacyBranchAssignment: { findMany: mocks.assignmentFindMany },
    restaurantOperatorCredential: {
      findFirst: mocks.credentialFindFirst,
      update: mocks.credentialUpdate,
    },
    pharmacyBranch: { findMany: mocks.branchFindMany, findFirst: mocks.branchFindFirst },
    pharmacySupplier: { findMany: mocks.supplierFindMany },
    pharmacyPharmacovigilanceReport: {
      findFirst: mocks.reportFindFirst,
      findMany: mocks.reportFindMany,
      create: mocks.reportCreate,
      update: mocks.reportUpdate,
      updateManyAndReturn: mocks.reportUpdateManyAndReturn,
    },
    pharmacyOwnerDigestSetting: { upsert: mocks.settingUpsert },
    pharmacySale: { findMany: mocks.saleFindMany },
  };
  // Interactive transactions run against the same mocked client delegates.
  Object.assign(mocks.comparisonTx, db);
  return {
    db: { ...db, $transaction: mocks.transaction },
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
    audit,
  } as unknown as TRPCContext;
}

function caller(role = 'ADMIN', audit: TRPCContext['audit'] = { detail: {} }) {
  return pharmacyReportsRouter.createCaller(context(role, audit));
}

function pvCaller() {
  mocks.branchFindFirst.mockResolvedValue({ id: 'branch_1' });
  return caller();
}

describe('normal Reports daily work pack', () => {
  const input = { from: '2026-09-01', to: '2026-09-10', asOf: '2026-09-11T00:00:00Z' };
  beforeEach(() => {
    mocks.can.mockResolvedValue(true);
    vi.mocked(hasModule).mockImplementation(
      (_entitlements, module) => module === 'pharmacy-reports'
    );
    mocks.branchFindMany.mockResolvedValue([{ id: 'branch_1', name: 'Main' }]);
    mocks.stockDashboard.mockResolvedValue([]);
    mocks.stockDigest.mockImplementation(async (_db, scope, actorId) => ({
      branchId: scope.branchId,
      ownerUserId: actorId,
      overdue: [],
      dueSoon: [],
      stale: [],
      resuming: [],
    }));
    mocks.anomalyRead.mockResolvedValue([]);
    mocks.expiryRead.mockResolvedValue([]);
    mocks.returnsRead.mockResolvedValue([]);
    mocks.creditsRead.mockResolvedValue([]);
  });

  it('works with Ask Fathom disabled and repeated normal caller reads create zero actions', async () => {
    const api = caller();
    const first = await api.dailyWorkPack(input);
    const second = await api.dailyWorkPack(input);
    expect(first.sources).toHaveLength(5);
    expect(second.sources).toHaveLength(5);
    expect(first.permissions.financial).toBe(true);
    expect(first.sources.every((source) => source.status === 'available')).toBe(true);
    expect(mocks.branchFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org_1', active: true } })
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.createDraft).not.toHaveBeenCalled();
    expect(mocks.settingUpsert).not.toHaveBeenCalled();
    expect(mocks.reportUpdate).not.toHaveBeenCalled();
    expect(vi.mocked(hasModule).mock.calls.every((call) => call[1] === 'pharmacy-reports')).toBe(
      true
    );
  });

  it('returns only operational sources when financial permission is denied', async () => {
    mocks.can.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const pack = await caller().dailyWorkPack(input);
    expect(pack.sources.map((source) => source.kind)).toEqual(['stock-dashboard', 'stock-digest']);
    for (const read of [mocks.anomalyRead, mocks.expiryRead, mocks.returnsRead, mocks.creditsRead])
      expect(read).not.toHaveBeenCalled();
    expect(JSON.stringify(pack)).not.toMatch(/Minor|currency|supplier-credit|anomalies/);
  });

  it('preserves the existing owner gate even when a non-owner has financial capability', async () => {
    const pack = await caller('EMPLOYEE').dailyWorkPack(input);
    expect(pack.permissions.financial).toBe(false);
    expect(mocks.anomalyRead).not.toHaveBeenCalled();
    expect(mocks.expiryRead).not.toHaveBeenCalled();
    expect(mocks.returnsRead).not.toHaveBeenCalled();
  });

  it('denies operational permission before any branch or source reads', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().dailyWorkPack(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.branchFindMany).not.toHaveBeenCalled();
    expect(mocks.stockDashboard).not.toHaveBeenCalled();
  });

  it('denies the disabled Reports module before branch or source reads', async () => {
    vi.mocked(hasModule).mockReturnValue(false);
    await expect(caller().dailyWorkPack(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.branchFindMany).not.toHaveBeenCalled();
    expect(mocks.stockDashboard).not.toHaveBeenCalled();
  });

  it.each(['outside_branch', 'foreign_tenant_branch'])(
    'denies unauthorized branch %s before source reads',
    async (branchId) => {
      await expect(caller().dailyWorkPack({ ...input, branchId })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(mocks.stockDashboard).not.toHaveBeenCalled();
      expect(mocks.anomalyRead).not.toHaveBeenCalled();
    }
  );

  it.each([
    { from: '2026-02-30' },
    { from: '2026-09-12' },
    { asOf: '2099-01-01T00:00:00Z' },
    { organizationId: 'foreign' },
    { financial: true },
  ])('rejects invalid or client-controlled server scope: %j', async (overrides) => {
    await expect(caller().dailyWorkPack({ ...input, ...overrides })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.stockDashboard).not.toHaveBeenCalled();
  });

  it('returns partial source failure through the normal caller without raw error disclosure', async () => {
    mocks.anomalyRead.mockRejectedValue(new Error('private_user database password'));
    const pack = await caller().dailyWorkPack(input);
    expect(pack.completeness).toMatchObject({ status: 'partial', allClear: false });
    expect(pack.sources.find((source) => source.kind === 'anomalies')!.status).toBe('unavailable');
    expect(JSON.stringify(pack)).not.toContain('password');
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.branchFindFirst.mockReset();
  mocks.transaction.mockImplementation((run) => run(mocks.comparisonTx));
});

describe('pharmacy administrator report bootstrap (#434)', () => {
  beforeEach(() => {
    mocks.can.mockResolvedValue(true);
    mocks.branchFindMany.mockResolvedValue([{ id: 'branch_1', name: 'Main' }]);
    mocks.userFindUnique.mockResolvedValue({ preferences: null });
  });

  it('loads branches, catalog and preferences through the shared operational grant', async () => {
    const api = caller();

    await expect(api.branches()).resolves.toMatchObject({
      organizationId: 'org_1',
      branches: [{ id: 'branch_1', name: 'Main' }],
    });
    await expect(api.catalog()).resolves.toMatchObject({
      permissions: { operational: true, financial: true },
    });
    await expect(api.getPreferences()).resolves.toMatchObject({ version: 1 });

    expect(mocks.can).toHaveBeenCalledTimes(4);
    expect(mocks.can.mock.calls.filter((call) => call[1] === 'reports:operational')).toHaveLength(
      3
    );
  });
});

describe('pharmacyReports.branches role scope (DEV-20)', () => {
  beforeEach(() => {
    vi.mocked(hasModule).mockReturnValue(true);
    mocks.branchFindMany.mockResolvedValue([{ id: 'branch_1', name: 'Main' }]);
  });

  it('gives an operational-report holder every active branch of the organization', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'reports:operational');
    await expect(caller().branches()).resolves.toEqual({
      organizationId: 'org_1',
      branches: [{ id: 'branch_1', name: 'Main' }],
    });
    expect(mocks.branchFindMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    expect(mocks.assignmentFindMany).not.toHaveBeenCalled();
  });

  it.each(['cashier', 'pharmacist', 'procurement manager'])(
    'gives a %s only the active branches they are assigned to, never an error',
    async () => {
      mocks.can.mockResolvedValue(false);
      mocks.assignmentFindMany.mockResolvedValue([{ branchId: 'branch_1' }]);
      await expect(caller('EMPLOYEE').branches()).resolves.toEqual({
        organizationId: 'org_1',
        branches: [{ id: 'branch_1', name: 'Main' }],
      });
      expect(mocks.assignmentFindMany).toHaveBeenCalledWith({
        where: { organizationId: 'org_1', userId: 'user_admin', active: true },
        select: { branchId: true },
      });
      expect(mocks.branchFindMany).toHaveBeenCalledWith({
        where: { organizationId: 'org_1', active: true, id: { in: ['branch_1'] } },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      });
    }
  );

  it('returns an empty list for an unassigned member without reading branches', async () => {
    mocks.can.mockResolvedValue(false);
    mocks.assignmentFindMany.mockResolvedValue([]);
    await expect(caller('EMPLOYEE').branches()).resolves.toEqual({
      organizationId: 'org_1',
      branches: [],
    });
    expect(mocks.branchFindMany).not.toHaveBeenCalled();
  });

  it('gives a session from another organization nothing, even with the operational grant', async () => {
    mocks.can.mockResolvedValue(true);
    const ctx = context();
    ctx.session!.user.organizationId = 'org_foreign';
    await expect(pharmacyReportsRouter.createCaller(ctx).branches()).resolves.toEqual({
      organizationId: 'org_1',
      branches: [],
    });
    expect(mocks.can).not.toHaveBeenCalled();
    expect(mocks.assignmentFindMany).not.toHaveBeenCalled();
    expect(mocks.branchFindMany).not.toHaveBeenCalled();
  });

  it('refuses a cashier saving the command-centre layout on the server', async () => {
    mocks.can.mockImplementation(async (_subject, action) =>
      ['pharmacy:counter', 'pharmacy:orders'].includes(action)
    );
    const { pharmacyDashboardDefault } = await import('@/lib/pharmacy/dashboard');
    await expect(
      caller('EMPLOYEE').updatePreferences(pharmacyDashboardDefault('EMPLOYEE'))
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
  });

  it('still refuses a workspace without Pharmacy Reports before any read', async () => {
    vi.mocked(hasModule).mockReturnValue(false);
    mocks.can.mockResolvedValue(true);
    await expect(caller().branches()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.branchFindMany).not.toHaveBeenCalled();
    expect(mocks.assignmentFindMany).not.toHaveBeenCalled();
  });
});

describe('Reports supplier filter names', () => {
  beforeEach(() => {
    mocks.can.mockResolvedValue(true);
    vi.mocked(hasModule).mockReturnValue(true);
    mocks.branchFindMany.mockResolvedValue([{ id: 'branch_1', name: 'Main' }]);
    mocks.supplierFindMany.mockResolvedValue([{ id: 'sup1', name: 'Acme Distribution' }]);
  });
  afterEach(() => {
    vi.mocked(hasModule).mockReturnValue(true);
  });

  it('reads only names and filter IDs from the authenticated tenant in name order', async () => {
    await expect(caller().suppliers()).resolves.toEqual([
      { id: 'sup1', name: 'Acme Distribution' },
    ]);
    expect(mocks.supplierFindMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_1' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
  });

  it('denies supplier lookup before reading names without Reports permission', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().suppliers()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.supplierFindMany).not.toHaveBeenCalled();
  });

  it('denies supplier lookup before reading names when Reports is not licensed', async () => {
    vi.mocked(hasModule).mockReturnValue(false);
    await expect(caller().suppliers()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.supplierFindMany).not.toHaveBeenCalled();
  });
});

describe('pharmacy owner digest capability boundary', () => {
  it('allows an owner with reports:financial and passes only active tenant branches', async () => {
    mocks.can.mockResolvedValue(true);
    mocks.branchFindMany.mockResolvedValue([
      { id: 'branch_2', name: 'Second' },
      { id: 'branch_1', name: 'Main' },
    ]);
    mocks.comparisonRead.mockResolvedValue({ rows: [] });

    await expect(
      caller().branchComparison({ from: '2026-10-01', to: '2026-10-07' })
    ).resolves.toEqual({ rows: [] });

    expect(mocks.can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user_admin' }),
      'reports:financial',
      undefined,
      expect.objectContaining({ source: 'TRPC' })
    );
    expect(mocks.branchFindMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    expect(mocks.comparisonRead).toHaveBeenCalledWith(
      mocks.comparisonTx,
      expect.objectContaining({
        branches: [
          { id: 'branch_2', name: 'Second' },
          { id: 'branch_1', name: 'Main' },
        ],
        from: '2026-10-01',
        to: '2026-10-07',
      })
    );
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });

  it('returns the empty comparison for an authorized owner with no active branches', async () => {
    mocks.can.mockResolvedValue(true);
    mocks.branchFindMany.mockResolvedValue([]);
    mocks.comparisonRead.mockResolvedValue({ rows: [] });

    await expect(
      caller().branchComparison({ from: '2026-10-01', to: '2026-10-07' })
    ).resolves.toEqual({ rows: [] });
    expect(mocks.comparisonRead).toHaveBeenCalledWith(mocks.comparisonTx, {
      branches: [],
      from: '2026-10-01',
      to: '2026-10-07',
    });
  });

  it.each([
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-10-07', to: '2026-10-01' },
    { from: '2026-01-01', to: '2026-04-01' },
    { from: '2026-10-01', to: '2026-10-07', branchId: 'foreign' },
    { from: '2026-10-01', to: '2026-10-07', organizationId: 'foreign' },
  ])('rejects invalid comparison filters before data access: %j', async (input) => {
    mocks.can.mockResolvedValue(true);
    await expect(caller().branchComparison(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.branchFindMany).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.comparisonRead).not.toHaveBeenCalled();
  });

  it('sanitizes unexpected comparison failures in production transport responses', async () => {
    mocks.can.mockResolvedValue(true);
    mocks.branchFindMany.mockResolvedValue([{ id: 'branch_1', name: 'Main' }]);
    const internalMessage = 'private database host and password';
    mocks.comparisonRead.mockRejectedValueOnce(new Error(internalMessage));
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const input = encodeURIComponent(
        JSON.stringify({ json: { from: '2026-10-01', to: '2026-10-07' } })
      );
      const response = await fetchRequestHandler({
        endpoint: '/trpc',
        req: new Request(`http://localhost/trpc/branchComparison?input=${input}`),
        router: pharmacyReportsRouter,
        createContext: async () => context(),
      });
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toContain('INTERNAL_SERVER_ERROR');
      expect(body).not.toContain(internalMessage);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('denies branch comparison without financial permission before data access', async () => {
    mocks.can.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      caller().branchComparison({ from: '2026-10-01', to: '2026-10-07' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.branchFindMany).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.comparisonRead).not.toHaveBeenCalled();
  });

  it('denies branch comparison to a non-owner even with financial capability', async () => {
    mocks.can.mockResolvedValue(true);
    mocks.branchFindMany.mockResolvedValue([{ id: 'branch_1', name: 'Main' }]);
    await expect(
      caller('EMPLOYEE').branchComparison({ from: '2026-10-01', to: '2026-10-07' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.comparisonRead).not.toHaveBeenCalled();
  });
  it('denies digest reads without reports:financial before tenant data access', async () => {
    mocks.can.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(caller().digestOverview()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user_admin' }),
      'reports:financial',
      undefined,
      expect.objectContaining({ source: 'TRPC' })
    );
    expect(mocks.branchFindMany).not.toHaveBeenCalled();
  });

  it('denies digest setting writes without reports:financial before tenant data access', async () => {
    mocks.can.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      caller().updateDigestSetting({ branchId: 'branch_1', enabled: true, time: '08:00' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user_admin' }),
      'reports:financial',
      undefined,
      expect.objectContaining({ source: 'TRPC' })
    );
    expect(mocks.branchFindMany).not.toHaveBeenCalled();
    expect(mocks.settingUpsert).not.toHaveBeenCalled();
  });

  it('denies anomaly reads without reports:financial before tenant data access', async () => {
    mocks.can.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      caller().anomalySignals({ from: '2026-09-01', to: '2026-09-04' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.branchFindMany).not.toHaveBeenCalled();
  });

  it('denies anomaly decisions without reports:financial before tenant data access', async () => {
    mocks.can.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      caller().acknowledgeAnomaly({ branchId: 'branch_1', signalId: 'sig_1', reason: 'Reviewed' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.branchFindMany).not.toHaveBeenCalled();
  });

  it('denies expiry advice and proposal without reports:financial before tenant data access', async () => {
    mocks.can.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      caller().expiryAdvice({ from: '2026-09-01', to: '2026-09-04' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.branchFindMany).not.toHaveBeenCalled();

    mocks.can.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      caller().proposeExpiryReturn({ branchId: 'branch_1', lotId: 'lot_1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.branchFindMany).not.toHaveBeenCalled();
  });

  it('scopes expiry advice and proposals to the server-resolved tenant and owner branch', async () => {
    mocks.can.mockResolvedValue(true);
    mocks.branchFindMany.mockResolvedValue([{ id: 'branch_1', name: 'Main' }]);
    mocks.expiryRead.mockResolvedValue([]);
    mocks.createDraft.mockResolvedValue({ id: 'return_1' });
    await caller().expiryAdvice({ from: '2026-09-01', to: '2026-09-04' });
    expect(mocks.expiryRead).toHaveBeenCalledWith(expect.anything(), {
      organizationId: 'org_1',
      branchIds: ['branch_1'],
    });
    await caller().proposeExpiryReturn({ branchId: 'branch_1', lotId: 'lot_1' });
    expect(mocks.createDraft).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: 'org_1', branchId: 'branch_1', actorId: 'user_admin' },
      'lot_1'
    );
  });
});

describe('RX-08 pharmacovigilance state boundaries', () => {
  beforeEach(() => {
    mocks.can.mockResolvedValue(true);
    vi.mocked(hasModule).mockReturnValue(true);
    mocks.assignmentFindMany.mockResolvedValue([{ branchId: 'branch_1' }]);
  });

  const filing = {
    branchId: 'branch_1',
    kind: 'ADVERSE_DRUG_REACTION' as const,
    occurredAt: new Date('2026-09-15'),
    assertedDescription: 'Patient reported nausea.',
  };

  it('requires pharmacy:safety or pharmacy:dispense before tenant data access to file a report', async () => {
    mocks.can.mockResolvedValue(false);

    await expect(pvCaller().createPharmacovigilanceReport(filing)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    expect(mocks.can.mock.calls.map((call) => call[1])).toEqual([
      'pharmacy:safety',
      'pharmacy:dispense',
    ]);
    expect(mocks.assignmentFindMany).not.toHaveBeenCalled();
    expect(mocks.branchFindFirst).not.toHaveBeenCalled();
    expect(mocks.reportCreate).not.toHaveBeenCalled();
  });

  it('lets an assigned pharmacist with only pharmacy:dispense file but not review a report', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'pharmacy:dispense');
    mocks.branchFindFirst.mockResolvedValue({ id: 'branch_1' });
    mocks.reportCreate.mockResolvedValue({ id: 'pv_1' });

    await expect(caller('EMPLOYEE').createPharmacovigilanceReport({ ...filing })).resolves.toEqual({
      id: 'pv_1',
    });
    expect(mocks.reportCreate).toHaveBeenCalledOnce();

    await expect(
      caller('EMPLOYEE').transitionPharmacovigilanceReport({
        id: 'pv_1',
        branchId: 'branch_1',
        state: 'UNDER_REVIEW',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.reportFindFirst).not.toHaveBeenCalled();
    expect(mocks.reportUpdateManyAndReturn).not.toHaveBeenCalled();
  });

  it.each([
    [
      'transitionPharmacovigilanceReport',
      () =>
        pvCaller().transitionPharmacovigilanceReport({
          id: 'pv_1',
          branchId: 'branch_1',
          state: 'UNDER_REVIEW',
        }),
    ],
    [
      'recordPharmacovigilanceSubmission',
      () =>
        pvCaller().recordPharmacovigilanceSubmission({
          id: 'pv_1',
          branchId: 'branch_1',
          state: 'PENDING',
        }),
    ],
    [
      'exportPharmacovigilanceDrap',
      () =>
        pvCaller().exportPharmacovigilanceDrap({
          branchId: 'branch_1',
          from: new Date('2026-09-01'),
          to: new Date('2026-09-30'),
        }),
    ],
  ])('requires pharmacy:safety before tenant data access for %s', async (_procedure, invoke) => {
    mocks.can.mockResolvedValue(false);

    await expect(invoke()).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mocks.can).toHaveBeenCalledTimes(1);
    expect(mocks.can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user_admin' }),
      'pharmacy:safety',
      undefined,
      expect.objectContaining({ source: 'TRPC' })
    );
    expect(mocks.assignmentFindMany).not.toHaveBeenCalled();
    expect(mocks.branchFindFirst).not.toHaveBeenCalled();
    expect(mocks.reportFindFirst).not.toHaveBeenCalled();
    expect(mocks.reportFindMany).not.toHaveBeenCalled();
    expect(mocks.reportCreate).not.toHaveBeenCalled();
    expect(mocks.reportUpdate).not.toHaveBeenCalled();
  });

  it.each([
    [
      'createPharmacovigilanceReport',
      mocks.reportCreate,
      () => pvCaller().createPharmacovigilanceReport(filing),
    ],
    [
      'transitionPharmacovigilanceReport',
      mocks.reportFindFirst,
      () =>
        pvCaller().transitionPharmacovigilanceReport({
          id: 'pv_1',
          branchId: 'branch_1',
          state: 'UNDER_REVIEW',
        }),
    ],
    [
      'recordPharmacovigilanceSubmission',
      mocks.reportFindFirst,
      () =>
        pvCaller().recordPharmacovigilanceSubmission({
          id: 'pv_1',
          branchId: 'branch_1',
          state: 'PENDING',
        }),
    ],
    [
      'exportPharmacovigilanceDrap',
      mocks.reportFindMany,
      () =>
        pvCaller().exportPharmacovigilanceDrap({
          branchId: 'branch_1',
          from: new Date('2026-09-01'),
          to: new Date('2026-09-30'),
        }),
    ],
  ])(
    'binds the authorized branch for row-level security before %s touches reports (#1244)',
    async (_procedure, reportCall, invoke) => {
      mocks.reportCreate.mockResolvedValue({ id: 'pv_1' });
      mocks.reportFindMany.mockResolvedValue([]);
      mocks.reportFindFirst.mockResolvedValue({
        id: 'pv_1',
        state: 'READY',
        externalSubmissionState: 'NOT_SUBMITTED',
        createdByUserId: 'maker',
        externalReference: null,
        externalFailureReason: null,
      });
      mocks.reportUpdateManyAndReturn.mockResolvedValue([{ id: 'pv_1' }]);

      await invoke();

      expect(mocks.transaction).toHaveBeenCalledOnce();
      expect(mocks.executeRaw).toHaveBeenCalledOnce();
      const [sql, branchId] = mocks.executeRaw.mock.calls[0];
      expect((sql as TemplateStringsArray).join('?')).toBe(
        "SELECT set_config('app.current_branch_id', ?, true)"
      );
      expect(branchId).toBe('branch_1');
      expect(reportCall).toHaveBeenCalled();
      expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        reportCall.mock.invocationCallOrder[0]
      );
    }
  );

  it('completing internal review does not mark the report externally submitted', async () => {
    mocks.reportFindFirst.mockResolvedValue({
      id: 'pv_1',
      state: 'UNDER_REVIEW',
      externalSubmissionState: 'NOT_SUBMITTED',
    });
    mocks.reportUpdateManyAndReturn.mockResolvedValue([
      {
        id: 'pv_1',
        state: 'READY',
        externalSubmissionState: 'NOT_SUBMITTED',
      },
    ]);
    const result = await pvCaller().transitionPharmacovigilanceReport({
      id: 'pv_1',
      branchId: 'branch_1',
      state: 'READY',
    });
    expect(mocks.reportUpdateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: 'UNDER_REVIEW',
          externalSubmissionState: 'NOT_SUBMITTED',
        }),
        data: expect.not.objectContaining({ externalSubmissionState: expect.anything() }),
      })
    );
    expect(result).toMatchObject({ externalSubmissionState: 'NOT_SUBMITTED' });
  });

  it('records a failed submission without changing or deleting the report', async () => {
    mocks.reportFindFirst.mockResolvedValue({
      id: 'pv_1',
      state: 'READY',
      externalSubmissionState: 'NOT_SUBMITTED',
      externalReference: null,
      externalFailureReason: null,
    });
    mocks.reportUpdateManyAndReturn.mockResolvedValue([
      {
        id: 'pv_1',
        state: 'READY',
        externalSubmissionState: 'FAILED',
      },
    ]);
    await pvCaller().recordPharmacovigilanceSubmission({
      id: 'pv_1',
      branchId: 'branch_1',
      state: 'FAILED',
      failureReason: 'DRAP endpoint unavailable',
    });
    expect(mocks.reportUpdateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ externalSubmissionState: 'NOT_SUBMITTED' }),
        data: expect.not.objectContaining({ state: expect.anything() }),
      })
    );
    expect(mocks.reportUpdateManyAndReturn.mock.calls[0]?.[0].data.externalSubmissionState).toBe(
      'FAILED'
    );
  });

  it('rejects a second failure with a different reason and returns an exact retry without writing', async () => {
    const failed = {
      id: 'pv_1',
      state: 'READY',
      externalSubmissionState: 'FAILED',
      externalReference: null,
      externalFailureReason: 'DRAP endpoint unavailable',
    };
    mocks.reportFindFirst.mockResolvedValue(failed);
    mocks.reportUpdateManyAndReturn.mockClear();

    await expect(
      pvCaller().recordPharmacovigilanceSubmission({
        id: 'pv_1',
        branchId: 'branch_1',
        state: 'FAILED',
        failureReason: 'Different failure reason',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.reportUpdateManyAndReturn).not.toHaveBeenCalled();

    await expect(
      pvCaller().recordPharmacovigilanceSubmission({
        id: 'pv_1',
        branchId: 'branch_1',
        state: 'FAILED',
        failureReason: 'DRAP endpoint unavailable',
      })
    ).resolves.toEqual(failed);
    expect(mocks.reportUpdateManyAndReturn).not.toHaveBeenCalled();
  });

  it('rejects a lifecycle transition when a concurrent writer changed the source state', async () => {
    mocks.reportFindFirst.mockResolvedValue({
      id: 'pv_1',
      state: 'READY',
      externalSubmissionState: 'NOT_SUBMITTED',
    });
    mocks.reportUpdateManyAndReturn.mockResolvedValue([]);

    await expect(
      pvCaller().transitionPharmacovigilanceReport({
        id: 'pv_1',
        branchId: 'branch_1',
        state: 'CLOSED',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.reportUpdateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'pv_1',
          branchId: 'branch_1',
          organizationId: 'org_1',
          state: 'READY',
          externalSubmissionState: 'NOT_SUBMITTED',
        },
      })
    );
  });

  it('rejects a stale lifecycle regression when submission wins the cross-state race', async () => {
    const row = {
      id: 'pv_1',
      state: 'READY',
      externalSubmissionState: 'PENDING',
      externalReference: null as string | null,
      externalFailureReason: null as string | null,
    };
    let lifecycleUpdateStarted!: () => void;
    const lifecycleStarted = new Promise<void>((resolve) => {
      lifecycleUpdateStarted = resolve;
    });
    let finishLifecycle!: () => void;
    const submissionFinished = new Promise<void>((resolve) => {
      finishLifecycle = resolve;
    });

    mocks.reportFindFirst.mockImplementation(async () => ({ ...row }));
    mocks.reportUpdateManyAndReturn.mockImplementation(async ({ where, data }) => {
      if (data.state === 'UNDER_REVIEW') {
        lifecycleUpdateStarted();
        await submissionFinished;
      }
      if (
        where.state !== row.state ||
        where.externalSubmissionState !== row.externalSubmissionState
      )
        return [];
      Object.assign(row, data);
      if (data.externalSubmissionState === 'SUBMITTED') finishLifecycle();
      return [{ ...row }];
    });

    const lifecycle = pvCaller().transitionPharmacovigilanceReport({
      id: 'pv_1',
      branchId: 'branch_1',
      state: 'UNDER_REVIEW',
    });
    const lifecycleResult = expect(lifecycle).rejects.toMatchObject({ code: 'CONFLICT' });
    await lifecycleStarted;
    await pvCaller().recordPharmacovigilanceSubmission({
      id: 'pv_1',
      branchId: 'branch_1',
      state: 'SUBMITTED',
      externalReference: 'DRAP-1',
    });

    await lifecycleResult;
    expect(row).toMatchObject({ state: 'READY', externalSubmissionState: 'SUBMITTED' });
  });

  it('rejects a lifecycle regression after an external submission completes', async () => {
    const report = {
      id: 'pv_1',
      state: 'READY',
      externalSubmissionState: 'NOT_SUBMITTED',
      externalReference: null as string | null,
      externalFailureReason: null as string | null,
    };
    mocks.reportFindFirst.mockImplementation(async () => ({ ...report }));
    mocks.reportUpdateManyAndReturn.mockImplementation(async ({ data }) => {
      Object.assign(report, data);
      return [{ ...report }];
    });

    await pvCaller().recordPharmacovigilanceSubmission({
      id: 'pv_1',
      branchId: 'branch_1',
      state: 'SUBMITTED',
      externalReference: 'DRAP-1',
    });

    await expect(
      pvCaller().transitionPharmacovigilanceReport({
        id: 'pv_1',
        branchId: 'branch_1',
        state: 'UNDER_REVIEW',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.reportUpdateManyAndReturn).toHaveBeenCalledOnce();
    expect(report).toMatchObject({ state: 'READY', externalSubmissionState: 'SUBMITTED' });
  });

  it('does not allow external submission state to regress after submission', async () => {
    mocks.reportFindFirst.mockResolvedValue({
      id: 'pv_1',
      state: 'SUBMITTED',
      externalSubmissionState: 'SUBMITTED',
      externalReference: 'DRAP-1',
      externalFailureReason: null,
    });

    await expect(
      pvCaller().recordPharmacovigilanceSubmission({
        id: 'pv_1',
        branchId: 'branch_1',
        state: 'PENDING',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.reportUpdateManyAndReturn).not.toHaveBeenCalled();
  });

  it('does not overwrite a completed submission reference', async () => {
    mocks.reportFindFirst.mockResolvedValue({
      id: 'pv_1',
      state: 'SUBMITTED',
      externalSubmissionState: 'SUBMITTED',
      externalReference: 'DRAP-1',
      externalFailureReason: null,
    });

    await expect(
      pvCaller().recordPharmacovigilanceSubmission({
        id: 'pv_1',
        branchId: 'branch_1',
        state: 'SUBMITTED',
        externalReference: 'DRAP-2',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.reportUpdateManyAndReturn).not.toHaveBeenCalled();
  });

  it('returns an exact completed-submission retry without writing again', async () => {
    const submitted = {
      id: 'pv_1',
      state: 'READY',
      externalSubmissionState: 'SUBMITTED',
      externalReference: 'DRAP-1',
      externalFailureReason: null,
    };
    mocks.reportFindFirst.mockResolvedValue(submitted);

    const result = await pvCaller().recordPharmacovigilanceSubmission({
      id: 'pv_1',
      branchId: 'branch_1',
      state: 'SUBMITTED',
      externalReference: 'DRAP-1',
    });

    expect(result).toEqual(submitted);
    expect(mocks.reportUpdateManyAndReturn).not.toHaveBeenCalled();
  });

  it('does not record a submission for a draft report', async () => {
    mocks.reportFindFirst.mockResolvedValue({
      id: 'pv_1',
      state: 'DRAFT',
      externalSubmissionState: 'NOT_SUBMITTED',
      externalReference: null,
      externalFailureReason: null,
    });

    await expect(
      pvCaller().recordPharmacovigilanceSubmission({
        id: 'pv_1',
        branchId: 'branch_1',
        state: 'SUBMITTED',
        externalReference: 'DRAP-1',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.reportUpdateManyAndReturn).not.toHaveBeenCalled();
  });

  it('rejects a submission update when its source state changed concurrently', async () => {
    mocks.reportFindFirst.mockResolvedValue({
      id: 'pv_1',
      state: 'READY',
      externalSubmissionState: 'PENDING',
      externalReference: null,
      externalFailureReason: null,
    });
    mocks.reportUpdateManyAndReturn.mockResolvedValue([]);

    await expect(
      pvCaller().recordPharmacovigilanceSubmission({
        id: 'pv_1',
        branchId: 'branch_1',
        state: 'SUBMITTED',
        externalReference: 'DRAP-1',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.reportUpdateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'pv_1',
          branchId: 'branch_1',
          organizationId: 'org_1',
          state: 'READY',
          externalSubmissionState: 'PENDING',
        },
      })
    );
  });

  it('exports every report in range with internal and external states distinguished', async () => {
    mocks.reportFindMany.mockResolvedValue([
      { id: 'pv_1', state: 'READY', externalSubmissionState: 'NOT_SUBMITTED' },
      { id: 'pv_2', state: 'CLOSED', externalSubmissionState: 'FAILED' },
    ]);
    const result = await pvCaller().exportPharmacovigilanceDrap({
      branchId: 'branch_1',
      from: new Date('2026-09-01'),
      to: new Date('2026-09-30'),
    });
    expect(result.reports).toHaveLength(2);
    expect(result.reports[0]).toMatchObject({
      reportState: 'READY',
      externalSubmissionState: 'NOT_SUBMITTED',
    });
    expect(result.reports[1]).toMatchObject({
      reportState: 'CLOSED',
      externalSubmissionState: 'FAILED',
    });
  });

  it('denies an out-of-tenant branch before reading reports', async () => {
    const api = pvCaller();
    mocks.branchFindFirst.mockResolvedValueOnce(null);
    await expect(
      api.exportPharmacovigilanceDrap({
        branchId: 'branch_other',
        from: new Date('2026-09-01'),
        to: new Date('2026-09-30'),
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.reportFindMany).not.toHaveBeenCalled();
  });
});

describe('repeat purchasing authorization', () => {
  const input = { from: '2026-01-01', to: '2026-01-31', asOf: '2026-05-01T00:00:00Z' };
  beforeEach(() => {
    mocks.can.mockResolvedValue(true);
    vi.mocked(hasModule).mockReturnValue(true);
    mocks.branchFindMany.mockResolvedValue([{ id: 'branch_1', name: 'Main' }]);
  });
  it('requires financial permission before data reads', async () => {
    mocks.can.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(caller().repeatPurchasing(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.repeatRead).not.toHaveBeenCalled();
    expect(mocks.branchFindMany).not.toHaveBeenCalled();
  });
  it('requires operational permission before data reads', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().repeatPurchasing(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.repeatRead).not.toHaveBeenCalled();
  });
  it('denies non-admin role despite capabilities', async () => {
    await expect(caller('EMPLOYEE').repeatPurchasing(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.repeatRead).not.toHaveBeenCalled();
  });
  it('denies module access and foreign/omitted branch scope', async () => {
    await expect(
      caller().repeatPurchasing({ ...input, branchId: 'other-tenant-branch' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    vi.mocked(hasModule).mockReturnValue(false);
    await expect(caller().repeatPurchasing(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.repeatRead).not.toHaveBeenCalled();
  });
  it('passes only active tenant branches and fixed cutoff to read-only helper', async () => {
    await caller().repeatPurchasing(input);
    expect(mocks.branchFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org_1', active: true } })
    );
    expect(mocks.repeatRead).toHaveBeenCalledWith(expect.anything(), 'org_1', {
      ...input,
      branchIds: ['branch_1'],
    });
  });
  it('rejects future cutoff and irrelevant item filters', async () => {
    await expect(
      caller().repeatPurchasing({ ...input, asOf: '2999-01-01T00:00:00Z' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().repeatPurchasing({ ...input, supplierId: 'supplier' } as typeof input)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.repeatRead).not.toHaveBeenCalled();
  });
});

describe('staffing suggestions (DEV-14)', () => {
  const input = { branchId: 'branch_1', from: '2026-09-01', to: '2026-09-02' };
  beforeEach(() => {
    mocks.can.mockResolvedValue(true);
    vi.mocked(hasModule).mockReturnValue(true);
    mocks.branchFindMany.mockResolvedValue([{ id: 'branch_1', name: 'Main' }]);
    mocks.saleFindMany.mockReset();
    mocks.saleFindMany.mockResolvedValue([
      { completedAt: new Date('2026-09-01T04:10:00Z') },
      { completedAt: new Date('2026-09-01T04:20:00Z') },
      { completedAt: new Date('2026-09-02T04:30:00Z') },
    ]);
  });
  it('computes hourly footfall (UTC when no workspace zone is set) and suggests staff', async () => {
    const report = await caller().staffingSuggestions({ ...input, receiptsPerStaffHour: 1 });
    expect(report.totalReceipts).toBe(3);
    expect(report.hours[4]).toMatchObject({
      receipts: 3,
      averagePerDay: 1.5,
      busiestDay: 2,
      suggestedStaff: 2,
    });
    expect(report.hours.filter((row) => row.suggestedStaff !== null)).toHaveLength(1);
    expect(report.config).toEqual({ receiptsPerStaffHour: 1, minimumStaff: 1 });
    expect(mocks.saleFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org_1', branchId: 'branch_1' }),
      })
    );
  });
  it('requires operational permission, the module and an in-scope branch before reading', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().staffingSuggestions(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    mocks.can.mockResolvedValue(true);
    await expect(
      caller().staffingSuggestions({ ...input, branchId: 'other-tenant-branch' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    vi.mocked(hasModule).mockReturnValue(false);
    await expect(caller().staffingSuggestions(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.saleFindMany).not.toHaveBeenCalled();
  });
  it('rejects out-of-bounds assumptions and windows', async () => {
    await expect(
      caller().staffingSuggestions({ ...input, receiptsPerStaffHour: 0 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().staffingSuggestions({ ...input, minimumStaff: 21 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().staffingSuggestions({ ...input, from: '2026-01-01', to: '2026-12-31' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.saleFindMany).not.toHaveBeenCalled();
  });
});

describe('PV safety capability, assignment and licence boundary', () => {
  const operations = [
    [
      'capture',
      (api: ReturnType<typeof caller>) =>
        api.createPharmacovigilanceReport({
          branchId: 'branch_1',
          kind: 'ADVERSE_DRUG_REACTION',
          occurredAt: new Date(),
          assertedDescription: 'Human report',
        }),
    ],
    [
      'transition',
      (api: ReturnType<typeof caller>) =>
        api.transitionPharmacovigilanceReport({
          id: 'pv_1',
          branchId: 'branch_1',
          state: 'UNDER_REVIEW',
        }),
    ],
    [
      'submission',
      (api: ReturnType<typeof caller>) =>
        api.recordPharmacovigilanceSubmission({
          id: 'pv_1',
          branchId: 'branch_1',
          state: 'PENDING',
        }),
    ],
    [
      'export',
      (api: ReturnType<typeof caller>) =>
        api.exportPharmacovigilanceDrap({
          branchId: 'branch_1',
          from: new Date('2026-09-01'),
          to: new Date('2026-09-30'),
        }),
    ],
  ] as const;
  beforeEach(() => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'pharmacy:safety');
    vi.mocked(hasModule).mockReturnValue(true);
    mocks.assignmentFindMany.mockResolvedValue([{ branchId: 'branch_1' }]);
    mocks.branchFindFirst.mockResolvedValue({ id: 'branch_1' });
    // READY permits both UNDER_REVIEW and a PENDING submission under #480 rules.
    mocks.reportFindFirst.mockResolvedValue({
      id: 'pv_1',
      state: 'READY',
      externalSubmissionState: 'NOT_SUBMITTED',
      externalReference: null,
      externalFailureReason: null,
      createdByUserId: 'other',
    });
    mocks.reportFindMany.mockResolvedValue([]);
    mocks.reportCreate.mockResolvedValue({ id: 'pv_1' });
    mocks.reportUpdateManyAndReturn.mockResolvedValue([{ id: 'pv_1' }]);
  });
  function expectNoReports() {
    for (const read of [
      mocks.reportFindFirst,
      mocks.reportFindMany,
      mocks.reportCreate,
      mocks.reportUpdate,
      mocks.reportUpdateManyAndReturn,
    ])
      expect(read).not.toHaveBeenCalled();
  }
  it.each(operations)(
    'allows safety without operational reports permission: %s',
    async (_name, invoke) => {
      await invoke(caller('EMPLOYEE'));
      expect(mocks.can).toHaveBeenCalledWith(
        expect.anything(),
        'pharmacy:safety',
        undefined,
        expect.anything()
      );
      expect(mocks.assignmentFindMany).toHaveBeenCalledWith({
        where: { organizationId: 'org_1', userId: 'user_admin', active: true },
        select: { branchId: true },
      });
    }
  );
  it.each(operations)('denies reports-only before DB access: %s', async (_name, invoke) => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'reports:operational');
    await expect(invoke(caller('EMPLOYEE'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.assignmentFindMany).not.toHaveBeenCalled();
    expect(mocks.branchFindFirst).not.toHaveBeenCalled();
    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expectNoReports();
  });
  it.each(operations)('denies another assigned tenant branch: %s', async (_name, invoke) => {
    mocks.assignmentFindMany.mockResolvedValue([{ branchId: 'branch_2' }]);
    await expect(invoke(caller('EMPLOYEE'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.branchFindFirst).not.toHaveBeenCalled();
    expectNoReports();
  });
  it.each(operations)(
    'denies absent reports licence before DB access: %s',
    async (_name, invoke) => {
      vi.mocked(hasModule).mockReturnValue(false);
      await expect(invoke(caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.assignmentFindMany).not.toHaveBeenCalled();
      expect(mocks.branchFindFirst).not.toHaveBeenCalled();
      expectNoReports();
    }
  );
  it.each(operations)(
    'denies inactive, foreign or nonexistent assigned branch: %s',
    async (_name, invoke) => {
      mocks.branchFindFirst.mockResolvedValue(null);
      await expect(invoke(caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expectNoReports();
    }
  );
});

describe('PV maker/checker approval', () => {
  const input = { id: 'pv_1', branchId: 'branch_1', state: 'READY' as const };
  const credential = {
    id: 'cred_1',
    credentialHash: 'stored-hash',
    failedAttempts: 0,
    lockedUntil: null,
  };
  let audit: TRPCContext['audit'];
  beforeEach(() => {
    audit = { detail: {} };
    mocks.can.mockResolvedValue(true);
    vi.mocked(hasModule).mockReturnValue(true);
    mocks.assignmentFindMany.mockResolvedValue([{ branchId: 'branch_1' }]);
    mocks.branchFindFirst.mockResolvedValue({ id: 'branch_1' });
    mocks.reportFindFirst.mockResolvedValue({
      id: 'pv_1',
      state: 'UNDER_REVIEW',
      externalSubmissionState: 'NOT_SUBMITTED',
      createdByUserId: 'user_admin',
    });
    mocks.reportUpdateManyAndReturn.mockResolvedValue([{ id: 'pv_1', state: 'READY' }]);
    mocks.userFindFirst.mockResolvedValue({ role: 'ADMIN', organizationRole: { key: 'owner' } });
    mocks.userCount.mockResolvedValue(0);
    mocks.credentialFindFirst.mockResolvedValue(credential);
    mocks.verifyPin.mockResolvedValue(true);
    mocks.auditCreate.mockResolvedValue({ id: 'audit_1' });
  });
  it('requires fresh PIN for solo owner approval, without changing the report', async () => {
    await expect(
      caller('ADMIN', audit).transitionPharmacovigilanceReport(input)
    ).resolves.toMatchObject({ blocked: expect.any(String) });
    expect(mocks.reportUpdateManyAndReturn).not.toHaveBeenCalled();
    expect(mocks.verifyPin).not.toHaveBeenCalled();
    expect(audit.detail).toMatchObject({
      skipInput: true,
      metadata: { policy: 'PV:SOLO_OWNER_PIN', reauthenticated: false },
    });
  });
  it('permits solo owner with a verified PIN and audits server reauthentication evidence', async () => {
    await caller('ADMIN', audit).transitionPharmacovigilanceReport({ ...input, pin: '1234' });
    expect(mocks.verifyPin).toHaveBeenCalledWith('PIN', '1234', 'stored-hash');
    expect(mocks.credentialFindFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_1',
        type: 'PIN',
        revokedAt: null,
        deviceId: null,
        staffProfile: { organizationId: 'org_1', userId: 'user_admin', status: 'ACTIVE' },
      },
    });
    expect(mocks.reportUpdateManyAndReturn).toHaveBeenCalledWith({
      where: {
        id: 'pv_1',
        branchId: 'branch_1',
        organizationId: 'org_1',
        state: 'UNDER_REVIEW',
        externalSubmissionState: 'NOT_SUBMITTED',
      },
      data: { state: 'READY', reviewedByUserId: 'user_admin' },
    });
    // The organization lock is taken only on the solo-owner readiness path.
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
    expect(mocks.credentialUpdate).toHaveBeenCalledWith({
      where: { id: 'cred_1' },
      data: { failedAttempts: 0, lockedUntil: null },
    });
    expect(audit.detail).toMatchObject({
      skipInput: true,
      metadata: {
        policy: 'PV:SOLO_OWNER_PIN',
        actorId: 'user_admin',
        reportId: 'pv_1',
        reauthenticated: true,
        reauthenticatedAt: expect.any(String),
      },
    });
    expect(JSON.stringify(audit)).not.toContain('1234');
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org_1',
        actorId: 'user_admin',
        action: 'pv_solo_owner_approval',
        targetId: 'pv_1',
        input: '[skipped]',
        metadata: expect.objectContaining({ policy: 'PV:SOLO_OWNER_PIN', branchId: 'branch_1' }),
      }),
    });
  });
  it.each([1, 2])(
    'requires a second approver with %s other active staff even with owner PIN',
    async (count) => {
      mocks.userCount.mockResolvedValue(count);
      await expect(
        caller('ADMIN', audit).transitionPharmacovigilanceReport({ ...input, pin: '1234' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.userCount).toHaveBeenCalledWith({
        where: {
          organizationId: 'org_1',
          id: { not: 'user_admin' },
          status: { in: ['ACTIVE', 'ON_LEAVE'] },
        },
      });
      expect(mocks.verifyPin).not.toHaveBeenCalled();
      expect(mocks.reportUpdateManyAndReturn).not.toHaveBeenCalled();
    }
  );
  it('allows a different safety-capable reviewer without owner PIN', async () => {
    mocks.reportFindFirst.mockResolvedValue({
      id: 'pv_1',
      state: 'UNDER_REVIEW',
      externalSubmissionState: 'NOT_SUBMITTED',
      createdByUserId: 'maker',
    });
    await caller('EMPLOYEE', audit).transitionPharmacovigilanceReport(input);
    expect(mocks.reportUpdateManyAndReturn).toHaveBeenCalled();
    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expect(mocks.userCount).not.toHaveBeenCalled();
    expect(mocks.verifyPin).not.toHaveBeenCalled();
  });
  it('rejects solo non-owner self approval despite safety capability', async () => {
    mocks.userFindFirst.mockResolvedValue({
      role: 'EMPLOYEE',
      organizationRole: { key: 'pharmacist' },
    });
    await expect(
      caller('EMPLOYEE', audit).transitionPharmacovigilanceReport({ ...input, pin: '1234' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.reportUpdateManyAndReturn).not.toHaveBeenCalled();
  });
  it('refuses approval if durable solo audit evidence cannot be written', async () => {
    mocks.auditCreate.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(
      caller('ADMIN', audit).transitionPharmacovigilanceReport({ ...input, pin: '1234' })
    ).rejects.toThrow('audit unavailable');
    expect(mocks.reportUpdateManyAndReturn).not.toHaveBeenCalled();
  });
  it('commits a failed PIN strike without approving', async () => {
    mocks.verifyPin.mockResolvedValue(false);
    await expect(
      caller('ADMIN', audit).transitionPharmacovigilanceReport({ ...input, pin: '0000' })
    ).resolves.toHaveProperty('blocked');
    expect(mocks.credentialUpdate).toHaveBeenCalledWith({
      where: { id: 'cred_1' },
      data: { failedAttempts: 1, lockedUntil: null },
    });
    expect(mocks.reportUpdateManyAndReturn).not.toHaveBeenCalled();
    expect(audit.detail).toMatchObject({ skipInput: true, metadata: { reauthenticated: false } });
  });
  it.each([null, { ...credential, lockedUntil: new Date('2099-01-01') }])(
    'denies missing/revoked/device-bound or locked PIN: %j',
    async (record) => {
      mocks.credentialFindFirst.mockResolvedValue(record);
      await expect(
        caller('ADMIN', audit).transitionPharmacovigilanceReport({ ...input, pin: '1234' })
      ).resolves.toHaveProperty('blocked');
      expect(mocks.verifyPin).not.toHaveBeenCalled();
      expect(mocks.reportUpdateManyAndReturn).not.toHaveBeenCalled();
    }
  );
  it('rolls back solo approval evidence when a concurrent lifecycle change wins', async () => {
    mocks.reportUpdateManyAndReturn.mockResolvedValue([]);
    await expect(
      caller('ADMIN', audit).transitionPharmacovigilanceReport({ ...input, pin: '1234' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('category growth report input boundaries', () => {
  const input = { from: '2026-02-01', to: '2026-02-01', configuration: [] };
  beforeEach(() => {
    mocks.can.mockResolvedValue(true);
    vi.mocked(hasModule).mockReturnValue(true);
    mocks.branchFindMany.mockResolvedValue([{ id: 'branch_1', name: 'Main' }]);
    mocks.queryRaw.mockResolvedValue([]);
  });

  it.each([
    { from: '2026-02-30', to: '2026-03-04' },
    { to: '2026-02-30' },
    { to: '2026-13-01' },
    { from: '2026-02-02' },
    { to: '2026-05-02' }, // 91 inclusive days.
    { from: '2000-01-01', to: '2026-10-08' },
  ])('rejects invalid public dates with BAD_REQUEST before SQL: %j', async (overrides) => {
    await expect(caller().categoryGrowth({ ...input, ...overrides })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it('rejects more than 100 authorized branches before SQL', async () => {
    mocks.branchFindMany.mockResolvedValue(
      Array.from({ length: 101 }, (_, i) => ({ id: `b${i}`, name: `Branch ${i}` }))
    );
    await expect(caller().categoryGrowth(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it.each(['2026-02-01', '2026-05-01'])(
    'accepts an inclusive range ending %s and converts the cutoff once',
    async (to) => {
      await caller().categoryGrowth({ ...input, to });
      const query = mocks.queryRaw.mock.calls[0][0];
      expect(query.values.slice(-2)).toEqual([
        new Date('2026-02-01T00:00:00.000Z'),
        new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000),
      ]);
    }
  );
});
