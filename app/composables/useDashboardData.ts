import type { ApiResponse, DashboardStats } from '~/types/api';
import type { Meeting } from '~/types/collaboration';
import type {
  DashboardActivityItem,
  DashboardCriticalData,
  DashboardCriticalDataset,
  DashboardDeadline,
  DashboardTask,
} from '~/types/dashboard';
import type { Project } from '~/types/delivery';

export const DASHBOARD_CRITICAL_DATA_KEY = 'dashboard-critical-v1';

export const DASHBOARD_CRITICAL_ENDPOINTS = {
  stats: '/api/dashboard/stats',
  activity: '/api/dashboard/activity',
  projects: '/api/v1/projects',
  meetings: '/api/v1/meetings/upcoming',
  deadlines: '/api/dashboard/deadlines',
  tasks: '/api/dashboard/my-tasks',
} as const satisfies Record<DashboardCriticalDataset, string>;

export interface DashboardRequest {
  <T>(path: string): Promise<T>;
}

export async function fetchDashboardCriticalData(
  request: DashboardRequest
): Promise<DashboardCriticalData> {
  const [stats, activity, projects, meetings, deadlines, tasks] = await Promise.allSettled([
    request<ApiResponse<DashboardStats>>(DASHBOARD_CRITICAL_ENDPOINTS.stats),
    request<ApiResponse<DashboardActivityItem[]>>(DASHBOARD_CRITICAL_ENDPOINTS.activity),
    request<ApiResponse<Project[]>>(DASHBOARD_CRITICAL_ENDPOINTS.projects),
    request<Meeting[]>(DASHBOARD_CRITICAL_ENDPOINTS.meetings),
    request<ApiResponse<DashboardDeadline[]>>(DASHBOARD_CRITICAL_ENDPOINTS.deadlines),
    request<ApiResponse<DashboardTask[]>>(DASHBOARD_CRITICAL_ENDPOINTS.tasks),
  ]);

  const settled = { stats, activity, projects, meetings, deadlines, tasks };
  const failedDatasets = (Object.keys(settled) as DashboardCriticalDataset[]).filter(
    (dataset) => settled[dataset].status === 'rejected'
  );

  return {
    stats: stats.status === 'fulfilled' ? stats.value.data : null,
    activity: activity.status === 'fulfilled' ? activity.value.data : [],
    projects: projects.status === 'fulfilled' ? projects.value.data.slice(0, 4) : [],
    meetings: meetings.status === 'fulfilled' ? meetings.value : [],
    deadlines: deadlines.status === 'fulfilled' ? deadlines.value.data : [],
    tasks: tasks.status === 'fulfilled' ? tasks.value.data : [],
    failedDatasets,
  };
}

export function useDashboardData() {
  const { request } = useApi();

  return useAsyncData(DASHBOARD_CRITICAL_DATA_KEY, () => fetchDashboardCriticalData(request), {
    server: true,
    lazy: false,
    deep: false,
    dedupe: 'cancel',
  });
}
