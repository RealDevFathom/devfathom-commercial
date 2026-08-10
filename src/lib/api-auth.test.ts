import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  compare: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  deleteToken: vi.fn(),
  createTenantDb: vi.fn(),
  resolveEntitlements: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ compare: mocks.compare, hash: vi.fn() }));
vi.mock('@/server/audit', () => ({ recordRestAudit: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  clientIp: vi.fn(() => '127.0.0.1'),
  rateLimit: vi.fn(() => ({ ok: true })),
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: (entitlements: { enabledModules: string[] }, key: string) =>
    entitlements.enabledModules.includes(key),
  resolveOrganizationEntitlements: mocks.resolveEntitlements,
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

import { authenticateApiRequest } from './api-auth';

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
