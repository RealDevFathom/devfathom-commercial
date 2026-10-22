import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSSRHelpers: vi.fn(),
  can: vi.fn(),
  loadSetupChecklist: vi.fn(),
  loadHotelLanding: vi.fn(),
  createHotelCaller: vi.fn(),
  withTenantDb: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT;${path}`);
  }),
  db: {},
}));
vi.mock('@/lib/abac', () => ({ can: mocks.can, subjectFromSession: (user: unknown) => user }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
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
  it('does not run Agency prefetches for Restaurant organizations', async () => {
    const agencyHelpers = helpers();
    mocks.createSSRHelpers.mockResolvedValue({
      helpers: agencyHelpers,
      entitlements: { vertical: 'RESTAURANT', enabledModules: ['restaurant-core'] },
    });

    await DashboardPage();

    expect(agencyHelpers.dashboard.getStats.prefetch).not.toHaveBeenCalled();
    expect(agencyHelpers.meetings.getUpcoming.prefetch).not.toHaveBeenCalled();
  });

  it('sends a restaurant operator to POS only when effective orders:take is allowed', async () => {
    const user = { id: 'cashier', role: 'EMPLOYEE', status: 'ACTIVE' };
    mocks.createSSRHelpers.mockResolvedValue({
      helpers: helpers(),
      session: { user },
      organization: { id: 'tenant' },
      entitlements: { vertical: 'RESTAURANT', enabledModules: ['restaurant-core'] },
    });
    mocks.can.mockImplementation(async (_subject, action) => action === 'orders:take');

    await expect(DashboardPage()).rejects.toThrow('NEXT_REDIRECT;/pos');

    expect(mocks.can).toHaveBeenNthCalledWith(1, user, 'admin:access', undefined, {
      db: mocks.db,
    });
    expect(mocks.can).toHaveBeenNthCalledWith(2, user, 'orders:take', undefined, {
      db: mocks.db,
    });
    expect(mocks.redirect).toHaveBeenCalledWith('/pos');
  });

  it.each(['kitchen', 'inventory', 'finance'])(
    'keeps a %s restaurant persona without orders:take on the dashboard',
    async (id) => {
      const user = { id, role: 'EMPLOYEE', status: 'ACTIVE' };
      mocks.createSSRHelpers.mockResolvedValue({
        helpers: helpers(),
        session: { user },
        organization: { id: 'tenant' },
        entitlements: { vertical: 'RESTAURANT', enabledModules: ['restaurant-core'] },
      });
      mocks.can.mockResolvedValue(false);

      await DashboardPage();

      expect(mocks.can).toHaveBeenCalledWith(user, 'orders:take', undefined, { db: mocks.db });
      expect(mocks.redirect).not.toHaveBeenCalled();
    }
  );

  it('keeps an effective administrator on the restaurant management dashboard', async () => {
    const user = { id: 'owner', role: 'EMPLOYEE', status: 'ACTIVE' };
    mocks.createSSRHelpers.mockResolvedValue({
      helpers: helpers(),
      session: { user },
      organization: { id: 'tenant' },
      entitlements: { vertical: 'RESTAURANT', enabledModules: ['restaurant-core'] },
    });
    mocks.can.mockResolvedValue(true);
    mocks.loadSetupChecklist.mockResolvedValue({ complete: true, items: [] });

    await DashboardPage();

    expect(mocks.can).toHaveBeenCalledOnce();
    expect(mocks.can).toHaveBeenCalledWith(user, 'admin:access', undefined, { db: mocks.db });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

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

describe.each(['RESTAURANT', 'PHARMACY'] as const)('%s first-run capability gate', (vertical) => {
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
    if (vertical === 'PHARMACY') {
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
    await DashboardPage();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });
});
