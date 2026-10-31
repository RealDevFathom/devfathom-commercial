/**
 * The `/api/trpc` routing decisions, at the layer where they are made.
 *
 * What each anonymous request must produce:
 *   - not allowlisted            → 401, nothing touched
 *   - allowlisted, token resolves→ the REAL router, inside that tenant's scope
 *   - allowlisted, no tenant     → the FALLBACK router, no tenant scope opened
 *
 * "No tenant scope opened" is the assertion that matters for the reset flow: it
 * is the same thing as "no email was sent", because the send happens inside the
 * procedure, which only runs inside `withTenantDb`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  organizationForAnonymousToken: vi.fn(),
  resolveExplicitOrganizationByHost: vi.fn(),
  resolveOrganizationById: vi.fn(),
  requireOrganizationForRequest: vi.fn(),
  withTenantDb: vi.fn(),
  createTRPCContext: vi.fn(),
  fetchRequestHandler: vi.fn(),
  admitAnonymousRequest: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@trpc/server/adapters/fetch', () => ({ fetchRequestHandler: mocks.fetchRequestHandler }));
vi.mock('@/server/routers/_app', () => ({ appRouter: { __which: 'real' } }));
vi.mock('@/server/routers/anonymous-fallback', () => ({
  anonymousFallbackRouter: { __which: 'fallback' },
}));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: mocks.withTenantDb }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/lib/auth/anonymous-tenant', () => ({
  organizationForAnonymousToken: mocks.organizationForAnonymousToken,
}));
vi.mock('@/lib/auth/anonymous-rate-limit', () => ({
  admitAnonymousRequest: mocks.admitAnonymousRequest,
}));
vi.mock('@/lib/tenancy/host', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tenancy/host')>('@/lib/tenancy/host');
  return {
    ...actual,
    requestHost: actual.requestHost,
    isTenantLifecycleAccessible: actual.isTenantLifecycleAccessible,
    TenantHostError: actual.TenantHostError,
    resolveExplicitOrganizationByHost: mocks.resolveExplicitOrganizationByHost,
    resolveOrganizationById: mocks.resolveOrganizationById,
    requireOrganizationForRequest: mocks.requireOrganizationForRequest,
  };
});

import { GET, POST } from './[trpc]/route';

const ORGANIZATION = { id: 'org_acme', slug: 'acme', status: 'ACTIVE' };

/** Which router the request was ultimately served by, or null if none was. */
function servedBy(): string | null {
  const call = mocks.fetchRequestHandler.mock.calls.at(0);
  return call ? ((call[0] as { router: { __which: string } }).router.__which ?? null) : null;
}

const url = (path: string, query = '?batch=1') =>
  `http://acme.example.com/api/trpc/${path}${query}`;
const tokenQuery = (token: string) =>
  `?batch=1&input=${encodeURIComponent(JSON.stringify({ '0': { json: { token } } }))}`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTenantActor.mockResolvedValue(null);
  mocks.admitAnonymousRequest.mockReturnValue({ ok: true });
  mocks.fetchRequestHandler.mockResolvedValue(new Response('served', { status: 200 }));
  // Pass the scoped handle straight through so the assertions see the real call.
  mocks.withTenantDb.mockImplementation(
    async (_id: string, run: (db: unknown) => Promise<unknown>) => run({})
  );
  mocks.createTRPCContext.mockResolvedValue({});
});

describe('procedures that are not allowlisted', () => {
  it.each([
    ['a protected procedure', 'clients.getAll'],
    ['a batch mixing allowlisted and protected', 'invitations.get,clients.getAll'],
    ['a batch mixing the two routing strategies', 'invitations.get,passwordReset.request'],
    ['no procedure at all', ''],
  ])('answers 401 for %s and runs no router', async (_label, path) => {
    const response = await GET(new Request(url(path)));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mocks.fetchRequestHandler).not.toHaveBeenCalled();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    // Nothing was looked up, so an unauthorised caller cannot use this path to
    // probe whether a token or a host exists.
    expect(mocks.organizationForAnonymousToken).not.toHaveBeenCalled();
    expect(mocks.resolveExplicitOrganizationByHost).not.toHaveBeenCalled();
  });
});

describe('token-routed procedures', () => {
  it('serves the real router inside the tenant the token names', async () => {
    mocks.organizationForAnonymousToken.mockResolvedValue('org_acme');
    mocks.resolveOrganizationById.mockResolvedValue(ORGANIZATION);

    const response = await GET(new Request(url('invitations.get', tokenQuery('a-real-token'))));

    expect(response.status).toBe(200);
    expect(mocks.organizationForAnonymousToken).toHaveBeenCalledWith('a-real-token');
    expect(mocks.withTenantDb).toHaveBeenCalledWith('org_acme', expect.any(Function), {
      timeout: 60_000,
    });
    expect(servedBy()).toBe('real');

    // `createContext` is a lazy callback, so invoke the one the handler passed.
    // No session is fabricated for the anonymous path: the context is built with
    // an explicit null, which every protected procedure refuses on its own.
    const { createContext } = mocks.fetchRequestHandler.mock.calls[0][0] as {
      createContext: () => unknown;
    };
    createContext();
    expect(mocks.createTRPCContext).toHaveBeenCalledWith(
      expect.objectContaining({ session: null, support: null, organization: ORGANIZATION })
    );
  });

  it.each([
    'invitations.get',
    'invitations.accept',
    'passwordReset.validate',
    'passwordReset.reset',
  ])('admits %s', async (procedure) => {
    mocks.organizationForAnonymousToken.mockResolvedValue('org_acme');
    mocks.resolveOrganizationById.mockResolvedValue(ORGANIZATION);

    const response = await POST(
      new Request(url(procedure), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ '0': { json: { token: 'a-real-token' } } }),
      })
    );

    expect(response.status).toBe(200);
    expect(servedBy()).toBe('real');
  });

  // An unknown token must be answered the same way a known-but-expired one is.
  // A 401 here would tell an anonymous caller that a token string does not exist.
  it('falls back without opening a tenant scope when the token names nothing', async () => {
    mocks.organizationForAnonymousToken.mockResolvedValue(null);

    const response = await GET(new Request(url('invitations.get', tokenQuery('nonsense'))));

    expect(response.status).toBe(200);
    expect(servedBy()).toBe('fallback');
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it('falls back when the token names a workspace that may not serve traffic', async () => {
    mocks.organizationForAnonymousToken.mockResolvedValue('org_acme');
    mocks.resolveOrganizationById.mockResolvedValue({ ...ORGANIZATION, status: 'SUSPENDED' });

    await GET(new Request(url('invitations.get', tokenQuery('a-real-token'))));

    expect(servedBy()).toBe('fallback');
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });
});

describe('passwordReset.request is routed by host, strictly', () => {
  const request = (host: string) =>
    new Request(url('passwordReset.request'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', host },
      body: JSON.stringify({ '0': { json: { email: 'someone@example.com' } } }),
    });

  it('uses the STRICT resolver, never the default-organization one', async () => {
    mocks.resolveExplicitOrganizationByHost.mockResolvedValue(ORGANIZATION);

    await POST(request('acme.example.com'));

    expect(mocks.resolveExplicitOrganizationByHost).toHaveBeenCalledWith('acme.example.com');
    expect(servedBy()).toBe('real');
    expect(mocks.withTenantDb).toHaveBeenCalledWith('org_acme', expect.any(Function), {
      timeout: 60_000,
    });
  });

  /**
   * The outage-adjacent hazard: on the shared staging host the non-strict
   * resolver returns DEFAULT_ORGANIZATION_ID, and a reset link would be minted
   * and mailed for a tenant the caller never named. Nothing may run.
   */
  it('opens no tenant scope on a shared or unknown host, so nothing is sent', async () => {
    mocks.resolveExplicitOrganizationByHost.mockResolvedValue(null);

    const response = await POST(request('staging.devfathom.com'));

    expect(response.status).toBe(200);
    expect(servedBy()).toBe('fallback');
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });
});

describe('rate limiting', () => {
  it('refuses before any database work once a limit is exceeded', async () => {
    mocks.admitAnonymousRequest.mockReturnValue({ ok: false, retryAfter: 42 });

    const response = await GET(new Request(url('invitations.get', tokenQuery('a-real-token'))));

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    expect(mocks.organizationForAnonymousToken).not.toHaveBeenCalled();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.fetchRequestHandler).not.toHaveBeenCalled();
  });

  it('is not consulted for a request that was never allowlisted', async () => {
    await GET(new Request(url('clients.getAll')));

    expect(mocks.admitAnonymousRequest).not.toHaveBeenCalled();
  });
});

describe('the signed-in path is unchanged', () => {
  it('still resolves the organization from the host and serves the real router', async () => {
    mocks.resolveTenantActor.mockResolvedValue({
      session: { user: { id: 'user_1', organizationId: 'org_acme' } },
      support: null,
    });
    mocks.requireOrganizationForRequest.mockResolvedValue(ORGANIZATION);

    const response = await GET(new Request(url('clients.getAll')));

    expect(response.status).toBe(200);
    expect(servedBy()).toBe('real');
    expect(mocks.requireOrganizationForRequest).toHaveBeenCalled();
    // The anonymous machinery is not involved at all for a real session.
    expect(mocks.admitAnonymousRequest).not.toHaveBeenCalled();
    expect(mocks.organizationForAnonymousToken).not.toHaveBeenCalled();
  });
});
