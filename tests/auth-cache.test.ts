import { beforeEach, describe, expect, test } from 'bun:test';
import { AUTH_USER_CACHE_TTL_MS, useAuth } from '../app/composables/useAuth.ts';
import type { ApiResponse, User } from '../app/types/api.ts';

interface Ref<T> {
  value: T;
}

type RequestImplementation = (path: string) => Promise<ApiResponse<User>>;

const admin: User = {
  id: 'user-1',
  name: 'Ada Admin',
  email: 'ada@example.com',
  role: 'ADMIN',
};

const employee: User = {
  id: 'user-2',
  name: 'Eli Employee',
  email: 'eli@example.com',
  role: 'EMPLOYEE',
};

const globals = globalThis as Record<string, unknown>;
let nuxtApp: object;
let cookies: Map<string, Ref<string | null>>;
let states: Map<string, Ref<unknown>>;
let requestCalls: string[];
let requestImplementation: RequestImplementation;
let navigations: string[];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function cookie(name: string) {
  const existing = cookies.get(name);
  if (existing) return existing;
  const value = { value: null };
  cookies.set(name, value);
  return value;
}

beforeEach(() => {
  nuxtApp = {};
  cookies = new Map();
  states = new Map();
  requestCalls = [];
  navigations = [];
  requestImplementation = async () => ({ data: admin });

  globals.useNuxtApp = () => nuxtApp;
  globals.useCookie = (name: string) => cookie(name);
  globals.useState = (key: string, initialise: () => unknown) => {
    const existing = states.get(key);
    if (existing) return existing;
    const value = { value: initialise() };
    states.set(key, value);
    return value;
  };
  globals.useApi = () => ({
    request: (path: string) => {
      requestCalls.push(path);
      return requestImplementation(path);
    },
  });
  globals.navigateTo = async (path: string) => {
    navigations.push(path);
  };
});

describe('Nuxt auth session validation cache', () => {
  test('validates a cookie-backed session when a hard refresh starts with empty user state', async () => {
    cookie('df_access_token').value = 'session-token';
    const auth = useAuth();

    expect(auth.user.value).toBeNull();
    expect(auth.validatedAt.value).toBeNull();
    expect(await auth.loadUser()).toEqual(admin);
    expect(requestCalls).toEqual(['/api/auth/me']);
  });

  test('shares one in-flight validation across simultaneous loadUser calls', async () => {
    const validation = deferred<ApiResponse<User>>();
    requestImplementation = () => validation.promise;
    cookie('df_access_token').value = 'session-token';

    const firstAuth = useAuth();
    const secondAuth = useAuth();
    const first = firstAuth.loadUser();
    const second = secondAuth.loadUser();

    expect(first).toBe(second);
    expect(requestCalls).toEqual(['/api/auth/me']);

    validation.resolve({ data: admin });
    expect(await first).toEqual(admin);
    expect(await second).toEqual(admin);
  });

  test('reuses a successful validation within the TTL and revalidates after expiry', async () => {
    const responses = [admin, employee];
    requestImplementation = async () => ({ data: responses.shift() as User });
    cookie('df_access_token').value = 'session-token';
    const auth = useAuth();

    expect(await auth.loadUser()).toEqual(admin);
    expect(await auth.loadUser()).toEqual(admin);
    expect(requestCalls).toHaveLength(1);

    auth.validatedAt.value = Date.now() - AUTH_USER_CACHE_TTL_MS - 1;
    expect(await auth.loadUser()).toEqual(employee);
    expect(requestCalls).toEqual(['/api/auth/me', '/api/auth/me']);
  });

  test('supports an explicit forced refresh of a fresh cached user', async () => {
    const responses = [admin, employee];
    requestImplementation = async () => ({ data: responses.shift() as User });
    cookie('df_access_token').value = 'session-token';
    const auth = useAuth();

    expect(await auth.loadUser()).toEqual(admin);
    expect(await auth.loadUser({ force: true })).toEqual(employee);
    expect(requestCalls).toEqual(['/api/auth/me', '/api/auth/me']);
  });

  test('logout clears all cached and in-flight authentication state', async () => {
    const staleValidation = deferred<ApiResponse<User>>();
    const freshValidation = deferred<ApiResponse<User>>();
    const validations = [staleValidation, freshValidation];
    requestImplementation = () => {
      const validation = validations.shift();
      if (!validation) throw new Error('Missing queued validation');
      return validation.promise;
    };
    cookie('df_access_token').value = 'old-session-token';
    const auth = useAuth();

    const staleRequest = auth.loadUser();
    await auth.logout();

    expect(auth.token.value).toBeNull();
    expect(auth.user.value).toBeNull();
    expect(auth.validatedAt.value).toBeNull();
    expect(navigations).toEqual(['/login']);

    auth.token.value = 'new-session-token';
    const freshRequest = auth.loadUser();
    expect(freshRequest).not.toBe(staleRequest);
    expect(requestCalls).toHaveLength(2);

    freshValidation.resolve({ data: employee });
    expect(await freshRequest).toEqual(employee);
    staleValidation.resolve({ data: admin });
    expect(await staleRequest).toBeNull();
    expect(auth.user.value).toEqual(employee);
  });

  test('clears rejected sessions and never caches a failed request', async () => {
    requestImplementation = async () => {
      throw new Error('Unauthorized');
    };
    cookie('df_access_token').value = 'rejected-session-token';
    const auth = useAuth();

    expect(await auth.loadUser()).toBeNull();
    expect(auth.token.value).toBeNull();
    expect(auth.user.value).toBeNull();
    expect(auth.validatedAt.value).toBeNull();

    auth.token.value = 'replacement-session-token';
    requestImplementation = async () => ({ data: employee });
    expect(await auth.loadUser()).toEqual(employee);
    expect(requestCalls).toEqual(['/api/auth/me', '/api/auth/me']);
  });

  test('clears a malformed session validation response instead of caching it', async () => {
    requestImplementation = async () => ({ data: null as unknown as User });
    cookie('df_access_token').value = 'invalid-session-token';
    const auth = useAuth();

    expect(await auth.loadUser()).toBeNull();
    expect(auth.token.value).toBeNull();
    expect(auth.user.value).toBeNull();
    expect(auth.validatedAt.value).toBeNull();
  });
});
