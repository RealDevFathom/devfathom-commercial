import { describe, expect, test } from 'bun:test';
import {
  DASHBOARD_CRITICAL_ENDPOINTS,
  fetchDashboardCriticalData,
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

const responses = {
  [DASHBOARD_CRITICAL_ENDPOINTS.stats]: { data: stats },
  [DASHBOARD_CRITICAL_ENDPOINTS.activity]: {
    data: [
      {
        id: 'activity-1',
        type: 'project',
        message: 'Updated a project',
        createdAt: '2026-07-18T00:00:00.000Z',
      },
    ],
  },
  [DASHBOARD_CRITICAL_ENDPOINTS.projects]: {
    data: Array.from({ length: 5 }, (_, index) => ({ id: `project-${index}` })),
  },
  [DASHBOARD_CRITICAL_ENDPOINTS.meetings]: [{ id: 'meeting-1' }],
  [DASHBOARD_CRITICAL_ENDPOINTS.deadlines]: { data: [{ id: 'deadline-1' }] },
  [DASHBOARD_CRITICAL_ENDPOINTS.tasks]: { data: [{ id: 'task-1' }] },
};

describe('dashboard critical loading', () => {
  test('starts all six critical requests before waiting for any response', async () => {
    const started = [];
    const resolvers = new Map();
    const request = (path) => {
      started.push(path);
      return new Promise((resolve) => resolvers.set(path, resolve));
    };

    const loading = fetchDashboardCriticalData(request);

    expect(started).toEqual(Object.values(DASHBOARD_CRITICAL_ENDPOINTS));
    expect(resolvers.size).toBe(6);

    for (const path of started) resolvers.get(path)(responses[path]);
    const result = await loading;

    expect(result.failedDatasets).toEqual([]);
    expect(result.stats).toEqual(stats);
    expect(result.projects).toHaveLength(4);
    expect(result.meetings).toEqual([{ id: 'meeting-1' }]);
  });

  test('keeps successful datasets when optional critical sections fail', async () => {
    const request = (path) => {
      if (
        path === DASHBOARD_CRITICAL_ENDPOINTS.activity ||
        path === DASHBOARD_CRITICAL_ENDPOINTS.deadlines
      ) {
        return Promise.reject(new Error('temporarily unavailable'));
      }
      return Promise.resolve(responses[path]);
    };

    const result = await fetchDashboardCriticalData(request);

    expect(result.failedDatasets).toEqual(['activity', 'deadlines']);
    expect(result.stats).toEqual(stats);
    expect(result.activity).toEqual([]);
    expect(result.deadlines).toEqual([]);
    expect(result.tasks).toEqual([{ id: 'task-1' }]);
  });

  test('keeps revenue out of the SSR-critical request set', () => {
    const paths = Object.values(DASHBOARD_CRITICAL_ENDPOINTS);

    expect(paths).toHaveLength(6);
    expect(paths).not.toContain('/api/dashboard/revenue-chart');
  });
});
