import type { Ref } from 'vue';
import type { ApiTokenRecord, Resignation, Webhook } from '~/types/firm';
import type {
  SettingsBootstrap,
  SettingsMemberProfile,
  SettingsNotificationPreferences,
  SettingsRole,
  SettingsUiPreferences,
} from '~/types/settings-bootstrap';

export const SETTINGS_BOOTSTRAP_KEY = 'settings-bootstrap-v1';
export const SETTINGS_BOOTSTRAP_ENDPOINT = '/api/settings/bootstrap';
export const SETTINGS_RESIGNATIONS_ENDPOINT = '/api/hr/resignations';
export const SETTINGS_SECTION_TTL_MS = 30_000;

export const SETTINGS_DEFERRED_ENDPOINTS = {
  sessions: '/api/auth/sessions',
  twoFactor: '/api/auth/two-factor/status',
  resignations: '/api/hr/resignations/mine',
  apiTokens: '/api/admin/api-tokens',
  webhooks: '/api/admin/webhooks',
} as const;

export const DEFAULT_SETTINGS_PREFERENCES: SettingsUiPreferences = {
  theme: 'system',
  density: 'default',
  type: 'default',
  accent: 'quiet',
  layout: 'top',
  icons: 'numeric',
};

export type SettingsDeferredSection = keyof typeof SETTINGS_DEFERRED_ENDPOINTS;

export interface SettingsSession {
  id: string;
  createdAt?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface SettingsTwoFactorStatus {
  enabled: boolean;
}

export interface SettingsRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, unknown>;
}

export type SettingsRequest = <T>(path: string, options?: SettingsRequestOptions) => Promise<T>;

type SettingsDeferredData =
  SettingsSession[] | SettingsTwoFactorStatus | Resignation[] | ApiTokenRecord[] | Webhook[];

interface SettingsCacheEntry<T> {
  data: T;
  expiresAt: number;
}

interface SettingsNuxtDataCache {
  isHydrating?: boolean;
  payload: { data: Record<string, unknown> };
  static: { data: Record<string, unknown> };
}

const sectionCache = new Map<string, SettingsCacheEntry<SettingsDeferredData>>();
const sectionRequests = new Map<string, Promise<SettingsDeferredData | null>>();

export function getSettingsBootstrapCachedData(
  key: string,
  nuxtApp: SettingsNuxtDataCache
): SettingsBootstrap | undefined {
  const cached = nuxtApp.isHydrating ? nuxtApp.payload.data[key] : nuxtApp.static.data[key];
  return cached as SettingsBootstrap | undefined;
}

export function canLoadSettingsSection(
  section: SettingsDeferredSection,
  role: SettingsRole
): boolean {
  if (section === 'apiTokens' || section === 'webhooks') return role === 'ADMIN';
  return true;
}

export function isSettingsCacheFresh(
  entry: SettingsCacheEntry<unknown> | undefined,
  now = Date.now()
): boolean {
  return Boolean(entry && entry.expiresAt > now);
}

export async function fetchSettingsBootstrap(request: SettingsRequest): Promise<SettingsBootstrap> {
  return request<SettingsBootstrap>(SETTINGS_BOOTSTRAP_ENDPOINT);
}

export async function fetchSettingsSection(
  section: SettingsDeferredSection,
  role: SettingsRole,
  request: SettingsRequest
): Promise<SettingsDeferredData | null> {
  if (!canLoadSettingsSection(section, role)) return null;

  switch (section) {
    case 'sessions':
      return (await request<{ data: SettingsSession[] }>(SETTINGS_DEFERRED_ENDPOINTS.sessions))
        .data;
    case 'twoFactor': {
      const status = await request<Record<string, unknown>>(SETTINGS_DEFERRED_ENDPOINTS.twoFactor);
      return { enabled: Boolean(status.enabled) };
    }
    case 'resignations':
      return (await request<{ data: Resignation[] }>(SETTINGS_DEFERRED_ENDPOINTS.resignations))
        .data;
    case 'apiTokens':
      return (await request<{ data: ApiTokenRecord[] }>(SETTINGS_DEFERRED_ENDPOINTS.apiTokens))
        .data;
    case 'webhooks':
      return (await request<{ data: Webhook[] }>(SETTINGS_DEFERRED_ENDPOINTS.webhooks)).data;
  }
}

export function useSettingsData() {
  const { request } = useApi();

  return useAsyncData(
    SETTINGS_BOOTSTRAP_KEY,
    () => fetchSettingsBootstrap(request as SettingsRequest),
    {
      server: true,
      lazy: true,
      deep: false,
      dedupe: 'defer',
      getCachedData: getSettingsBootstrapCachedData,
    }
  );
}

export function useSettingsSections(
  primary: Ref<SettingsBootstrap | undefined>,
  requestOverride?: SettingsRequest
) {
  const request = requestOverride ?? (useApi().request as SettingsRequest);
  const sessions = shallowRef<SettingsSession[]>([]);
  const twoFactorStatus = shallowRef<SettingsTwoFactorStatus | null>(null);
  const resignations = shallowRef<Resignation[]>([]);
  const apiTokens = shallowRef<ApiTokenRecord[]>([]);
  const webhooks = shallowRef<Webhook[]>([]);
  const sectionLoaded = ref<Record<SettingsDeferredSection, boolean>>({
    sessions: false,
    twoFactor: false,
    resignations: false,
    apiTokens: false,
    webhooks: false,
  });
  const sectionLoading = ref<Record<SettingsDeferredSection, boolean>>({
    sessions: false,
    twoFactor: false,
    resignations: false,
    apiTokens: false,
    webhooks: false,
  });
  const sectionErrors = ref<Record<SettingsDeferredSection, string>>({
    sessions: '',
    twoFactor: '',
    resignations: '',
    apiTokens: '',
    webhooks: '',
  });

  const profile = computed(() => primary.value?.profile ?? null);
  const preferences = computed<SettingsUiPreferences>(() => ({
    ...DEFAULT_SETTINGS_PREFERENCES,
    ...(primary.value?.preferences ?? {}),
  }));
  const notificationPreferences = computed(() => primary.value?.notificationPreferences ?? {});
  const admin = computed(() => profile.value?.role === 'ADMIN');

  function cacheKey(section: SettingsDeferredSection) {
    return `${profile.value?.id ?? 'anonymous'}:${section}`;
  }

  function applySection(section: SettingsDeferredSection, data: SettingsDeferredData) {
    switch (section) {
      case 'sessions':
        sessions.value = data as SettingsSession[];
        break;
      case 'twoFactor':
        twoFactorStatus.value = data as SettingsTwoFactorStatus;
        break;
      case 'resignations':
        resignations.value = data as Resignation[];
        break;
      case 'apiTokens':
        apiTokens.value = data as ApiTokenRecord[];
        break;
      case 'webhooks':
        webhooks.value = data as Webhook[];
        break;
    }
    sectionLoaded.value[section] = true;
  }

  async function loadSection(section: SettingsDeferredSection, force = false) {
    const currentProfile = profile.value;
    if (!currentProfile || !canLoadSettingsSection(section, currentProfile.role)) return;

    const key = cacheKey(section);
    const cached = sectionCache.get(key);
    if (!force && isSettingsCacheFresh(cached)) {
      applySection(section, cached!.data);
      return;
    }

    sectionLoading.value[section] = true;
    sectionErrors.value[section] = '';
    try {
      let pending = sectionRequests.get(key);
      if (!pending || force) {
        pending = fetchSettingsSection(section, currentProfile.role, request);
        sectionRequests.set(key, pending);
      }
      const data = await pending;
      if (data === null) return;
      sectionCache.set(key, { data, expiresAt: Date.now() + SETTINGS_SECTION_TTL_MS });
      applySection(section, data);
    } catch (caught: unknown) {
      const error = caught as { data?: { detail?: string }; message?: string };
      sectionErrors.value[section] =
        error.data?.detail || error.message || 'This Settings section could not be loaded.';
    } finally {
      sectionRequests.delete(key);
      sectionLoading.value[section] = false;
    }
  }

  const loadSecurity = () => Promise.all([loadSection('sessions'), loadSection('twoFactor')]);
  const loadEmployment = () => loadSection('resignations');
  const loadApiTokens = () => loadSection('apiTokens');
  const loadWebhooks = () => loadSection('webhooks');
  const refreshSessions = () => loadSection('sessions', true);
  const refreshTwoFactor = () => loadSection('twoFactor', true);
  const refreshResignations = () => loadSection('resignations', true);
  const refreshApiTokens = () => loadSection('apiTokens', true);
  const refreshWebhooks = () => loadSection('webhooks', true);

  function replacePrimary(changes: Partial<SettingsBootstrap>) {
    if (!primary.value) return;
    primary.value = { ...primary.value, ...changes };
  }

  async function updateProfile(body: Record<string, unknown>) {
    const response = await request<{ data: Partial<SettingsMemberProfile> }>('/api/team/me', {
      method: 'PATCH',
      body,
    });
    if (primary.value) {
      replacePrimary({ profile: { ...primary.value.profile, ...response.data } });
    }
    return response.data;
  }

  async function savePreference(key: string, value: string) {
    const next = { ...preferences.value, [key]: value };
    replacePrimary({ preferences: next });
    await request('/api/auth/preferences', { method: 'PUT', body: next });
  }

  async function saveNotificationPreference(
    category: string,
    channel: 'inApp' | 'email',
    value: boolean
  ) {
    const current = notificationPreferences.value[category] ?? { inApp: true, email: true };
    const next: SettingsNotificationPreferences = {
      ...notificationPreferences.value,
      [category]: { ...current, [channel]: value },
    };
    replacePrimary({ notificationPreferences: next });
    await request('/api/auth/notification-preferences', { method: 'PUT', body: next });
  }

  const changePassword = (currentPassword: string, newPassword: string) =>
    request('/api/auth/password', {
      method: 'PATCH',
      body: { current_password: currentPassword, new_password: newPassword },
    });
  const signOutEverywhere = () => request('/api/auth/sign-out-everywhere', { method: 'POST' });

  const beginTwoFactorEnrollment = () =>
    request<{ secret: string; otpauthUri: string }>('/api/auth/two-factor/enrollment', {
      method: 'POST',
    });
  async function confirmTwoFactor(token: string) {
    const result = await request<{ recoveryCodes: string[] }>(
      '/api/auth/two-factor/enrollment/confirm',
      { method: 'POST', body: { token } }
    );
    await refreshTwoFactor();
    return result;
  }
  async function disableTwoFactor(token: string) {
    await request('/api/auth/two-factor', { method: 'DELETE', body: { token } });
    await refreshTwoFactor();
  }

  async function createApiToken(body: Record<string, unknown>) {
    const result = await request<ApiTokenRecord & { token: string }>(
      SETTINGS_DEFERRED_ENDPOINTS.apiTokens,
      { method: 'POST', body }
    );
    await refreshApiTokens();
    return result;
  }
  async function revokeApiToken(id: string) {
    await request(`/api/admin/api-tokens/${id}`, { method: 'DELETE' });
    await refreshApiTokens();
  }

  async function createWebhook(body: Record<string, unknown>) {
    const result = await request<{ data: Webhook & { secret: string } }>(
      SETTINGS_DEFERRED_ENDPOINTS.webhooks,
      { method: 'POST', body }
    );
    await refreshWebhooks();
    return result.data;
  }
  async function removeWebhook(id: string) {
    await request(`/api/admin/webhooks/${id}`, { method: 'DELETE' });
    await refreshWebhooks();
  }

  async function submitResignation(body: Record<string, unknown>) {
    const result = await request<{ data: Resignation }>(SETTINGS_RESIGNATIONS_ENDPOINT, {
      method: 'POST',
      body,
    });
    await refreshResignations();
    return result.data;
  }
  async function withdrawResignation(id: string) {
    const result = await request<{ data: Resignation }>(`/api/hr/resignations/${id}/withdraw`, {
      method: 'PATCH',
    });
    await refreshResignations();
    return result.data;
  }

  return {
    profile,
    preferences,
    notificationPreferences,
    admin,
    sessions,
    twoFactorStatus,
    resignations,
    apiTokens,
    webhooks,
    sectionLoaded,
    sectionLoading,
    sectionErrors,
    loadSecurity,
    loadEmployment,
    loadApiTokens,
    loadWebhooks,
    refreshSessions,
    refreshTwoFactor,
    refreshResignations,
    refreshApiTokens,
    refreshWebhooks,
    updateProfile,
    savePreference,
    saveNotificationPreference,
    changePassword,
    signOutEverywhere,
    beginTwoFactorEnrollment,
    confirmTwoFactor,
    disableTwoFactor,
    createApiToken,
    revokeApiToken,
    createWebhook,
    removeWebhook,
    submitResignation,
    withdrawResignation,
  };
}
