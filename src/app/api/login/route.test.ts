/**
 * The shared-host credential endpoint.
 *
 * The assertions that matter here are on the RESPONSE PAYLOAD, not the UI: no
 * organization information may be emitted before the password is proven, and
 * every failure must be byte-identical.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveSharedLogin: vi.fn(),
  createLoginIntent: vi.fn(),
  discardLoginIntent: vi.fn(),
  rateLimit: vi.fn(() => ({ ok: true, retryAfter: 0 })),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', () => ({ ipFromHeaders: vi.fn(() => '203.0.113.9') }));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: mocks.rateLimit }));
vi.mock('@/lib/auth/shared-login', () => ({ resolveSharedLogin: mocks.resolveSharedLogin }));
vi.mock('@/lib/auth/login-intent', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/login-intent')>('@/lib/auth/login-intent');
  return {
    ...actual,
    createLoginIntent: mocks.createLoginIntent,
    discardLoginIntent: mocks.discardLoginIntent,
  };
});

import { DELETE, POST } from './route';

const ORIGINAL_BASE_DOMAIN = process.env.PLATFORM_BASE_DOMAIN;

function request(body: unknown, host = 'www.devfathom.com', headers: Record<string, string> = {}) {
  return new Request(`https://${host}/api/login`, {
    method: 'POST',
    headers: {
      host,
      origin: `https://${host}`,
      'content-type': 'application/json',
      'x-forwarded-proto': 'https',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const CREDENTIALS = { email: 'alex@company.com', password: 'correct-horse' };

const ORGANIZATIONS = [
  {
    organizationId: 'org_1',
    userId: 'user_1',
    slug: 'acme',
    displayName: 'Acme',
    ssoEnforced: false,
  },
  {
    organizationId: 'org_2',
    userId: 'user_2',
    slug: 'zephyr',
    displayName: 'Zephyr',
    ssoEnforced: false,
  },
];

describe('POST /api/login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PLATFORM_BASE_DOMAIN = 'devfathom.com';
    mocks.rateLimit.mockReturnValue({ ok: true, retryAfter: 0 });
    mocks.createLoginIntent.mockResolvedValue({
      token: 't'.repeat(43),
      expiresAt: new Date(Date.now() + 300_000),
    });
    mocks.resolveSharedLogin.mockResolvedValue({ outcome: 'failed' });
  });

  afterEach(() => {
    process.env.PLATFORM_BASE_DOMAIN = ORIGINAL_BASE_DOMAIN;
  });

  it('does not exist on a tenant host', async () => {
    const response = await POST(request(CREDENTIALS, 'acme.devfathom.com'));

    expect(response.status).toBe(404);
    expect(mocks.resolveSharedLogin).not.toHaveBeenCalled();
  });

  it('does not exist on the admin host', async () => {
    const response = await POST(request(CREDENTIALS, 'admin.devfathom.com'));

    expect(response.status).toBe(404);
  });

  it.each([
    ['a cross-site origin', { origin: 'https://evil.com' }],
    ['a cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
    ['a form content type', { 'content-type': 'application/x-www-form-urlencoded' }],
  ])('refuses %s', async (_label, headers) => {
    const response = await POST(request(CREDENTIALS, 'www.devfathom.com', headers));

    expect(response.status).toBe(403);
    expect(mocks.resolveSharedLogin).not.toHaveBeenCalled();
  });

  // The whole point of D7: nothing about organizations before the password.
  describe('emits no organization information before credentials verify', () => {
    it.each([
      ['a wrong password', CREDENTIALS],
      ['an unknown address', { email: 'nobody@example.com', password: 'anything' }],
      ['a malformed body', { email: 'not-an-email', password: '' }],
    ])('for %s', async (_label, body) => {
      const response = await POST(request(body));
      const text = await response.text();

      expect(response.status).toBe(401);
      expect(JSON.parse(text)).toEqual({
        outcome: 'failed',
        message: 'Invalid email or password. Please try again.',
      });
      // No slug, no display name, no id, no count.
      expect(text).not.toMatch(/organizations|slug|displayName|org_/);
      expect(response.headers.get('set-cookie')).toBeNull();
    });

    it('returns the same body for a rate-limited attempt', async () => {
      mocks.rateLimit.mockReturnValue({ ok: false, retryAfter: 60 });

      const response = await POST(request(CREDENTIALS));

      expect(await response.json()).toEqual({
        outcome: 'failed',
        message: 'Invalid email or password. Please try again.',
      });
      expect(mocks.resolveSharedLogin).not.toHaveBeenCalled();
    });

    // WHA-1208: the body may not distinguish the two, but the status and
    // Retry-After must, or the form can only say "wrong password".
    it('separates a tripped limiter from a wrong password by status, not by body', async () => {
      const wrongPassword = await POST(request(CREDENTIALS));
      const wrongPasswordBody = await wrongPassword.text();

      mocks.rateLimit.mockReturnValue({ ok: false, retryAfter: 137 });
      const limited = await POST(request(CREDENTIALS));

      expect(wrongPassword.status).toBe(401);
      expect(limited.status).toBe(429);
      // Byte-identical body: still no enumeration oracle.
      expect(await limited.text()).toBe(wrongPasswordBody);
      // ...but the client is told how long to wait.
      expect(limited.headers.get('retry-after')).toBe('137');
      expect(wrongPassword.headers.get('retry-after')).toBeNull();
    });

    it('reports the longest wait when more than one limiter is blocked', async () => {
      mocks.rateLimit
        .mockReturnValueOnce({ ok: false, retryAfter: 12 })
        .mockReturnValueOnce({ ok: true, retryAfter: 0 })
        .mockReturnValueOnce({ ok: false, retryAfter: 240 });

      const response = await POST(request(CREDENTIALS));

      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('240');
    });

    it('never advertises a zero-second wait', async () => {
      mocks.rateLimit.mockReturnValue({ ok: false, retryAfter: 0 });

      const response = await POST(request(CREDENTIALS));

      expect(response.headers.get('retry-after')).toBe('1');
    });

    it('rate limits before discovery runs', async () => {
      mocks.rateLimit.mockReturnValue({ ok: false, retryAfter: 60 });

      await POST(request(CREDENTIALS));

      expect(mocks.resolveSharedLogin).not.toHaveBeenCalled();
    });

    // D18: the credential check, intent creation, and selection are limited
    // independently.
    it('applies separate limiter keys for credentials and intent minting', async () => {
      await POST(request(CREDENTIALS));

      const keys = mocks.rateLimit.mock.calls.map((call) => (call as unknown as string[])[0]);
      expect(keys).toEqual(
        expect.arrayContaining([
          'login:ip:203.0.113.9',
          'login:acct:alex@company.com',
          'login:intent:203.0.113.9',
        ])
      );
    });
  });

  it('continues straight through for exactly one eligible workspace', async () => {
    mocks.resolveSharedLogin.mockResolvedValue({
      outcome: 'eligible',
      email: 'alex@company.com',
      organizations: [ORGANIZATIONS[0]!],
    });

    const response = await POST(request(CREDENTIALS));
    const body = await response.json();

    expect(body.outcome).toBe('single');
    expect(body.organizations).toEqual([
      { id: 'org_1', slug: 'acme', displayName: 'Acme', ssoEnforced: false, ssoUrl: null },
    ]);
    expect(response.headers.get('set-cookie')).toContain('df_login_intent=');
    expect(response.headers.get('set-cookie')).not.toContain('Domain=');
  });

  it('renders a selection for more than one eligible workspace', async () => {
    mocks.resolveSharedLogin.mockResolvedValue({
      outcome: 'eligible',
      email: 'alex@company.com',
      organizations: ORGANIZATIONS,
    });

    const body = await (await POST(request(CREDENTIALS))).json();

    expect(body.outcome).toBe('select');
    expect(body.organizations).toHaveLength(2);
  });

  it('records only the password-eligible workspaces as intent candidates', async () => {
    mocks.resolveSharedLogin.mockResolvedValue({
      outcome: 'eligible',
      email: 'alex@company.com',
      organizations: [ORGANIZATIONS[0]!, { ...ORGANIZATIONS[1]!, ssoEnforced: true }],
    });

    const body = await (await POST(request(CREDENTIALS))).json();

    // Both are shown...
    expect(body.organizations).toHaveLength(2);
    expect(body.organizations[1].ssoEnforced).toBe(true);
    expect(body.organizations[1].ssoUrl).toBe('https://zephyr.devfathom.com/login');
    // ...but only the password-eligible one is selectable server-side, so there
    // is no password path into the enforced workspace even if the client is
    // bypassed entirely.
    const [intent] = mocks.createLoginIntent.mock.calls[0] as [{ candidates: unknown[] }];
    expect(intent.candidates).toEqual([{ organizationId: 'org_1', userId: 'user_1' }]);
  });

  it('shows the SSO-only screen when every workspace enforces SSO, and mints no intent', async () => {
    mocks.resolveSharedLogin.mockResolvedValue({
      outcome: 'eligible',
      email: 'alex@company.com',
      organizations: ORGANIZATIONS.map((organization) => ({
        ...organization,
        ssoEnforced: true,
      })),
    });

    const response = await POST(request(CREDENTIALS));
    const body = await response.json();

    expect(body.outcome).toBe('sso-only');
    expect(mocks.createLoginIntent).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toContain('df_login_intent=;');
  });

  // D15
  it.each([
    ['https://evil.com', '/dashboard'],
    ['/%2f%2fevil.com', '/dashboard'],
    ['/projects/1', '/projects/1'],
  ])('validates the callback URL %j server-side', async (submitted, expected) => {
    mocks.resolveSharedLogin.mockResolvedValue({
      outcome: 'eligible',
      email: 'alex@company.com',
      organizations: [ORGANIZATIONS[0]!],
    });

    const body = await (await POST(request({ ...CREDENTIALS, callbackUrl: submitted }))).json();

    expect(body.callbackUrl).toBe(expected);
  });
});

describe('DELETE /api/login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PLATFORM_BASE_DOMAIN = 'devfathom.com';
  });

  afterEach(() => {
    process.env.PLATFORM_BASE_DOMAIN = ORIGINAL_BASE_DOMAIN;
  });

  it('invalidates the pending intent and clears its cookie', async () => {
    const response = await DELETE(
      new Request('https://www.devfathom.com/api/login', {
        method: 'DELETE',
        headers: { host: 'www.devfathom.com', cookie: `df_login_intent=${'t'.repeat(43)}` },
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.discardLoginIntent).toHaveBeenCalledWith('t'.repeat(43));
    expect(response.headers.get('set-cookie')).toContain('df_login_intent=;');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(response.headers.get('set-cookie')).not.toContain('Domain=');
  });

  it.each(['acme.devfathom.com', 'admin.devfathom.com', 'unrelated.example.com'])(
    'is a successful no-op on the non-shared host %s',
    async (host) => {
      const response = await DELETE(
        new Request(`https://${host}/api/login`, {
          method: 'DELETE',
          headers: { host, cookie: `df_login_intent=${'t'.repeat(43)}` },
        })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(mocks.discardLoginIntent).not.toHaveBeenCalled();
      expect(response.headers.get('set-cookie')).toContain('df_login_intent=;');
      expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
      expect(response.headers.get('set-cookie')).not.toContain('Domain=');
    }
  );
});
