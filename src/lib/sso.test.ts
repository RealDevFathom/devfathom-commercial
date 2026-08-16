/**
 * D20 — SSO just-in-time provisioning must MATCH an existing member whose stored
 * address differs only by case, never silently create a second account for the
 * same person in the same organization.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  entitlements: vi.fn(async () => ({ activeSeats: 1, seatLimit: 50 })),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/secret-crypto', () => ({ decryptSecret: vi.fn() }));
vi.mock('@/lib/http-origin', () => ({ publicRequestOrigin: vi.fn() }));
vi.mock('@/lib/tenancy/host', () => ({ requireOrganizationForRequest: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: mocks.entitlements,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: vi.fn(
    async (_organizationId: string, run: (db: unknown) => Promise<unknown>) =>
      await run({
        user: { findFirst: mocks.findFirst, create: mocks.create, update: mocks.update },
      })
  ),
}));

import { provisionIdentityUser, type ActiveIdentityConnection } from './sso';

const connection = {
  id: 'conn_1',
  organizationId: 'org_devfathom',
  allowJit: true,
  domains: [],
  configuration: {},
  roleMappings: {},
  organization: { id: 'org_devfathom', slug: 'devfathom', status: 'ACTIVE' },
} as unknown as ActiveIdentityConnection;

describe('provisionIdentityUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.entitlements.mockResolvedValue({ activeSeats: 1, seatLimit: 50 });
  });

  it('matches the existing member when the IdP asserts a different casing', async () => {
    const existing = { id: 'user_1', email: 'alex@company.com', status: 'ACTIVE' };
    mocks.findFirst.mockResolvedValue(existing);

    const user = await provisionIdentityUser(connection, { email: 'ALEX@COMPANY.COM' });

    expect(user).toBe(existing);
    // The lookup used the canonical form...
    expect(mocks.findFirst).toHaveBeenCalledWith({ where: { email: 'alex@company.com' } });
    // ...and nothing was provisioned.
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([['  Alex@Company.com  '], ['ALEX@COMPANY.COM'], ['alex@COMPANY.com']])(
    'normalizes the asserted claim %j before looking up',
    async (asserted) => {
      mocks.findFirst.mockResolvedValue({ id: 'user_1', status: 'ACTIVE' });

      await provisionIdentityUser(connection, { email: asserted });

      expect(mocks.findFirst).toHaveBeenCalledWith({ where: { email: 'alex@company.com' } });
    }
  );

  it('stores the canonical form when it does provision', async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.create.mockResolvedValue({ id: 'user_2' });

    await provisionIdentityUser(connection, { email: 'New.Person@Company.COM', name: 'New' });

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'new.person@company.com' }),
      })
    );
  });

  it('refuses to create a duplicate rather than letting the unique index surface', async () => {
    // First lookup (the match check) misses; the pre-create guard then finds a
    // row — the concurrent-provision case.
    mocks.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'user_1' });

    await expect(
      provisionIdentityUser(connection, { email: 'alex@company.com', name: 'Alex' })
    ).rejects.toThrow('An account with this email already exists in this organization.');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('still refuses an inactive matching account', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'user_1', status: 'INACTIVE' });

    await expect(provisionIdentityUser(connection, { email: 'ALEX@COMPANY.COM' })).rejects.toThrow(
      'The matching organization account is inactive.'
    );
  });
});
