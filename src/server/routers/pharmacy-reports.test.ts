import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  repeatRead: vi.fn().mockResolvedValue({ horizons: [] }),
  can: vi.fn(async () => false),
  branchFindMany: vi.fn(),
  settingUpsert: vi.fn(),
  branchFindFirst: vi.fn(),
  assignments: vi.fn().mockResolvedValue([]),
  staff: vi.fn(),
  credential: vi.fn(),
  credentialUpdate: vi.fn(),
  auditCreate: vi.fn(),
  reportCreate: vi.fn(),
  reportFindFirst: vi.fn(),
  reportFindMany: vi.fn(),
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
vi.mock('@/server/audit', async () => ({
  ...(await vi.importActual<typeof import('@/server/audit')>('@/server/audit')),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { hasModule } from '@/lib/entitlements';
import type { TRPCContext } from '../trpc';
import { pharmacyReportsRouter } from './pharmacy-reports';

function caller(role = 'ADMIN') {
  return pharmacyReportsRouter.createCaller({
    db: {
      $transaction: async (fn: (db: unknown) => unknown) => fn(dbForApproval()),
      user: {
        findUnique: vi.fn().mockResolvedValue({ organizationId: 'org_1', role, status: 'ACTIVE' }),
      },
      pharmacyBranchAssignment: { findMany: mocks.assignments },
      pharmacyBranch: { findMany: mocks.branchFindMany, findFirst: mocks.branchFindFirst },
      pharmacyPharmacovigilanceReport: {
        create: mocks.reportCreate,
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

function dbForApproval() {
  return {
    $queryRaw: vi.fn(),
    auditLog: { create: mocks.auditCreate },
    restaurantStaffProfile: { findMany: mocks.staff },
    restaurantOperatorCredential: { findFirst: mocks.credential, update: mocks.credentialUpdate },
    pharmacyPharmacovigilanceReport: { update: mocks.reportUpdate },
  };
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
  beforeEach(() => mocks.can.mockResolvedValue(true));
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
    expect('externalSubmissionState' in result && result.externalSubmissionState).toBe(
      'NOT_SUBMITTED'
    );
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

describe('pharmacovigilance authorization', () => {
  const branchId = 'branch_1';
  const actions = [
    (api: ReturnType<typeof caller>) =>
      api.createPharmacovigilanceReport({
        branchId,
        kind: 'ADVERSE_DRUG_REACTION',
        occurredAt: new Date(),
        assertedDescription: 'Human report',
      }),
    (api: ReturnType<typeof caller>) =>
      api.transitionPharmacovigilanceReport({ branchId, id: 'pv_1', state: 'READY' }),
    (api: ReturnType<typeof caller>) =>
      api.recordPharmacovigilanceSubmission({ branchId, id: 'pv_1', state: 'PENDING' }),
    (api: ReturnType<typeof caller>) =>
      api.exportPharmacovigilanceDrap({ branchId, from: new Date(), to: new Date() }),
  ];
  beforeEach(() => {
    mocks.can.mockResolvedValue(true);
    mocks.assignments.mockResolvedValue([]);
    mocks.branchFindFirst.mockReset().mockResolvedValue({ id: branchId });
    mocks.reportFindFirst.mockResolvedValue({
      id: 'pv_1',
      state: 'UNDER_REVIEW',
      createdByUserId: 'other_author',
    });
    mocks.reportFindMany.mockResolvedValue([]);
  });
  it.each(actions)(
    'denies missing safety capability before branch and report access',
    async (action) => {
      mocks.can.mockResolvedValue(false);
      await expect(action(caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.can).toHaveBeenCalledWith(
        expect.anything(),
        'pharmacy:safety',
        undefined,
        expect.anything()
      );
      expect(mocks.branchFindFirst).not.toHaveBeenCalled();
      expect(mocks.reportFindFirst).not.toHaveBeenCalled();
      expect(mocks.reportFindMany).not.toHaveBeenCalled();
      expect(mocks.reportCreate).not.toHaveBeenCalled();
      expect(mocks.reportUpdate).not.toHaveBeenCalled();
    }
  );
  it.each(actions)('denies unassigned staff before report access', async (action) => {
    await expect(action(caller('EMPLOYEE'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.reportFindFirst).not.toHaveBeenCalled();
    expect(mocks.reportFindMany).not.toHaveBeenCalled();
    expect(mocks.reportCreate).not.toHaveBeenCalled();
    expect(mocks.reportUpdate).not.toHaveBeenCalled();
  });
  it.each(actions)('allows owner without assignments', async (action) => {
    await action(caller());
    expect(mocks.assignments).not.toHaveBeenCalled();
    expect(mocks.branchFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: branchId, organizationId: 'org_1', active: true } })
    );
  });
  it.each(actions)('denies inactive or foreign branch even for owner', async (action) => {
    mocks.branchFindFirst.mockResolvedValue(null);
    await expect(action(caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.reportFindFirst).not.toHaveBeenCalled();
    expect(mocks.reportFindMany).not.toHaveBeenCalled();
    expect(mocks.reportCreate).not.toHaveBeenCalled();
    expect(mocks.reportUpdate).not.toHaveBeenCalled();
  });
  it.each(actions)(
    'allows owner in another active branch despite narrower assignments',
    async (action) => {
      mocks.assignments.mockResolvedValue([{ branchId: 'different_branch' }]);
      await action(caller());
      expect(mocks.assignments).not.toHaveBeenCalled();
    }
  );
  it('allows assigned safety staff and rejects inactive branches even for owner', async () => {
    mocks.assignments.mockResolvedValue([{ branchId }]);
    await actions[3](caller('EMPLOYEE'));
    mocks.branchFindFirst.mockResolvedValue(null);
    await expect(actions[3](caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('requires a second identity for self review without owner PIN evidence', async () => {
    mocks.reportFindFirst.mockResolvedValue({
      id: 'pv_1',
      state: 'UNDER_REVIEW',
      createdByUserId: 'user_admin',
    });
    expect(await actions[1](caller())).toHaveProperty('blocked');
    expect(mocks.reportUpdate).not.toHaveBeenCalled();
  });
});

describe('PV approval evidence', () => {
  beforeEach(() => {
    mocks.can.mockResolvedValue(true);
    mocks.branchFindFirst.mockResolvedValue({ id: 'branch_1' });
  });
  it.each(['DRAFT', 'UNDER_REVIEW', 'READY', 'SUBMITTED', 'CLOSED'])(
    'rejects external submission without a reviewer in %s',
    async (state) => {
      mocks.reportFindFirst.mockResolvedValue({ id: 'pv_1', state, reviewedByUserId: null });
      await expect(
        caller().recordPharmacovigilanceSubmission({
          id: 'pv_1',
          branchId: 'branch_1',
          state: 'SUBMITTED',
          externalReference: 'DRAP-1',
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(mocks.reportUpdate).not.toHaveBeenCalled();
    }
  );
  it.each(['DRAFT', 'UNDER_REVIEW'])('rejects stale reviewer in %s', async (state) => {
    mocks.reportFindFirst.mockResolvedValue({ id: 'pv_1', state, reviewedByUserId: 'reviewer' });
    await expect(
      caller().recordPharmacovigilanceSubmission({
        id: 'pv_1',
        branchId: 'branch_1',
        state: 'SUBMITTED',
        externalReference: 'DRAP-1',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
  it.each(['READY', 'SUBMITTED', 'CLOSED'])(
    'records approved external submission in %s',
    async (state) => {
      mocks.reportFindFirst.mockResolvedValue({ id: 'pv_1', state, reviewedByUserId: 'reviewer' });
      await caller().recordPharmacovigilanceSubmission({
        id: 'pv_1',
        branchId: 'branch_1',
        state: 'SUBMITTED',
        externalReference: 'DRAP-1',
      });
      expect(mocks.reportUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            externalSubmissionState: 'SUBMITTED',
            externalReference: 'DRAP-1',
            externalFailureReason: null,
          },
        })
      );
    }
  );
  it.each([
    ['READY', 'UNDER_REVIEW'],
    ['UNDER_REVIEW', 'DRAFT'],
  ])('clears approval on %s to %s', async (state, target) => {
    mocks.reportFindFirst.mockResolvedValue({ id: 'pv_1', state, reviewedByUserId: 'reviewer' });
    await caller().transitionPharmacovigilanceReport({
      id: 'pv_1',
      branchId: 'branch_1',
      state: target as 'DRAFT' | 'UNDER_REVIEW',
    });
    expect(mocks.reportUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { state: target, reviewedByUserId: null } })
    );
  });
  it('fails closed when the atomic solo approval audit fails', async () => {
    const { hashOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
    mocks.reportFindFirst.mockResolvedValue({
      id: 'pv_1',
      state: 'UNDER_REVIEW',
      createdByUserId: 'user_admin',
    });
    mocks.staff.mockResolvedValue([{ id: 'staff_1', userId: 'user_admin' }]);
    mocks.credential.mockResolvedValue({
      id: 'cred_1',
      credentialHash: await hashOperatorCredential('PIN', '123456'),
      failedAttempts: 0,
      lockedUntil: null,
    });
    mocks.auditCreate.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(
      caller().transitionPharmacovigilanceReport({
        id: 'pv_1',
        branchId: 'branch_1',
        state: 'READY',
        ownerAuthorization: { staffProfileId: 'staff_1', pin: '123456' },
      })
    ).rejects.toThrow('audit unavailable');
    expect(mocks.reportUpdate).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.auditCreate.mock.calls)).not.toContain('123456');
  });
});
