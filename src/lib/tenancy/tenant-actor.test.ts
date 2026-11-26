import type { Session } from 'next-auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getSupportSession: vi.fn(),
  requireOrganizationForRequest: vi.fn(),
  isSharedHost: vi.fn(() => false),
  resolveOrganizationById: vi.fn(),
  withTenantDb: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('@/lib/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/tenancy/host', () => {
  class TenantHostError extends Error {
    constructor(
      message: string,
      readonly status: 404 | 409 | 423
    ) {
      super(message);
    }
  }

  return {
    isSharedHost: mocks.isSharedHost,
    isTenantLifecycleAccessible: vi.fn(() => true),
    requestHost: (request: Request) => new URL(request.url).hostname,
    requireOrganizationForRequest: mocks.requireOrganizationForRequest,
    resolveOrganizationById: mocks.resolveOrganizationById,
    resolveOrganizationByHost: vi.fn(),
    TenantHostError,
    TENANT_HOST_HEADER: 'x-devfathom-host',
    REQUEST_METHOD_HEADER: 'x-devfathom-request-method',
  };
});
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: mocks.withTenantDb }));
vi.mock('@/lib/tenancy/support-session', () => ({
  getSupportSession: mocks.getSupportSession,
}));

import { headers } from 'next/headers';
import { resolveOrganizationByHost } from '@/lib/tenancy/host';
import { TenantHostError } from '@/lib/tenancy/host';
import { resolveTenantActor, resolveTenantMismatchLoginPath } from './tenant-actor';
import { proxy } from '@/proxy';

function sessionFor(user: Record<string, unknown>): Session {
  return {
    expires: new Date(Date.now() + 60_000).toISOString(),
    user: { id: 'user_1', organizationId: 'org_other', ...user },
  } as Session;
}

// #16: the actor resolver now applies the session verdict, so a fixture without
// a status would be rejected before the host check it is meant to exercise.
const session = sessionFor({ status: 'ACTIVE' });

const request = () => new Request('http://devfathom.localhost:3000/dashboard');

describe('resolveTenantActor', () => {
  beforeEach(() => {
    vi.stubEnv('DEMO_ACCESS_CODE', 'test-only-code');
    vi.clearAllMocks();
    mocks.getSupportSession.mockResolvedValue(null);
    mocks.isSharedHost.mockReturnValue(false);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('treats a session for another workspace as unauthenticated', async () => {
    mocks.requireOrganizationForRequest.mockRejectedValue(
      new TenantHostError('This session belongs to a different workspace.', 409)
    );

    await expect(resolveTenantActor({ request: request(), session })).resolves.toBeNull();
  });

  it('preserves a host denial when requested by a route', async () => {
    const denial = new TenantHostError('This session belongs to a different workspace.', 409);
    mocks.requireOrganizationForRequest.mockRejectedValue(denial);

    await expect(
      resolveTenantActor({ request: request(), session, throwOnHostError: true })
    ).rejects.toBe(denial);
  });

  it('does not hide unexpected resolution failures', async () => {
    mocks.requireOrganizationForRequest.mockRejectedValue(new Error('Database unavailable'));

    await expect(resolveTenantActor({ request: request(), session })).rejects.toThrow(
      'Database unavailable'
    );
  });

  // #16: no route handler should have to remember the revocation check, so the
  // resolver refuses to produce an actor for a session that is not usable — and
  // it does so BEFORE touching the database.
  it.each([
    ['a revoked session', { status: 'ACTIVE', sessionRevoked: true }],
    ['a legacy REVOKED sentinel', { status: 'REVOKED' }],
    ['a session with no status', {}],
    ['a deactivated account', { status: 'INACTIVE' }],
  ])('refuses to build an actor for %s', async (_label, user) => {
    mocks.requireOrganizationForRequest.mockResolvedValue({ id: 'org_other' });

    await expect(
      resolveTenantActor({ request: request(), session: sessionFor(user) })
    ).resolves.toBeNull();
    expect(mocks.requireOrganizationForRequest).not.toHaveBeenCalled();
  });

  it('rejects an API call while a temporary password is outstanding', async () => {
    mocks.requireOrganizationForRequest.mockResolvedValue({ id: 'org_other' });
    const blocked = sessionFor({ status: 'ACTIVE', mustChangePassword: true });

    await expect(
      resolveTenantActor({
        request: new Request('http://devfathom.localhost:3000/api/upload'),
        session: blocked,
      })
    ).rejects.toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED', status: 403 });
    expect(mocks.requireOrganizationForRequest).not.toHaveBeenCalled();

    await expect(
      resolveTenantActor({
        request: new Request(
          'http://devfathom.localhost:3000/api/trpc/team.changePassword?batch=1'
        ),
        session: blocked,
      })
    ).resolves.toMatchObject({ organization: { id: 'org_other' } });
    await expect(
      resolveTenantActor({
        request: new Request('http://devfathom.localhost:3000/api/auth/signout', {
          method: 'POST',
        }),
        session: blocked,
      })
    ).resolves.toMatchObject({ organization: { id: 'org_other' } });
    await expect(
      resolveTenantActor({
        request: new Request('http://devfathom.localhost:3000/dashboard'),
        session: blocked,
      })
    ).resolves.toMatchObject({ organization: { id: 'org_other' } });
  });

  it('DEV-961: refuses every route handler until a gated approver sets up the authenticator', async () => {
    mocks.requireOrganizationForRequest.mockResolvedValue({ id: 'org_other' });
    const gated = sessionFor({ status: 'ACTIVE', approvalAuthenticatorSetupRequired: true });
    const call = (path: string, method = 'POST') =>
      resolveTenantActor({
        request: new Request(`http://devfathom.localhost:3000${path}`, { method }),
        session: gated,
      });
    for (const path of [
      '/api/upload',
      '/api/pharmacy/counter/sales',
      '/api/pharmacy/data-export',
      '/api/assistant',
      '/api/ably-token',
      '/api/trpc/pharmacySales.refund',
      // A batch cannot carry a blocked call alongside the set-up calls.
      '/api/trpc/approvalAuthenticator.getStatus,pharmacySales.refund?batch=1',
      '/api/trpc/approvalAuthenticator.getStatus%2CpharmacySales.refund?batch=1',
      // Route handlers outside /api: exports and downloads are refused the same way.
      '/pharmacy/accounts/fiscal-exceptions/csv',
      '/pharmacy/accounts/tax-profile-review/export',
      '/dashboard',
    ])
      await expect(call(path, 'GET')).rejects.toMatchObject({
        code: 'APPROVAL_AUTHENTICATOR_SETUP_REQUIRED',
        status: 403,
      });
    for (const path of ['/api/upload', '/pharmacy/accounts/fiscal-exceptions/csv'])
      await expect(call(path)).rejects.toMatchObject({
        code: 'APPROVAL_AUTHENTICATOR_SETUP_REQUIRED',
        status: 403,
      });
    expect(mocks.requireOrganizationForRequest).not.toHaveBeenCalled();

    for (const path of [
      '/api/trpc/approvalAuthenticator.getStatus,approvalAuthenticator.beginEnrollment?batch=1',
      '/api/trpc/approvalAuthenticator.confirmEnrollment',
      '/api/auth/signout',
    ])
      await expect(call(path)).resolves.toMatchObject({ organization: { id: 'org_other' } });
  });

  it('DEV-961: refuses a server action, but lets a page render reach the set-up redirect', async () => {
    // A page render or server action carries no Request; the workspace comes from the host.
    mocks.isSharedHost.mockReturnValue(true);
    mocks.resolveOrganizationById.mockResolvedValue({ id: 'org_other', status: 'ACTIVE' });
    const gated = sessionFor({ status: 'ACTIVE', approvalAuthenticatorSetupRequired: true });
    // A server action carries no Request; Next names the action in the Next-Action header.
    vi.mocked(headers).mockResolvedValue(
      new Headers({ host: 'devfathom.localhost:3000', 'next-action': '7f00ab' }) as never
    );
    await expect(resolveTenantActor({ session: gated })).rejects.toMatchObject({
      code: 'APPROVAL_AUTHENTICATOR_SETUP_REQUIRED',
      status: 403,
    });
    // A page render builds the actor; the workspace layout then sends them to the set-up screen.
    vi.mocked(headers).mockResolvedValue(
      new Headers({ host: 'devfathom.localhost:3000' }) as never
    );
    await expect(resolveTenantActor({ session: gated })).resolves.toMatchObject({
      organization: { id: 'org_other' },
    });
    // A member who is not asked is never refused, in a server action either.
    vi.mocked(headers).mockResolvedValue(
      new Headers({ host: 'devfathom.localhost:3000', 'next-action': '7f00ab' }) as never
    );
    await expect(
      resolveTenantActor({ session: sessionFor({ status: 'ACTIVE' }) })
    ).resolves.toMatchObject({ organization: { id: 'org_other' } });
  });

  describe('DEV-961: a server action is refused however Next receives it', () => {
    const gated = () => sessionFor({ status: 'ACTIVE', approvalAuthenticatorSetupRequired: true });
    const setUp = () => sessionFor({ status: 'ACTIVE', approvalAuthenticatorSetupRequired: false });
    // What the proxy forwards: the host and the request method (always overwritten there).
    const withRequest = (method: string | null, extra: Record<string, string> = {}) =>
      vi.mocked(headers).mockResolvedValue(
        new Headers({
          host: 'devfathom.localhost:3000',
          ...(method ? { 'x-devfathom-request-method': method } : {}),
          ...extra,
        }) as never
      );
    const refused = { code: 'APPROVAL_AUTHENTICATOR_SETUP_REQUIRED', status: 403 };
    beforeEach(() => {
      mocks.isSharedHost.mockReturnValue(true);
      mocks.resolveOrganizationById.mockResolvedValue({ id: 'org_other', status: 'ACTIVE' });
    });

    it.each([
      // A plain form submission: Next runs the action named by its $ACTION_ID_ field, no header.
      [
        'a multipart form POST with no Next-Action header',
        'POST',
        {
          'content-type': 'multipart/form-data; boundary=----devfathom',
        },
      ],
      ['a URL-encoded form POST', 'POST', { 'content-type': 'application/x-www-form-urlencoded' }],
      [
        'a fetch action (Next-Action header)',
        'POST',
        { 'next-action': '7f00ab', 'content-type': 'text/plain;charset=UTF-8' },
      ],
      ['a POST with any other body', 'POST', { 'content-type': 'application/json' }],
      ['a PUT', 'PUT', {}],
      ['a DELETE', 'DELETE', {}],
      // Without the proxy's method header the request is checked as a POST.
      [
        'a multipart body when the method is unknown',
        null,
        {
          'content-type': 'multipart/form-data; boundary=----devfathom',
        },
      ],
      ['a Next-Action header when the method is unknown', null, { 'next-action': '7f00ab' }],
    ] as const)(
      'refuses %s for a member who must set up the app',
      async (_label, method, extra) => {
        withRequest(method, extra);
        await expect(resolveTenantActor({ session: gated() })).rejects.toMatchObject(refused);
        // A member who has set up the app (or is not asked) is resolved as usual.
        await expect(resolveTenantActor({ session: setUp() })).resolves.toMatchObject({
          organization: { id: 'org_other' },
        });
      }
    );

    it.each([
      ['a GET page render', 'GET', {}],
      ['a HEAD request', 'HEAD', {}],
      ['a client navigation (RSC GET)', 'GET', { rsc: '1' }],
      // Next never runs an action for a GET, whatever the headers say.
      [
        'a GET carrying a form content type',
        'GET',
        { 'content-type': 'multipart/form-data; boundary=x' },
      ],
      ['a render with no method header and no action', null, {}],
    ] as const)('lets %s reach the set-up redirect', async (_label, method, extra) => {
      withRequest(method, extra);
      await expect(resolveTenantActor({ session: gated() })).resolves.toMatchObject({
        organization: { id: 'org_other' },
      });
    });
  });

  it('still builds an actor for an ON_LEAVE session', async () => {
    mocks.requireOrganizationForRequest.mockResolvedValue({ id: 'org_other' });

    const actor = await resolveTenantActor({
      request: request(),
      session: sessionFor({ status: 'ON_LEAVE' }),
    });
    expect(actor?.organization).toEqual({ id: 'org_other' });
  });

  it('requires a live absolute grant expiry for a demo organization', async () => {
    mocks.requireOrganizationForRequest.mockResolvedValue({ id: 'org_other', isDemo: true });

    await expect(
      resolveTenantActor({
        request: request(),
        session: sessionFor({ status: 'ACTIVE' }),
      })
    ).resolves.toBeNull();
    await expect(
      resolveTenantActor({
        request: request(),
        session: sessionFor({ status: 'ACTIVE', demoAccessExpiresAt: Date.now() - 1 }),
      })
    ).resolves.toBeNull();
    const user = {
      status: 'ACTIVE',
      id: 'user_demo_restaurant_seat_1_waiter',
      email: 'waiter.seat1@demo.devfathom.invalid',
      organizationId: 'org_demo_restaurant_seat_1',
      demoAccessExpiresAt: Date.now() + 60_000,
    };
    await expect(
      resolveTenantActor({ request: request(), session: sessionFor(user) })
    ).resolves.toBeNull();
    mocks.requireOrganizationForRequest.mockResolvedValue({
      id: user.organizationId,
      slug: 'demo-restaurant-seat-1',
      isDemo: true,
      status: 'ACTIVE',
      vertical: 'RESTAURANT',
      deploymentMode: 'SHARED',
    });
    await expect(
      resolveTenantActor({ request: request(), session: sessionFor(user) })
    ).resolves.toMatchObject({ organization: { id: user.organizationId, isDemo: true } });
    mocks.requireOrganizationForRequest.mockResolvedValue({
      id: user.organizationId,
      isDemo: false,
    });
    await expect(
      resolveTenantActor({ request: request(), session: sessionFor(user) })
    ).resolves.toBeNull();
  });

  // D14: `df_support_session` is domain-wide and outranks the tenant JWT, so an
  // operator with a live support session who opened the shared host would have
  // been handed an impersonated actor for a workspace they never opened.
  describe('on the shared host', () => {
    beforeEach(() => mocks.isSharedHost.mockReturnValue(true));

    it('ignores a live support session', async () => {
      mocks.getSupportSession.mockResolvedValue({
        organizationId: 'org_support',
        tenantUserId: 'user_support',
      });
      mocks.requireOrganizationForRequest.mockResolvedValue({ id: 'org_other' });

      const actor = await resolveTenantActor({ request: request(), session });

      expect(mocks.getSupportSession).not.toHaveBeenCalled();
      expect(actor?.support).toBeNull();
      expect(actor?.session.user.id).toBe('user_1');
    });

    it('still resolves the tenant session normally', async () => {
      mocks.requireOrganizationForRequest.mockResolvedValue({ id: 'org_other' });

      const actor = await resolveTenantActor({ request: request(), session });

      expect(actor?.organization).toEqual({ id: 'org_other' });
    });
  });
});

describe('wrong-host session login destination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isSharedHost.mockReturnValue(false);
    vi.mocked(headers).mockResolvedValue(
      new Headers({ host: 'devfathom.localhost:3000' }) as never
    );
    mocks.auth.mockResolvedValue(session);
    vi.mocked(resolveOrganizationByHost).mockResolvedValue({ id: 'org_agency' } as never);
    mocks.resolveOrganizationById.mockResolvedValue({
      id: 'org_other',
      slug: 'karahi-house',
      status: 'ACTIVE',
    });
  });
  it('redirects to the session organization database slug before rendering a shell', async () => {
    await expect(resolveTenantMismatchLoginPath()).resolves.toBe(
      'http://karahi-house.localhost:3000/login'
    );
    expect(mocks.resolveOrganizationById).toHaveBeenCalledWith('org_other');
  });
  it('does not redirect a matching host', async () => {
    vi.mocked(resolveOrganizationByHost).mockResolvedValue({ id: 'org_other' } as never);
    await expect(resolveTenantMismatchLoginPath()).resolves.toBeNull();
  });
  it.each(['host', 'x-forwarded-host'])(
    'preserves the %s port through the proxy into the wrong-host login redirect',
    async (hostHeader) => {
      const response = await proxy(
        new Request('http://devfathom.localhost:3000/dashboard', {
          headers: {
            host: 'internal.localhost:8080',
            [hostHeader]: 'devfathom.localhost:3000',
            cookie: 'authjs.session-token=test-session',
          },
        })
      );
      const forwardedHost = response.headers.get('x-middleware-request-x-devfathom-host');
      expect(forwardedHost).toBe('devfathom.localhost:3000');
      vi.mocked(headers).mockResolvedValue(
        new Headers({ 'x-devfathom-host': forwardedHost! }) as never
      );

      await expect(resolveTenantMismatchLoginPath()).resolves.toBe(
        'http://karahi-house.localhost:3000/login'
      );
      expect(resolveOrganizationByHost).toHaveBeenCalledWith('devfathom.localhost:3000');
    }
  );
  it('does not use revoked sessions to select a tenant host', async () => {
    mocks.auth.mockResolvedValue(sessionFor({ status: 'ACTIVE', sessionRevoked: true }));
    await expect(resolveTenantMismatchLoginPath()).resolves.toBeNull();
    expect(mocks.resolveOrganizationById).not.toHaveBeenCalled();
  });
});
