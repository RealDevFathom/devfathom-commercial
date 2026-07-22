import { beforeEach, describe, expect, test } from 'bun:test';
import {
  SETTINGS_BOOTSTRAP_ENDPOINT,
  SETTINGS_BOOTSTRAP_KEY,
  SETTINGS_DEFERRED_ENDPOINTS,
  SETTINGS_RESIGNATIONS_ENDPOINT,
  SETTINGS_SECTION_TTL_MS,
  canLoadSettingsSection,
  fetchSettingsBootstrap,
  fetchSettingsSection,
  getSettingsBootstrapCachedData,
  isSettingsCacheFresh,
  useSettingsData,
  useSettingsSections,
} from '../app/composables/useSettingsData.ts';
import type { SettingsBootstrap } from '../app/types/settings-bootstrap.ts';

const globals = globalThis as Record<string, unknown>;

function reference<T>(value: T) {
  return { value };
}

function bootstrap(role: 'ADMIN' | 'EMPLOYEE' = 'ADMIN', id = 'settings-user'): SettingsBootstrap {
  return {
    profile: {
      id,
      name: 'Settings User',
      email: 'settings@example.com',
      role,
      department: 'ENGINEERING',
      title: 'Engineer',
      skills: ['Vue'],
      status: 'ACTIVE',
    },
    preferences: { theme: 'system' },
    notificationPreferences: { task: { inApp: true, email: true } },
  };
}

beforeEach(() => {
  globals.ref = reference;
  globals.shallowRef = reference;
  globals.computed = (getter: () => unknown) => ({
    get value() {
      return getter();
    },
  });
});

describe('Settings fast-path loading', () => {
  test('uses exactly one endpoint for primary Settings data', async () => {
    const calls: string[] = [];
    const expected = bootstrap('EMPLOYEE');
    const result = await fetchSettingsBootstrap(async (path) => {
      calls.push(path);
      return expected;
    });

    expect(result).toEqual(expected);
    expect(calls).toEqual([SETTINGS_BOOTSTRAP_ENDPOINT]);
    expect(calls).not.toContain(SETTINGS_DEFERRED_ENDPOINTS.sessions);
    expect(calls).not.toContain(SETTINGS_DEFERRED_ENDPOINTS.resignations);
  });

  test('reuses the SSR payload during hydration without invoking the handler', () => {
    const expected = bootstrap('EMPLOYEE');
    const requestCalls: string[] = [];
    let captured:
      | {
          key: string;
          handler: () => Promise<SettingsBootstrap>;
          options: { getCachedData: typeof getSettingsBootstrapCachedData };
        }
      | undefined;
    globals.useApi = () => ({
      request: async (path: string) => {
        requestCalls.push(path);
        return expected;
      },
    });
    globals.useAsyncData = (
      key: string,
      handler: () => Promise<SettingsBootstrap>,
      options: object
    ) => {
      captured = { key, handler, options } as typeof captured;
      return captured;
    };

    useSettingsData();
    const cached = captured!.options.getCachedData(SETTINGS_BOOTSTRAP_KEY, {
      isHydrating: true,
      payload: { data: { [SETTINGS_BOOTSTRAP_KEY]: expected } },
      static: { data: {} },
    });

    expect(cached).toEqual(expected);
    expect(requestCalls).toEqual([]);
    const serialized = JSON.stringify(cached).toLowerCase();
    expect(serialized).not.toContain('bearer');
    expect(serialized).not.toContain('credential');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('secret');
  });

  test('does not issue admin requests for non-admin users', async () => {
    const calls: string[] = [];
    const request = async (path: string) => {
      calls.push(path);
      return { data: [] };
    };

    expect(canLoadSettingsSection('apiTokens', 'EMPLOYEE')).toBe(false);
    expect(canLoadSettingsSection('webhooks', 'HR')).toBe(false);
    expect(await fetchSettingsSection('apiTokens', 'EMPLOYEE', request)).toBeNull();
    expect(await fetchSettingsSection('webhooks', 'EMPLOYEE', request)).toBeNull();
    expect(calls).toEqual([]);
  });

  test('fetches only the deferred section that was requested', async () => {
    const calls: string[] = [];
    const request = async (path: string) => {
      calls.push(path);
      if (path === SETTINGS_DEFERRED_ENDPOINTS.twoFactor) return { enabled: true };
      return { data: [] };
    };

    await fetchSettingsSection('sessions', 'EMPLOYEE', request);
    expect(calls).toEqual([SETTINGS_DEFERRED_ENDPOINTS.sessions]);
    await fetchSettingsSection('twoFactor', 'EMPLOYEE', request);
    expect(calls).toEqual([
      SETTINGS_DEFERRED_ENDPOINTS.sessions,
      SETTINGS_DEFERRED_ENDPOINTS.twoFactor,
    ]);
    await fetchSettingsSection('resignations', 'EMPLOYEE', request);
    expect(calls.at(-1)).toBe(SETTINGS_DEFERRED_ENDPOINTS.resignations);
  });

  test('treats section cache entries as fresh only within the short browser TTL', () => {
    const now = 1_000_000;
    expect(isSettingsCacheFresh({ data: [], expiresAt: now + SETTINGS_SECTION_TTL_MS }, now)).toBe(
      true
    );
    expect(isSettingsCacheFresh({ data: [], expiresAt: now }, now)).toBe(false);
  });

  test('reuses each loaded section from the current browser cache', async () => {
    const primary = reference(bootstrap('EMPLOYEE', 'cache-user'));
    const calls: string[] = [];
    const settings = useSettingsSections(primary, async (path) => {
      calls.push(path);
      if (path === SETTINGS_DEFERRED_ENDPOINTS.twoFactor) return { enabled: false };
      return { data: [] };
    });

    await settings.loadSecurity();
    await settings.loadSecurity();
    await settings.loadEmployment();
    await settings.loadEmployment();

    expect(calls).toEqual([
      SETTINGS_DEFERRED_ENDPOINTS.sessions,
      SETTINGS_DEFERRED_ENDPOINTS.twoFactor,
      SETTINGS_DEFERRED_ENDPOINTS.resignations,
    ]);
  });
});

describe('Settings mutation isolation', () => {
  test('updates local preferences before persistence resolves', async () => {
    const primary = reference(bootstrap());
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = async (path: string) => {
      if (path === '/api/auth/preferences') await persisted;
      return { success: true };
    };
    const settings = useSettingsSections(primary, request);

    const saving = settings.savePreference('theme', 'dark');
    expect(primary.value.preferences.theme).toBe('dark');
    release();
    await saving;
  });

  test('refreshes only the dataset owned by each mutation flow', async () => {
    const primary = reference(bootstrap('ADMIN', 'mutation-user'));
    const calls: Array<{ path: string; method: string }> = [];
    const request = async (path: string, options: { method?: string } = {}) => {
      const method = options.method ?? 'GET';
      calls.push({ path, method });
      if (path === '/api/team/me') return { data: { name: 'Updated User' } };
      if (path === SETTINGS_DEFERRED_ENDPOINTS.twoFactor) {
        return method === 'GET' ? { enabled: true } : { success: true };
      }
      if (path === '/api/auth/two-factor/enrollment') {
        return { secret: 'one-shot-2fa', otpauthUri: 'otpauth://safe' };
      }
      if (path === '/api/auth/two-factor/enrollment/confirm') {
        return { recoveryCodes: ['one-shot-recovery'] };
      }
      if (path === SETTINGS_DEFERRED_ENDPOINTS.apiTokens && method === 'POST') {
        return {
          id: 'token-1',
          name: 'CI',
          prefix: 'df_prefix',
          scopes: [],
          token: 'one-shot-token',
        };
      }
      if (path === SETTINGS_DEFERRED_ENDPOINTS.webhooks && method === 'POST') {
        return { data: { id: 'hook-1', secret: 'one-shot-webhook' } };
      }
      if (path === SETTINGS_RESIGNATIONS_ENDPOINT && method === 'POST') {
        return { data: { id: 'resignation-1' } };
      }
      if (path.endsWith('/withdraw')) return { data: { id: 'resignation-1' } };
      return { data: [] };
    };
    const settings = useSettingsSections(primary, request);

    await settings.updateProfile({ name: 'Updated User' });
    expect(calls.splice(0)).toEqual([{ path: '/api/team/me', method: 'PATCH' }]);
    expect(primary.value.profile.name).toBe('Updated User');

    await settings.savePreference('density', 'compact');
    expect(calls.splice(0)).toEqual([{ path: '/api/auth/preferences', method: 'PUT' }]);
    await settings.saveNotificationPreference('task', 'email', false);
    expect(calls.splice(0)).toEqual([
      { path: '/api/auth/notification-preferences', method: 'PUT' },
    ]);
    await settings.changePassword('old-password', 'new-password');
    expect(calls.splice(0)).toEqual([{ path: '/api/auth/password', method: 'PATCH' }]);
    await settings.signOutEverywhere();
    expect(calls.splice(0)).toEqual([{ path: '/api/auth/sign-out-everywhere', method: 'POST' }]);

    await settings.beginTwoFactorEnrollment();
    expect(calls.splice(0)).toEqual([{ path: '/api/auth/two-factor/enrollment', method: 'POST' }]);
    await settings.confirmTwoFactor('123456');
    expect(calls.splice(0)).toEqual([
      { path: '/api/auth/two-factor/enrollment/confirm', method: 'POST' },
      { path: SETTINGS_DEFERRED_ENDPOINTS.twoFactor, method: 'GET' },
    ]);
    await settings.disableTwoFactor('123456');
    expect(calls.splice(0)).toEqual([
      { path: '/api/auth/two-factor', method: 'DELETE' },
      { path: SETTINGS_DEFERRED_ENDPOINTS.twoFactor, method: 'GET' },
    ]);

    await settings.createApiToken({ name: 'CI' });
    expect(calls.splice(0)).toEqual([
      { path: SETTINGS_DEFERRED_ENDPOINTS.apiTokens, method: 'POST' },
      { path: SETTINGS_DEFERRED_ENDPOINTS.apiTokens, method: 'GET' },
    ]);
    await settings.revokeApiToken('token-1');
    expect(calls.splice(0)).toEqual([
      { path: '/api/admin/api-tokens/token-1', method: 'DELETE' },
      { path: SETTINGS_DEFERRED_ENDPOINTS.apiTokens, method: 'GET' },
    ]);

    await settings.createWebhook({ url: 'https://example.com/hook' });
    expect(calls.splice(0)).toEqual([
      { path: SETTINGS_DEFERRED_ENDPOINTS.webhooks, method: 'POST' },
      { path: SETTINGS_DEFERRED_ENDPOINTS.webhooks, method: 'GET' },
    ]);
    await settings.removeWebhook('hook-1');
    expect(calls.splice(0)).toEqual([
      { path: '/api/admin/webhooks/hook-1', method: 'DELETE' },
      { path: SETTINGS_DEFERRED_ENDPOINTS.webhooks, method: 'GET' },
    ]);

    await settings.submitResignation({ reason: 'New role' });
    expect(calls.splice(0)).toEqual([
      { path: SETTINGS_RESIGNATIONS_ENDPOINT, method: 'POST' },
      { path: SETTINGS_DEFERRED_ENDPOINTS.resignations, method: 'GET' },
    ]);
    await settings.withdrawResignation('resignation-1');
    expect(calls.splice(0)).toEqual([
      { path: '/api/hr/resignations/resignation-1/withdraw', method: 'PATCH' },
      { path: SETTINGS_DEFERRED_ENDPOINTS.resignations, method: 'GET' },
    ]);

    expect(calls).toEqual([]);
    expect(JSON.stringify(primary.value)).not.toContain('one-shot-token');
    expect(JSON.stringify(primary.value)).not.toContain('one-shot-webhook');
    expect(JSON.stringify(primary.value)).not.toContain('one-shot-2fa');
  });

  test('keeps admin loaders inert for an employee composable', async () => {
    const primary = reference(bootstrap('EMPLOYEE', 'employee-user'));
    const calls: string[] = [];
    const settings = useSettingsSections(primary, async (path) => {
      calls.push(path);
      return { data: [] };
    });

    await settings.loadApiTokens();
    await settings.loadWebhooks();
    expect(calls).toEqual([]);
  });
});
