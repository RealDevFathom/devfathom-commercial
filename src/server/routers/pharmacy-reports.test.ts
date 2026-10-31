import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

const mocks = vi.hoisted(() => ({
  raw: vi.fn().mockResolvedValue([]),
  repeatRead: vi.fn().mockResolvedValue({ horizons: [] }),
  can: vi.fn<typeof import('@/lib/abac').can>(async () => false),
  branchFindMany: vi.fn(),
  settingUpsert: vi.fn(),
  userFindUnique: vi.fn(),
  branchFindFirst: vi.fn(),
  reportFindFirst: vi.fn(),
  reportFindMany: vi.fn(),
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
}));
vi.mock('@/lib/pharmacy/branch-comparison', () => ({
  readPharmacyBranchComparison: mocks.comparisonRead,
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

function context(role = 'ADMIN') {
  return {
    db: {
      $queryRaw: mocks.raw,
      $transaction: mocks.transaction,
      pharmacyBranch: { findMany: mocks.branchFindMany, findFirst: mocks.branchFindFirst },
      pharmacyPharmacovigilanceReport: {
        findFirst: mocks.reportFindFirst,
        findMany: mocks.reportFindMany,
        update: mocks.reportUpdate,
        updateManyAndReturn: mocks.reportUpdateManyAndReturn,
      },
      pharmacyOwnerDigestSetting: { upsert: mocks.settingUpsert },
      user: { findUnique: mocks.userFindUnique },
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
  } as unknown as TRPCContext;
}

function caller(role = 'ADMIN') {
  return pharmacyReportsRouter.createCaller(context(role));
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
});

describe('RX-08 pharmacovigilance state boundaries', () => {
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
    expect(result.externalSubmissionState).toBe('NOT_SUBMITTED');
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

describe('category growth report input boundaries', () => {
  const input = { from: '2026-02-01', to: '2026-02-01', configuration: [] };
  beforeEach(() => {
    mocks.can.mockResolvedValue(true);
    vi.mocked(hasModule).mockReturnValue(true);
    mocks.branchFindMany.mockResolvedValue([{ id: 'branch_1', name: 'Main' }]);
    mocks.raw.mockResolvedValue([]);
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
    expect(mocks.raw).not.toHaveBeenCalled();
  });

  it('rejects more than 100 authorized branches before SQL', async () => {
    mocks.branchFindMany.mockResolvedValue(
      Array.from({ length: 101 }, (_, i) => ({ id: `b${i}`, name: `Branch ${i}` }))
    );
    await expect(caller().categoryGrowth(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.raw).not.toHaveBeenCalled();
  });

  it.each(['2026-02-01', '2026-05-01'])(
    'accepts an inclusive range ending %s and converts the cutoff once',
    async (to) => {
      await caller().categoryGrowth({ ...input, to });
      const query = mocks.raw.mock.calls[0][0];
      expect(query.values.slice(-2)).toEqual([
        new Date('2026-02-01T00:00:00.000Z'),
        new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000),
      ]);
    }
  );
});
