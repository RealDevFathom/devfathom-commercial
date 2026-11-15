import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ can: vi.fn(), counterAccess: vi.fn(), closeBranches: vi.fn() }));
vi.mock('@/lib/abac', () => ({ can: mocks.can, subjectFromSession: (user: unknown) => user }));
vi.mock('./pharmacy-sales', () => ({
  canAccessPharmacyCounter: mocks.counterAccess,
  pharmacyCloseBranchIds: mocks.closeBranches,
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

import { moduleForProcedure } from '@/lib/module-catalog';
import type { TRPCContext } from '../trpc';
import { PHARMACY_NAVIGATION_CAPABILITIES, pharmacyAccessRouter } from './pharmacy-access';

const db = {};

function caller(user: { id: string; role: string } = { id: 'cashier', role: 'EMPLOYEE' }) {
  return pharmacyAccessRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_a',
      enabledModules: ['pharmacy-core'],
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: {},
    },
    session: { expires: 'later', user: { ...user, status: 'ACTIVE' } },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  mocks.can.mockReset().mockResolvedValue(false);
  mocks.counterAccess.mockReset().mockResolvedValue(false);
  mocks.closeBranches.mockReset().mockResolvedValue([]);
});

describe('#979 pharmacy rail capability read', () => {
  it('is licensed by mandatory Pharmacy Core', () => {
    expect(moduleForProcedure('pharmacyAccess.navigation')).toBe('pharmacy-core');
  });

  it('gives a cashier none of the gated rail capabilities', async () => {
    const result = await caller().navigation();

    expect(result).toEqual({
      userId: 'cashier',
      organizationId: 'org_a',
      capabilities: [],
      closeBranchIds: [],
    });
    expect(mocks.counterAccess).toHaveBeenCalledWith(expect.objectContaining({ db }));
    for (const capability of PHARMACY_NAVIGATION_CAPABILITIES) {
      if (capability === 'pharmacy:counter' || capability === 'pharmacy:close') continue;
      expect(mocks.can).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'cashier' }),
        capability,
        undefined,
        expect.objectContaining({ db, source: 'TRPC' })
      );
    }
  });

  it('returns exactly what the ABAC engine grants, in catalogue order', async () => {
    mocks.can.mockImplementation(
      async (_subject: unknown, action: string) =>
        action === 'reports:operational' || action === 'pharmacy:procurement'
    );

    const result = await caller({ id: 'manager', role: 'EMPLOYEE' }).navigation();

    expect(result.capabilities).toEqual(['pharmacy:procurement', 'reports:operational']);
  });

  it('never asks about a capability outside the rail', async () => {
    await caller().navigation();

    const asked = mocks.can.mock.calls.map(([, action]) => action);
    expect(asked.sort()).toEqual(
      PHARMACY_NAVIGATION_CAPABILITIES.filter(
        (capability) => capability !== 'pharmacy:counter' && capability !== 'pharmacy:close'
      ).sort()
    );
    expect(asked).not.toContain('pharmacy:counter');
    expect(mocks.counterAccess).toHaveBeenCalledTimes(1);
  });

  it('advertises Counter only when the counter server guard authorizes access', async () => {
    // A coarse ABAC grant must not bypass the counter's alias DENYs or branch scope.
    mocks.can.mockResolvedValue(true);
    expect((await caller().navigation()).capabilities).not.toContain('pharmacy:counter');
    mocks.counterAccess.mockResolvedValue(true);
    expect((await caller().navigation()).capabilities).toContain('pharmacy:counter');
  });
});

describe('DEV-240 navigation decisions', () => {
  it('reports Inventory only with its capability and Day close only with an admitted branch', async () => {
    mocks.can.mockResolvedValue(true);
    expect((await caller().navigation()).capabilities).toContain('pharmacy:inventory');
    expect((await caller().navigation()).capabilities).not.toContain('pharmacy:close');
    mocks.closeBranches.mockResolvedValue(['branch-1']);
    const result = await caller().navigation();
    expect(result.capabilities).toContain('pharmacy:close');
    expect(result.closeBranchIds).toEqual(['branch-1']);
  });

  it.each([
    { userId: 'another-user', organizationId: 'org_a' },
    { userId: 'cashier', organizationId: 'another-org' },
  ])('refuses a mismatched cache identity %j before checking access', async (input) => {
    await expect(caller().navigation(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.can).not.toHaveBeenCalled();
    expect(mocks.counterAccess).not.toHaveBeenCalled();
    expect(mocks.closeBranches).not.toHaveBeenCalled();
  });
});
