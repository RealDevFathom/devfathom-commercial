import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  counterAccess: vi.fn(),
  dayCloseAccess: vi.fn(),
  managerReportBranches: vi.fn(),
}));
vi.mock('@/lib/abac', () => ({ can: mocks.can, subjectFromSession: (user: unknown) => user }));
vi.mock('./pharmacy-sales', () => ({
  canAccessPharmacyCounter: mocks.counterAccess,
  canAccessDayClose: mocks.dayCloseAccess,
}));
// The reports decision: the ABAC grant reaches every branch, otherwise a
// Manager's assigned branches (DEV-505).
vi.mock('./pharmacy-reports', () => ({
  pharmacyReportAccess: async (ctx: { db: unknown; session: { user: unknown } }) =>
    (await mocks.can(ctx.session.user, 'reports:operational', undefined, {
      db: ctx.db,
      source: 'TRPC',
    }))
      ? 'ALL'
      : mocks.managerReportBranches(),
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
  mocks.dayCloseAccess.mockReset().mockResolvedValue(false);
  mocks.managerReportBranches.mockReset().mockResolvedValue([]);
});

describe('#979 pharmacy rail capability read', () => {
  it('is licensed by mandatory Pharmacy Core', () => {
    expect(moduleForProcedure('pharmacyAccess.navigation')).toBe('pharmacy-core');
  });

  it('gives a cashier none of the gated rail capabilities', async () => {
    const result = await caller().navigation();

    expect(result).toEqual({ userId: 'cashier', organizationId: 'org_a', capabilities: [] });
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
    expect(asked).not.toContain('pharmacy:close');
    expect(mocks.counterAccess).toHaveBeenCalledTimes(1);
    expect(mocks.dayCloseAccess).toHaveBeenCalledTimes(1);
  });

  it('advertises Counter only when the counter server guard authorizes access', async () => {
    // A coarse ABAC grant must not bypass the counter's alias DENYs or branch scope.
    mocks.can.mockResolvedValue(true);
    expect((await caller().navigation()).capabilities).not.toContain('pharmacy:counter');
    mocks.counterAccess.mockResolvedValue(true);
    expect((await caller().navigation()).capabilities).toContain('pharmacy:counter');
  });

  // DEV-505: Day close follows the day-close server decision, never a coarse grant.
  it('advertises Day close only when the day-close server guard authorizes access', async () => {
    mocks.can.mockResolvedValue(true);
    expect((await caller().navigation()).capabilities).not.toContain('pharmacy:close');
    mocks.dayCloseAccess.mockResolvedValue(true);
    expect((await caller().navigation()).capabilities).toContain('pharmacy:close');
  });

  // DEV-505: a Manager without `reports:operational` is offered Reports only when
  // their reports are scoped to at least one assigned branch.
  it('advertises Reports to a Manager with an assigned branch, not one without', async () => {
    const manager = caller({ id: 'manager', role: 'EMPLOYEE' });
    expect((await manager.navigation()).capabilities).not.toContain('reports:operational');
    mocks.managerReportBranches.mockResolvedValue(['branch-a']);
    mocks.dayCloseAccess.mockResolvedValue(true);
    mocks.can.mockImplementation(
      async (_subject: unknown, action: string) => action === 'pharmacy:procurement'
    );
    expect((await manager.navigation()).capabilities).toEqual([
      'pharmacy:procurement',
      'reports:operational',
      'pharmacy:close',
    ]);
  });
});
