import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userFindFirst: vi.fn(),
  userCreate: vi.fn(),
  userUpdate: vi.fn(),
  userCount: vi.fn(),
  queryRaw: vi.fn(),
  branchFindMany: vi.fn(),
  assignmentCreateMany: vi.fn(),
  departmentFindFirst: vi.fn(),
  roleFindFirst: vi.fn(),
  assertSeatAvailable: vi.fn(),
  annotateAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  assertSeatAvailable: mocks.assertSeatAvailable,
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: mocks.annotateAudit,
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'hashed') }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async () => true) };
});

import type { TRPCContext } from '../trpc';
import { organizationAdminRouter } from './organization-admin';

type MemberDb = {
  user: {
    findFirst: typeof mocks.userFindFirst;
    create: typeof mocks.userCreate;
    update: typeof mocks.userUpdate;
    count: typeof mocks.userCount;
  };
  organizationDepartment: { findFirst: typeof mocks.departmentFindFirst };
  organizationRole: { findFirst: typeof mocks.roleFindFirst };
  pharmacyBranch: { findMany: typeof mocks.branchFindMany };
  pharmacyBranchAssignment: { createMany: typeof mocks.assignmentCreateMany };
  $queryRaw: typeof mocks.queryRaw;
  $transaction: (fn: (tx: MemberDb) => Promise<unknown>) => Promise<unknown>;
};

const db: MemberDb = {
  user: {
    findFirst: mocks.userFindFirst,
    create: mocks.userCreate,
    update: mocks.userUpdate,
    count: mocks.userCount,
  },
  organizationDepartment: { findFirst: mocks.departmentFindFirst },
  organizationRole: { findFirst: mocks.roleFindFirst },
  pharmacyBranch: { findMany: mocks.branchFindMany },
  pharmacyBranchAssignment: { createMany: mocks.assignmentCreateMany },
  $queryRaw: mocks.queryRaw,
  $transaction: (fn) => fn(db),
};

function caller(
  organizationId = 'org_a',
  entitlements = { activeSeats: 1, seatLimit: 10 },
  support = false
) {
  return organizationAdminRouter.createCaller({
    db,
    entitlements: { enabledModules: [], ...entitlements },
    session: {
      expires: new Date(Date.now() + 60_000).toISOString(),
      user: {
        id: 'admin_a',
        isSupportSession: support,
        organizationId,
        role: 'ADMIN',
        department: 'COUNTER',
        status: 'ACTIVE',
      },
    },
    organization: null,
    support: support
      ? { organizationId, tenantUserId: 'admin_a', expiresAt: new Date(Date.now() + 60_000) }
      : null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

const input = {
  name: 'Ayesha Cashier',
  email: 'Ayesha@Clifton.test',
  password: 'Temporary-123456',
  title: 'Cashier',
  role: 'EMPLOYEE' as const,
  department: 'COUNTER',
  organizationRoleId: null,
};

const updateInput = {
  id: 'admin_b',
  role: 'EMPLOYEE' as const,
  status: 'ACTIVE' as const,
  organizationRoleId: null,
  title: 'Cashier',
  department: 'COUNTER',
};

describe('organization member creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertSeatAvailable.mockImplementation(() => {});
    mocks.departmentFindFirst.mockResolvedValue({ id: 'dept_counter' });
    mocks.roleFindFirst.mockResolvedValue({ id: 'role_cashier' });
    mocks.userFindFirst.mockResolvedValue(null);
    mocks.userCount.mockResolvedValue(0);
    mocks.queryRaw.mockResolvedValue([{ id: 'org_a' }]);
    mocks.branchFindMany.mockResolvedValue([]);
    mocks.assignmentCreateMany.mockResolvedValue({ count: 0 });
    mocks.userCreate.mockResolvedValue({
      id: 'user_new',
      email: 'ayesha@clifton.test',
      name: 'Ayesha Cashier',
    });
  });

  it.each(['aaaaaaaaaaaa', 'AAAAAAAAAAAA', 'PasswordOnly'])(
    'rejects weak staff passwords: %s',
    async (password) => {
      await expect(caller().createMember({ ...input, password })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      await expect(caller().resetMemberPassword({ id: 'member', password })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(mocks.userCreate).not.toHaveBeenCalled();
      expect(mocks.userFindFirst).not.toHaveBeenCalled();
    }
  );

  it('creates an ACTIVE member scoped to the caller tenant with a hashed password', async () => {
    await caller('org_a').createMember(input);

    expect(mocks.userCreate).toHaveBeenCalledTimes(1);
    const data = mocks.userCreate.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      organizationId: 'org_a',
      email: 'ayesha@clifton.test',
      password: 'hashed',
      passwordChangedAt: null,
      mustChangePassword: true,
      role: 'EMPLOYEE',
      department: 'COUNTER',
      status: 'ACTIVE',
    });
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.userCreate.mock.invocationCallOrder[0]!
    );
    expect(mocks.userCount).toHaveBeenCalledWith({
      where: { organizationId: 'org_a', status: { in: ['ACTIVE', 'ON_LEAVE', 'INVITED'] } },
    });
    // The duplicate check is scoped to the caller tenant, never global.
    expect(mocks.userFindFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org_a', email: 'ayesha@clifton.test' },
      select: { id: true },
    });
  });

  it('refuses before writing anything when the seat limit is reached', async () => {
    mocks.userCount.mockResolvedValue(10);

    await expect(
      caller('org_a', { activeSeats: 10, seatLimit: 10 }).createMember(input)
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Seat limit reached (10/10).',
    });
    expect(mocks.queryRaw).toHaveBeenCalled();
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it('rejects a department that is not active in the caller tenant', async () => {
    mocks.departmentFindFirst.mockResolvedValue(null);

    await expect(caller('org_a').createMember(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.departmentFindFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org_a', key: 'COUNTER', active: true },
      select: { id: true },
    });
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it('rejects a custom role that belongs to another tenant', async () => {
    mocks.roleFindFirst.mockResolvedValue(null);

    await expect(
      caller('org_a').createMember({ ...input, organizationRoleId: 'role_from_org_b' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it('fails closed on a duplicate email within the tenant', async () => {
    mocks.userFindFirst.mockResolvedValue({ id: 'existing' });

    await expect(caller('org_a').createMember(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it('maps a concurrent duplicate email to CONFLICT', async () => {
    mocks.userCreate.mockRejectedValue({ code: 'P2002' });

    await expect(caller('org_a').createMember(input)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'A member with this email already exists in this workspace.',
    });
  });

  it('assigns the new member to the chosen active pharmacy branches', async () => {
    mocks.branchFindMany.mockResolvedValue([{ id: 'branch_clifton' }, { id: 'branch_dha' }]);

    await caller('org_a').createMember({
      ...input,
      branchIds: ['branch_clifton', 'branch_dha', 'branch_clifton'],
    });

    expect(mocks.branchFindMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_a',
        id: { in: ['branch_clifton', 'branch_dha'] },
        active: true,
      },
      select: { id: true },
    });
    expect(mocks.assignmentCreateMany).toHaveBeenCalledWith({
      data: [
        { organizationId: 'org_a', branchId: 'branch_clifton', userId: 'user_new', active: true },
        { organizationId: 'org_a', branchId: 'branch_dha', userId: 'user_new', active: true },
      ],
    });
  });

  it('refuses an inactive or unknown branch before creating the member', async () => {
    mocks.branchFindMany.mockResolvedValue([{ id: 'branch_clifton' }]);

    await expect(
      caller('org_a').createMember({ ...input, branchIds: ['branch_clifton', 'branch_missing'] })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Choose an active pharmacy branch.' });
    expect(mocks.userCreate).not.toHaveBeenCalled();
    expect(mocks.assignmentCreateMany).not.toHaveBeenCalled();
  });
});

describe('organization member last-admin guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.departmentFindFirst.mockResolvedValue({ id: 'dept_counter' });
    mocks.userFindFirst.mockResolvedValue({
      id: 'admin_b',
      email: 'admin@example.test',
      role: 'ADMIN',
      status: 'ACTIVE',
    });
    mocks.userCount.mockResolvedValue(1);
    mocks.queryRaw.mockResolvedValue([{ id: 'org_a' }]);
    mocks.userUpdate.mockResolvedValue({ id: 'admin_b', email: 'admin@example.test' });
  });

  it('refuses to demote the last active admin under the organization row lock', async () => {
    await expect(caller().updateMember(updateInput)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Cannot demote or deactivate the last active admin.',
    });

    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.userCount).toHaveBeenCalledWith({
      where: { organizationId: 'org_a', role: 'ADMIN', status: 'ACTIVE' },
    });
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.userCount.mock.invocationCallOrder[0]!
    );
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it('refuses to deactivate the last active admin', async () => {
    await expect(
      caller().updateMember({ ...updateInput, role: 'ADMIN', status: 'INACTIVE' })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Cannot demote or deactivate the last active admin.',
    });

    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it('serializes concurrent two-admin demotions so one active admin remains', async () => {
    let activeAdmins = 2;
    let transactionTail = Promise.resolve();
    const concurrentDb = {
      ...db,
      user: {
        ...db.user,
        count: vi.fn(async () => activeAdmins),
        update: vi.fn(async ({ data }: { data: { role: string; status: string } }) => {
          if (data.role !== 'ADMIN' || data.status !== 'ACTIVE') activeAdmins -= 1;
          return { id: 'updated', email: 'admin@example.test' };
        }),
      },
      $transaction: async (fn: (tx: MemberDb) => Promise<unknown>) => {
        const prior = transactionTail;
        let release!: () => void;
        transactionTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await prior;
        try {
          return await fn(concurrentDb as MemberDb);
        } finally {
          release();
        }
      },
    };
    const concurrentCaller = (memberId: string) =>
      organizationAdminRouter
        .createCaller({
          db: concurrentDb,
          entitlements: { enabledModules: [], activeSeats: 2, seatLimit: 10 },
          session: {
            expires: new Date(Date.now() + 60_000).toISOString(),
            user: {
              id: 'admin_a',
              organizationId: 'org_a',
              role: 'ADMIN',
              department: 'COUNTER',
              status: 'ACTIVE',
            },
          },
          organization: null,
          support: null,
          requestMeta: { ip: null, userAgent: null },
          audit: { detail: {} },
        } as unknown as TRPCContext)
        .updateMember({ ...updateInput, id: memberId });

    const results = await Promise.allSettled([
      concurrentCaller('admin_b'),
      concurrentCaller('admin_c'),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(activeAdmins).toBe(1);
  });
});

describe('support cannot establish durable administrator access', () => {
  beforeEach(() => vi.clearAllMocks());
  it('blocks creating an administrator with a known password', async () => {
    await expect(
      caller('org_a', undefined, true).createMember({ ...input, role: 'ADMIN' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.userCreate).not.toHaveBeenCalled();
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
  it('blocks elevating another member', async () => {
    await expect(
      caller('org_a', undefined, true).updateMember({ ...updateInput, role: 'ADMIN' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
  it('blocks resetting an administrator password', async () => {
    await expect(
      caller('org_a', undefined, true).resetMemberPassword({
        id: 'admin_b',
        password: input.password,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});

describe('support impersonation member boundary', () => {
  it('cannot create members or elevate existing members through a direct server caller', async () => {
    const support = caller('org_a', { activeSeats: 1, seatLimit: 10 }, true);
    await expect(support.createMember(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Support access is read-only.',
    });
    await expect(
      support.updateMember({
        id: 'employee',
        role: 'ADMIN',
        status: 'ACTIVE',
        organizationRoleId: null,
        title: 'Admin',
        department: 'COUNTER',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.userCreate).not.toHaveBeenCalled();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});
