// @vitest-environment node
/**
 * DEV-1055: the API reference used to authenticate by hand and so skipped the
 * shared `/api/v1` limits: every request with a made-up token cost an unbounded
 * bcrypt compare. It now runs through `withApiAuth`, so the per-IP limit applies
 * before authentication and the per-token limit after it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  compare: vi.fn(),
  findMany: vi.fn(),
  rateLimit: vi.fn(),
  recordRestAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ compare: mocks.compare, hash: vi.fn() }));
vi.mock('@/server/audit', () => ({ recordRestAudit: mocks.recordRestAudit }));
vi.mock('@/lib/rate-limit', () => ({
  clientIp: vi.fn(() => '203.0.113.9'),
  rateLimit: mocks.rateLimit,
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: (entitlements: { enabledModules: string[] }, key: string) =>
    entitlements.enabledModules.includes(key),
  resolveOrganizationEntitlements: vi.fn(async () => ({
    organizationId: 'org_1',
    seatLimit: 10,
    activeSeats: 1,
    enabledModules: ['api'],
    modules: [],
    limits: {},
  })),
}));
vi.mock('@/lib/approval-authenticator-gate', () => ({
  approvalAuthenticatorGate: vi.fn(async () => ({ approver: false, setupRequired: false })),
}));
vi.mock('@/lib/tenancy/scoped-db', () => {
  const tenantDb = { apiToken: { update: vi.fn(async () => ({})), delete: vi.fn() } };
  return {
    createTenantDb: vi.fn(),
    withPlatformDb: (run: (db: unknown) => unknown) =>
      run({ apiToken: { findMany: mocks.findMany } }),
    withTenantDb: (_organizationId: string, run: (db: unknown) => unknown) => run(tenantDb),
  };
});

import { GET } from './route';

const request = () =>
  new Request('https://acme.example.com/api/v1/spec', {
    headers: { Authorization: 'Bearer df_test_fixture_token' },
  });

type Gate = { ok: boolean; retryAfter: number; remaining: number };
const open: Gate = { ok: true, retryAfter: 0, remaining: 1 };
const shut: Gate = { ok: false, retryAfter: 42, remaining: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockResolvedValue(open);
  mocks.compare.mockResolvedValue(true);
  mocks.findMany.mockResolvedValue([
    {
      id: 'token_1',
      organizationId: 'org_1',
      userId: 'user_1',
      tokenHash: 'hash',
      // A narrow token: the reference needs no particular scope.
      scopes: ['meetings:read'],
      expiresAt: null,
      user: {
        id: 'user_1',
        role: 'EMPLOYEE',
        status: 'ACTIVE',
        organization: { id: 'org_1', status: 'ACTIVE' },
      },
    },
  ]);
});

describe('DEV-1055: GET /api/v1/spec uses the shared API limits', () => {
  it('serves the reference to any valid token and counts it against both limits', async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.text()).resolves.toContain('https://acme.example.com/api/v1');
    expect(mocks.rateLimit.mock.calls).toEqual([
      ['api:ip:203.0.113.9', 120, 60_000],
      ['api:token:token_1', 240, 60_000],
    ]);
    expect(mocks.recordRestAudit).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'spec:read', status: 200 })
    );
  });

  it('refuses a flooding address before any token lookup or bcrypt compare', async () => {
    mocks.rateLimit.mockResolvedValue(shut);

    const response = await GET(request());

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.compare).not.toHaveBeenCalled();
    expect(mocks.recordRestAudit).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'spec:read', status: 429, ctx: null })
    );
  });

  it('refuses a token that has used up its own limit', async () => {
    mocks.rateLimit.mockImplementation(async (key: string) =>
      key.startsWith('api:token:') ? shut : open
    );

    const response = await GET(request());

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    await expect(response.json()).resolves.toEqual({ error: 'Too many requests' });
  });

  it('still answers 401 to an invalid token, after the address limit', async () => {
    mocks.compare.mockResolvedValue(false);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.rateLimit).toHaveBeenCalledWith('api:ip:203.0.113.9', 120, 60_000);
    expect(mocks.recordRestAudit).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'spec:read', status: 401, ctx: null })
    );
  });
});
