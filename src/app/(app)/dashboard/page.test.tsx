import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createSSRHelpers: vi.fn() }));

vi.mock('@/lib/trpc-server', () => ({ createSSRHelpers: mocks.createSSRHelpers }));
vi.mock('@tanstack/react-query', () => ({
  HydrationBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('./dashboard-content', () => ({ DashboardContent: () => null }));
vi.mock('./restaurant-dashboard-content', () => ({ RestaurantDashboardContent: () => null }));

import DashboardPage from './page';

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
