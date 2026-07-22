import type { ApiResponse } from '~/types/api';
import type { DashboardBootstrapData, DashboardCriticalDataset } from '~/types/dashboard';

export const DASHBOARD_CRITICAL_DATA_KEY = 'dashboard-bootstrap-v1';
export const DASHBOARD_BOOTSTRAP_ENDPOINT = '/api/dashboard/bootstrap';
export const DASHBOARD_BROWSER_FRESHNESS_MS = 45_000;

export interface DashboardRequest {
  <T>(path: string): Promise<T>;
}

interface DashboardBrowserCacheEntry {
  data: DashboardBootstrapData;
  storedAt: number;
}

interface DashboardCacheLookup {
  userId?: string | null;
  payloadData?: DashboardBootstrapData;
  isHydrating: boolean;
  cause: 'initial' | 'refresh:hook' | 'refresh:manual' | 'watch';
  now?: number;
}

const dashboardBrowserCache = new Map<string, DashboardBrowserCacheEntry>();

function listOrEmpty<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

export function normalizeDashboardBootstrap(
  value: Partial<DashboardBootstrapData> | null | undefined
): DashboardBootstrapData {
  return {
    stats: value?.stats ?? null,
    activity: listOrEmpty(value?.activity),
    projects: listOrEmpty(value?.projects).slice(0, 4),
    meetings: listOrEmpty(value?.meetings),
    deadlines: listOrEmpty(value?.deadlines),
    tasks: listOrEmpty(value?.tasks),
    failedDatasets: listOrEmpty(value?.failedDatasets).filter(
      (dataset): dataset is DashboardCriticalDataset =>
        ['stats', 'activity', 'projects', 'meetings', 'deadlines', 'tasks'].includes(dataset)
    ),
  };
}

export async function fetchDashboardBootstrap(
  request: DashboardRequest
): Promise<DashboardBootstrapData> {
  const response = await request<ApiResponse<DashboardBootstrapData>>(DASHBOARD_BOOTSTRAP_ENDPOINT);
  return normalizeDashboardBootstrap(response.data);
}

export function cacheDashboardDataForUser(
  userId: string | null | undefined,
  data: DashboardBootstrapData,
  now = Date.now()
) {
  if (!userId) return;
  for (const cachedUserId of dashboardBrowserCache.keys()) {
    if (cachedUserId !== userId) dashboardBrowserCache.delete(cachedUserId);
  }
  dashboardBrowserCache.set(userId, { data, storedAt: now });
}

export function getCachedDashboardData({
  userId,
  payloadData,
  isHydrating,
  cause,
  now = Date.now(),
}: DashboardCacheLookup): DashboardBootstrapData | undefined {
  if (cause === 'refresh:manual') return undefined;

  if (isHydrating && payloadData) {
    cacheDashboardDataForUser(userId, payloadData, now);
    return payloadData;
  }
  if (!userId) return undefined;

  const cached = dashboardBrowserCache.get(userId);
  if (!cached) return undefined;
  const age = now - cached.storedAt;
  if (age < 0 || age >= DASHBOARD_BROWSER_FRESHNESS_MS) {
    dashboardBrowserCache.delete(userId);
    return undefined;
  }
  return cached.data;
}

export function clearDashboardBrowserCache() {
  dashboardBrowserCache.clear();
}

export function useDashboardData() {
  const { request } = useApi();
  const { user } = useAuth();
  const userId = computed(() => user.value?.id ?? null);
  const key = computed(() => `${DASHBOARD_CRITICAL_DATA_KEY}:${userId.value ?? 'unresolved'}`);

  return useAsyncData(key, () => fetchDashboardBootstrap(request), {
    server: true,
    lazy: false,
    deep: false,
    dedupe: 'cancel',
    getCachedData: (cacheKey, nuxtApp, context) =>
      getCachedDashboardData({
        userId: userId.value,
        payloadData:
          nuxtApp.isHydrating === true
            ? (nuxtApp.payload.data[cacheKey] as DashboardBootstrapData | undefined)
            : undefined,
        isHydrating: nuxtApp.isHydrating === true,
        cause: context.cause,
      }),
    transform: (data) => {
      if (import.meta.client) cacheDashboardDataForUser(userId.value, data);
      return data;
    },
  });
}
