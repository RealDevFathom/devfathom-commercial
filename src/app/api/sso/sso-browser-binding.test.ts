// @vitest-environment node
/**
 * F10 / DEV-833 — SSO login CSRF. An OIDC callback or SAML POST started in one
 * browser must not sign a different browser in: the transaction is bound to an
 * unpredictable cookie set by the start route, and verified before any account
 * is provisioned or ticket issued.
 */
import { SSO_START_LIMITS } from '@/lib/sso-limits';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { oversizedRequest } from '../../../../tests/fixtures/bounded-request';

type StateRow = {
  id: string;
  organizationId: string;
  identityConnectionId: string;
  key: string;
  kind: string;
  payload: Record<string, unknown>;
  expiresAt: Date;
  usedAt: Date | null;
};

const mocks = vi.hoisted(() => ({
  provisionIdentityUser: vi.fn(),
  issueSsoTicket: vi.fn(),
  requireIdentityConnection: vi.fn(),
  connectionUpdate: vi.fn(),
}));

let states: StateRow[] = [];
let samlRequestCounter = 0;

vi.mock('server-only', () => ({}));
vi.mock('@/lib/secret-crypto', () => ({ decryptSecret: vi.fn(() => undefined) }));
// The real proxy-aware origin helpers: the binding cookie's attributes follow
// the scheme the browser used (DEV-849).
vi.mock('@/lib/tenancy/host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tenancy/host')>()),
  requireOrganizationForRequest: vi.fn(async () => ({ id: 'org_1' })),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: vi.fn(async (_organizationId: string, run: (db: unknown) => Promise<unknown>) =>
    run({
      $executeRaw: vi.fn(),
      $queryRaw: vi.fn(async (_sql, sourceKey: string, connectionId: string, now: Date) => {
        const active = states.filter(
          (row) => row.identityConnectionId === connectionId && !row.usedAt && row.expiresAt > now
        );
        return [
          {
            total: active.length,
            fromSource: active.filter((row) => row.payload.sourceKey === sourceKey).length,
          },
        ];
      }),
      organizationSsoState: {
        create: vi.fn(async ({ data }: { data: Omit<StateRow, 'id' | 'usedAt'> }) => {
          const row = { id: `s${states.length + 1}`, usedAt: null, ...data };
          states.push(row);
          return row;
        }),
        findFirst: vi.fn(
          async ({
            where,
          }: {
            where: {
              key: string;
              identityConnectionId: string;
              kind: string;
              expiresAt: { gt: Date };
            };
          }) =>
            states.find(
              (row) =>
                row.key === where.key &&
                row.identityConnectionId === where.identityConnectionId &&
                row.kind === where.kind &&
                row.usedAt === null &&
                row.expiresAt > where.expiresAt.gt
            ) ?? null
        ),
        updateMany: vi.fn(
          async ({ where }: { where: { id?: string; key?: string; usedAt: null } }) => {
            const matches = states.filter(
              (row) =>
                row.usedAt === null &&
                (where.id === undefined || row.id === where.id) &&
                (where.key === undefined || row.key === where.key)
            );
            for (const row of matches) row.usedAt = new Date();
            return { count: matches.length };
          }
        ),
      },
      organizationIdentityConnection: { update: mocks.connectionUpdate },
    })
  ),
}));

vi.mock('@/lib/sso', async () => {
  const actual = await vi.importActual<typeof import('@/lib/sso')>('@/lib/sso');
  return {
    ...actual,
    requireIdentityConnection: mocks.requireIdentityConnection,
    identityConnectionForOrganization: mocks.requireIdentityConnection,
    provisionIdentityUser: mocks.provisionIdentityUser,
    issueSsoTicket: mocks.issueSsoTicket,
  };
});

vi.mock('@/lib/oidc-discovery', () => ({ discoverOidc: vi.fn(async () => ({})) }));
vi.mock('openid-client', () => ({
  randomPKCECodeVerifier: () => 'pkce-verifier',
  calculatePKCECodeChallenge: async () => 'pkce-challenge',
  randomNonce: () => 'oidc-nonce',
  buildAuthorizationUrl: (_config: unknown, params: Record<string, string>) =>
    new URL(`https://idp.example/authorize?${new URLSearchParams(params)}`),
  authorizationCodeGrant: vi.fn(async () => ({
    claims: () => ({ email: 'attacker@acme.example', email_verified: true }),
  })),
}));

// A minimal SAML double that exercises the real InResponseTo cache contract:
// the start saves the AuthnRequest ID, the callback must find it again.
vi.mock('@node-saml/node-saml', () => ({
  ValidateInResponseTo: { always: 'always' },
  SAML: class {
    constructor(
      private readonly options: {
        cacheProvider: {
          saveAsync(key: string, value: string): Promise<unknown>;
          getAsync(key: string): Promise<string | null>;
          removeAsync(key: string | null): Promise<string | null>;
        };
      }
    ) {}
    async getAuthorizeUrlAsync(relayState: string) {
      const requestId = `_req${++samlRequestCounter}`;
      await this.options.cacheProvider.saveAsync(requestId, new Date().toISOString());
      return `https://idp.example/saml?RelayState=${relayState}&ID=${requestId}`;
    }
    async validatePostResponseAsync({ SAMLResponse }: { SAMLResponse: string }) {
      const inResponseTo = SAMLResponse.startsWith('_req')
        ? SAMLResponse
        : (Buffer.from(SAMLResponse, 'base64')
            .toString()
            .match(/InResponseTo="([^"]+)"/)?.[1] ?? '');
      if (!(await this.options.cacheProvider.getAsync(inResponseTo))) {
        throw new Error('InResponseTo is not valid');
      }
      await this.options.cacheProvider.removeAsync(inResponseTo);
      return { profile: { nameID: 'attacker@acme.example', email: 'attacker@acme.example' } };
    }
  },
}));

import { SSO_BROWSER_BINDING_COOKIE, SSO_TICKET_COOKIE } from '@/lib/sso';
import { GET as oidcStart } from './oidc/[connectionId]/start/route';
import { GET as oidcCallback } from './oidc/[connectionId]/callback/route';
import { GET as samlStart } from './saml/[connectionId]/start/route';
import { POST as samlCallback } from './saml/[connectionId]/callback/route';

const route = (connectionId: string) => ({ params: Promise.resolve({ connectionId }) });

function bindingCookieFrom(response: Response): string {
  const header = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${SSO_BROWSER_BINDING_COOKIE}=`));
  const value = header?.split(';')[0]!.split('=')[1];
  if (!value) throw new Error('start did not set the browser binding cookie');
  return value;
}

function ticketCookieSet(response: Response) {
  return response.headers
    .getSetCookie()
    .some(
      (cookie) =>
        cookie.startsWith(`${SSO_TICKET_COOKIE}=`) && !cookie.startsWith(`${SSO_TICKET_COOKIE}=;`)
    );
}

function cookieHeader(binding?: string): HeadersInit {
  return binding ? { cookie: `theme=dark; ${SSO_BROWSER_BINDING_COOKIE}=${binding}` } : {};
}

beforeEach(() => {
  vi.clearAllMocks();
  states = [];
  samlRequestCounter = 0;
  mocks.provisionIdentityUser.mockResolvedValue({ id: 'user_attacker' });
  mocks.issueSsoTicket.mockResolvedValue({
    token: 'sso-ticket',
    expiresAt: new Date(Date.now() + 60_000),
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('OIDC browser binding (F10)', () => {
  beforeEach(() => {
    mocks.requireIdentityConnection.mockResolvedValue({
      id: 'conn_oidc',
      organizationId: 'org_1',
      issuer: 'https://idp.example',
      clientId: 'client',
      encryptedClientSecret: null,
    });
  });

  async function startInBrowser() {
    const response = await oidcStart(
      new Request('https://acme.example/api/sso/oidc/conn_oidc/start'),
      route('conn_oidc')
    );
    expect(response.status).toBe(302);
    const state = new URL(response.headers.get('location')!).searchParams.get('state')!;
    return { binding: bindingCookieFrom(response), state };
  }

  function callback(state: string, binding?: string) {
    return oidcCallback(
      new Request(`https://acme.example/api/sso/oidc/conn_oidc/callback?code=c&state=${state}`, {
        headers: cookieHeader(binding),
      }),
      route('conn_oidc')
    );
  }

  it('stores only a hash of the browser binding with the state', async () => {
    const { binding } = await startInBrowser();
    expect(states).toHaveLength(1);
    expect(typeof states[0]!.payload.browserBindingHash).toBe('string');
    expect(states[0]!.payload.sourceKey).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(states[0])).not.toContain(binding);
  });

  it('rejects the callback in a browser that did not start the flow', async () => {
    const browserA = await startInBrowser();

    const noCookie = await callback(browserA.state);
    expect(noCookie.headers.get('location')).toBe('https://acme.example/login?ssoError=oidc');
    expect(ticketCookieSet(noCookie)).toBe(false);

    const browserB = await startInBrowser();
    const otherBrowser = await callback(browserA.state, browserB.binding);
    expect(otherBrowser.headers.get('location')).toBe('https://acme.example/login?ssoError=oidc');
    expect(ticketCookieSet(otherBrowser)).toBe(false);

    expect(mocks.provisionIdentityUser).not.toHaveBeenCalled();
    expect(mocks.issueSsoTicket).not.toHaveBeenCalled();
    // Browser A's transaction is still unconsumed and usable by browser A.
    expect(states.find((row) => row.key === browserA.state)!.usedAt).toBeNull();
  });

  it('signs in the browser that started the flow', async () => {
    const browserA = await startInBrowser();
    const response = await callback(browserA.state, browserA.binding);

    expect(response.headers.get('location')).toBe('https://acme.example/sso/complete');
    expect(ticketCookieSet(response)).toBe(true);
    expect(mocks.issueSsoTicket).toHaveBeenCalledWith('org_1', 'user_attacker');
    expect(states[0]!.usedAt).toBeInstanceOf(Date);
  });
});

describe('SAML browser binding (F10)', () => {
  beforeEach(() => {
    mocks.requireIdentityConnection.mockResolvedValue({
      id: 'conn_saml',
      organizationId: 'org_1',
      ssoUrl: 'https://idp.example/saml',
      certificate: 'CERT',
      entityId: null,
      issuer: null,
    });
  });

  async function startInBrowser() {
    const response = await samlStart(
      new Request('https://acme.example/api/sso/saml/conn_saml/start'),
      route('conn_saml')
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    return {
      binding: bindingCookieFrom(response),
      relayState: location.searchParams.get('RelayState')!,
      requestId: location.searchParams.get('ID')!,
    };
  }

  function callback(flow: { relayState: string; requestId: string }, binding?: string) {
    const form = new FormData();
    // The double treats SAMLResponse as the response's InResponseTo value.
    form.set('SAMLResponse', flow.requestId);
    form.set('RelayState', flow.relayState);
    return samlCallback(
      new Request('https://acme.example/api/sso/saml/conn_saml/callback', {
        method: 'POST',
        body: form,
        headers: cookieHeader(binding),
      }),
      route('conn_saml')
    );
  }

  it('stops reading an oversized callback before consuming SAML state', async () => {
    const flow = await startInBrowser();
    const limit = 512 * 1024;
    const input = oversizedRequest(limit, {
      url: 'https://acme.example/api/sso/saml/conn_saml/callback',
      headers: {
        ...cookieHeader(flow.binding),
        'content-type': 'application/x-www-form-urlencoded',
      },
    });

    expect((await samlCallback(input.request, route('conn_saml'))).status).toBe(413);
    expect(input.cancelled()).toBe(true);
    expect(input.bytesRead()).toBe(limit + 16_384);
    expect(states.every((state) => state.usedAt === null)).toBe(true);
    expect(mocks.provisionIdentityUser).not.toHaveBeenCalled();
  });

  it('completes a URL-encoded sign-in with a large synthetic assertion', async () => {
    const flow = await startInBrowser();
    const samlResponse = Buffer.from(
      `<Response InResponseTo="${flow.requestId}"><Attribute>${'x'.repeat(64 * 1024)}</Attribute></Response>`
    ).toString('base64');
    const body = new URLSearchParams({ SAMLResponse: samlResponse, RelayState: flow.relayState });
    const response = await samlCallback(
      new Request('https://acme.example/api/sso/saml/conn_saml/callback', {
        method: 'POST',
        headers: cookieHeader(flow.binding),
        body,
      }),
      route('conn_saml')
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://acme.example/sso/complete');
    expect(mocks.provisionIdentityUser).toHaveBeenCalledOnce();
  });

  it('binds both the RelayState and the AuthnRequest ID to the browser', async () => {
    const { binding } = await startInBrowser();
    expect(states.map((row) => row.kind).sort()).toEqual(['SAML_RELAY', 'SAML_REQUEST']);
    expect(states[0]!.payload.sourceKey).toMatch(/^[0-9a-f]{64}$/);
    expect(states[1]!.payload.sourceKey).toBe(states[0]!.payload.sourceKey);
    for (const row of states) {
      expect(typeof row.payload.browserBindingHash).toBe('string');
      expect(JSON.stringify(row)).not.toContain(binding);
    }
  });

  it('rejects a SAML POST transferred to a browser that did not start the flow', async () => {
    const browserA = await startInBrowser();

    const noCookie = await callback(browserA);
    expect(noCookie.status).toBe(303);
    expect(noCookie.headers.get('location')).toBe('https://acme.example/login?ssoError=saml');
    expect(ticketCookieSet(noCookie)).toBe(false);

    const browserB = await startInBrowser();
    const otherBrowser = await callback(browserA, browserB.binding);
    expect(otherBrowser.headers.get('location')).toBe('https://acme.example/login?ssoError=saml');
    expect(ticketCookieSet(otherBrowser)).toBe(false);

    // Pairing browser B's own RelayState with browser A's response still fails
    // InResponseTo, because A's AuthnRequest ID is bound to browser A.
    const mixed = await callback(
      { relayState: browserB.relayState, requestId: browserA.requestId },
      browserB.binding
    );
    expect(mixed.headers.get('location')).toBe('https://acme.example/login?ssoError=saml');
    expect(ticketCookieSet(mixed)).toBe(false);

    expect(mocks.provisionIdentityUser).not.toHaveBeenCalled();
    expect(mocks.issueSsoTicket).not.toHaveBeenCalled();
    const aRequest = states.find((row) => row.key === browserA.requestId)!;
    expect(aRequest.usedAt).toBeNull();
  });

  it('signs in the browser that started the flow', async () => {
    const browserA = await startInBrowser();
    const response = await callback(browserA, browserA.binding);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://acme.example/sso/complete');
    expect(ticketCookieSet(response)).toBe(true);
    expect(mocks.issueSsoTicket).toHaveBeenCalledWith('org_1', 'user_attacker');
    expect(states.every((row) => row.usedAt instanceof Date)).toBe(true);
  });
});

describe('browser binding cookie attributes (DEV-849)', () => {
  function bindingSetCookie(response: Response): string {
    const header = response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${SSO_BROWSER_BINDING_COOKIE}=`));
    if (!header) throw new Error('start did not set the browser binding cookie');
    return header.toLowerCase();
  }

  function startSaml(url: string, headers?: HeadersInit) {
    return samlStart(new Request(url, { headers }), route('conn_saml'));
  }

  beforeEach(() => {
    mocks.requireIdentityConnection.mockResolvedValue({
      id: 'conn_saml',
      organizationId: 'org_1',
      ssoUrl: 'https://idp.example/saml',
      certificate: 'CERT',
      entityId: null,
      issuer: null,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is SameSite=None; Secure on a non-production deployment served over HTTPS', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const cookie = bindingSetCookie(
      await startSaml('https://staging.acme.example/api/sso/saml/conn_saml/start')
    );
    expect(cookie).toContain('samesite=none');
    expect(cookie).toContain('secure');
    expect(cookie).toContain('httponly');
    expect(cookie).toContain('path=/api/sso');
  });

  it('honors the proxy-forwarded HTTPS scheme outside production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const cookie = bindingSetCookie(
      await startSaml('http://internal:3000/api/sso/saml/conn_saml/start', {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'staging.acme.example',
      })
    );
    expect(cookie).toContain('samesite=none');
    expect(cookie).toContain('secure');
  });

  it('falls back to SameSite=Lax only for plain-HTTP local development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const cookie = bindingSetCookie(
      await startSaml('http://localhost:3000/api/sso/saml/conn_saml/start')
    );
    expect(cookie).toContain('samesite=lax');
    expect(cookie).not.toMatch(/;\s*secure/);
  });

  it('stays SameSite=None; Secure in production regardless of the request scheme', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('RATE_LIMIT_HMAC_SECRET', 'synthetic-cookie-test');
    for (const url of [
      'https://acme.example/api/sso/saml/conn_saml/start',
      'http://internal:3000/api/sso/saml/conn_saml/start',
    ]) {
      const cookie = bindingSetCookie(await startSaml(url));
      expect(cookie).toContain('samesite=none');
      expect(cookie).toMatch(/;\s*secure/);
      expect(cookie).toContain('httponly');
    }
  });

  it('clears the cookie with the same attributes after a successful SAML POST', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const start = await startSaml('https://staging.acme.example/api/sso/saml/conn_saml/start');
    const binding = bindingCookieFrom(start);
    const location = new URL(start.headers.get('location')!);
    const form = new FormData();
    form.set('SAMLResponse', location.searchParams.get('ID')!);
    form.set('RelayState', location.searchParams.get('RelayState')!);
    const response = await samlCallback(
      new Request('https://staging.acme.example/api/sso/saml/conn_saml/callback', {
        method: 'POST',
        body: form,
        headers: cookieHeader(binding),
      }),
      route('conn_saml')
    );
    expect(ticketCookieSet(response)).toBe(true);
    const cleared = bindingSetCookie(response);
    expect(cleared).toContain('samesite=none');
    expect(cleared).toMatch(/;\s*secure/);
    expect(cleared).toMatch(/max-age=0|expires=thu, 01 jan 1970/);
  });
});

describe('start admission', () => {
  it.each([
    ['OIDC', oidcStart],
    ['SAML', samlStart],
  ] as const)(
    'refuses an exhausted %s budget before tenant lookup, discovery or state writes',
    async (_protocol, start) => {
      const { clearRateLimit, rateLimit, clientIp } = await import('@/lib/rate-limit');
      const { discoverOidc } = await import('@/lib/oidc-discovery');
      const request = new Request('https://acme.example/start', {
        headers: { host: 'acme.example' },
      });
      const { requireOrganizationForRequest } = await import('@/lib/tenancy/host');
      for (const [key, limit] of [
        ['overall', SSO_START_LIMITS.platform],
        [`ip:${clientIp(request)}`, SSO_START_LIMITS.source],
        ['host:acme.example', SSO_START_LIMITS.host],
        ['connection:fixture', SSO_START_LIMITS.connection],
      ] as const) {
        const name = 'sso:start:' + key;
        try {
          for (let i = 0; i < limit; i++) await rateLimit(name, limit, 60_000);
          const response = await start(request, route('fixture'));
          expect(response.status).toBe(429);
          expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
          expect(requireOrganizationForRequest).not.toHaveBeenCalled();
          expect(mocks.requireIdentityConnection).not.toHaveBeenCalled();
          expect(discoverOidc).not.toHaveBeenCalled();
          expect(states).toHaveLength(0);
        } finally {
          await clearRateLimit(name);
        }
      }
    }
  );
  it('leaves all shared quota available to a different source on a different business', async () => {
    const limiter = await import('@/lib/rate-limit');
    const { requireOrganizationForRequest } = await import('@/lib/tenancy/host');
    vi.stubEnv('CLIENT_IP_HEADER', 'x-fixture-address');
    const balances = new Map([
      ['sso:start:ip:192.0.2.1', 0],
      ['sso:start:overall', 1],
    ]);
    const quota = vi.spyOn(limiter, 'rateLimit').mockImplementation(async (key, limit) => {
      const available = balances.get(key) ?? limit;
      if (!available) return { ok: false, remaining: 0, retryAfter: 60 };
      balances.set(key, available - 1);
      return { ok: true, remaining: available - 1, retryAfter: 0 };
    });
    const req = (host: string, address: string) =>
      new Request('https://' + host + '/start', {
        headers: { host, 'x-fixture-address': address },
      });
    try {
      expect((await oidcStart(req('first.example', '192.0.2.1'), route('first'))).status).toBe(429);
      expect(quota.mock.calls.map(([key]) => key)).toEqual(['sso:start:ip:192.0.2.1']);
      expect(balances.get('sso:start:overall')).toBe(1);
      expect(requireOrganizationForRequest).not.toHaveBeenCalled();
      expect(states).toHaveLength(0);

      vi.mocked(requireOrganizationForRequest, { partial: true }).mockResolvedValueOnce({
        id: 'org_2',
      });
      mocks.requireIdentityConnection.mockResolvedValueOnce({
        id: 'other',
        organizationId: 'org_2',
        issuer: 'https://idp.example',
        clientId: 'fixture',
      });
      const admitted = await oidcStart(req('other.example', '192.0.2.2'), route('other'));
      expect(admitted.status).toBe(302);
      expect(quota.mock.calls.slice(1).map(([key, limit]) => [key, limit])).toEqual([
        ['sso:start:ip:192.0.2.2', 300],
        ['sso:start:overall', 6000],
        ['sso:start:host:other.example', 900],
        ['sso:start:connection:other', 600],
        ['sso:start:organization:org_2', 900],
      ]);
      expect(states).toHaveLength(1);
      expect(states[0]).toMatchObject({ organizationId: 'org_2', identityConnectionId: 'other' });
    } finally {
      quota.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('charges the same business on both verified aliases before reading entitlements or the connection', async () => {
    const { rateLimit, clearRateLimit } = await import('@/lib/rate-limit');
    const key = 'sso:start:organization:org_1';
    try {
      for (let i = 0; i < SSO_START_LIMITS.business; i++)
        await rateLimit(key, SSO_START_LIMITS.business, 60_000);
      for (const host of ['tenant.example', 'alias.example']) {
        const response = await oidcStart(
          new Request('https://' + host + '/start', { headers: { host } }),
          route('fixture')
        );
        expect(response.status).toBe(429);
      }
      expect(mocks.requireIdentityConnection).not.toHaveBeenCalled();
      expect(states).toHaveLength(0);
    } finally {
      await clearRateLimit(key);
    }
  });
});
