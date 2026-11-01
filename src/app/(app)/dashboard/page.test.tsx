import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSSRHelpers: vi.fn(),
  redirect: vi.fn(),
  can: vi.fn(),
  loadSetupChecklist: vi.fn(),
  loadHotelLanding: vi.fn(),
  createHotelCaller: vi.fn(),
  withTenantDb: vi.fn(),
  drawerFindMany: vi.fn(),
  branchFindMany: vi.fn(),
  db: {} as Record<string, unknown>,
}));
mocks.db.pharmacyDrawerSession = { findMany: mocks.drawerFindMany };
mocks.db.pharmacyBranch = { findMany: mocks.branchFindMany };
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/abac', () => ({ can: mocks.can, subjectFromSession: (user: unknown) => user }));
vi.mock('@/lib/onboarding/setup-evaluator', () => ({
  loadSetupChecklist: mocks.loadSetupChecklist,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: mocks.withTenantDb }));
vi.mock('./pharmacy-dashboard-content', () => ({ PharmacyDashboardContent: () => null }));
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
  mocks.drawerFindMany.mockResolvedValue([]);
  mocks.branchFindMany.mockResolvedValue([]);
});

vi.mock('@/lib/trpc-server', () => ({ createSSRHelpers: mocks.createSSRHelpers }));
vi.mock('@tanstack/react-query', () => ({
  HydrationBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('./dashboard-content', () => ({ DashboardContent: () => null }));
vi.mock('./restaurant-dashboard-content', () => ({ RestaurantDashboardContent: () => null }));

import DashboardPage from './page';
import { PharmacyDashboardContent } from './pharmacy-dashboard-content';
import { PharmacyCashierHome } from './pharmacy-cashier-home';
import { HotelDashboardContent } from './hotel-dashboard-content';
import { RestaurantDashboardContent } from './restaurant-dashboard-content';

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
    ['owner', 'ADMIN', '/restaurant'],
    ['waiter', 'EMPLOYEE', '/pos'],
  ])(
    'redirects a Restaurant %s (%s) to %s before loading dashboard data',
    async (_persona, role, target) => {
      const agencyHelpers = helpers();
      mocks.createSSRHelpers.mockResolvedValue({
        helpers: agencyHelpers,
        session: { user: { id: 'restaurant-user', role, status: 'ACTIVE' } },
        entitlements: { vertical: 'RESTAURANT', enabledModules: ['restaurant-core'] },
      });

      await expect(
        DashboardPage({ searchParams: Promise.resolve({ landing: '1' }) })
      ).rejects.toThrow('redirect');

      expect(mocks.redirect).toHaveBeenCalledWith(target);
      expect(agencyHelpers.dashboard.getStats.prefetch).not.toHaveBeenCalled();
      expect(agencyHelpers.meetings.getUpcoming.prefetch).not.toHaveBeenCalled();
      expect(mocks.withTenantDb).not.toHaveBeenCalled();
    }
  );

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
    const page = await DashboardPage({});
    expect(mocks.withTenantDb).toHaveBeenCalledWith('tenant', expect.any(Function));
    expect(mocks.can).toHaveBeenCalledWith(user, 'admin:access', undefined, { db: mocks.db });
    expect(mocks.loadSetupChecklist).toHaveBeenCalledTimes(loads ? 1 : 0);
    if (loads) expect(mocks.loadSetupChecklist).toHaveBeenCalledWith(mocks.db, 'tenant', vertical);
    // Without any grant an EMPLOYEE is counter staff and lands on the cashier home.
    if (role === 'EMPLOYEE' && !allowed) {
      expect(page.props.children.type).toBe(PharmacyCashierHome);
    } else {
      expect(page.props.children.type).toBe(PharmacyDashboardContent);
      expect(page.props.children.props).toEqual({ role });
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

describe('PHARMACY dashboard audience by role', () => {
  const vertical = 'PHARMACY' as const;
  // Each persona's role and the capabilities its pharmacy role template grants.
  const personas = [
    ['owner', 'ADMIN', ['reports:operational', 'reports:financial', 'pharmacy:close']],
    ['admin', 'ADMIN', []],
    ['manager', 'EMPLOYEE', ['pharmacy:manage', 'pharmacy:orders', 'pharmacy:procurement']],
    ['cashier', 'EMPLOYEE', ['pharmacy:counter', 'pharmacy:orders']],
  ] as const;

  function signIn(role: string, grants: readonly string[]) {
    const user = { id: `${role}-user`, role, status: 'ACTIVE' };
    mocks.createSSRHelpers.mockResolvedValue({
      helpers: helpers(),
      session: { user },
      organization: { id: 'tenant', timezone: 'Asia/Karachi', currency: 'PKR' },
      entitlements: { vertical, enabledModules: ['pharmacy-counter', 'pharmacy-reports'] },
    });
    mocks.can.mockImplementation(async (_subject: unknown, action: string) =>
      grants.includes(action)
    );
    return user;
  }

  it.each(personas.filter(([persona]) => persona !== 'cashier'))(
    'shows the %s (%s) the owner command centre',
    async (_persona, role, grants) => {
      signIn(role, grants);
      const page = await DashboardPage({});
      expect(page.props.children.type).toBe(PharmacyDashboardContent);
      expect(mocks.drawerFindMany).not.toHaveBeenCalled();
    }
  );

  it('routes a cashier to their own counter home with only their own open drawer', async () => {
    const [, role, grants] = personas[3];
    const user = signIn(role, grants);
    mocks.drawerFindMany.mockResolvedValue([
      { id: 'drawer-1', branchId: 'branch-1', openedAt: new Date(), openingFloatMinor: 50_000 },
    ]);
    mocks.branchFindMany.mockResolvedValue([
      { id: 'branch-1', name: 'SehatCart Test Branch', city: 'Lahore' },
    ]);

    const page = await DashboardPage({});

    expect(page.props.children.type).toBe(PharmacyCashierHome);
    expect(page.props.children.props).toMatchObject({
      counterAvailable: true,
      shifts: [{ id: 'drawer-1', branchLabel: 'SehatCart Test Branch · Lahore' }],
    });
    expect(mocks.drawerFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'tenant', openedByActorId: user.id, status: 'OPEN' },
      })
    );
  });
});
