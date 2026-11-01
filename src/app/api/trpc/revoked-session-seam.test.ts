/**
 * The seam between #18 (session revocation) and #19 (anonymous transport).
 *
 * The two changes meet at one line in `/api/trpc`: `resolveTenantActor` returns
 * null for a revoked session, and null is also what an anonymous request looks
 * like. So a browser holding a revoked cookie AND a valid invite token now
 * reaches the anonymous path. That is intended — it is exactly how someone
 * locked out of a revoked session accepts a new invitation — but it is only safe
 * if the revoked session contributes NOTHING on the way through.
 *
 * These tests pin both halves of that seam:
 *   - revoked cookie + valid anonymous token → served, with no session and none
 *     of the revoked session's organization, role, or support identity
 *   - revoked cookie + no anonymous standing → still unauthorized
 *
 * `resolveTenantActor` and `evaluateSessionUser` are REAL here. Mocking the
 * actor would assume the very thing under test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getSupportSession: vi.fn(),
  organizationForAnonymousToken: vi.fn(),
  resolveOrganizationById: vi.fn(),
  resolveExplicitOrganizationByHost: vi.fn(),
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
vi.mock('@/lib/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/tenancy/support-session', () => ({ getSupportSession: mocks.getSupportSession }));
vi.mock('@/lib/auth/anonymous-tenant', () => ({
  organizationForAnonymousToken: mocks.organizationForAnonymousToken,
}));
vi.mock('@/lib/auth/anonymous-rate-limit', () => ({
  admitAnonymousRequest: mocks.admitAnonymousRequest,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: mocks.withTenantDb,
  createTenantDb: vi.fn(() => ({})),
}));
vi.mock('@/lib/tenancy/host', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tenancy/host')>('@/lib/tenancy/host');
  return {
    ...actual,
    resolveExplicitOrganizationByHost: mocks.resolveExplicitOrganizationByHost,
    resolveOrganizationById: mocks.resolveOrganizationById,
    requireOrganizationForRequest: mocks.requireOrganizationForRequest,
  };
});

import { GET, POST } from './[trpc]/route';

const INVITE_ORGANIZATION = { id: 'org_invitee', slug: 'invitee', status: 'ACTIVE' };

/**
 * A session that #18 revokes. It still carries a full, privileged-looking user —
 * a different organization and an ADMIN role — so that anything inherited from it
 * would be visible in the assertions below.
 */
const REVOKED_SESSION = {
  expires: 'later',
  user: {
    id: 'user_revoked',
    organizationId: 'org_someone_else',
    organizationSlug: 'someone-else',
    role: 'ADMIN',
    status: 'ACTIVE',
    sessionRevoked: true,
    sessionInvalidReason: 'REVOKED',
  },
};

const url = (path: string, query = '?batch=1') =>
  `http://acme.example.com/api/trpc/${path}${query}`;
const tokenQuery = (token: string) =>
  `?batch=1&input=${encodeURIComponent(JSON.stringify({ '0': { json: { token } } }))}`;

function servedBy(): string | null {
  const call = mocks.fetchRequestHandler.mock.calls.at(0);
  return call ? ((call[0] as { router: { __which: string } }).router.__which ?? null) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(REVOKED_SESSION);
  mocks.getSupportSession.mockResolvedValue(null);
  mocks.admitAnonymousRequest.mockReturnValue({ ok: true });
  mocks.fetchRequestHandler.mockResolvedValue(new Response('served', { status: 200 }));
  mocks.withTenantDb.mockImplementation(
    async (_id: string, run: (db: unknown) => Promise<unknown>) => run({})
  );
  mocks.createTRPCContext.mockResolvedValue({});
});

describe('a revoked session presenting a valid anonymous token', () => {
  beforeEach(() => {
    mocks.organizationForAnonymousToken.mockResolvedValue(INVITE_ORGANIZATION.id);
    mocks.resolveOrganizationById.mockResolvedValue(INVITE_ORGANIZATION);
  });

  it('is served through the anonymous path, in the tenant the TOKEN names', async () => {
    const response = await GET(new Request(url('invitations.accept', tokenQuery('a-real-token'))));

    expect(response.status).toBe(200);
    expect(servedBy()).toBe('real');
    // The token's organization, never the revoked session's.
    expect(mocks.withTenantDb).toHaveBeenCalledWith(INVITE_ORGANIZATION.id, expect.any(Function), {
      timeout: 60_000,
    });
    expect(mocks.withTenantDb).not.toHaveBeenCalledWith(
      'org_someone_else',
      expect.anything(),
      expect.anything()
    );
    // The signed-in path was never entered.
    expect(mocks.requireOrganizationForRequest).not.toHaveBeenCalled();
  });

  it('builds a context with no session and no inherited privileges', async () => {
    await GET(new Request(url('invitations.accept', tokenQuery('a-real-token'))));

    const { createContext } = mocks.fetchRequestHandler.mock.calls[0][0] as {
      createContext: () => unknown;
    };
    createContext();

    expect(mocks.createTRPCContext).toHaveBeenCalledTimes(1);
    const context = mocks.createTRPCContext.mock.calls[0][0];

    expect(context.session).toBeNull();
    expect(context.support).toBeNull();
    expect(context.organization).toEqual(INVITE_ORGANIZATION);

    // Nothing from the revoked session survived into the context, by any route.
    const serialized = JSON.stringify({
      session: context.session,
      support: context.support,
      organization: context.organization,
    });
    expect(serialized).not.toContain('user_revoked');
    expect(serialized).not.toContain('org_someone_else');
    expect(serialized).not.toContain('ADMIN');
  });
});

describe('a revoked session WITHOUT anonymous standing', () => {
  it('is unauthorized on a protected procedure', async () => {
    const response = await GET(new Request(url('clients.getAll')));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mocks.fetchRequestHandler).not.toHaveBeenCalled();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it('is unauthorized on an admin procedure it could reach before revocation', async () => {
    const response = await POST(
      new Request(url('organizationAdmin.listMembers'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ '0': { json: {} } }),
      })
    );

    expect(response.status).toBe(401);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  /**
   * Allowlisted, but the token names nothing. This must be answered by the
   * fallback — never by the revoked session's tenant, and never with a 401 that
   * would reveal the token does not exist.
   */
  it('gets the generic fallback, not its old tenant, when the token resolves to nothing', async () => {
    mocks.organizationForAnonymousToken.mockResolvedValue(null);

    const response = await GET(new Request(url('invitations.get', tokenQuery('nonsense'))));

    expect(response.status).toBe(200);
    expect(servedBy()).toBe('fallback');
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.createTRPCContext).not.toHaveBeenCalled();
  });
});

/**
 * The control: the same code path with a session that #18 does NOT revoke must
 * still take the signed-in route. Without this, every assertion above would also
 * pass if the handler had simply stopped accepting sessions altogether.
 */
describe('a usable session is unaffected', () => {
  it('still takes the signed-in path', async () => {
    mocks.auth.mockResolvedValue({
      expires: 'later',
      user: { id: 'user_ok', organizationId: 'org_acme', role: 'ADMIN', status: 'ACTIVE' },
    });
    mocks.requireOrganizationForRequest.mockResolvedValue({
      id: 'org_acme',
      slug: 'acme',
      status: 'ACTIVE',
    });

    const response = await GET(new Request(url('clients.getAll')));

    expect(response.status).toBe(200);
    expect(servedBy()).toBe('real');
    expect(mocks.requireOrganizationForRequest).toHaveBeenCalled();
    expect(mocks.admitAnonymousRequest).not.toHaveBeenCalled();
  });
});

describe('a temporary password on an API route', () => {
  it('returns 403 PASSWORD_CHANGE_REQUIRED and still allows the password change', async () => {
    mocks.auth.mockResolvedValue({
      expires: 'later',
      user: {
        id: 'user_temp',
        organizationId: 'org_acme',
        role: 'EMPLOYEE',
        status: 'ACTIVE',
        mustChangePassword: true,
      },
    });

    const blocked = await GET(new Request(url('clients.getAll')));
    expect(blocked.status).toBe(403);
    await expect(blocked.json()).resolves.toEqual({
      code: 'PASSWORD_CHANGE_REQUIRED',
      error: 'PASSWORD_CHANGE_REQUIRED',
    });
    expect(mocks.fetchRequestHandler).not.toHaveBeenCalled();

    mocks.requireOrganizationForRequest.mockResolvedValue({
      id: 'org_acme',
      slug: 'acme',
      status: 'ACTIVE',
    });
    const allowed = await POST(new Request(url('team.changePassword'), { method: 'POST' }));
    expect(allowed.status).toBe(200);
    expect(servedBy()).toBe('real');
  });
});
