import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  read: vi.fn(),
  branches: vi.fn(),
  transaction: vi.fn(),
  tx: { $queryRaw: vi.fn() },
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
vi.mock('@/lib/pharmacy/reports', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/reports')>('@/lib/pharmacy/reports')),
  readPharmacyOwnerCommandCentre: mocks.read,
}));

import type { TRPCContext } from '../trpc';
import { pharmacyReportsRouter } from './pharmacy-reports';

const input = { branchId: 'branch_1', from: '2026-09-01', to: '2026-09-10' };

function caller() {
  return pharmacyReportsRouter.createCaller({
    db: {
      $transaction: mocks.transaction,
      pharmacyBranch: { findMany: mocks.branches },
    },
    entitlements: {
      organizationId: 'org_1',
      enabledModules: ['pharmacy-reports'],
      modules: [],
    },
    session: {
      expires: 'later',
      user: { id: 'owner_1', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org_1' },
    },
    organization: { id: 'org_1', timezone: 'Asia/Karachi' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('command-centre transaction-local Khata context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.branches.mockResolvedValue([{ id: 'branch_1', name: 'Main' }]);
    mocks.transaction.mockImplementation(async (work) => work(mocks.tx));
    mocks.read.mockResolvedValue({ metrics: { khataAgingMinor: 4200, salesMinor: 10000 } });
  });

  it('runs the owner report reader through one transaction client', async () => {
    const result = await caller().commandCentre(input);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.read).toHaveBeenCalledWith(mocks.tx, {
      ...input,
      branchIds: ['branch_1'],
      timeZone: 'Asia/Karachi',
    });
    expect(result.permissions).toEqual({ operational: true, financial: true });
    expect(result.metrics.khataAgingMinor).toBe(4200);
  });

  it('preserves financial masking after the transaction read', async () => {
    mocks.can.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const result = await caller().commandCentre(input);
    expect(mocks.read).toHaveBeenCalledWith(mocks.tx, expect.any(Object));
    expect(result.permissions.financial).toBe(false);
    expect(result.metrics.khataAgingMinor).toBeNull();
  });
});
