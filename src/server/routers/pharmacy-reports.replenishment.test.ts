import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PharmacyReplenishmentReportReaderInput } from '@/lib/pharmacy/replenishment-report';

const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  branches: vi.fn(),
  read: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/replenishment-report', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/replenishment-report')>(
    '@/lib/pharmacy/replenishment-report'
  )),
  readPharmacyReplenishmentReport: mocks.read,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: mocks.audit,
}));

import { hasModule } from '@/lib/entitlements';
import type { TRPCContext } from '../trpc';
import { pharmacyReportsRouter } from './pharmacy-reports';

const readAt = new Date('2026-09-14T12:00:00Z');
const input = {
  branchId: 'branch',
  medicineId: 'medicine',
  historyStartDate: '2026-09-10',
  originDate: '2026-09-13',
  horizonDays: 2,
  method: 'RECENT_MEAN' as const,
};
function caller(role = 'ADMIN', session = true) {
  const db = { pharmacyBranch: { findMany: mocks.branches } };
  return {
    db,
    api: pharmacyReportsRouter.createCaller({
      db,
      entitlements: { organizationId: 'org', enabledModules: ['pharmacy-reports'], modules: [] },
      session: session
        ? { expires: 'later', user: { id: 'actor', role, status: 'ACTIVE', organizationId: 'org' } }
        : null,
      organization: { id: 'org' },
      support: null,
      requestMeta: { ip: null, userAgent: null },
      audit: { detail: {} },
    } as unknown as TRPCContext),
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(readAt);
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  vi.mocked(hasModule).mockImplementation((_entitlements, module) => module === 'pharmacy-reports');
  mocks.branches.mockResolvedValue([{ id: 'branch', name: 'Main' }]);
  mocks.read.mockImplementation(async (_db, resolved: PharmacyReplenishmentReportReaderInput) => ({
    permissions: { financial: resolved.financial },
    forecast: { status: 'INSUFFICIENT_EVIDENCE', result: null },
  }));
});
afterEach(() => vi.useRealTimers());

describe('authenticated ordinary replenishment report endpoint', () => {
  it('binds server tenant and active branches and works with AskFathom disabled', async () => {
    const { api, db } = caller();
    expect(await api.replenishment(input)).toMatchObject({
      permissions: { financial: true },
      forecast: { result: null },
    });
    expect(mocks.branches).toHaveBeenCalledWith({
      where: { organizationId: 'org', active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    expect(mocks.read).toHaveBeenCalledWith(
      db,
      { ...input, organizationId: 'org', authorizedBranchIds: ['branch'], financial: true },
      readAt
    );
    expect(vi.mocked(hasModule).mock.calls.every((call) => call[1] === 'pharmacy-reports')).toBe(
      true
    );
    expect(mocks.can.mock.calls.map((call) => call[1])).toEqual([
      'reports:operational',
      'reports:financial',
    ]);
    expect(pharmacyReportsRouter._def.procedures.replenishment._def.type).toBe('query');
  });

  it('denies an unauthenticated caller before capability, branch or evidence reads', async () => {
    await expect(caller('ADMIN', false).api.replenishment(input)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mocks.can).not.toHaveBeenCalled();
    expect(mocks.branches).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('denies operational permission before branch or evidence reads', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().api.replenishment(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.branches).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('denies an unlicensed module before branch or evidence reads', async () => {
    vi.mocked(hasModule).mockReturnValue(false);
    await expect(caller().api.replenishment(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.branches).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it.each(['foreign', 'inactive'])('denies %s branch before evidence reads', async (branchId) => {
    await expect(caller().api.replenishment({ ...input, branchId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('passes financial denial to service while retaining operational access', async () => {
    mocks.can.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await caller().api.replenishment(input)).toMatchObject({
      permissions: { financial: false },
    });
    expect(mocks.read.mock.calls[0][1].financial).toBe(false);
  });
  it('retains the owner financial gate for non-owners even with capability', async () => {
    expect(await caller('EMPLOYEE').api.replenishment(input)).toMatchObject({
      permissions: { financial: false },
    });
    expect(mocks.can.mock.calls.map((call) => call[1])).toEqual(['reports:operational']);
  });
  it.each([
    { organizationId: 'foreign' },
    { authorizedBranchIds: ['foreign'] },
    { financial: true },
    { readAt: '2000-01-01' },
    { patientId: 'patient' },
    { medicineId: '' },
    { historyStartDate: '2026-02-30' },
    { historyStartDate: '2026-01-01' },
    { originDate: '2026-09-15' },
    { horizonDays: 367 },
    { method: 'INVENTED' },
  ])('rejects invalid input/server-field spoofing: %j', async (overrides) => {
    await expect(
      caller().api.replenishment({ ...input, ...overrides } as typeof input)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('sanitizes source errors without exposing patient or database detail', async () => {
    mocks.read.mockRejectedValue(new Error('patient identity database password'));
    await expect(caller().api.replenishment(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Replenishment evidence is unavailable for this scope or scenario.',
    });
  });
});
