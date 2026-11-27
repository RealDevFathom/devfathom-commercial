/**
 * DEV-1004: a SCIM change the pharmacy access guard refuses rolls its transaction back, then the
 * FAILED event is written in a transaction of its own. The refusal is the answer either way:
 * a failure to write that record never turns the 403 into a server error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withPlatformDb: vi.fn(),
  withTenantDb: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: mocks.withPlatformDb,
  withTenantDb: mocks.withTenantDb,
}));
vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: vi.fn(async () => ({})),
  hasModule: () => true,
}));

import { AccessChangeError } from '@/lib/team/pharmacy-access-guard';
import { withScimAuth } from './scim';

const TOKEN = `scim_${'a'.repeat(48)}`;
const request = () =>
  new Request('https://test.invalid/api/scim/v2/Users/user_1', {
    method: 'PATCH',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
const refusal = new AccessChangeError({
  code: 'FORBIDDEN',
  message: 'Only the owner can make someone an owner or an administrator, on the team screen.',
});

describe('withScimAuth: a refused access change', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withPlatformDb.mockImplementation(async (run: (db: unknown) => unknown) =>
      run({
        organizationScimToken: {
          findUnique: async () => ({
            id: 'token_1',
            organizationId: 'org_1',
            expiresAt: null,
            revokedAt: null,
            organization: { status: 'ACTIVE' },
          }),
        },
      })
    );
  });

  it('records the FAILED event in a transaction of its own and answers 403', async () => {
    const create = vi.fn(async () => ({}));
    mocks.withTenantDb
      .mockImplementationOnce(async () => {
        throw refusal;
      })
      .mockImplementationOnce(async (_org: string, run: (db: unknown) => unknown) =>
        run({ organizationScimEvent: { create } })
      );
    const response = await withScimAuth(request(), async () => new Response(null));
    expect(response.status).toBe(403);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org_1',
        operation: 'PATCH',
        resourceType: 'User',
        status: 'FAILED',
        error: refusal.message,
        payload: { userId: 'user_1' },
      }),
    });
  });

  it('still answers 403 when the FAILED event cannot be written', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.withTenantDb
      .mockImplementationOnce(async () => {
        throw refusal;
      })
      .mockImplementationOnce(async () => {
        throw new Error('connection lost');
      });
    const response = await withScimAuth(request(), async () => new Response(null));
    expect(response.status).toBe(403);
    expect(((await response.json()) as { detail: string }).detail).toBe(refusal.message);
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });
});
