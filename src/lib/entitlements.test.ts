import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ withPlatformDb: vi.fn(), withTenantDb: vi.fn() }));

vi.mock('@/lib/tenancy/scoped-db', () => mocks);

import {
  resolveCurrentOrganizationEntitlements,
  resolveOrganizationEntitlements,
} from './entitlements';

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

describe('current entitlement snapshots', () => {
  const moduleId = 'mod_academics';
  const moduleKey = 'university-academics';

  function gate() {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { wait, open };
  }

  it('shares queued reads by tenant, releases the tenant connection, and observes a revocation while a prior snapshot is still finishing', async () => {
    const connection = gate();
    const firstControlRead = gate();
    const controlStarted = gate();
    const disabled = new Set<string>();
    const held = new Set<string>();
    mocks.withTenantDb.mockImplementation(async (id, read) => {
      await connection.wait;
      held.add(id);
      try {
        return await read({
          organization: {
            findUnique: () => ({ id, seatLimit: 5, packageId: id, vertical: 'UNIVERSITY' }),
          },
          organizationModule: {
            findMany: () =>
              disabled.has(id)
                ? [
                    {
                      moduleId,
                      status: 'DISABLED',
                      seatLimit: null,
                      startsAt: new Date(0),
                      expiresAt: null,
                      overrides: null,
                    },
                  ]
                : [],
          },
          organizationLimit: { findMany: () => [] },
          user: { count: () => 1 },
        });
      } finally {
        held.delete(id);
      }
    });
    let firstAlpha = true;
    mocks.withPlatformDb.mockImplementation(async (read) =>
      read({
        platformModule: {
          findMany: () => [
            { id: moduleId, key: moduleKey, name: 'Academics', band: 'VERTICAL_OPTIONAL' },
          ],
        },
        platformContract: { findMany: () => [] },
        platformPackage: {
          findUnique: async ({ where }: { where: { id: string } }) => {
            expect(held.has(where.id)).toBe(false);
            if (where.id === 'alpha' && firstAlpha) {
              firstAlpha = false;
              controlStarted.open();
              await firstControlRead.wait;
            }
            return { moduleLinks: [{ limits: null, module: { id: moduleId, active: true } }] };
          },
        },
      })
    );
    const prior = resolveCurrentOrganizationEntitlements('alpha');
    expect(resolveCurrentOrganizationEntitlements('alpha')).toBe(prior);
    const other = resolveCurrentOrganizationEntitlements('bravo');
    expect(other).not.toBe(prior);
    connection.open();
    await controlStarted.wait;
    disabled.add('alpha');
    const fresh = await resolveCurrentOrganizationEntitlements('alpha');
    expect(fresh.enabledModules).not.toContain(moduleKey);
    firstControlRead.open();
    expect((await prior).enabledModules).toContain(moduleKey);
    expect((await other).organizationId).toBe('bravo');
    disabled.delete('alpha');
    expect((await resolveCurrentOrganizationEntitlements('alpha')).enabledModules).toContain(
      moduleKey
    );
  });

  it('drops failed queued reads so the tenant can retry immediately', async () => {
    mocks.withTenantDb
      .mockRejectedValueOnce(new Error('connection one'))
      .mockRejectedValueOnce(new Error('connection two'));
    const first = resolveCurrentOrganizationEntitlements('retry');
    expect(resolveCurrentOrganizationEntitlements('retry')).toBe(first);
    await expect(first).rejects.toThrow('connection one');
    await expect(resolveCurrentOrganizationEntitlements('retry')).rejects.toThrow('connection two');
  });
});
