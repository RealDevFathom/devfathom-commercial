// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), shared: vi.fn(), discard: vi.fn() }));
vi.mock('@/lib/auth', () => ({ handlers: { GET: m.get, POST: m.post } }));
vi.mock('@/app/api/login/route', () => ({ POST: m.shared }));
vi.mock('@/lib/auth/login-intent', () => ({
  LOGIN_INTENT_COOKIE: 'df_login_intent',
  discardLoginIntent: m.discard,
}));
vi.mock('@/lib/tenancy/host', () => ({ requestHost: (r: Request) => r.headers.get('host') }));
import { POST } from './route';
function request(
  fields: Record<string, string> = {},
  headers: Record<string, string> = {},
  host = 'tenant.example.test'
) {
  return new Request(`https://${host}/login/submit`, {
    method: 'POST',
    headers: {
      host,
      origin: `https://${host}`,
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'same-origin',
      cookie: 'session=old; keep=value',
      'x-forwarded-for': '192.0.2.1',
      ...headers,
    },
    body: new URLSearchParams({
      email: 'reader@example.test',
      password: 'fake-password',
      callbackUrl: '/dashboard',
      ...fields,
    }),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('PLATFORM_BASE_DOMAIN', 'example.test');
  m.get.mockResolvedValue(
    Response.json(
      { csrfToken: 'fake-csrf' },
      { headers: { 'set-cookie': 'csrf=fake-cookie; HttpOnly' } }
    )
  );
  m.post.mockResolvedValue(
    Response.json(
      { url: 'https://tenant.example.test/login' },
      { headers: { 'set-cookie': 'session=new; HttpOnly' } }
    )
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe('native login composition', () => {
  it.each<Record<string, string>>([
    { origin: 'https://foreign.test' },
    { origin: '' },
    { 'sec-fetch-site': 'cross-site' },
    { 'content-type': 'application/json' },
  ])('rejects invalid origin/body boundary %j', async (headers) => {
    expect((await POST(request({}, headers))).status).toBe(403);
    expect(m.get).not.toHaveBeenCalled();
    expect(m.shared).not.toHaveBeenCalled();
  });
  it('forwards the CSRF cookie/token, original client headers and credentials to existing auth handlers', async () => {
    const response = await POST(request({ totp: '123456' }, { 'content-length': '999' }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/dashboard');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const callback = m.post.mock.calls[0][0] as Request;
    expect(callback.url).toBe('https://tenant.example.test/api/auth/callback/credentials');
    expect(callback.headers.get('cookie')).toContain('csrf=fake-cookie');
    expect(callback.headers.get('cookie')).toContain('keep=value');
    expect(callback.headers.get('x-forwarded-for')).toBe('192.0.2.1');
    expect(callback.headers.get('content-length')).toBeNull();
    expect(Object.fromEntries(await callback.formData())).toEqual({
      email: 'reader@example.test',
      password: 'fake-password',
      totp: '123456',
      csrfToken: 'fake-csrf',
      callbackUrl: 'https://tenant.example.test/login',
    });
    expect(response.headers.getSetCookie()).toEqual([
      'csrf=fake-cookie; HttpOnly',
      'session=new; HttpOnly',
    ]);
  });
  it.each(['https://foreign.test/', '//foreign.test/', '/\\foreign.test/'])(
    'does not redirect to unsafe callback %s',
    async (callbackUrl) => {
      const response = await POST(request({ callbackUrl }));
      expect(response.headers.get('location')).toBe('/dashboard');
    }
  );
  it.each([
    ['2fa_required', '2fa-required'],
    ['2fa_invalid', '2fa-invalid'],
    ['sso_required', 'sso-required'],
    ['suspended', 'suspended'],
    ['rate_limited', 'rate-limited'],
    ['unknown', 'invalid'],
  ])('maps %s without leaking auth details', async (code, key) => {
    m.post.mockResolvedValue(
      Response.json({
        url: `https://tenant.example.test/login?error=CredentialsSignin&code=${code}`,
      })
    );
    expect((await POST(request())).headers.get('location')).toBe(`/login?loginError=${key}`);
  });
  it('refuses a missing CSRF token before credential submission', async () => {
    m.get.mockResolvedValue(Response.json({}));
    const response = await POST(request());
    expect(response.headers.get('location')).toBe('/login?loginError=invalid');
    expect(m.post).not.toHaveBeenCalled();
  });
  it('honors shared rate limiting before invoking credentials callback', async () => {
    m.shared.mockResolvedValue(Response.json({}, { status: 429 }));
    const response = await POST(request({}, {}, 'app.example.test'));
    expect(response.headers.get('location')).toBe('/login?loginError=rate-limited');
    expect(m.get).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
  });
  it('carries the single-workspace intent to existing Auth.js and retires unused interactive intents', async () => {
    m.shared.mockResolvedValue(
      Response.json(
        { outcome: 'single', organizations: [{ id: 'org-a', ssoEnforced: false }] },
        { headers: { 'set-cookie': 'df_login_intent=fake-intent; HttpOnly' } }
      )
    );
    expect((await POST(request({}, {}, 'app.example.test'))).status).toBe(303);
    const callback = m.post.mock.calls[0][0] as Request;
    expect(callback.url).toContain('/callback/login-intent');
    expect(callback.headers.get('cookie')).toContain('df_login_intent=fake-intent');
    expect((await callback.formData()).get('organizationId')).toBe('org-a');
    m.shared.mockResolvedValue(
      Response.json(
        { outcome: 'multiple', organizations: [] },
        { headers: { 'set-cookie': 'df_login_intent=unused; HttpOnly' } }
      )
    );
    expect((await POST(request({}, {}, 'app.example.test'))).headers.get('location')).toBe(
      '/login?loginError=continue'
    );
    expect(m.discard).toHaveBeenCalledExactlyOnceWith('unused');
  });
  it('reports an unavailable handler without logging submitted credentials or error contents', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.get.mockRejectedValue(new Error('fake-password private details'));
    expect((await POST(request())).headers.get('location')).toBe('/login?loginError=unavailable');
    expect(log).toHaveBeenCalledExactlyOnceWith('[login/submit] native sign-in failed:', 'Error');
  });
});
