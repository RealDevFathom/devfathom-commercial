import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => false),
  branchFindMany: vi.fn(),
  settingUpsert: vi.fn(),
  branchFindFirst: vi.fn(),
  reportFindFirst: vi.fn(),
  reportFindMany: vi.fn(),
  reportUpdate: vi.fn(),
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
import { pharmacyReportsRouter } from './pharmacy-reports';

function caller() {
  return pharmacyReportsRouter.createCaller({
    db: {
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
      user: { id: 'user_admin', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org_1' },
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
});

describe('RX-08 pharmacovigilance state boundaries', () => {
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
    expect(result.externalSubmissionState).toBe('NOT_SUBMITTED');
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
