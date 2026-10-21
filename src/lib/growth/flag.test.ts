import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn(), withPlatformDb: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => mocks);

import { isGrowthEnabled } from '.';

const organizationId = 'org_growth_test';
const now = new Date('2026-10-21T00:00:00Z');
const grant = {
  moduleId: 'mod_growth',
  status: 'ENABLED',
  startsAt: new Date('2026-10-01T00:00:00Z'),
  expiresAt: null,
  seatLimit: null,
  overrides: null,
};
const tenantDb = {
  organization: { findUnique: vi.fn() },
  organizationModule: { findMany: vi.fn() },
  organizationLimit: { findMany: vi.fn() },
  user: { count: vi.fn() },
};
const platformDb = {
  platformModule: { findMany: vi.fn() },
  platformPackage: { findUnique: vi.fn() },
  platformContract: { findMany: vi.fn() },
};

describe('isGrowthEnabled through real entitlement resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.withTenantDb.mockImplementation((id, run) => {
      expect(id).toBe(organizationId);
      return run(tenantDb);
    });
    mocks.withPlatformDb.mockImplementation((run) => run(platformDb));
    tenantDb.organization.findUnique.mockResolvedValue({
      id: organizationId,
      seatLimit: 1,
      packageId: null,
      vertical: 'AGENCY',
    });
    tenantDb.organizationModule.findMany.mockResolvedValue([]);
    tenantDb.organizationLimit.findMany.mockResolvedValue([]);
    tenantDb.user.count.mockResolvedValue(0);
    platformDb.platformModule.findMany.mockResolvedValue([
      { id: 'mod_growth', key: 'growth_ai', name: 'Growth AI', band: 'PLATFORM' },
    ]);
    platformDb.platformPackage.findUnique.mockResolvedValue(null);
    platformDb.platformContract.findMany.mockResolvedValue([]);
  });
  afterEach(() => vi.useRealTimers());

  it('defaults off without a module grant and scopes tenant reads to Organization.id', async () => {
    await expect(isGrowthEnabled(organizationId)).resolves.toBe(false);
    expect(tenantDb.organization.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: organizationId } })
    );
    expect(tenantDb.organizationModule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId } })
    );
    expect(platformDb.platformModule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { active: true } })
    );
  });

  it.each([
    [{}, true],
    [{ status: 'TRIAL' }, true],
    [{ status: 'DISABLED' }, false],
    [{ expiresAt: now }, false],
    [{ startsAt: new Date('2026-10-22T00:00:00Z') }, false],
  ])('honors override status and time: %j', async (change, expected) => {
    tenantDb.organizationModule.findMany.mockResolvedValue([{ ...grant, ...change }]);
    await expect(isGrowthEnabled(organizationId)).resolves.toBe(expected);
  });

  it('stays off if growth_ai is absent from the active catalog, even with an override', async () => {
    platformDb.platformModule.findMany.mockResolvedValue([]);
    tenantDb.organizationModule.findMany.mockResolvedValue([grant]);
    await expect(isGrowthEnabled(organizationId)).resolves.toBe(false);
  });

  it('inherits package grants but respects an explicit disable', async () => {
    tenantDb.organization.findUnique.mockResolvedValue({
      id: organizationId,
      seatLimit: 1,
      packageId: 'pkg_growth',
      vertical: 'AGENCY',
    });
    platformDb.platformPackage.findUnique.mockResolvedValue({
      moduleLinks: [{ limits: null, module: { id: 'mod_growth', active: true } }],
    });
    await expect(isGrowthEnabled(organizationId)).resolves.toBe(true);
    tenantDb.organizationModule.findMany.mockResolvedValue([{ ...grant, status: 'DISABLED' }]);
    await expect(isGrowthEnabled(organizationId)).resolves.toBe(false);
  });

  it('inherits a live contract using the existing status and time filters', async () => {
    platformDb.platformContract.findMany.mockResolvedValue([
      {
        seatLimit: 1,
        endDate: new Date('2026-11-01T00:00:00Z'),
        graceUntil: null,
        modules: [{ seatLimit: null, limits: null, module: { id: 'mod_growth', active: true } }],
      },
    ]);
    await expect(isGrowthEnabled(organizationId)).resolves.toBe(true);
    expect(platformDb.platformContract.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId,
          status: { in: ['ACTIVE', 'GRACE', 'RENEWAL_DUE'] },
          startDate: { lte: now },
          OR: [{ endDate: { gte: now } }, { graceUntil: { gte: now } }],
        },
      })
    );
  });
});
