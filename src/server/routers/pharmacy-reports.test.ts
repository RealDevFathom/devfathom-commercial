import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  repeatRead: vi.fn().mockResolvedValue({ horizons: [] }),
  can: vi.fn<typeof import('@/lib/abac').can>(),
  branchFindMany: vi.fn(),
  settingUpsert: vi.fn(),
  branchFindFirst: vi.fn(),
  assignmentFindMany: vi.fn(),
  userFindFirst: vi.fn(),
  userCount: vi.fn(),
  credentialFindFirst: vi.fn(),
  credentialUpdate: vi.fn(),
  verifyPin: vi.fn(),
  queryRaw: vi.fn(),
  auditCreate: vi.fn(),
  reportFindFirst: vi.fn(),
  reportFindMany: vi.fn(),
  reportCreate: vi.fn(),
  reportUpdate: vi.fn(),
  stockDashboard: vi.fn(),
  stockDigest: vi.fn(),
  anomalyRead: vi.fn(),
  expiryRead: vi.fn(),
  returnsRead: vi.fn(),
  creditsRead: vi.fn(),
  refresh: vi.fn(),
  createDraft: vi.fn(),
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

function caller(role = 'ADMIN', audit: TRPCContext['audit'] = { detail: {} }) {
  const db = {
    $queryRaw: mocks.queryRaw,
    auditLog: { create: mocks.auditCreate },
    user: { findFirst: mocks.userFindFirst, count: mocks.userCount },
    pharmacyBranchAssignment: { findMany: mocks.assignmentFindMany },
    restaurantOperatorCredential: {
      findFirst: mocks.credentialFindFirst,
      update: mocks.credentialUpdate,
    },
    pharmacyBranch: { findMany: mocks.branchFindMany, findFirst: mocks.branchFindFirst },
    pharmacyPharmacovigilanceReport: {
      findFirst: mocks.reportFindFirst,
      findMany: mocks.reportFindMany,
      create: mocks.reportCreate,
      update: mocks.reportUpdate,
    },
    pharmacyOwnerDigestSetting: { upsert: mocks.settingUpsert },
  };
  return pharmacyReportsRouter.createCaller({
    db: { ...db, $transaction: async (fn: (tx: unknown) => unknown) => fn(db) },
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
  } as unknown as TRPCContext);
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
});

describe('pharmacy owner digest capability boundary', () => {
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
  beforeEach(() => {
    mocks.can.mockResolvedValue(true);
    vi.mocked(hasModule).mockReturnValue(true);
    mocks.assignmentFindMany.mockResolvedValue([{ branchId: 'branch_1' }]);
  });

  it.each([
    [
      'createPharmacovigilanceReport',
      () =>
        pvCaller().createPharmacovigilanceReport({
          branchId: 'branch_1',
          kind: 'ADVERSE_DRUG_REACTION',
          occurredAt: new Date('2026-09-15'),
          assertedDescription: 'Patient reported nausea.',
        }),
    ],
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

  it('completing internal review does not mark the report externally submitted', async () => {
    mocks.reportFindFirst.mockResolvedValue({ id: 'pv_1', state: 'UNDER_REVIEW' });
    mocks.reportUpdate.mockResolvedValue({
      id: 'pv_1',
      state: 'READY',
      externalSubmissionState: 'NOT_SUBMITTED',
    });
    const result = await pvCaller().transitionPharmacovigilanceReport({
      id: 'pv_1',
      branchId: 'branch_1',
      state: 'READY',
    });
    expect(mocks.reportUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ externalSubmissionState: expect.anything() }),
      })
    );
    expect(result).toMatchObject({ externalSubmissionState: 'NOT_SUBMITTED' });
  });

  it('records a failed submission without changing or deleting the report', async () => {
    mocks.reportFindFirst.mockResolvedValue({ id: 'pv_1', state: 'READY' });
    mocks.reportUpdate.mockResolvedValue({
      id: 'pv_1',
      state: 'READY',
      externalSubmissionState: 'FAILED',
    });
    await pvCaller().recordPharmacovigilanceSubmission({
      id: 'pv_1',
      branchId: 'branch_1',
      state: 'FAILED',
      failureReason: 'DRAP endpoint unavailable',
    });
    expect(mocks.reportUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.not.objectContaining({ state: expect.anything() }) })
    );
    expect(mocks.reportUpdate.mock.calls[0]?.[0].data.externalSubmissionState).toBe('FAILED');
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
    mocks.reportFindFirst.mockResolvedValue({
      id: 'pv_1',
      state: 'DRAFT',
      createdByUserId: 'other',
    });
    mocks.reportFindMany.mockResolvedValue([]);
  });
  function expectNoReports() {
    for (const read of [
      mocks.reportFindFirst,
      mocks.reportFindMany,
      mocks.reportCreate,
      mocks.reportUpdate,
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
      createdByUserId: 'user_admin',
    });
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
    expect(mocks.reportUpdate).not.toHaveBeenCalled();
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
    expect(mocks.reportUpdate).toHaveBeenCalledWith({
      where: { id: 'pv_1' },
      data: { state: 'READY', reviewedByUserId: 'user_admin' },
    });
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
      expect(mocks.reportUpdate).not.toHaveBeenCalled();
    }
  );
  it('allows a different safety-capable reviewer without owner PIN', async () => {
    mocks.reportFindFirst.mockResolvedValue({
      id: 'pv_1',
      state: 'UNDER_REVIEW',
      createdByUserId: 'maker',
    });
    await caller('EMPLOYEE', audit).transitionPharmacovigilanceReport(input);
    expect(mocks.reportUpdate).toHaveBeenCalled();
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
    expect(mocks.reportUpdate).not.toHaveBeenCalled();
  });
  it('refuses approval if durable solo audit evidence cannot be written', async () => {
    mocks.auditCreate.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(
      caller('ADMIN', audit).transitionPharmacovigilanceReport({ ...input, pin: '1234' })
    ).rejects.toThrow('audit unavailable');
    expect(mocks.reportUpdate).not.toHaveBeenCalled();
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
    expect(mocks.reportUpdate).not.toHaveBeenCalled();
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
      expect(mocks.reportUpdate).not.toHaveBeenCalled();
    }
  );
});
