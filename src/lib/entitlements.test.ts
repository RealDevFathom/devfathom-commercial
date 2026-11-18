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

describe('DEV-913 pharmacy audit log entitlement', () => {
  beforeEach(() => vi.clearAllMocks());

  function setup(vertical: string, override: 'DISABLED' | null) {
    const now = new Date('2026-11-18T00:00:00.000Z');
    const db = {
      organization: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: 'org_1', seatLimit: 5, packageId: null, vertical }),
      },
      organizationModule: {
        findMany: vi.fn().mockResolvedValue(
          override
            ? [
                {
                  moduleId: 'mod_audit',
                  status: override,
                  seatLimit: null,
                  startsAt: now,
                  expiresAt: null,
                  overrides: null,
                },
              ]
            : []
        ),
      },
      organizationLimit: { findMany: vi.fn().mockResolvedValue([]) },
      user: { count: vi.fn().mockResolvedValue(1) },
    };
    const platformDb = {
      platformModule: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'mod_audit', key: 'audit', name: 'Audit logs', band: 'PLATFORM' },
          { id: 'mod_hr', key: 'hr', name: 'HR', band: 'PLATFORM' },
        ]),
      },
      platformPackage: { findUnique: vi.fn().mockResolvedValue(null) },
      platformContract: { findMany: vi.fn().mockResolvedValue([]) },
    };
    mocks.withPlatformDb.mockImplementation((run: (client: typeof platformDb) => unknown) =>
      run(platformDb)
    );
    return { db, now };
  }

  it.each([null, 'DISABLED'] as const)(
    'enables audit for a pharmacy with no plan grant (override %s)',
    async (override) => {
      const { db, now } = setup('PHARMACY', override);
      const result = await resolveOrganizationEntitlements('org_1', db as never, now);
      expect(result.enabledModules).toEqual(['audit']);
      expect(result.modules.find((module) => module.key === 'audit')).toMatchObject({
        enabled: true,
        source: 'BASELINE',
      });
    }
  );

  it.each(['AGENCY', 'RESTAURANT', 'HOSPITALITY'])(
    'leaves audit to the plan for %s',
    async (vertical) => {
      const { db, now } = setup(vertical, null);
      const result = await resolveOrganizationEntitlements('org_1', db as never, now);
      expect(result.enabledModules).toEqual([]);
    }
  );

  it('enables audit for a pharmacy even when the catalog lacks the row', async () => {
    const { db, now } = setup('PHARMACY', null);
    const platformDb = {
      platformModule: { findMany: vi.fn().mockResolvedValue([]) },
      platformPackage: { findUnique: vi.fn().mockResolvedValue(null) },
      platformContract: { findMany: vi.fn().mockResolvedValue([]) },
    };
    mocks.withPlatformDb.mockImplementation((run: (client: typeof platformDb) => unknown) =>
      run(platformDb)
    );
    const result = await resolveOrganizationEntitlements('org_1', db as never, now);
    expect(result.enabledModules).toEqual(['audit']);
  });
});
