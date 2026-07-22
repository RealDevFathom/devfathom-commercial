import { beforeEach, describe, expect, test } from 'bun:test';
import {
  DASHBOARD_BOOTSTRAP_ENDPOINT,
  DASHBOARD_BROWSER_FRESHNESS_MS,
  cacheDashboardDataForUser,
  clearDashboardBrowserCache,
  fetchDashboardBootstrap,
  getCachedDashboardData,
} from '../app/composables/useDashboardData.ts';

const stats = {
  activeProjects: 3,
  totalTasks: 7,
  completedTasksThisWeek: 2,
  pendingLeaves: 1,
  outstandingInvoices: 4,
  revenue: [{ currency: 'USD', amount: 1000 }],
  expenses: [{ currency: 'USD', amount: 250 }],
  isAdmin: true,
};

const bootstrap = {
  stats,
  activity: [
    {
      id: 'activity-1',
      type: 'project',
      message: 'Updated a project',
      createdAt: '2026-07-18T00:00:00.000Z',
    },
  ],
  projects: Array.from({ length: 4 }, (_, index) => ({ id: `project-${index}` })),
  meetings: [{ id: 'meeting-1' }],
  deadlines: [{ id: 'deadline-1' }],
  tasks: [{ id: 'task-1' }],
  failedDatasets: [],
};

describe('dashboard bootstrap loading', () => {
  beforeEach(() => clearDashboardBrowserCache());

  test('makes exactly one SSR-critical bootstrap request', async () => {
    const started = [];
    const request = async (path) => {
      started.push(path);
      return { data: bootstrap };
    };

    const result = await fetchDashboardBootstrap(request);

    expect(started).toEqual([DASHBOARD_BOOTSTRAP_ENDPOINT]);
    expect(result).toEqual(bootstrap);
    expect(result.projects).toHaveLength(4);
  });

  test('reuses the SSR payload during hydration without a duplicate request', async () => {
    let requests = 0;
    const ssrData = await fetchDashboardBootstrap(async () => {
      requests += 1;
      return { data: bootstrap };
    });

    const hydrated = getCachedDashboardData({
      userId: 'user-1',
      payloadData: ssrData,
      isHydrating: true,
      cause: 'initial',
      now: 1_000,
    });
    const warmNavigation = getCachedDashboardData({
      userId: 'user-1',
      isHydrating: false,
      cause: 'initial',
      now: 1_000 + DASHBOARD_BROWSER_FRESHNESS_MS - 1,
    });

    expect(requests).toBe(1);
    expect(hydrated).toBe(ssrData);
    expect(warmNavigation).toBe(ssrData);
  });

  test('expires browser data, bypasses it on manual refresh, and isolates users', () => {
    cacheDashboardDataForUser('user-1', bootstrap, 2_000);

    expect(
      getCachedDashboardData({
        userId: 'user-2',
        isHydrating: false,
        cause: 'initial',
        now: 2_001,
      })
    ).toBeUndefined();
    expect(
      getCachedDashboardData({
        userId: 'user-1',
        isHydrating: false,
        cause: 'refresh:manual',
        now: 2_001,
      })
    ).toBeUndefined();
    expect(
      getCachedDashboardData({
        userId: 'user-1',
        isHydrating: false,
        cause: 'initial',
        now: 2_000 + DASHBOARD_BROWSER_FRESHNESS_MS,
      })
    ).toBeUndefined();
  });

  test('normalizes partial optional data without losing successful critical data', async () => {
    const result = await fetchDashboardBootstrap(async () => ({
      data: {
        stats,
        activity: null,
        projects: [{ id: 'project-1' }],
        meetings: undefined,
        deadlines: null,
        tasks: [{ id: 'task-1' }],
        failedDatasets: ['activity', 'meetings', 'deadlines'],
      },
    }));

    expect(result.stats).toEqual(stats);
    expect(result.activity).toEqual([]);
    expect(result.meetings).toEqual([]);
    expect(result.deadlines).toEqual([]);
    expect(result.tasks).toEqual([{ id: 'task-1' }]);
    expect(result.failedDatasets).toEqual(['activity', 'meetings', 'deadlines']);
  });

  test('keeps the revenue chart outside the critical request and payload', () => {
    expect(DASHBOARD_BOOTSTRAP_ENDPOINT).toBe('/api/dashboard/bootstrap');
    expect(DASHBOARD_BOOTSTRAP_ENDPOINT).not.toBe('/api/dashboard/revenue-chart');
    expect(bootstrap).not.toHaveProperty('revenueChart');
    expect(bootstrap).not.toHaveProperty('byCurrency');
  });
});
