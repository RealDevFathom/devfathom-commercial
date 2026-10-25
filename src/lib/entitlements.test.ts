import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ withPlatformDb: vi.fn() }));

vi.mock('@/lib/tenancy/scoped-db', () => ({ withPlatformDb: mocks.withPlatformDb }));

import { resolveOrganizationEntitlements } from './entitlements';

describe('baseline entitlement resolution', () => {
  beforeEach(() => vi.clearAllMocks());

  it('always enables baseline modules and ignores package or override plumbing', async () => {
    const now = new Date('2026-09-02T00:00:00.000Z');
    const db = {
      organization: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'org_1',
          seatLimit: 5,
          packageId: 'pkg_1',
          vertical: 'AGENCY',
        }),
      },
      organizationModule: {
        findMany: vi.fn().mockResolvedValue([
          {
            moduleId: 'mod_dashboard',
            status: 'DISABLED',
            seatLimit: null,
            startsAt: now,
            expiresAt: null,
            overrides: null,
          },
        ]),
      },
      organizationLimit: { findMany: vi.fn().mockResolvedValue([]) },
      user: { count: vi.fn().mockResolvedValue(1) },
    };
    const platformDb = {
      organization: { findUnique: vi.fn().mockResolvedValue({ packageId: 'pkg_1' }) },
      platformModule: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'mod_dashboard', key: 'dashboard', name: 'Dashboard', band: 'BASELINE' },
          { id: 'mod_projects', key: 'projects', name: 'Projects', band: 'VERTICAL_OPTIONAL' },
        ]),
      },
      platformPackage: {
        findUnique: vi.fn().mockResolvedValue({
          moduleLinks: [
            { limits: null, module: { id: 'mod_dashboard', active: true } },
            { limits: null, module: { id: 'mod_projects', active: true } },
          ],
        }),
      },
      platformContract: { findMany: vi.fn().mockResolvedValue([]) },
    };
    mocks.withPlatformDb.mockImplementation((run: (client: typeof platformDb) => unknown) =>
      run(platformDb)
    );

    const result = await resolveOrganizationEntitlements('org_1', db as never, now);

    expect(result.enabledModules).toEqual(['dashboard', 'projects']);
    expect(result.modules).toEqual([
      {
        key: 'dashboard',
        name: 'Dashboard',
        enabled: true,
        source: 'BASELINE',
        seatLimit: null,
        expiresAt: null,
      },
      {
        key: 'projects',
        name: 'Projects',
        enabled: true,
        source: 'PACKAGE',
        seatLimit: null,
        expiresAt: null,
      },
    ]);
  });

  it('CTO-P1 keeps a contract-shaped manual denial above an optional package grant', async () => {
    const now = new Date('2026-10-25T00:00:00.000Z');
    const db = {
      organization: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'org_1',
          seatLimit: 5,
          packageId: 'pkg_1',
          vertical: 'PHARMACY',
        }),
      },
      organizationModule: {
        findMany: vi.fn().mockResolvedValue([
          {
            moduleId: 'mod_optional',
            status: 'DISABLED',
            seatLimit: null,
            startsAt: now,
            expiresAt: null,
            overrides: null,
            reason: 'Contract CON-304',
          },
        ]),
      },
      organizationLimit: { findMany: vi.fn().mockResolvedValue([]) },
      user: { count: vi.fn().mockResolvedValue(1) },
    };
    const platformDb = {
      platformModule: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'mod_optional',
            key: 'optional',
            name: 'Optional',
            band: 'VERTICAL_OPTIONAL',
          },
        ]),
      },
      platformPackage: {
        findUnique: vi.fn().mockResolvedValue({
          moduleLinks: [{ limits: null, module: { id: 'mod_optional', active: true } }],
        }),
      },
      platformContract: { findMany: vi.fn().mockResolvedValue([]) },
    };
    mocks.withPlatformDb.mockImplementation((run: (client: typeof platformDb) => unknown) =>
      run(platformDb)
    );

    const result = await resolveOrganizationEntitlements('org_1', db as never, now);

    expect(result.enabledModules).not.toContain('optional');
    expect(result.modules).toEqual([
      expect.objectContaining({
        key: 'optional',
        enabled: false,
        source: 'OVERRIDE',
        seatLimit: null,
        expiresAt: null,
      }),
    ]);
  });

  it('uses the package from an organization visible only inside the supplied transaction', async () => {
    const now = new Date('2026-09-04T00:00:00.000Z');
    const db = {
      organization: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'org_uncommitted',
          seatLimit: 5,
          packageId: 'pkg_restaurant',
          vertical: 'RESTAURANT',
        }),
      },
      organizationModule: { findMany: vi.fn().mockResolvedValue([]) },
      organizationLimit: { findMany: vi.fn().mockResolvedValue([]) },
      user: { count: vi.fn().mockResolvedValue(1) },
    };
    const platformDb = {
      organization: { findUnique: vi.fn().mockResolvedValue(null) },
      platformModule: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'mod_restaurant_menu',
            key: 'restaurant-menu',
            name: 'Restaurant Menu',
            band: 'VERTICAL_OPTIONAL',
          },
        ]),
      },
      platformPackage: {
        findUnique: vi.fn().mockResolvedValue({
          moduleLinks: [{ limits: null, module: { id: 'mod_restaurant_menu', active: true } }],
        }),
      },
      platformContract: { findMany: vi.fn().mockResolvedValue([]) },
    };
    mocks.withPlatformDb.mockImplementation((run: (client: typeof platformDb) => unknown) =>
      run(platformDb)
    );

    const result = await resolveOrganizationEntitlements('org_uncommitted', db as never, now);

    expect(platformDb.organization.findUnique).not.toHaveBeenCalled();
    expect(platformDb.platformPackage.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pkg_restaurant' } })
    );
    expect(result.enabledModules).toContain('restaurant-menu');
    expect(result.modules[0]?.source).toBe('PACKAGE');
  });
});
