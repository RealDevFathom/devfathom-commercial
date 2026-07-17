import type { ApiResponse, User } from '~/types/api';

export function useAuth() {
  const token = useCookie<string | null>('df_access_token', {
    sameSite: 'lax',
    secure: import.meta.env.PROD,
    maxAge: 60 * 60 * 24 * 7,
  });
  const user = useState<User | null>('auth-user', () => null);
  const { request } = useApi();

  async function login(email: string, password: string) {
    const response = await request<
      | { access_token: string; user: User }
      | { two_factor_required: true; challenge_token: string; expires_in: number }
    >('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    if ('two_factor_required' in response) return response;
    token.value = response.access_token;
    user.value = response.user;
    return response.user;
  }

  async function verifyTwoFactor(challengeToken: string, code: string) {
    const response = await request<{ access_token: string; user: User }>('/api/auth/login/verify', {
      method: 'POST',
      body: { challenge_token: challengeToken, code },
    });
    token.value = response.access_token;
    user.value = response.user;
    return response.user;
  }

  async function loadUser() {
    if (!token.value) return null;
    if (user.value) return user.value;
    try {
      const response = await request<ApiResponse<User>>('/api/auth/me');
      user.value = response.data;
      return user.value;
    } catch {
      token.value = null;
      user.value = null;
      return null;
    }
  }

  async function logout() {
    token.value = null;
    user.value = null;
    await navigateTo('/login');
  }

  return { token, user, login, verifyTwoFactor, loadUser, logout };
}
