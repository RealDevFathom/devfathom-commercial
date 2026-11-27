import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  compare: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  deleteToken: vi.fn(),
  createTenantDb: vi.fn(),
  resolveEntitlements: vi.fn(),
  currentEntitlements: vi.fn(),
  recordRestAudit: vi.fn(),
  approvalAuthenticatorGate: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ compare: mocks.compare, hash: vi.fn() }));
vi.mock('@/server/audit', () => ({ recordRestAudit: mocks.recordRestAudit }));
vi.mock('@/lib/rate-limit', () => ({
  clientIp: vi.fn(() => '127.0.0.1'),
  rateLimit: vi.fn(() => ({ ok: true })),
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: (entitlements: { enabledModules: string[] }, key: string) =>
    entitlements.enabledModules.includes(key),
  resolveOrganizationEntitlements: mocks.resolveEntitlements,
  resolveCurrentOrganizationEntitlements: mocks.currentEntitlements,
}));
vi.mock('@/lib/approval-authenticator-gate', () => ({
  approvalAuthenticatorGate: mocks.approvalAuthenticatorGate,
}));
vi.mock('@/lib/tenancy/scoped-db', () => {
  const tenantDb = {
    apiToken: { update: mocks.update, delete: mocks.deleteToken },
  };
  return {
    createTenantDb: mocks.createTenantDb,
    withPlatformDb: (run: (db: unknown) => unknown) =>
      run({ apiToken: { findMany: mocks.findMany } }),
    withTenantDb: (_organizationId: string, run: (db: unknown) => unknown) => run(tenantDb),
  };
});

import { authenticateApiRequest, withApiAuth } from './api-auth';

describe('authenticateApiRequest entitlement enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.compare.mockResolvedValue(true);
    mocks.update.mockResolvedValue({});
    mocks.resolveEntitlements.mockResolvedValue({
      organizationId: 'org_1',
      seatLimit: 10,
      activeSeats: 1,
      enabledModules: [],
      modules: [],
      limits: {},
    });
    mocks.findMany.mockResolvedValue([
      {
        id: 'token_1',
        organizationId: 'org_1',
        userId: 'user_1',
        tokenHash: 'hash',
        scopes: ['*'],
        expiresAt: null,
        user: {
          id: 'user_1',
          role: 'ADMIN',
          status: 'ACTIVE',
          organization: { id: 'org_1', status: 'ACTIVE' },
        },
      },
    ]);
  });

  it('uses the current separated entitlement read for university provider tokens', async () => {
    mocks.findMany.mockResolvedValueOnce([
      {
        id: 'token_1',
        organizationId: 'org_1',
        userId: 'user_1',
        tokenHash: 'hash',
        scopes: [],
        expiresAt: null,
        user: {
          role: 'MEMBER',
          status: 'ACTIVE',
          organization: { id: 'org_1', status: 'ACTIVE', vertical: 'UNIVERSITY' },
        },
      },
    ]);
    mocks.currentEntitlements.mockResolvedValueOnce({ enabledModules: [] });
    const result = await authenticateApiRequest(
      new Request('https://university.example/api/v1/university/events', {
        headers: { Authorization: 'Bearer df_existing_valid_token' },
      })
    );
    expect((result as Response).status).toBe(403);
    expect(mocks.currentEntitlements).toHaveBeenCalledWith('org_1');
    expect(mocks.resolveEntitlements).not.toHaveBeenCalled();
  });

  it('returns 403 for an existing valid token when API access is disabled', async () => {
    const result = await authenticateApiRequest(
      new Request('https://acme.example.com/api/v1/projects', {
        headers: { Authorization: 'Bearer df_existing_valid_token' },
      })
    );

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'API access is not enabled for this organization.',
    });
    expect(mocks.createTenantDb).not.toHaveBeenCalled();
    expect(mocks.deleteToken).not.toHaveBeenCalled();
  });
});

describe('DEV-961 an API token is gated like its member’s session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.compare.mockResolvedValue(true);
    mocks.update.mockResolvedValue({});
    mocks.resolveEntitlements.mockResolvedValue({
      organizationId: 'org_1',
      seatLimit: 10,
      activeSeats: 1,
      enabledModules: ['api'],
      modules: [],
      limits: {},
    });
    mocks.findMany.mockResolvedValue([
      {
        id: 'token_1',
        organizationId: 'org_1',
        userId: 'user_1',
        tokenHash: 'hash',
        scopes: ['*'],
        expiresAt: null,
        user: {
          id: 'user_1',
          role: 'ADMIN',
          status: 'ACTIVE',
          organization: { id: 'org_1', status: 'ACTIVE' },
        },
      },
    ]);
  });
  const call = () =>
    authenticateApiRequest(
      new Request('https://acme.example.com/api/v1/projects', {
        headers: { Authorization: 'Bearer df_existing_valid_token' },
      })
    );

  it('refuses the token of an approver who has not set up the authenticator', async () => {
    mocks.approvalAuthenticatorGate.mockResolvedValue({ approver: true, setupRequired: true });
    const result = await call();
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
    await expect((result as Response).json()).resolves.toMatchObject({
      code: 'APPROVAL_AUTHENTICATOR_SETUP_REQUIRED',
    });
    expect(mocks.approvalAuthenticatorGate).toHaveBeenCalledWith(expect.anything(), {
      organizationId: 'org_1',
      userId: 'user_1',
    });
    expect(mocks.createTenantDb).not.toHaveBeenCalled();
  });

  it('accepts the token once nothing is outstanding', async () => {
    mocks.approvalAuthenticatorGate.mockResolvedValue({ approver: true, setupRequired: false });
    await expect(call()).resolves.toMatchObject({ organizationId: 'org_1', userId: 'user_1' });
  });
});

describe('withApiAuth error logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.approvalAuthenticatorGate.mockResolvedValue({ approver: false, setupRequired: false });
    mocks.compare.mockResolvedValue(true);
    mocks.update.mockResolvedValue({});
    mocks.resolveEntitlements.mockResolvedValue({
      organizationId: 'org_1',
      seatLimit: 10,
      activeSeats: 1,
      enabledModules: ['api'],
      modules: [],
      limits: {},
    });
    mocks.findMany.mockResolvedValue([
      {
        id: 'token_1',
        organizationId: 'org_1',
        userId: 'user_1',
        tokenHash: 'hash',
        scopes: ['*'],
        expiresAt: null,
        user: {
          id: 'user_1',
          role: 'ADMIN',
          status: 'ACTIVE',
          organization: { id: 'org_1', status: 'ACTIVE' },
        },
      },
    ]);
  });

  it.each(['projects:read', 'spec:read'])(
    'audits an entitlement lookup failure and denies %s',
    async (scope) => {
      const failure = new Error('fixture entitlement store unavailable');
      mocks.resolveEntitlements.mockRejectedValueOnce(failure);
      const handler = vi.fn(() => new Response('fixture data'));
      const route =
        scope === 'spec:read'
          ? (await import('@/app/api/v1/spec/route')).GET
          : withApiAuth(scope, handler);
      const request = new Request(
        'https://example.test/api/v1/' + (scope === 'spec:read' ? 'spec' : 'projects'),
        {
          headers: { Authorization: 'Bearer df_test_fixture' },
        }
      );
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const response = await route(request);
        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({ error: 'Internal server error' });
        expect(mocks.resolveEntitlements).toHaveBeenCalledWith('org_1', expect.anything());
        expect(mocks.recordRestAudit).toHaveBeenCalledTimes(1);
        expect(mocks.recordRestAudit).toHaveBeenCalledWith(
          expect.objectContaining({ request, scope, status: 500, error: failure })
        );
        expect(mocks.createTenantDb).not.toHaveBeenCalled();
        expect(handler).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    }
  );

  it('logs with a constant format string, the scope and the full error, and returns a generic 500', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('prisma internals: relation "secret" does not exist');
    // A scope containing format tokens must never be interpreted as a format string.
    const scope = 'odd%s%d%o:read';
    const handler = withApiAuth(scope, () => {
      throw failure;
    });

    const response = await handler(
      new Request('https://acme.example.com/api/v1/odd', {
        headers: { Authorization: 'Bearer df_existing_valid_token' },
      })
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual(['API error in %s:', scope, failure]);
    expect(spy.mock.calls[0]?.[2]).toBe(failure);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Internal server error' });
    expect(mocks.recordRestAudit).toHaveBeenCalledWith(
      expect.objectContaining({ scope, status: 500, error: failure })
    );
    spy.mockRestore();
  });
});
