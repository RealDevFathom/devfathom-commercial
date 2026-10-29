import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSSRHelpers: vi.fn(),
  redirect: vi.fn(),
  can: vi.fn(),
  loadSetupChecklist: vi.fn(),
  loadHotelLanding: vi.fn(),
  createHotelCaller: vi.fn(),
  withTenantDb: vi.fn(),
  db: {},
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/abac', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/abac')>()),
  can: mocks.can,
  subjectFromSession: (user: unknown) => user,
}));
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
});

vi.mock('@/lib/trpc-server', () => ({ createSSRHelpers: mocks.createSSRHelpers }));
vi.mock('@tanstack/react-query', () => ({
  HydrationBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('./dashboard-content', () => ({ DashboardContent: () => null }));
vi.mock('./restaurant-dashboard-content', () => ({ RestaurantDashboardContent: () => null }));

import DashboardPage from './page';
import { PharmacyDashboardContent } from './pharmacy-dashboard-content';
import { HotelDashboardContent } from './hotel-dashboard-content';
import { RestaurantDashboardContent } from './restaurant-dashboard-content';
import { ALL_ACTIONS, POLICIES } from '@/lib/abac/policies';

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
  it('registers the POS landing capability in the production ABAC catalogue', () => {
    expect(ALL_ACTIONS).toContain('orders:take');
    expect(POLICIES['orders:take']).toEqual([]);
  });

  it.each([
    ['owner', ['admin:access'], '/restaurant'],
    ['owner with order-taking access', ['admin:access', 'orders:take'], '/restaurant'],
    ['waiter', ['orders:take'], '/pos'],
  ])(
    'redirects a Restaurant %s with %s to %s before loading dashboard data',
    async (_persona, capabilities, target) => {
      const agencyHelpers = helpers();
      const user = { id: 'restaurant-user', role: 'EMPLOYEE', status: 'ACTIVE' };
      mocks.createSSRHelpers.mockResolvedValue({
        helpers: agencyHelpers,
        session: { user },
        organization: { id: 'restaurant-tenant' },
        entitlements: { vertical: 'RESTAURANT', enabledModules: ['restaurant-core'] },
      });
      mocks.can.mockImplementation(async (_subject, action) => capabilities.includes(action));

      await expect(DashboardPage()).rejects.toThrow('redirect');

      expect(mocks.redirect).toHaveBeenCalledWith(target);
      expect(mocks.withTenantDb).toHaveBeenCalledWith('restaurant-tenant', expect.any(Function));
      expect(mocks.can.mock.calls.map(([, action]) => action)).toEqual(
        capabilities.includes('admin:access') ? ['admin:access'] : ['admin:access', 'orders:take']
      );
      expect(mocks.can).toHaveBeenCalledWith(user, 'admin:access', undefined, { db: mocks.db });
      if (target === '/pos') {
        expect(mocks.can).toHaveBeenCalledWith(user, 'orders:take', undefined, { db: mocks.db });
      }
      expect(agencyHelpers.dashboard.getStats.prefetch).not.toHaveBeenCalled();
      expect(agencyHelpers.meetings.getUpcoming.prefetch).not.toHaveBeenCalled();
    }
  );

  it.each(['ADMIN', 'EMPLOYEE'])(
    'keeps a Restaurant %s without order-taking access on the usable dashboard',
    async (role) => {
      const user = { id: 'kitchen-user', role, status: 'ACTIVE' };
      mocks.createSSRHelpers.mockResolvedValue({
        helpers: helpers(),
        session: { user },
        organization: { id: 'restaurant-tenant' },
        entitlements: {
          vertical: 'RESTAURANT',
          enabledModules: ['restaurant-core', 'restaurant-inventory'],
        },
      });
      mocks.can.mockResolvedValue(false);

      const page = await DashboardPage();

      expect(mocks.redirect).not.toHaveBeenCalled();
      expect(mocks.can.mock.calls.slice(0, 2).map(([, action]) => action)).toEqual([
        'admin:access',
        'orders:take',
      ]);
      expect(mocks.can).toHaveBeenCalledWith(user, 'admin:access', undefined, { db: mocks.db });
      expect(mocks.can).toHaveBeenCalledWith(user, 'orders:take', undefined, { db: mocks.db });
      expect(page.props.children.type).toBe(RestaurantDashboardContent);
      expect(page.props.children.props.enabledModules).toEqual([
        'restaurant-core',
        'restaurant-inventory',
      ]);
    }
  );

  it.each([
    ['organization', undefined, { user: { id: 'kitchen-user', role: 'EMPLOYEE' } }],
    ['session user', { id: 'restaurant-tenant' }, undefined],
  ])(
    'does not resolve Restaurant capabilities without a %s',
    async (_missing, organization, session) => {
      mocks.createSSRHelpers.mockResolvedValue({
        helpers: helpers(),
        organization,
        session,
        entitlements: { vertical: 'RESTAURANT', enabledModules: ['restaurant-core'] },
      });

      const page = await DashboardPage();

      expect(mocks.withTenantDb).not.toHaveBeenCalled();
      expect(mocks.can).not.toHaveBeenCalled();
      expect(mocks.redirect).not.toHaveBeenCalled();
      expect(page.props.children.type).toBe(RestaurantDashboardContent);
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

    const page = await DashboardPage();

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

    await DashboardPage();

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
    const page = await DashboardPage();
    expect(mocks.withTenantDb).toHaveBeenCalledWith('tenant', expect.any(Function));
    expect(mocks.can).toHaveBeenCalledWith(user, 'admin:access', undefined, { db: mocks.db });
    expect(mocks.loadSetupChecklist).toHaveBeenCalledTimes(loads ? 1 : 0);
    if (loads) expect(mocks.loadSetupChecklist).toHaveBeenCalledWith(mocks.db, 'tenant', vertical);
    expect(page.props.children.type).toBe(PharmacyDashboardContent);
    expect(page.props.children.props).toEqual({ role });
  });

  it('does not query setup evidence without a session', async () => {
    mocks.createSSRHelpers.mockResolvedValue({
      helpers: helpers(),
      organization: { id: 'tenant' },
      entitlements: { vertical, enabledModules: [] },
    });
    await DashboardPage();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });
});
