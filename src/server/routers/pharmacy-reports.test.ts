import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  repeatRead: vi.fn().mockResolvedValue({ horizons: [] }),
  can: vi.fn().mockResolvedValue(false),
  branchFindMany: vi.fn(),
  settingUpsert: vi.fn(),
  branchFindFirst: vi.fn(),
  assignmentFindMany: vi.fn(),
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
vi.mock('@/server/audit', () => ({
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
      pharmacyBranch: { findMany: mocks.branchFindMany, findFirst: mocks.branchFindFirst },
      pharmacyBranchAssignment: { findMany: mocks.assignmentFindMany },
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
  const revision = new Date('2026-10-29T00:00:00.000Z');

  beforeEach(() => {
    mocks.can.mockResolvedValue(true);
    mocks.assignmentFindMany.mockResolvedValue([{ branchId: 'branch_1' }]);
  });

  it('completing internal review does not mark the report externally submitted', async () => {
    mocks.reportFindFirst.mockResolvedValue({
      id: 'pv_1',
      state: 'UNDER_REVIEW',
      updatedAt: revision,
    });
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
        where: expect.objectContaining({
          organizationId: 'org_1',
          branchId: 'branch_1',
          state: 'UNDER_REVIEW',
          updatedAt: revision,
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
      updatedAt: revision,
    });
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
      expect.objectContaining({
        where: expect.objectContaining({
          state: 'READY',
          externalSubmissionState: 'NOT_SUBMITTED',
          externalReference: null,
          externalFailureReason: null,
          updatedAt: revision,
        }),
        data: expect.not.objectContaining({ state: expect.anything() }),
      })
    );
    expect(mocks.reportUpdate.mock.calls[0]?.[0].data.externalSubmissionState).toBe('FAILED');
  });

  it('refuses competing lifecycle writes instead of overwriting the winning transition', async () => {
    mocks.reportFindFirst.mockResolvedValue({ id: 'pv_1', state: 'READY', updatedAt: revision });
    mocks.reportUpdate.mockRejectedValueOnce({ code: 'P2025' });

    await expect(
      pvCaller().transitionPharmacovigilanceReport({
        id: 'pv_1',
        branchId: 'branch_1',
        state: 'CLOSED',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it.each([
    ['DRAFT', 'NOT_SUBMITTED', 'PENDING'],
    ['READY', 'SUBMITTED', 'PENDING'],
    ['SUBMITTED', 'SUBMITTED', 'FAILED'],
  ] as const)(
    'rejects invalid internal/external submission transition %s/%s -> %s',
    async (state, externalSubmissionState, requestedState) => {
      mocks.reportFindFirst.mockResolvedValue({
        id: 'pv_1',
        state,
        externalSubmissionState,
        externalReference: externalSubmissionState === 'SUBMITTED' ? 'DRAP-1' : null,
        externalFailureReason: null,
        updatedAt: revision,
      });

      await expect(
        pvCaller().recordPharmacovigilanceSubmission({
          id: 'pv_1',
          branchId: 'branch_1',
          state: requestedState,
          ...(requestedState === 'FAILED' ? { failureReason: 'Network failure' } : {}),
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(mocks.reportUpdate).not.toHaveBeenCalled();
    }
  );

  it('compare-and-sets the full failure evidence so concurrent FAILED retries cannot overwrite it', async () => {
    mocks.reportFindFirst.mockResolvedValue({
      id: 'pv_1',
      state: 'READY',
      externalSubmissionState: 'FAILED',
      externalReference: null,
      externalFailureReason: 'First failure',
      updatedAt: revision,
    });
    mocks.reportUpdate.mockRejectedValueOnce({ code: 'P2025' });

    await expect(
      pvCaller().recordPharmacovigilanceSubmission({
        id: 'pv_1',
        branchId: 'branch_1',
        state: 'FAILED',
        failureReason: 'Second failure',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.reportUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          externalSubmissionState: 'FAILED',
          externalFailureReason: 'First failure',
          updatedAt: revision,
        }),
      })
    );
  });

  it.each(['SUBMITTED', 'FAILED'] as const)(
    'records a pending submission outcome %s after the internal report is closed',
    async (state) => {
      let report = {
        id: 'pv_1',
        state: 'READY',
        externalSubmissionState: 'PENDING',
        externalReference: null,
        externalFailureReason: null,
        updatedAt: revision,
      };
      mocks.reportFindFirst.mockImplementation(async () => ({ ...report }));
      mocks.reportUpdate.mockImplementation(async ({ data }) => {
        report = { ...report, ...data };
        return { ...report };
      });
      const api = pvCaller();
      await api.transitionPharmacovigilanceReport({
        id: 'pv_1',
        branchId: 'branch_1',
        state: 'CLOSED',
      });
      const result = await api.recordPharmacovigilanceSubmission({
        id: 'pv_1',
        branchId: 'branch_1',
        state,
        ...(state === 'SUBMITTED'
          ? { externalReference: 'DRAP-1' }
          : { failureReason: 'Endpoint unavailable' }),
      });

      expect(result).toMatchObject({
        state: 'CLOSED',
        externalSubmissionState: state,
        externalReference: state === 'SUBMITTED' ? 'DRAP-1' : null,
        externalFailureReason: state === 'FAILED' ? 'Endpoint unavailable' : null,
      });
      expect(mocks.reportUpdate).toHaveBeenLastCalledWith({
        where: {
          id: 'pv_1',
          organizationId: 'org_1',
          branchId: 'branch_1',
          state: 'CLOSED',
          externalSubmissionState: 'PENDING',
          externalReference: null,
          externalFailureReason: null,
          updatedAt: revision,
        },
        data: {
          externalSubmissionState: state,
          externalReference: state === 'SUBMITTED' ? 'DRAP-1' : null,
          externalFailureReason: state === 'FAILED' ? 'Endpoint unavailable' : null,
        },
      });
    }
  );

  it.each(['NOT_SUBMITTED', 'FAILED', 'SUBMITTED'] as const)(
    'does not start or retry a submission on a closed report with external state %s',
    async (externalSubmissionState) => {
      mocks.reportFindFirst.mockResolvedValue({
        id: 'pv_1',
        state: 'CLOSED',
        externalSubmissionState,
      });
      await expect(
        pvCaller().recordPharmacovigilanceSubmission({
          id: 'pv_1',
          branchId: 'branch_1',
          state: 'PENDING',
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(mocks.reportUpdate).not.toHaveBeenCalled();
    }
  );

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
    mocks.assignmentFindMany.mockResolvedValueOnce([{ branchId: 'branch_other' }]);
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

describe('RX-08 pharmacovigilance authorization', () => {
  const operations = [
    {
      name: 'capture',
      invoke: (api: ReturnType<typeof caller>) =>
        api.createPharmacovigilanceReport({
          branchId: 'branch_1',
          kind: 'ADVERSE_DRUG_REACTION',
          occurredAt: new Date('2026-09-01'),
          assertedDescription: 'Human asserted report',
        }),
    },
    {
      name: 'lifecycle transition',
      invoke: (api: ReturnType<typeof caller>) =>
        api.transitionPharmacovigilanceReport({
          id: 'pv_1',
          branchId: 'branch_1',
          state: 'CLOSED',
        }),
    },
    {
      name: 'submission outcome',
      invoke: (api: ReturnType<typeof caller>) =>
        api.recordPharmacovigilanceSubmission({
          id: 'pv_1',
          branchId: 'branch_1',
          state: 'SUBMITTED',
          externalReference: 'DRAP-1',
        }),
    },
    {
      name: 'DRAP export',
      invoke: (api: ReturnType<typeof caller>) =>
        api.exportPharmacovigilanceDrap({
          branchId: 'branch_1',
          from: new Date('2026-09-01'),
          to: new Date('2026-09-30'),
        }),
    },
  ];

  beforeEach(() => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'pharmacy:safety');
    mocks.branchFindFirst.mockResolvedValue({ id: 'branch_1' });
    mocks.assignmentFindMany.mockResolvedValue([{ branchId: 'branch_1' }]);
    mocks.reportFindFirst.mockResolvedValue({
      id: 'pv_1',
      state: 'READY',
      externalSubmissionState: 'NOT_SUBMITTED',
      externalReference: null,
      externalFailureReason: null,
      updatedAt: new Date('2026-10-29T00:00:00.000Z'),
    });
    mocks.reportCreate.mockResolvedValue({ id: 'pv_1' });
    mocks.reportUpdate.mockResolvedValue({ id: 'pv_1' });
    mocks.reportFindMany.mockResolvedValue([]);
  });

  describe.each(operations)('$name', ({ invoke }) => {
    it('denies staff without safety capability before accessing branch or clinical data', async () => {
      mocks.can.mockResolvedValue(false);
      await expect(invoke(caller('EMPLOYEE'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
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

    it.each(['ADMIN', 'EMPLOYEE'])(
      'denies an unassigned branch even for a capable %s',
      async (role) => {
        mocks.assignmentFindMany.mockResolvedValue([{ branchId: 'branch_other' }]);
        await expect(invoke(caller(role))).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(mocks.reportFindFirst).not.toHaveBeenCalled();
        expect(mocks.reportFindMany).not.toHaveBeenCalled();
        expect(mocks.reportCreate).not.toHaveBeenCalled();
        expect(mocks.reportUpdate).not.toHaveBeenCalled();
      }
    );

    it('allows capable staff assigned to the active tenant branch', async () => {
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
      expect(mocks.branchFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'branch_1', organizationId: 'org_1', active: true },
        })
      );
    });
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
