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
  // WHA-290: JIT provisioning resolves the department from the tenant's own
  // catalog, so the fake tenant client has to answer for both.
  organizationFindUnique: vi.fn(async () => ({ vertical: 'AGENCY' })),
  departmentFindMany: vi.fn(async () => [{ key: 'LEADERSHIP' }, { key: 'ENGINEERING' }]),
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
  withTenantDb: vi.fn(async (_organizationId: string, run: (db: unknown) => Promise<unknown>) => {
    const tenantDb: Record<string, unknown> = {
      user: {
        findFirst: mocks.findFirst,
        create: mocks.create,
        update: mocks.update,
        // Seat lock reads the occupied-seat count under `FOR UPDATE`.
        count: vi.fn(async () => 0),
      },
      organization: { findUnique: mocks.organizationFindUnique },
      organizationDepartment: { findMany: mocks.departmentFindMany },
      $queryRaw: vi.fn(async () => []),
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tenantDb),
    };
    return run(tenantDb);
  }),
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
    // `clearAllMocks` clears calls, not implementations, so the catalog fakes
    // are restored to the agency default for every case.
    mocks.organizationFindUnique.mockResolvedValue({ vertical: 'AGENCY' });
    mocks.departmentFindMany.mockResolvedValue([{ key: 'LEADERSHIP' }, { key: 'ENGINEERING' }]);
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

  // WHA-290 — `User.department` is a composite foreign key onto
  // `organization_departments`. A hardcoded agency-era key raised
  // `users_organizationId_department_fkey` in any tenant that does not have it,
  // so JIT provisioning has to derive the key from the tenant's own catalog.
  //
  // The per-vertical cases live in `department-provisioning.db.test.ts`, where
  // they are proved against the real constraint; this file keeps to what is
  // observable at the SSO call site and stays free of vertical literals (the
  // §16 scattered-conditional audit).
  describe('tenant department catalog', () => {
    it('keeps the agency default when the tenant still has it', async () => {
      mocks.findFirst.mockResolvedValue(null);
      mocks.create.mockResolvedValue({ id: 'user_3' });

      await provisionIdentityUser(connection, { email: 'new@company.com', name: 'New' });

      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ department: 'ENGINEERING' }),
        })
      );
    });

    it('falls back to an active department when the tenant removed the default', async () => {
      mocks.findFirst.mockResolvedValue(null);
      mocks.create.mockResolvedValue({ id: 'user_4' });
      mocks.departmentFindMany.mockResolvedValue([{ key: 'OPERATIONS' }, { key: 'DESIGN' }]);

      await provisionIdentityUser(connection, { email: 'new@company.com', name: 'New' });

      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ department: 'OPERATIONS' }),
        })
      );
    });

    it('states why it cannot provision when the tenant deactivated every department', async () => {
      mocks.findFirst.mockResolvedValue(null);
      mocks.departmentFindMany.mockResolvedValue([]);

      await expect(
        provisionIdentityUser(connection, { email: 'new@company.com', name: 'New' })
      ).rejects.toThrow('no active department');
      expect(mocks.create).not.toHaveBeenCalled();
    });
  });
});
