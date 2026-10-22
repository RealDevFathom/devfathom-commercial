import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', async (original) => ({
  ...(await original<typeof import('@/server/audit')>()),
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/abac', () => ({
  can: vi.fn(async () => true),
  subjectFromSession: (user: unknown) => user,
}));
vi.mock('bcryptjs', () => ({ compare: vi.fn(async (value: string) => value === 'correct') }));
vi.mock('@/lib/pharmacy/settlement', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/settlement')>()),
  refundPharmacyTender: vi.fn(),
  applyPharmacyTender: vi.fn(),
  readPharmacyTenderOutcome: vi.fn(),
}));
import {
  applyPharmacyTender,
  readPharmacyTenderOutcome,
  refundPharmacyTender,
} from '@/lib/pharmacy/settlement';
import { can, subjectFromSession } from '@/lib/abac';
import * as abac from '@/lib/abac';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';
const canSpy = vi.spyOn(abac, 'can');
const app = router({ pharmacySales: pharmacySalesRouter });
const input = {
  branchId: 'branch-a',
  saleId: 'sale-a',
  deviceId: 'device-a',
  businessDate: new Date('2026-10-02'),
  type: 'KHATA' as const,
  amountMinor: 100,
  idempotencyKey: 'key-a',
  familyAccountId: 'family-a',
};
type Permission = { capability: string; effect: 'ALLOW' | 'DENY' };

function fixture(
  permissions: Permission[] = [{ capability: 'pharmacy:counter', effect: 'ALLOW' }],
  role: 'ADMIN' | 'EMPLOYEE' = 'ADMIN',
  overrides: Permission[] = []
) {
  const member = {
    status: 'ACTIVE',
    organizationId: 'org-a',
    organizationRole: {
      permissions: [...permissions] as { capability: string; effect: string }[],
    },
    permissionOverrides: [...overrides] as { capability: string; effect: string }[],
  };
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(),
    user: { findUnique: vi.fn(async () => member) },
    pharmacyBranchAssignment: {
      findMany: vi.fn(async () => [{ branchId: 'branch-a' }]),
    },
    pharmacyBranch: {
      findFirst: vi.fn().mockResolvedValue({ id: 'branch-a' }),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
    },
    pharmacyTender: { findFirst: vi.fn().mockResolvedValue({ type: 'CREDIT' }) },
    user: { findUnique: vi.fn().mockResolvedValue({
      password: 'hash', status: 'ACTIVE', twoFactorEnabledAt: null, twoFactorSecret: null,
    }) },
    pharmacySale: { findFirst: vi.fn().mockResolvedValue({ customerId: 'customer-a', createdByUserId: 'cashier-a' }) },
    pharmacyFamilyAccount: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'family-a',
          displayName: 'Family',
          creditLimitMinor: 100,
          members: [{ id: 'member-a' }],
        },
      ]),
      update: vi.fn().mockResolvedValue({}),
    },
    pharmacyKhataEvent: {
      findFirst: vi.fn(),
      groupBy: vi.fn().mockResolvedValue([]),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
    },
    pharmacyKhataLimitDecision: { create: vi.fn().mockResolvedValue({}) },
    user: {
      findFirst: vi.fn().mockResolvedValue({ organizationRole: { key: 'owner' } }),
    },
  };
  db.$transaction.mockImplementation(async (callback) => callback(db));
  const user = {
    id: 'owner-a',
    role,
    status: 'ACTIVE',
    organizationId: 'org-a',
    passwordAuthenticatedAt: Date.now(),
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: { expires: 'later', user },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  };
  return {
    db,
    member,
    user,
    context,
    caller: () => app.createCaller(context as unknown as TRPCContext).pharmacySales,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readPharmacyTenderOutcome).mockResolvedValue({
    status: 'NOT_FOUND',
    replayUnsafe: true,
  });
  vi.mocked(applyPharmacyTender).mockResolvedValue({
    tenderId: 'tender-a',
    settled: false,
    receiptNumber: null,
    remainingMinor: 100,
    replayed: false,
  });
  vi.mocked(refundPharmacyTender).mockResolvedValue({
    refundId: 'refund-a',
    originalTenderId: 'tender-a',
    amountMinor: 50,
    replayed: false,
  });
});

describe('Khata read and write permissions (#831)', () => {
  const finance: Permission[] = [{ capability: 'reports:financial', effect: 'ALLOW' }];
  const refund = {
    branchId: 'branch-a',
    originalTenderId: 'tender-a',
    deviceId: 'device-a',
    businessDate: input.businessDate,
    amountMinor: 50,
    reason: 'Return',
    idempotencyKey: 'refund-a',
  };

  it('allows reports-only account, statement and tender-outcome reads without posting', async () => {
    const f = fixture(finance, 'EMPLOYEE');
    const account = {
      id: 'family-a',
      displayName: 'Family',
      creditLimitMinor: 100,
      memberId: 'member-a',
      balanceMinor: 0,
    };
    await expect(
      f.caller().khataAccounts({ branchId: 'branch-a', saleId: 'sale-a' })
    ).resolves.toEqual([account]);
    await expect(
      f.caller().khataStatement({
        branchId: 'branch-a',
        saleId: 'sale-a',
        familyAccountId: 'family-a',
      })
    ).resolves.toEqual({ account, generatedAt: expect.any(Date), truncated: false, entries: [] });
    await expect(f.caller().tenderOutcome(input)).resolves.toEqual({
      status: 'NOT_FOUND',
      replayUnsafe: true,
    });
    expect(applyPharmacyTender).not.toHaveBeenCalled();
    expect(refundPharmacyTender).not.toHaveBeenCalled();
    expect(f.db.pharmacyKhataEvent.create).not.toHaveBeenCalled();
    expect(f.db.pharmacyKhataLimitDecision.create).not.toHaveBeenCalled();
  });

  it.each(['KHATA', 'CREDIT'] as const)(
    'denies reports-only %s charges before writing',
    async (type) => {
      const f = fixture(finance, 'EMPLOYEE');
      await expect(f.caller().tender({ ...input, type })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Pharmacy counter permission required.',
      });
      expect(f.db.$transaction).not.toHaveBeenCalled();
      expect(applyPharmacyTender).not.toHaveBeenCalled();
      expect(f.db.pharmacyKhataEvent.create).not.toHaveBeenCalled();
      expect(f.db.pharmacyKhataLimitDecision.create).not.toHaveBeenCalled();
    }
  );

  it('denies a reports-only credit refund before opening a transaction', async () => {
    const f = fixture(finance, 'EMPLOYEE');
    f.db.pharmacyBranchAssignment.findMany.mockResolvedValue([{ branchId: 'branch-a' }]);
    await expect(f.caller().refundTender(refund)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(refundPharmacyTender).not.toHaveBeenCalled();
    expect(f.db.pharmacyKhataEvent.create).not.toHaveBeenCalled();
  });

  it.each(['pharmacy:receipt', 'pharmacy:dispense'])(
    'does not let finance plus %s authorize a credit refund',
    async (capability) => {
      const f = fixture([...finance, { capability, effect: 'ALLOW' }], 'EMPLOYEE');
      f.db.pharmacyBranchAssignment.findMany.mockResolvedValue([{ branchId: 'branch-a' }]);
      await expect(f.caller().refundTender(refund)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Pharmacy counter permission required.',
      });
      expect(f.db.pharmacyTender.findFirst).toHaveBeenCalled();
      expect(refundPharmacyTender).not.toHaveBeenCalled();
      expect(f.db.pharmacyKhataEvent.create).not.toHaveBeenCalled();
    }
  );

  it.each(['*', 'pharmacy:*', 'pharmacy:counter'])(
    'preserves owner %s access to charges and credit refunds',
    async (capability) => {
      const f = fixture([{ capability, effect: 'ALLOW' }]);
      await expect(f.caller().tender(input)).resolves.toMatchObject({ tenderId: 'tender-a' });
      expect(applyPharmacyTender).toHaveBeenCalledExactlyOnceWith(
        f.db,
        { organizationId: 'org-a', branchId: 'branch-a', actorId: 'owner-a' },
        { ...input, type: 'CREDIT' }
      );
      expect(f.db.pharmacyKhataEvent.create).toHaveBeenCalledExactlyOnceWith({
        data: expect.objectContaining({ kind: 'CHARGE', amountMinor: 100 }),
      });

      vi.mocked(refundPharmacyTender).mockResolvedValue({
        refundId: 'refund-a',
        originalTenderId: 'tender-a',
        amountMinor: 50,
        replayed: false,
      });
      f.db.pharmacyKhataEvent.findFirst.mockResolvedValueOnce({
        id: 'khata:tender-a',
        familyAccountId: 'family-a',
      });
      await expect(f.caller().refundTender(refund)).resolves.toMatchObject({
        refundId: 'refund-a',
      });
      expect(refundPharmacyTender).toHaveBeenCalledExactlyOnceWith(
        f.db,
        { organizationId: 'org-a', branchId: 'branch-a', actorId: 'owner-a' },
        refund
      );
      expect(f.db.pharmacyKhataEvent.create).toHaveBeenLastCalledWith({
        data: expect.objectContaining({ kind: 'PAYMENT', amountMinor: 50 }),
      });
    }
  );

  it.each(['*', 'pharmacy:*', 'pharmacy:counter'])(
    'lets a counter DENY override owner %s and financial access for writes',
    async (capability) => {
      const f = fixture([...finance, { capability, effect: 'ALLOW' }], 'ADMIN', [
        { capability: 'pharmacy:counter', effect: 'DENY' },
      ]);
      await expect(f.caller().tender(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(f.caller().refundTender(refund)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.$transaction).not.toHaveBeenCalled();
      expect(applyPharmacyTender).not.toHaveBeenCalled();
      expect(refundPharmacyTender).not.toHaveBeenCalled();
      expect(f.db.pharmacyKhataEvent.create).not.toHaveBeenCalled();
    }
  );

  it('lets a role counter DENY beat a user counter ALLOW and financial access', async () => {
    const f = fixture(
      [...finance, { capability: 'pharmacy:counter', effect: 'DENY' }],
      'EMPLOYEE',
      [{ capability: 'pharmacy:counter', effect: 'ALLOW' }]
    );
    await expect(f.caller().tender(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(applyPharmacyTender).not.toHaveBeenCalled();
    expect(f.db.pharmacyKhataEvent.create).not.toHaveBeenCalled();
  });
});

type Caller = ReturnType<ReturnType<typeof fixture>['caller']>;
const khataPaths: { name: string; run: (caller: Caller, branchId: string) => Promise<unknown> }[] =
  [
    {
      name: 'accounts',
      run: (c, branchId) => c.khataAccounts({ branchId, saleId: input.saleId }),
    },
    {
      name: 'statement',
      run: (c, branchId) =>
        c.khataStatement({
          branchId,
          saleId: input.saleId,
          familyAccountId: input.familyAccountId,
        }),
    },
    { name: 'Khata charge', run: (c, branchId) => c.tender({ ...input, branchId }) },
    {
      name: 'credit charge',
      run: (c, branchId) => c.tender({ ...input, branchId, type: 'CREDIT' }),
    },
    { name: 'Khata outcome', run: (c, branchId) => c.tenderOutcome({ ...input, branchId }) },
    {
      name: 'credit outcome',
      run: (c, branchId) => c.tenderOutcome({ ...input, branchId, type: 'CREDIT' }),
    },
    {
      name: 'legacy credit outcome without a family account',
      run: (c, branchId) =>
        c.tenderOutcome({ ...input, branchId, type: 'CREDIT', familyAccountId: undefined }),
    },
    {
      name: 'credit refund',
      run: (c, branchId) =>
        c.refundTender({
          branchId,
          originalTenderId: 'tender-a',
          deviceId: input.deviceId,
          businessDate: input.businessDate,
          amountMinor: 50,
          reason: 'Return',
          idempotencyKey: 'refund-a',
        }),
    },
  ];

describe.each(khataPaths)('Khata $name authorization', ({ run }) => {
  it('allows the assigned branch with real counter permissions and no dispense grant', async () => {
    const f = fixture();
    f.user.role = 'EMPLOYEE';
    await expect(run(f.caller(), 'branch-a')).resolves.toBeDefined();
  });

  it.each(['user', 'role'])(
    'keeps a %s clinical DENY separate from counter access',
    async (source) => {
      const f = fixture();
      f.user.role = 'EMPLOYEE';
      const denial = { capability: 'pharmacy:dispense', effect: 'DENY' };
      if (source === 'user') f.member.permissionOverrides = [denial];
      else f.member.organizationRole.permissions.push(denial);

      await expect(run(f.caller(), 'branch-a')).resolves.toBeDefined();
    }
  );

  it.each(['branch-b', 'unassigned'])(
    'denies a cashier assigned to %s before Khata data or money operations',
    async (assignment) => {
      const f = fixture();
      f.user.role = 'EMPLOYEE';
      f.db.pharmacyBranchAssignment.findMany.mockResolvedValue(
        assignment === 'unassigned' ? [] : [{ branchId: assignment }]
      );
      // Both branches are active in org-a; only branch assignment differs.
      await expect(run(f.caller(), 'branch-a')).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Branch is outside your scope.',
      });
      expect(f.db.pharmacySale.findFirst).not.toHaveBeenCalled();
      expect(f.db.pharmacyFamilyAccount.findMany).not.toHaveBeenCalled();
      expect(f.db.pharmacyKhataEvent.findFirst).not.toHaveBeenCalled();
      expect(f.db.pharmacyKhataEvent.findMany).not.toHaveBeenCalled();
      expect(f.db.pharmacyKhataEvent.create).not.toHaveBeenCalled();
      expect(f.db.$queryRaw).not.toHaveBeenCalled();
      expect(readPharmacyTenderOutcome).not.toHaveBeenCalled();
      expect(applyPharmacyTender).not.toHaveBeenCalled();
      expect(refundPharmacyTender).not.toHaveBeenCalled();
    }
  );

  it.each(['user', 'role'])('honors a %s DENY despite another counter ALLOW', async (source) => {
    const f = fixture();
    f.user.role = 'EMPLOYEE';
    if (source === 'user') {
      f.member.permissionOverrides = [{ capability: 'pharmacy:counter', effect: 'DENY' }];
    } else {
      f.member.organizationRole.permissions = [{ capability: 'pharmacy:counter', effect: 'DENY' }];
      f.member.permissionOverrides = [{ capability: 'pharmacy:counter', effect: 'ALLOW' }];
    }
    await expect(run(f.caller(), 'branch-a')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(applyPharmacyTender).not.toHaveBeenCalled();
    expect(refundPharmacyTender).not.toHaveBeenCalled();
  });

  it.each(['pharmacy:dispense', 'pharmacy.counter'])(
    'rejects %s without a canonical counter grant',
    async (capability) => {
      const f = fixture();
      f.user.role = 'EMPLOYEE';
      f.member.organizationRole.permissions = [{ capability, effect: 'ALLOW' }];
      await expect(run(f.caller(), 'branch-a')).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(readPharmacyTenderOutcome).not.toHaveBeenCalled();
      expect(applyPharmacyTender).not.toHaveBeenCalled();
      expect(refundPharmacyTender).not.toHaveBeenCalled();
    }
  );

  it.each(['session', 'database'])('rejects an inactive %s user', async (source) => {
    const f = fixture();
    if (source === 'session') f.user.status = 'INACTIVE';
    else f.member.status = 'INACTIVE';
    await expect(run(f.caller(), 'branch-a')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(applyPharmacyTender).not.toHaveBeenCalled();
    expect(refundPharmacyTender).not.toHaveBeenCalled();
  });

  it.each([{ assignments: [] }, { assignments: [{ branchId: 'branch-b' }] }])(
    'preserves and audits tenant-admin access with assignments $assignments',
    async ({ assignments }) => {
      const f = fixture();
      f.db.pharmacyBranchAssignment.findMany.mockResolvedValue(assignments);
      await expect(run(f.caller(), 'branch-a')).resolves.toBeDefined();
      expect(f.context.audit.detail).toMatchObject({
        targetType: 'PharmacyBranch',
        targetId: 'branch-a',
        metadata: { branchId: 'branch-a' },
      });
    }
  );
});

describe.each(
  khataPaths.filter(
    ({ name }) => name === 'accounts' || name === 'statement' || name.includes('outcome')
  )
)('Khata finance $name authorization', ({ run }) => {
  it('allows an assigned finance-only member to read', async () => {
    const f = fixture();
    f.user.role = 'EMPLOYEE';
    f.member.organizationRole.permissions = [{ capability: 'reports:financial', effect: 'ALLOW' }];
    await expect(run(f.caller(), 'branch-a')).resolves.toBeDefined();
  });

  it.each(['user', 'role'])(
    'keeps a %s clinical DENY separate from financial reads',
    async (source) => {
      const f = fixture();
      f.user.role = 'EMPLOYEE';
      f.member.organizationRole.permissions = [{ capability: 'reports:financial', effect: 'ALLOW' }];
      const denial = { capability: 'pharmacy:dispense', effect: 'DENY' };
      if (source === 'user') f.member.permissionOverrides = [denial];
      else f.member.organizationRole.permissions.push(denial);

      await expect(run(f.caller(), 'branch-a')).resolves.toBeDefined();
    }
  );

  it.each([{ assignments: [] }, { assignments: [{ branchId: 'branch-b' }] }])(
    'denies finance reads outside assignments $assignments',
    async ({ assignments }) => {
      const f = fixture();
      f.user.role = 'EMPLOYEE';
      f.member.organizationRole.permissions = [
        { capability: 'reports:financial', effect: 'ALLOW' },
      ];
      f.db.pharmacyBranchAssignment.findMany.mockResolvedValue(assignments);
      await expect(run(f.caller(), 'branch-a')).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Branch is outside your scope.',
      });
      expect(f.db.pharmacySale.findFirst).not.toHaveBeenCalled();
      expect(readPharmacyTenderOutcome).not.toHaveBeenCalled();
    }
  );

  it('denies inactive finance members before reading evidence', async () => {
    const f = fixture();
    f.member.organizationRole.permissions = [{ capability: 'reports:financial', effect: 'ALLOW' }];
    f.member.status = 'INACTIVE';
    await expect(run(f.caller(), 'branch-a')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.pharmacySale.findFirst).not.toHaveBeenCalled();
    expect(readPharmacyTenderOutcome).not.toHaveBeenCalled();
  });

  it('does not let financial access bypass an explicit counter DENY', async () => {
    const f = fixture();
    f.member.organizationRole.permissions = [{ capability: 'reports:financial', effect: 'ALLOW' }];
    f.member.permissionOverrides = [{ capability: 'pharmacy:counter', effect: 'DENY' }];
    await expect(run(f.caller(), 'branch-a')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.pharmacySale.findFirst).not.toHaveBeenCalled();
    expect(readPharmacyTenderOutcome).not.toHaveBeenCalled();
  });
});

describe('Khata router trust and recovery boundary', () => {
  it.each(['CASH', 'CARD', 'BANK_TRANSFER', 'WALLET'])(
    'preserves the receipt permission boundary for a %s refund',
    async (type) => {
      const f = fixture();
      f.user.role = 'EMPLOYEE';
      f.member.permissionOverrides = [{ capability: 'pharmacy:dispense', effect: 'DENY' }];
      f.db.pharmacyTender.findFirst.mockResolvedValue({ type });

      await expect(
        f.caller().refundTender({
          branchId: input.branchId,
          originalTenderId: 'tender-a',
          deviceId: input.deviceId,
          businessDate: input.businessDate,
          amountMinor: 50,
          reason: 'Return',
          idempotencyKey: 'refund-a',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(refundPharmacyTender).not.toHaveBeenCalled();
      expect(f.db.pharmacyKhataEvent.create).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['bootstrap admin wildcard', '*', ['pharmacy:counter']],
    ['counter operator', 'pharmacy:counter', ['pharmacy:counter']],
    ['finance operator', 'reports:financial', ['pharmacy:counter', 'reports:financial']],
  ])(
    'admits a %s without requiring clinical dispense permission',
    async (_name, grant, actions) => {
      const f = fixture();
      f.member.organizationRole.permissions = [{ capability: grant, effect: 'ALLOW' }];

      await expect(
        f.caller().khataAccounts({ branchId: 'branch-a', saleId: 'sale-a' })
      ).resolves.toEqual([expect.objectContaining({ id: 'family-a' })]);
      expect(canSpy.mock.calls.map(([, action]) => action)).toEqual(actions);
      expect(can).not.toHaveBeenCalledWith(
        expect.anything(),
        'pharmacy:dispense',
        expect.anything(),
        expect.anything()
      );
    }
  );

  it('does not treat clinical dispense permission as Khata access', async () => {
    const f = fixture();
    f.member.organizationRole.permissions = [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }];

    await expect(
      f.caller().khataAccounts({ branchId: 'branch-a', saleId: 'sale-a' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Pharmacy counter or financial reports permission required.',
    });
    expect(canSpy.mock.calls.map(([, action]) => action)).toEqual([
      'pharmacy:counter',
      'reports:financial',
    ]);
    expect(can).not.toHaveBeenCalledWith(
      expect.anything(),
      'pharmacy:dispense',
      expect.anything(),
      expect.anything()
    );
  });

  it('lets a finance-only operator read statements and tender outcomes', async () => {
    const f = fixture();
    f.member.organizationRole.permissions = [{ capability: 'reports:financial', effect: 'ALLOW' }];

    await expect(
      f.caller().khataStatement({
        branchId: 'branch-a',
        saleId: 'sale-a',
        familyAccountId: 'family-a',
      })
    ).resolves.toBeDefined();
    await expect(f.caller().tenderOutcome(input)).resolves.toMatchObject({
      status: 'NOT_FOUND',
    });
    expect(readPharmacyTenderOutcome).toHaveBeenCalledWith(
      f.db,
      expect.objectContaining({ organizationId: 'org-a', branchId: 'branch-a' }),
      { ...input, type: 'CREDIT' }
    );
    expect(canSpy.mock.calls.map(([, action]) => action)).toEqual([
      'pharmacy:counter',
      'reports:financial',
      'pharmacy:counter',
      'reports:financial',
    ]);
  });

  it('allows a cashier with counter access to read and charge Khata without dispense access', async () => {
    const f = fixture();
    f.user.role = 'EMPLOYEE';
    await expect(
      can(subjectFromSession(f.user), 'pharmacy:dispense', undefined, { db: f.db as never })
    ).resolves.toBe(false);

    await expect(
      f.caller().khataAccounts({ branchId: 'branch-a', saleId: 'sale-a' })
    ).resolves.toEqual([
      expect.objectContaining({ id: 'family-a', balanceMinor: 0, creditLimitMinor: 100 }),
    ]);
    await expect(f.caller().tender(input)).resolves.toMatchObject({ tenderId: 'tender-a' });
    await expect(f.caller().tenderOutcome(input)).resolves.toEqual({
      status: 'NOT_FOUND',
      replayUnsafe: true,
    });

    expect(f.db.pharmacyBranchAssignment.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-a',
        userId: f.user.id,
        active: true,
        branch: { organizationId: 'org-a', active: true },
      },
      select: { branchId: true },
    });
  });
  it('uses server tenant, CREDIT settlement and an atomic member charge', async () => {
    const f = fixture();
    await f.caller().tender(input);
    expect(applyPharmacyTender).toHaveBeenCalledWith(
      f.db,
      { organizationId: 'org-a', branchId: 'branch-a', actorId: 'owner-a' },
      { ...input, type: 'CREDIT' }
    );
    expect(f.db.pharmacyKhataEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: 'khata:tender-a',
        memberId: 'member-a',
        dueAt: input.businessDate,
        familyAccountId: 'family-a',
        kind: 'CHARGE',
        amountMinor: 100,
      }),
    });
  });
  it('rejects a direct override even when the general session authentication is recent', async () => {
    const f = fixture();
    await expect(f.caller().tender({ ...input, amountMinor: 101, ownerOverride: true,
      overrideReason: 'Exception' })).rejects.toMatchObject({ message: 'OWNER_ACTION_REQUIRED' });
    expect(f.db.pharmacyFamilyAccount.update).not.toHaveBeenCalled();
  });
  it('requires the canonical capability before issuing operation-bound evidence', async () => {
    const f = fixture();
    vi.mocked(can).mockResolvedValue(false);
    await expect(f.caller().authorizeKhataOverride({ branchId: 'branch-a', saleId: 'sale-a',
      familyAccountId: 'family-a', amountMinor: 101, reason: 'Exception', password: 'correct' }))
      .rejects.toMatchObject({ message: 'OWNER_ACTION_REQUIRED' });
    expect(f.db.$executeRaw).not.toHaveBeenCalled();
  });
  it('does not issue approval evidence without password reauthentication', async () => {
    const f = fixture();
    await expect(f.caller().authorizeKhataOverride({ branchId: 'branch-a', saleId: 'sale-a',
      familyAccountId: 'family-a', amountMinor: 101, reason: 'Exception', password: 'wrong' }))
      .rejects.toMatchObject({ message: 'OWNER_ACTION_REQUIRED' });
    expect(f.db.$executeRaw).not.toHaveBeenCalled();
  });
  it('binds approval to the exact operation and consumes it once', async () => {
    const f = fixture();
    const approvalId = '11111111-1111-4111-8111-111111111111';
    const evidence = { id: approvalId, approverId: 'owner-a', reason: 'Exception', createdAt: new Date() };
    const approver = { id: 'owner-a', status: 'ACTIVE', organizationId: 'org-a', roleKey: 'owner', isSystem: true };
    f.db.$queryRaw
      .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([])
      .mockResolvedValueOnce([evidence]).mockResolvedValueOnce([approver]);
    await f.caller().tender({ ...input, amountMinor: 101, ownerOverride: true,
      overrideReason: 'Exception', approvalId });
    expect(f.db.$executeRaw).toHaveBeenCalledOnce();

    f.db.$queryRaw.mockReset().mockResolvedValue([]);
    await expect(f.caller().tender({ ...input, amountMinor: 102, ownerOverride: true,
      overrideReason: 'Exception', approvalId, idempotencyKey: 'key-b' }))
      .rejects.toMatchObject({ message: 'OWNER_ACTION_REQUIRED' });
  });
  it('observes capability revocation inside the tender transaction', async () => {
    const f = fixture();
    const approvalId = '22222222-2222-4222-8222-222222222222';
    f.db.$queryRaw.mockReset()
      .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: approvalId, approverId: 'owner-a', reason: 'Exception', createdAt: new Date() }])
      .mockResolvedValueOnce([{ id: 'owner-a', status: 'ACTIVE', organizationId: 'org-a', roleKey: 'owner', isSystem: true }]);
    vi.mocked(can).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(f.caller().tender({ ...input, amountMinor: 101, ownerOverride: true,
      overrideReason: 'Exception', approvalId })).rejects.toMatchObject({ message: 'OWNER_ACTION_REQUIRED' });
    expect(f.db.$executeRaw).not.toHaveBeenCalled();
  });
  it.each(['passwordAuthenticatedAt', 'organizationId', 'ownerAuthorizedByUserId'])(
    'rejects client %s',
    async (field) => {
      const f = fixture();
      await expect(
        f.caller().tender({ ...input, [field]: 'forged' } as never)
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(applyPharmacyTender).not.toHaveBeenCalled();
    }
  );
  it('rejects stale session metadata because it is never approval evidence', async () => {
    const f = fixture();
    await expect(
      f
        .caller()
        .tender({
          ...input,
          amountMinor: 101,
          ownerOverride: true,
          overrideReason: 'Approved exception',
        })
    ).rejects.toMatchObject({ message: 'OWNER_ACTION_REQUIRED' });
    expect(applyPharmacyTender).not.toHaveBeenCalled();
  });
  it('replays exact accepted evidence without reauthorizing or duplicating a charge', async () => {
    const f = fixture();
    f.user.passwordAuthenticatedAt = 0;
    const result = { tenderId: 'tender-a', settled: true, receiptNumber: 1, remainingMinor: 0 };
    vi.mocked(readPharmacyTenderOutcome).mockResolvedValue({
      status: 'ACCEPTED',
      replayUnsafe: true,
      result,
    });
    expect(
      await f
        .caller()
        .tender({ ...input, ownerOverride: true, overrideReason: 'Approved exception' })
    ).toEqual({
      ...result,
      replayed: true,
    });
    expect(applyPharmacyTender).not.toHaveBeenCalled();
    expect(f.db.pharmacyKhataEvent.create).not.toHaveBeenCalled();
    await f.caller().tenderOutcome(input);
    expect(readPharmacyTenderOutcome).toHaveBeenLastCalledWith(
      f.db,
      expect.objectContaining({ organizationId: 'org-a' }),
      { ...input, type: 'CREDIT' }
    );
  });
  it('denies inactive branches, absent capability and a different vertical before money writes', async () => {
    const f = fixture();
    f.db.pharmacyBranch.findFirst.mockResolvedValue(null as never);
    await expect(f.caller().tender(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    f.db.pharmacyBranch.findFirst.mockResolvedValue({ id: 'branch-a' });
    f.member.organizationRole.permissions = [];
    await expect(f.caller().tender(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    f.member.organizationRole.permissions = [{ capability: 'pharmacy:counter', effect: 'ALLOW' }];
    f.context.organization.vertical = 'RESTAURANT';
    await expect(
      f.caller().khataAccounts({ branchId: 'branch-a', saleId: 'sale-a' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(applyPharmacyTender).not.toHaveBeenCalled();
  });
  it('gates Khata with counter or finance access, never clinical dispense access', async () => {
    const f = fixture();
    f.member.organizationRole.permissions = [{ capability: 'reports:financial', effect: 'ALLOW' }];

    await expect(
      f.caller().khataAccounts({ branchId: 'branch-a', saleId: 'sale-a' })
    ).resolves.toEqual([expect.objectContaining({ id: 'family-a' })]);
    expect(can).toHaveBeenCalledWith(subjectFromSession(f.user), 'pharmacy:counter', undefined, {
      db: f.db,
      source: 'TRPC',
    });
    expect(can).toHaveBeenCalledWith(subjectFromSession(f.user), 'reports:financial', undefined, {
      db: f.db,
      source: 'TRPC',
    });
    expect(canSpy.mock.calls.map(([, action]) => action)).not.toContain('pharmacy:dispense');

    f.member.organizationRole.permissions = [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }];
    await expect(
      f.caller().khataAccounts({ branchId: 'branch-a', saleId: 'sale-a' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('appends a refund payment once without editing the original charge', async () => {
    const f = fixture();
    const charge = { id: 'khata:tender-a', familyAccountId: 'family-a' };
    f.db.pharmacyKhataEvent.findFirst
      .mockResolvedValueOnce(charge)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(charge)
      .mockResolvedValueOnce({ id: 'khata-refund:refund-a' });
    vi.mocked(refundPharmacyTender).mockResolvedValue({
      refundId: 'refund-a',
      originalTenderId: 'tender-a',
      amountMinor: 50,
      replayed: false,
    });
    const refund = {
      branchId: 'branch-a',
      originalTenderId: 'tender-a',
      deviceId: 'device-a',
      businessDate: input.businessDate,
      amountMinor: 50,
      reason: 'Return',
      idempotencyKey: 'refund-a',
    };
    await f.caller().refundTender(refund);
    await f.caller().refundTender(refund);
    expect(f.db.pharmacyKhataEvent.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        id: 'khata-refund:refund-a',
        kind: 'PAYMENT',
        settlesChargeId: 'khata:tender-a',
        amountMinor: 50,
      }),
    });
  });
});
