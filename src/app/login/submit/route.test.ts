/**
 * WHA-1623 — the native (pre-hydration) sign-in POST.
 *
 * The handlers it composes are mocked: this file proves the transport — which
 * requests are replayed, which cookies travel, where the browser is sent — not
 * the credential checks, which keep their own suites.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authGet: vi.fn(),
  authPost: vi.fn(),
  sharedPost: vi.fn(),
  discardLoginIntent: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ handlers: { GET: mocks.authGet, POST: mocks.authPost } }));
vi.mock('@/app/api/login/route', () => ({ POST: mocks.sharedPost }));
vi.mock('@/lib/auth/login-intent', () => ({
  LOGIN_INTENT_COOKIE: 'df_login_intent',
  discardLoginIntent: mocks.discardLoginIntent,
}));

import { POST } from './route';

const ORIGINAL_BASE_DOMAIN = process.env.PLATFORM_BASE_DOMAIN;
const SESSION_COOKIE = 'authjs.session-token=session-jwt; Path=/; HttpOnly; SameSite=Lax';

function nativePost(
  fields: Record<string, string>,
  host = 'acme.devfathom.com',
  headers: Record<string, string> = {}
) {
  return new Request(`https://${host}/login/submit`, {
    method: 'POST',
    headers: {
      host,
      origin: `https://${host}`,
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-proto': 'https',
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
    body: new URLSearchParams(fields),
  });
}

function csrfResponse() {
  return Response.json(
    { csrfToken: 'csrf-token' },
    { headers: { 'set-cookie': 'authjs.csrf-token=csrf-token%7Chash; Path=/; HttpOnly' } }
  );
}

function callbackResponse(url: string, setCookie?: string) {
  return Response.json({ url }, setCookie ? { headers: { 'set-cookie': setCookie } } : undefined);
}

const CREDENTIALS = {
  email: 'alex@company.com',
  password: 'correct-horse',
  callbackUrl: '/pharmacy',
};

describe('POST /login/submit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PLATFORM_BASE_DOMAIN = 'devfathom.com';
    mocks.authGet.mockImplementation(async () => csrfResponse());
    mocks.discardLoginIntent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.PLATFORM_BASE_DOMAIN = ORIGINAL_BASE_DOMAIN;
  });

  describe('tenant host', () => {
    it('signs in through the credentials callback and redirects to the callback URL', async () => {
      mocks.authPost.mockResolvedValue(
        callbackResponse('https://acme.devfathom.com/login', SESSION_COOKIE)
      );

      const response = await POST(nativePost({ ...CREDENTIALS, totp: '' }));

      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/pharmacy');
      expect(response.headers.getSetCookie()).toContain(SESSION_COOKIE);

      const callback = mocks.authPost.mock.calls[0][0] as Request;
      expect(new URL(callback.url).pathname).toBe('/api/auth/callback/credentials');
      expect(callback.headers.get('cookie')).toContain('authjs.csrf-token=csrf-token%7Chash');
      const body = new URLSearchParams(await callback.text());
      expect(body.get('email')).toBe(CREDENTIALS.email);
      expect(body.get('password')).toBe(CREDENTIALS.password);
      expect(body.get('csrfToken')).toBe('csrf-token');
    });

    it('re-renders /login with the uniform error and no session on a wrong password', async () => {
      mocks.authPost.mockResolvedValue(
        callbackResponse(
          'https://acme.devfathom.com/login?error=CredentialsSignin&code=credentials'
        )
      );

      const response = await POST(nativePost(CREDENTIALS));

      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(
        '/login?loginError=invalid&callbackUrl=%2Fpharmacy'
      );
      expect(response.headers.getSetCookie()).toEqual([]);
    });

    it.each([
      ['2fa_required', '2fa-required'],
      ['2fa_invalid', '2fa-invalid'],
      ['suspended', 'suspended'],
      ['sso_required', 'sso-required'],
      ['organization_suspended', 'invalid'],
    ])('maps Auth.js code %s to %s exactly as the hydrated form does', async (code, key) => {
      mocks.authPost.mockResolvedValue(
        callbackResponse(`https://acme.devfathom.com/login?error=CredentialsSignin&code=${code}`)
      );

      const response = await POST(nativePost({ email: 'a@b.co', password: 'x' }));

      expect(response.headers.get('location')).toBe(`/login?loginError=${key}`);
    });

    it('never redirects off-origin, whatever callbackUrl says', async () => {
      mocks.authPost.mockResolvedValue(callbackResponse('https://acme.devfathom.com/login'));

      const response = await POST(nativePost({ ...CREDENTIALS, callbackUrl: '//evil.com' }));

      expect(response.headers.get('location')).toBe('/dashboard');
    });

    it('reports an unavailable service without leaking the failure', async () => {
      mocks.authGet.mockRejectedValue(new Error('db down for alex@company.com'));
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const response = await POST(nativePost(CREDENTIALS));

      expect(response.headers.get('location')).toBe(
        '/login?loginError=unavailable&callbackUrl=%2Fpharmacy'
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain('alex@company.com');
      log.mockRestore();
    });
  });

  describe('login CSRF', () => {
    it.each([
      ['a cross-site origin', { origin: 'https://evil.com' }],
      ['a cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
      ['a JSON body', { 'content-type': 'application/json' }],
    ])('refuses %s', async (_label, headers) => {
      const response = await POST(nativePost(CREDENTIALS, 'acme.devfathom.com', headers));

      expect(response.status).toBe(403);
      expect(mocks.authPost).not.toHaveBeenCalled();
      expect(mocks.sharedPost).not.toHaveBeenCalled();
    });
  });

  describe('shared host', () => {
    const HOST = 'www.devfathom.com';
    const INTENT = 'df_login_intent=intent-token; Path=/; HttpOnly; SameSite=Lax';

    function sharedCheck(body: unknown, init?: ResponseInit) {
      mocks.sharedPost.mockResolvedValue(Response.json(body, init));
    }

    it('proves the password via /api/login, then exchanges the intent for a session', async () => {
      sharedCheck(
        { outcome: 'single', organizations: [{ id: 'org_1', ssoEnforced: false }] },
        { headers: { 'set-cookie': INTENT } }
      );
      mocks.authPost.mockResolvedValue(callbackResponse(`https://${HOST}/login`, SESSION_COOKIE));

      const response = await POST(nativePost(CREDENTIALS, HOST));

      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/pharmacy');
      expect(response.headers.getSetCookie()).toContain(SESSION_COOKIE);

      const check = mocks.sharedPost.mock.calls[0][0] as Request;
      expect(check.headers.get('content-type')).toBe('application/json');
      expect(check.headers.get('origin')).toBe(`https://${HOST}`);
      expect(await check.json()).toEqual({
        email: CREDENTIALS.email,
        password: CREDENTIALS.password,
        callbackUrl: '/pharmacy',
      });

      // The login-intent provider (which clears the WHA-1570 budgets) receives
      // the freshly minted intent exactly as the browser would send it.
      const exchange = mocks.authPost.mock.calls[0][0] as Request;
      expect(new URL(exchange.url).pathname).toBe('/api/auth/callback/login-intent');
      expect(exchange.headers.get('cookie')).toContain('df_login_intent=intent-token');
      expect(new URLSearchParams(await exchange.text()).get('organizationId')).toBe('org_1');
      expect(mocks.discardLoginIntent).not.toHaveBeenCalled();
    });

    it('re-renders /login with the uniform error on a wrong password', async () => {
      sharedCheck(
        { outcome: 'failed', message: 'Invalid email or password. Please try again.' },
        { status: 401 }
      );

      const response = await POST(nativePost(CREDENTIALS, HOST));

      expect(response.headers.get('location')).toBe(
        '/login?loginError=invalid&callbackUrl=%2Fpharmacy'
      );
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(mocks.authPost).not.toHaveBeenCalled();
    });

    it('names a tripped limiter rather than blaming the password', async () => {
      sharedCheck({ outcome: 'failed' }, { status: 429, headers: { 'retry-after': '60' } });

      const response = await POST(nativePost(CREDENTIALS, HOST));

      expect(response.headers.get('location')).toBe(
        '/login?loginError=rate-limited&callbackUrl=%2Fpharmacy'
      );
    });

    it('retires the intent and asks for the interactive form when a chooser is needed', async () => {
      sharedCheck(
        {
          outcome: 'select',
          organizations: [
            { id: 'org_1', ssoEnforced: false },
            { id: 'org_2', ssoEnforced: false },
          ],
        },
        { headers: { 'set-cookie': INTENT } }
      );

      const response = await POST(nativePost(CREDENTIALS, HOST));

      expect(response.headers.get('location')).toBe(
        '/login?loginError=continue&callbackUrl=%2Fpharmacy'
      );
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(mocks.discardLoginIntent).toHaveBeenCalledWith('intent-token');
      expect(mocks.authPost).not.toHaveBeenCalled();
    });

    it('retires the intent when the workspace needs a second factor', async () => {
      sharedCheck(
        { outcome: 'single', organizations: [{ id: 'org_1', ssoEnforced: false }] },
        { headers: { 'set-cookie': INTENT } }
      );
      mocks.authPost.mockResolvedValue(
        callbackResponse(`https://${HOST}/login?error=CredentialsSignin&code=2fa_required`)
      );

      const response = await POST(nativePost(CREDENTIALS, HOST));

      expect(response.headers.get('location')).toBe(
        '/login?loginError=continue&callbackUrl=%2Fpharmacy'
      );
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(mocks.discardLoginIntent).toHaveBeenCalledWith('intent-token');
    });
  });
});
