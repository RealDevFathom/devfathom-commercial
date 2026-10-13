import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSSRHelpers: vi.fn(),
  can: vi.fn(),
  loadSetupChecklist: vi.fn(),
  withTenantDb: vi.fn(),
  db: {},
}));
vi.mock('@/lib/abac', () => ({ can: mocks.can, subjectFromSession: (user: unknown) => user }));
vi.mock('@/lib/onboarding/setup-evaluator', () => ({
  loadSetupChecklist: mocks.loadSetupChecklist,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: mocks.withTenantDb }));
vi.mock('./pharmacy-dashboard-content', () => ({ PharmacyDashboardContent: () => null }));

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
    if (loads)
      expect(mocks.loadSetupChecklist).toHaveBeenCalledWith(mocks.db, 'tenant', vertical);
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
