import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
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

import { can } from '@/lib/abac';
import type { TRPCContext } from '../trpc';
import { organizationAdminRouter } from './organization-admin';

type MemberDb = {
  user: {
    findFirst: typeof mocks.userFindFirst;
    findUnique: typeof mocks.userFindUnique;
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
    findUnique: mocks.userFindUnique,
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

function caller(organizationId = 'org_a', entitlements = { activeSeats: 1, seatLimit: 10 }) {
  return organizationAdminRouter.createCaller({
    db,
    entitlements: { enabledModules: [], ...entitlements },
    session: {
      expires: 'later',
      user: {
        id: 'admin_a',
        organizationId,
        role: 'ADMIN',
        department: 'COUNTER',
        status: 'ACTIVE',
      },
    },
    organization: null,
    support: null,
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

  it('refuses a sole admin who attempts to demote themselves', async () => {
    mocks.userFindFirst.mockResolvedValue({
      id: 'admin_a',
      email: 'admin@example.test',
      role: 'ADMIN',
      status: 'ACTIVE',
    });

    await expect(caller().updateMember({ ...updateInput, id: 'admin_a' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Cannot demote or deactivate the last active admin.',
    });

    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it('allows an admin demotion when another active admin remains', async () => {
    mocks.userCount.mockResolvedValue(2);

    await expect(caller().updateMember(updateInput)).resolves.toMatchObject({ id: 'admin_b' });

    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.userUpdate).toHaveBeenCalledOnce();
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
            expires: 'later',
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

/** DEV-828: an access change must not hand the operator the member's authentication secrets. */
describe('organization member update response (DEV-828)', () => {
  const SECRET_FIELDS = [
    'password',
    'twoFactorSecret',
    'twoFactorEnabledAt',
    'recoveryCodes',
    'tokenVersion',
    'mustChangePassword',
  ];
  const ownerRow = {
    id: 'owner_b',
    name: 'Workspace Owner',
    email: 'owner@example.test',
    role: 'EMPLOYEE',
    status: 'ACTIVE',
    title: 'Cashier',
    department: 'COUNTER',
    organizationRoleId: null,
    password: '$2a$12$abcdefghijklmnopqrstuuJ0Ow0bS1TzE3s1Ga3H9F6K1Y0a1b2c3',
    twoFactorSecret: 'JBSWY3DPEHPK3PXP',
    twoFactorEnabledAt: new Date('2026-11-01T00:00:00Z'),
    recoveryCodes: [{ id: 'rc_1', codeHash: 'recovery-code-hash-0001' }],
    tokenVersion: 7,
    mustChangePassword: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(can).mockResolvedValue(true);
    mocks.departmentFindFirst.mockResolvedValue({ id: 'dept_counter' });
    mocks.userFindFirst.mockResolvedValue({
      id: 'owner_b',
      email: 'owner@example.test',
      role: 'EMPLOYEE',
      status: 'ACTIVE',
    });
    // The mock ignores `select`, so this is what leaks if the router passes the row through.
    mocks.userUpdate.mockResolvedValue(ownerRow);
  });

  it('returns only id and email for an MFA-enabled member', async () => {
    const result = await caller().updateMember({ ...updateInput, id: 'owner_b' });

    expect(result).toEqual({ id: 'owner_b', email: 'owner@example.test' });
    const serialized = JSON.stringify(result);
    for (const field of SECRET_FIELDS) expect(serialized).not.toContain(`"${field}"`);
    expect(serialized).not.toContain(ownerRow.twoFactorSecret);
    expect(serialized).not.toContain(ownerRow.password);
    expect(serialized).not.toContain(ownerRow.recoveryCodes[0]!.codeHash);
  });

  it('selects only the response fields from the database', async () => {
    await caller().updateMember({ ...updateInput, id: 'owner_b' });

    expect(mocks.userUpdate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: { id: 'owner_b' },
        select: { id: true, email: true },
      })
    );
  });

  it('refuses a caller without admin access and changes nothing', async () => {
    vi.mocked(can).mockResolvedValue(false);

    await expect(caller().updateMember({ ...updateInput, id: 'owner_b' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });
});

describe('organizationAdmin.resetMemberPassword hierarchy guard', () => {
  const reset = { id: 'member', password: 'Temporary-123456' };
  const live = { status: 'ACTIVE', organizationRole: null, permissionOverrides: [] };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(can).mockResolvedValue(true);
    mocks.userFindFirst.mockResolvedValue({ id: 'member', email: 'm@clifton.test' });
  });

  it.each([
    ['another admin', { ...live, role: 'ADMIN' }],
    [
      'the owner',
      {
        ...live,
        role: 'ADMIN',
        organizationRole: { key: 'owner', isSystem: true, permissions: [] },
      },
    ],
  ])('refuses to reset %s', async (_label, target) => {
    mocks.userFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'admin_a' ? { ...live, role: 'ADMIN' } : target
    );
    await expect(caller().resetMemberPassword(reset)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it('lets an admin reset an employee', async () => {
    mocks.userFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      ...live,
      role: where.id === 'admin_a' ? 'ADMIN' : 'EMPLOYEE',
    }));
    await expect(caller().resetMemberPassword(reset)).resolves.toEqual({ success: true });
    expect(mocks.userUpdate).toHaveBeenCalledOnce();
  });
});
