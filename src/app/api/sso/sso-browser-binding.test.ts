// @vitest-environment node
/**
 * F10 / DEV-833 — SSO login CSRF. An OIDC callback or SAML POST started in one
 * browser must not sign a different browser in: the transaction is bound to an
 * unpredictable cookie set by the start route, and verified before any account
 * is provisioned or ticket issued.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('@/lib/tenancy/host', () => ({ requireOrganizationForRequest: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: vi.fn(async (_organizationId: string, run: (db: unknown) => Promise<unknown>) =>
    run({
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
    provisionIdentityUser: mocks.provisionIdentityUser,
    issueSsoTicket: mocks.issueSsoTicket,
  };
});

vi.mock('openid-client', () => ({
  discovery: vi.fn(async () => ({})),
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
      const inResponseTo = SAMLResponse;
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

  it('binds both the RelayState and the AuthnRequest ID to the browser', async () => {
    const { binding } = await startInBrowser();
    expect(states.map((row) => row.kind).sort()).toEqual(['SAML_RELAY', 'SAML_REQUEST']);
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
