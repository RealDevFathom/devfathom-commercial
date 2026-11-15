import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSSRHelpers: vi.fn(),
  redirect: vi.fn(),
  can: vi.fn(),
  loadSetupChecklist: vi.fn(),
  loadHotelLanding: vi.fn(),
  createHotelCaller: vi.fn(),
  withTenantDb: vi.fn(),
  loadPharmacyStaffHome: vi.fn(),
  db: {},
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/abac', () => ({ can: mocks.can, subjectFromSession: (user: unknown) => user }));
vi.mock('@/lib/onboarding/setup-evaluator', () => ({
  loadSetupChecklist: mocks.loadSetupChecklist,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: mocks.withTenantDb }));
vi.mock('./pharmacy-dashboard-content', () => ({ PharmacyDashboardContent: () => null }));
vi.mock('./pharmacy-staff-home', () => ({ PharmacyStaffHome: () => null }));
vi.mock('@/lib/pharmacy/staff-home', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/staff-home')>(
    '@/lib/pharmacy/staff-home'
  )),
  loadPharmacyStaffHome: mocks.loadPharmacyStaffHome,
}));
vi.mock('./hotel-dashboard-content', () => ({ HotelDashboardContent: () => null }));
vi.mock('@/lib/hotel/landing', () => ({ loadHotelLanding: mocks.loadHotelLanding }));
vi.mock('@/server/routers/hotel-property', () => ({
  hotelPropertyRouter: { createCaller: mocks.createHotelCaller },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.redirect.mockImplementation(() => {
    throw new Error('redirect');
  });
  mocks.withTenantDb.mockImplementation((_id, callback) => callback(mocks.db));
});

vi.mock('@/lib/trpc-server', () => ({ createSSRHelpers: mocks.createSSRHelpers }));
vi.mock('@tanstack/react-query', () => ({
  HydrationBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('./dashboard-content', () => ({ DashboardContent: () => null }));
vi.mock('./restaurant-dashboard-content', () => ({ RestaurantDashboardContent: () => null }));

import DashboardPage from './page';
import { PharmacyDashboardContent } from './pharmacy-dashboard-content';
import { PharmacyStaffHome } from './pharmacy-staff-home';
import { HotelDashboardContent } from './hotel-dashboard-content';
import { RestaurantDashboardContent } from './restaurant-dashboard-content';
import { PharmacistHome } from './pharmacist-home';

function helpers() {
  return {
    dashboard: {
      getStats: { prefetch: vi.fn() },
      getRecentActivity: { prefetch: vi.fn() },
      getUpcomingDeadlines: { prefetch: vi.fn() },
      getProjectCards: { prefetch: vi.fn() },
      getMyTasks: { prefetch: vi.fn() },
    },
    meetings: { getUpcoming: { prefetch: vi.fn() } },
    team: { getAll: { prefetch: vi.fn() } },
    dehydrate: vi.fn(),
  };
}

describe('DashboardPage vertical dispatch', () => {
  it.each([
    ['owner', 'ADMIN', ['admin:access', 'orders:take'], true, '/restaurant'],
    ['delegated manager', 'EMPLOYEE', ['admin:access'], true, '/restaurant'],
    ['waiter', 'EMPLOYEE', ['orders:take'], true, '/pos'],
    ['cashier', 'EMPLOYEE', ['orders:take'], true, '/pos'],
    ['restricted administrator', 'ADMIN', ['orders:take'], true, '/pos'],
    ['kitchen', 'EMPLOYEE', ['kitchen:operate'], true, null],
    ['inventory', 'EMPLOYEE', ['inventory:read'], true, null],
    ['finance', 'EMPLOYEE', ['money:read'], true, null],
    ['no grants', 'EMPLOYEE', [], true, null],
    ['administrator with denied grants', 'ADMIN', [], true, null],
    ['waiter without POS module', 'EMPLOYEE', ['orders:take'], false, null],
  ])(
    'selects the effective landing for %s (%s)',
    async (_persona, role, capabilities, posEnabled, target) => {
      const agencyHelpers = helpers();
      const user = { id: 'restaurant-user', role, status: 'ACTIVE' };
      mocks.can.mockImplementation(async (_subject, action) => capabilities.includes(action));
      const enabledModules = ['restaurant-core', ...(posEnabled ? ['restaurant-pos'] : [])];
      mocks.createSSRHelpers.mockResolvedValue({
        helpers: agencyHelpers,
        organization: { id: 'restaurant-org' },
        session: { user },
        entitlements: { vertical: 'RESTAURANT', enabledModules },
      });

      const render = DashboardPage({ searchParams: Promise.resolve({ landing: '1' }) });
      if (target) {
        await expect(render).rejects.toThrow('redirect');
        expect(mocks.redirect).toHaveBeenCalledWith(target);
      } else {
        const page = await render;
        expect(mocks.redirect).not.toHaveBeenCalled();
        expect(page.props.children.type).toBe(RestaurantDashboardContent);
        expect(page.props.children.props.enabledModules).toEqual(enabledModules);
      }
      expect(agencyHelpers.dashboard.getStats.prefetch).not.toHaveBeenCalled();
      expect(agencyHelpers.meetings.getUpcoming.prefetch).not.toHaveBeenCalled();
      expect(mocks.withTenantDb).toHaveBeenCalledWith('restaurant-org', expect.any(Function));
      for (const call of mocks.can.mock.calls) {
        expect(call[0]).toEqual(user);
        expect(call[3]).toEqual({ db: mocks.db });
      }
    }
  );

  it('does not choose a restaurant sign-in destination without a tenant', async () => {
    mocks.createSSRHelpers.mockResolvedValue({
      helpers: helpers(),
      session: { user: { id: 'u', role: 'EMPLOYEE' } },
      entitlements: { vertical: 'RESTAURANT', enabledModules: ['restaurant-pos'] },
    });
    const page = await DashboardPage({ searchParams: Promise.resolve({ landing: '1' }) });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(page.props.children.type).toBe(RestaurantDashboardContent);
  });

  it.each(['ADMIN', 'EMPLOYEE'])(
    'retains the Restaurant dashboard on explicit navigation for %s',
    async (role) => {
      const agencyHelpers = helpers();
      mocks.can.mockResolvedValue(false);
      mocks.createSSRHelpers.mockResolvedValue({
        helpers: agencyHelpers,
        organization: { id: 'restaurant-org' },
        session: { user: { id: 'restaurant-user', role, status: 'ACTIVE' } },
        entitlements: { vertical: 'RESTAURANT', enabledModules: ['restaurant-core'] },
      });
      const page = await DashboardPage({});
      expect(mocks.redirect).not.toHaveBeenCalled();
      expect(page.props.children.type).toBe(RestaurantDashboardContent);
      expect(page.props.children.props.enabledModules).toEqual(['restaurant-core']);
      expect(agencyHelpers.dashboard.getStats.prefetch).not.toHaveBeenCalled();
    }
  );

  it('lands a Hospitality organization on the property setup page, without Agency prefetches', async () => {
    const agencyHelpers = helpers();
    const ctx = { entitlements: { vertical: 'HOSPITALITY' } };
    const caller = { extras: {}, get: vi.fn() };
    const landing = { kind: 'properties', properties: [] };
    mocks.createHotelCaller.mockReturnValue(caller);
    mocks.loadHotelLanding.mockResolvedValue(landing);
    mocks.createSSRHelpers.mockResolvedValue({
      helpers: agencyHelpers,
      ctx,
      session: { user: { id: 'gm', role: 'ADMIN', status: 'ACTIVE' } },
      organization: { id: 'tenant', displayName: 'Fathom Grand Hotel' },
      entitlements: { vertical: 'HOSPITALITY', enabledModules: ['hotel-core'] },
    });

    const page = await DashboardPage({});

    expect(agencyHelpers.dashboard.getStats.prefetch).not.toHaveBeenCalled();
    expect(agencyHelpers.team.getAll.prefetch).not.toHaveBeenCalled();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.createHotelCaller).toHaveBeenCalledWith(ctx);
    expect(mocks.loadHotelLanding).toHaveBeenCalledWith(caller);
    expect(page.props.children.type).toBe(HotelDashboardContent);
    expect(page.props.children.props).toEqual({
      landing,
      organizationName: 'Fathom Grand Hotel',
      isAdmin: true,
    });
  });

  it('retains the Agency dashboard prefetch path', async () => {
    const agencyHelpers = helpers();
    mocks.createSSRHelpers.mockResolvedValue({
      helpers: agencyHelpers,
      entitlements: { vertical: 'AGENCY', enabledModules: ['dashboard'] },
    });

    await DashboardPage({});

    expect(agencyHelpers.dashboard.getStats.prefetch).toHaveBeenCalledOnce();
    expect(agencyHelpers.meetings.getUpcoming.prefetch).toHaveBeenCalledOnce();
  });
});

describe('PHARMACY first-run capability gate', () => {
  const vertical = 'PHARMACY' as const;
  it.each([
    ['EMPLOYEE', true, true],
    ['EMPLOYEE', false, false],
    ['ADMIN', false, false],
    ['ADMIN', true, true],
  ])('role %s, admin:access %s: loads checklist %s', async (role, allowed, loads) => {
    const user = { id: 'owner', role, status: 'ACTIVE' };
    mocks.createSSRHelpers.mockResolvedValue({
      helpers: helpers(),
      session: { user },
      organization: { id: 'tenant' },
      entitlements: { vertical, enabledModules: [] },
    });
    mocks.can.mockResolvedValue(allowed);
    mocks.loadSetupChecklist.mockResolvedValue({ complete: false, items: [] });
    mocks.loadPharmacyStaffHome.mockResolvedValue({ links: [], branches: [], shifts: [] });
    const page = await DashboardPage({});
    expect(mocks.withTenantDb).toHaveBeenCalledWith('tenant', expect.any(Function));
    expect(mocks.can).toHaveBeenCalledWith(user, 'admin:access', undefined, { db: mocks.db });
    expect(mocks.loadSetupChecklist).toHaveBeenCalledTimes(loads ? 1 : 0);
    if (loads) expect(mocks.loadSetupChecklist).toHaveBeenCalledWith(mocks.db, 'tenant', vertical);
    // DEV-20: a member with no command-centre grant lands on their own staff home.
    if (role === 'ADMIN' || allowed) {
      expect(page.props.children.type).toBe(PharmacyDashboardContent);
      expect(page.props.children.props).toEqual({ role });
    } else {
      expect(page.props.children.type).toBe(PharmacyStaffHome);
    }
  });

  it('does not query setup evidence without a session', async () => {
    mocks.createSSRHelpers.mockResolvedValue({
      helpers: helpers(),
      organization: { id: 'tenant' },
      entitlements: { vertical, enabledModules: [] },
    });
    await DashboardPage({});
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });
});

describe('PHARMACY dashboard role routing (DEV-20)', () => {
  const home = {
    links: [{ key: 'counter', href: '/pharmacy/counter', label: 'Open Counter', description: '' }],
    branches: [{ id: 'branch_1', name: 'Main' }],
    shifts: [],
    timeZone: 'UTC',
  };
  const render = async (role: string, grants: string[]) => {
    const user = { id: 'member', role, status: 'ACTIVE' };
    mocks.createSSRHelpers.mockResolvedValue({
      helpers: helpers(),
      session: { user },
      organization: { id: 'tenant' },
      entitlements: { vertical: 'PHARMACY', enabledModules: ['pharmacy-reports'] },
    });
    mocks.can.mockImplementation(async (_user: unknown, action: string) => grants.includes(action));
    mocks.loadPharmacyStaffHome.mockResolvedValue(home);
    return { user, page: await DashboardPage({ searchParams: Promise.resolve({ landing: '1' }) }) };
  };

  it.each([
    ['cashier', ['pharmacy:counter', 'pharmacy:orders']],
    ['procurement manager', ['pharmacy:procurement']],
    ['inventory clerk', ['pharmacy:inventory']],
    ['finance', ['reports:financial']],
    ['manager without the reports grant', ['pharmacy:manage', 'pharmacy:orders']],
  ])('lands a %s on their own staff home, not the Owner command centre', async (_name, grants) => {
    const { user, page } = await render('EMPLOYEE', grants);
    expect(page.props.children.type).toBe(PharmacyStaffHome);
    expect(page.props.children.props).toEqual({ home });
    expect(mocks.loadPharmacyStaffHome).toHaveBeenCalledWith(mocks.db, 'tenant', user, [
      'pharmacy-reports',
    ]);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it.each([
    ['Admin (owner)', 'ADMIN', []],
    ['manager with the reports grant', 'EMPLOYEE', ['pharmacy:manage', 'reports:operational']],
    ['operational reports reader', 'EMPLOYEE', ['reports:operational']],
  ])('keeps the Owner command centre for a %s', async (_name, role, grants) => {
    const { page } = await render(role, grants);
    expect(page.props.children.type).toBe(PharmacyDashboardContent);
    expect(page.props.children.props).toEqual({ role });
    expect(mocks.loadPharmacyStaffHome).not.toHaveBeenCalled();
  });

  it('leaves a pharmacist on the DEV-95 pharmacist home, not the staff home', async () => {
    const { page } = await render('EMPLOYEE', ['pharmacy:dispense', 'pharmacy:prescriptions']);
    expect(page.props.children.type).toBe(PharmacistHome);
    expect(mocks.loadPharmacyStaffHome).not.toHaveBeenCalled();
  });
});

describe('PHARMACY pharmacist landing (DEV-95)', () => {
  const DISPENSING = ['pharmacy-core', 'pharmacy-reports', 'pharmacy-dispensing'];
  function pharmacySession(capabilities: string[], enabledModules = DISPENSING) {
    mocks.can.mockImplementation(async (_subject: unknown, action: string) =>
      capabilities.includes(action)
    );
    mocks.createSSRHelpers.mockResolvedValue({
      helpers: helpers(),
      session: { user: { id: 'u', role: 'EMPLOYEE', status: 'ACTIVE' } },
      organization: { id: 'tenant' },
      entitlements: { vertical: 'PHARMACY', enabledModules },
    });
    mocks.loadPharmacyStaffHome.mockResolvedValue({
      links: [],
      branches: [],
      shifts: [],
      timeZone: 'UTC',
    });
  }
  const PHARMACIST = ['pharmacy:prescriptions', 'pharmacy:dispense'];

  it('lands a pharmacist on the pharmacist queue after sign-in', async () => {
    pharmacySession(PHARMACIST);
    await expect(
      DashboardPage({ searchParams: Promise.resolve({ landing: '1' }) })
    ).rejects.toThrow('redirect');
    expect(mocks.redirect).toHaveBeenCalledWith('/pharmacy/pharmacist-queue');
    // Only the three landing capabilities are read, inside the tenant database.
    const landingReads = mocks.can.mock.calls
      .map(([, action]) => action)
      .filter((action) => action !== 'admin:access');
    expect(landingReads.sort()).toEqual([
      'pharmacy:dispense',
      'pharmacy:prescriptions',
      'reports:operational',
    ]);
    for (const call of mocks.can.mock.calls) expect(call[3]).toEqual({ db: mocks.db });
  });

  it('shows a pharmacist their own home, not the owner command centre, on an explicit visit', async () => {
    pharmacySession(PHARMACIST);
    const page = await DashboardPage({});
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(page.props.children.type).toBe(PharmacistHome);
    expect(page.props.children.props.tools.map((tool: { href: string }) => tool.href)).toEqual([
      '/pharmacy/pharmacist-queue',
      '/pharmacy/prescriptions',
    ]);
  });

  it('keeps a pharmacist off the command centre without Pharmacy Dispensing, with nowhere to redirect', async () => {
    pharmacySession(PHARMACIST, ['pharmacy-core', 'pharmacy-reports']);
    const page = await DashboardPage({ searchParams: Promise.resolve({ landing: '1' }) });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(page.props.children.type).toBe(PharmacistHome);
    expect(page.props.children.props.tools).toEqual([]);
  });

  it.each([
    ['an owner-operator', ['reports:operational', ...PHARMACIST]],
    ['an auditor', ['reports:operational']],
  ])('keeps the command centre for %s', async (_persona, capabilities) => {
    pharmacySession(capabilities);
    const page = await DashboardPage({ searchParams: Promise.resolve({ landing: '1' }) });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(page.props.children.type).toBe(PharmacyDashboardContent);
  });

  // DEV-20: a member with no pharmacist or report capability (a cashier) gets their own staff
  // home instead of the command centre, without a redirect.
  it('lands a member with no pharmacist capability on their staff home', async () => {
    pharmacySession(['pharmacy:counter']);
    const page = await DashboardPage({ searchParams: Promise.resolve({ landing: '1' }) });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(page.props.children.type).toBe(PharmacyStaffHome);
  });

  it('logs a failed access read and falls back to the command centre without redirecting', async () => {
    pharmacySession(PHARMACIST);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.can.mockImplementation(async (_subject: unknown, action: string) => {
      if (action === 'admin:access') return false;
      throw new TypeError('unavailable');
    });
    const page = await DashboardPage({ searchParams: Promise.resolve({ landing: '1' }) });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(page.props.children.type).toBe(PharmacyDashboardContent);
    expect(error).toHaveBeenCalledWith('[dashboard] pharmacy access read unavailable', {
      error: 'TypeError',
    });
    error.mockRestore();
  });
});
