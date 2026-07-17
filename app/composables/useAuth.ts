import type { ApiResponse, User } from '~/types/api';

// Route middleware can reuse a recently server-validated principal for one minute.
// Protected API endpoints remain authoritative and validate the bearer token on every request.
export const AUTH_USER_CACHE_TTL_MS = 60_000;

export interface LoadUserOptions {
  force?: boolean;
}

interface AuthRuntimeState {
  generation: number;
  inFlight: Promise<User | null> | null;
}

const authRuntimeByNuxtApp = new WeakMap<object, AuthRuntimeState>();

function getAuthRuntime(nuxtApp: object): AuthRuntimeState {
  const existing = authRuntimeByNuxtApp.get(nuxtApp);
  if (existing) return existing;

  const runtime = { generation: 0, inFlight: null };
  authRuntimeByNuxtApp.set(nuxtApp, runtime);
  return runtime;
}

export function useAuth() {
  const token = useCookie<string | null>('df_access_token', {
    sameSite: 'lax',
    secure: import.meta.env.PROD,
    maxAge: 60 * 60 * 24 * 7,
  });
  const user = useState<User | null>('auth-user', () => null);
  const validatedAt = useState<number | null>('auth-user-validated-at', () => null);
  const runtime = getAuthRuntime(useNuxtApp());
  const { request } = useApi();

  function clearAuthentication() {
    runtime.generation += 1;
    runtime.inFlight = null;
    token.value = null;
    user.value = null;
    validatedAt.value = null;
  }

  function storeAuthenticatedUser(accessToken: string, authenticatedUser: User) {
    runtime.generation += 1;
    runtime.inFlight = null;
    token.value = accessToken;
    user.value = authenticatedUser;
    validatedAt.value = Date.now();
  }

  async function login(email: string, password: string) {
    const response = await request<
      | { access_token: string; user: User }
      | { two_factor_required: true; challenge_token: string; expires_in: number }
    >('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    if ('two_factor_required' in response) return response;
    storeAuthenticatedUser(response.access_token, response.user);
    return response.user;
  }

  async function verifyTwoFactor(challengeToken: string, code: string) {
    const response = await request<{ access_token: string; user: User }>('/api/auth/login/verify', {
      method: 'POST',
      body: { challenge_token: challengeToken, code },
    });
    storeAuthenticatedUser(response.access_token, response.user);
    return response.user;
  }

  function loadUser({ force = false }: LoadUserOptions = {}): Promise<User | null> {
    if (!token.value) {
      clearAuthentication();
      return Promise.resolve(null);
    }

    if (runtime.inFlight) return runtime.inFlight;

    const now = Date.now();
    const cacheAge =
      validatedAt.value === null ? Number.POSITIVE_INFINITY : now - validatedAt.value;
    if (!force && user.value && cacheAge < AUTH_USER_CACHE_TTL_MS) {
      // SSR and browser clocks can differ; rebase a future server timestamp so
      // clock skew cannot extend the client-side cache beyond one local TTL.
      if (cacheAge < 0) validatedAt.value = now;
      return Promise.resolve(user.value);
    }

    const generation = runtime.generation;
    const tokenAtRequestStart = token.value;
    let validationRequest: Promise<User | null>;

    validationRequest = request<ApiResponse<User>>('/api/auth/me')
      .then((response) => {
        if (runtime.generation !== generation || token.value !== tokenAtRequestStart) return null;
        if (!response.data) {
          clearAuthentication();
          return null;
        }
        user.value = response.data;
        validatedAt.value = Date.now();
        return user.value;
      })
      .catch(() => {
        if (runtime.generation === generation && token.value === tokenAtRequestStart) {
          clearAuthentication();
        }
        return null;
      })
      .finally(() => {
        if (runtime.inFlight === validationRequest) runtime.inFlight = null;
      });

    runtime.inFlight = validationRequest;
    return validationRequest;
  }

  async function logout() {
    clearAuthentication();
    await navigateTo('/login');
  }

  return { token, user, validatedAt, login, verifyTwoFactor, loadUser, logout };
}
