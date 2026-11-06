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
  recordAuthAudit: vi.fn(),
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
import { clearRateLimit, rateLimit } from '@/lib/rate-limit';
import { recordAuthAudit } from '@/server/audit';
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
  const approver = {
    id: 'owner-a',
    email: 'owner@example.test',
    password: 'hash',
    status: 'ACTIVE',
    role: 'ADMIN',
    twoFactorEnabledAt: null as Date | null,
    twoFactorSecret: null as string | null,
    organizationRole: { key: 'owner', isSystem: true } as { key: string; isSystem: boolean } | null,
  };
  // Permission rules of other members (approvers) by id; every other read is the session member.
  const rulesById: Record<string, typeof member> = {};
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(),
    user: {
      findUnique: vi.fn(async (args?: { where?: { id?: string } }) =>
        args?.where?.id && rulesById[args.where.id] ? rulesById[args.where.id] : member
      ),
      findFirst: vi.fn(async (): Promise<Record<string, unknown> | null> => ({ ...approver })),
    },
    twoFactorRecoveryCode: {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    pharmacyBranchAssignment: {
      findMany: vi.fn(async () => [{ branchId: 'branch-a' }]),
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => ({ id: 'assignment-a' })),
    },
    organizationIdentityConnection: {
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
    },
    pharmacyBranch: {
      findFirst: vi.fn().mockResolvedValue({ id: 'branch-a' }),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
    },
    pharmacyTender: { findFirst: vi.fn().mockResolvedValue({ type: 'CREDIT' }) },
    pharmacySale: { findFirst: vi.fn().mockResolvedValue({ customerId: 'customer-a' }) },
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
    rulesById,
    approver,
    user,
    context,
    caller: () => app.createCaller(context as unknown as TRPCContext).pharmacySales,
  };
}
beforeEach(async () => {
  vi.clearAllMocks();
  for (const key of [
    'login:acct:owner@example.test',
    'khata-approval:acct:org-a:owner@example.test',
    'khata-approval:acct:org-a:manager@example.test',
    'khata-approval:acct:org-a:ghost@example.test',
    'khata-approval:actor:org-a:owner-a',
  ])
    await clearRateLimit(key);
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
  it('does not let a finance-only operator create or refund Khata tenders', async () => {
    const f = fixture();
    f.member.organizationRole.permissions = [{ capability: 'reports:financial', effect: 'ALLOW' }];
    const refund = {
      branchId: 'branch-a',
      originalTenderId: 'tender-a',
      deviceId: 'device-a',
      businessDate: input.businessDate,
      amountMinor: 50,
      reason: 'Return',
      idempotencyKey: 'refund-a',
    };

    await expect(f.caller().tender(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Pharmacy counter permission required.',
    });
    await expect(f.caller().refundTender(refund)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
    expect(applyPharmacyTender).not.toHaveBeenCalled();
    expect(refundPharmacyTender).not.toHaveBeenCalled();
    expect(f.db.pharmacyKhataEvent.create).not.toHaveBeenCalled();
  });
  const approvalId = '11111111-1111-4111-8111-111111111111';
  const approval = {
    branchId: 'branch-a',
    saleId: 'sale-a',
    familyAccountId: 'family-a',
    amountMinor: 101,
    reason: 'Exception',
    password: 'correct',
  };
  function routeRaw(
    f: ReturnType<typeof fixture>,
    evidence: Record<string, unknown> | null,
    approverRow: Record<string, unknown> | null
  ) {
    f.db.$queryRaw.mockImplementation(async (query: { sql?: string; strings?: string[] }) => {
      const text = query?.sql ?? query?.strings?.join('?') ?? '';
      if (text.includes('FROM pharmacy_khata_override_approvals')) return evidence ? [evidence] : [];
      if (text.includes('FROM users u')) return approverRow ? [approverRow] : [];
      return [];
    });
  }
  const evidence = () => ({
    id: approvalId,
    approverId: 'owner-a',
    reason: 'Exception',
    createdAt: new Date(),
    approvedLimitMinor: 101,
    dbNow: new Date(),
  });
  const approverRow = {
    id: 'owner-a',
    status: 'ACTIVE',
    role: 'EMPLOYEE',
    roleKey: 'owner',
    isSystem: true,
    branchAssigned: true,
  };
  it('rejects a direct override even when the general session authentication is recent', async () => {
    const f = fixture();
    await expect(
      f.caller().tender({ ...input, amountMinor: 101, ownerOverride: true, overrideReason: 'Exception' })
    ).rejects.toMatchObject({ message: 'OWNER_ACTION_REQUIRED' });
    expect(f.db.pharmacyFamilyAccount.update).not.toHaveBeenCalled();
  });
  it('issues single-use, operation-bound evidence for the reauthenticated session approver', async () => {
    const f = fixture();
    const result = await f.caller().authorizeKhataOverride(approval);
    expect(result.approvalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.db.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-a', id: 'owner-a' } })
    );
    expect(f.db.$executeRaw).toHaveBeenCalledOnce();
    const insert = f.db.$executeRaw.mock.calls[0]![0] as { values: unknown[] };
    // The approved final limit is balance at approval (0) + amount.
    expect(insert.values).toEqual([
      result.approvalId, 'org-a', 'branch-a', 'owner-a', 'sale-a', 'family-a', 101, 101, 'Exception',
    ]);
    // Password, code and reason never enter the audit input.
    expect(f.context.audit.detail).toMatchObject({ skipInput: true });
  });
  function approverRules(
    f: ReturnType<typeof fixture>,
    id: string,
    permissions: string[],
    overrides: Permission[] = []
  ) {
    f.rulesById[id] = {
      ...f.member,
      organizationRole: {
        permissions: permissions.map((capability) => ({ capability, effect: 'ALLOW' })),
      },
      permissionOverrides: overrides,
    };
  }
  it('lets a second-person manager approve the cashier tender', async () => {
    const f = fixture();
    approverRules(f, 'manager-b', ['pharmacy:manage']);
    f.db.user.findFirst.mockResolvedValue({
      ...f.approver,
      id: 'manager-b',
      email: 'manager@example.test',
      role: 'EMPLOYEE',
      organizationRole: { key: 'manager', isSystem: true },
    });
    await f.caller().authorizeKhataOverride({ ...approval, approverEmail: 'Manager@Example.test' });
    expect(f.db.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-a', email: 'manager@example.test' } })
    );
    const insert = f.db.$executeRaw.mock.calls[0]![0] as { values: unknown[] };
    expect(insert.values[3]).toBe('manager-b');
    expect(f.db.pharmacyBranchAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-a',
          branchId: 'branch-a',
          userId: 'manager-b',
          active: true,
        }),
      })
    );
  });
  it('refuses a manager who is not assigned to the charge branch', async () => {
    const f = fixture();
    f.db.user.findFirst.mockResolvedValue({
      ...f.approver,
      id: 'manager-b',
      email: 'manager@example.test',
      role: 'EMPLOYEE',
      organizationRole: { key: 'manager', isSystem: true },
    });
    f.db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
    await expect(
      f.caller().authorizeKhataOverride({ ...approval, approverEmail: 'manager@example.test' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'OWNER_ACTION_REQUIRED' });
    expect(f.db.$executeRaw).not.toHaveBeenCalled();
  });
  it.each([
    [
      'a manager with a user DENY on pharmacy:manage',
      'EMPLOYEE',
      'manager',
      ['pharmacy:manage'],
      'pharmacy:manage',
    ],
    [
      'a manager with a user DENY on pharmacy:*',
      'EMPLOYEE',
      'manager',
      ['pharmacy:manage'],
      'pharmacy:*',
    ],
    ['an owner with a user DENY on pharmacy:*', 'EMPLOYEE', 'owner', ['pharmacy:*'], 'pharmacy:*'],
    [
      'an owner-operator with a user DENY on pharmacy:manage',
      'EMPLOYEE',
      'owner-operator',
      ['pharmacy:orders'],
      'pharmacy:manage',
    ],
    ['an ADMIN with a user DENY on admin:access', 'ADMIN', 'owner', [], 'admin:access'],
    ['an ADMIN with a user DENY on *', 'ADMIN', 'owner', [], '*'],
  ])('refuses %s at issuance', async (_label, role, key, permissions, denied) => {
    const f = fixture();
    approverRules(f, 'approver-b', permissions, [{ capability: denied, effect: 'DENY' }]);
    f.db.user.findFirst.mockResolvedValue({
      ...f.approver,
      id: 'approver-b',
      email: 'manager@example.test',
      role,
      organizationRole: { key, isSystem: true },
    });
    await expect(
      f.caller().authorizeKhataOverride({ ...approval, approverEmail: 'manager@example.test' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'OWNER_ACTION_REQUIRED' });
    expect(f.db.$executeRaw).not.toHaveBeenCalled();
    expect(recordAuthAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'approver-b',
        reason: 'Khata override approval refused: Approver permission denied',
      })
    );
  });
  it('lets an owner-operator without a DENY approve', async () => {
    const f = fixture();
    // The owner-operator template carries no pharmacy:manage grant.
    approverRules(f, 'approver-b', ['pharmacy:orders', 'pharmacy:dispense']);
    f.db.user.findFirst.mockResolvedValue({
      ...f.approver,
      id: 'approver-b',
      email: 'manager@example.test',
      role: 'EMPLOYEE',
      organizationRole: { key: 'owner-operator', isSystem: true },
    });
    await f.caller().authorizeKhataOverride({ ...approval, approverEmail: 'manager@example.test' });
    expect(f.db.$executeRaw).toHaveBeenCalledOnce();
  });
  it('lets a tenant ADMIN approve without a branch assignment', async () => {
    const f = fixture();
    f.db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null);
    await f.caller().authorizeKhataOverride(approval);
    expect(f.db.$executeRaw).toHaveBeenCalledOnce();
  });
  it('refuses password approval when the workspace enforces SSO', async () => {
    const f = fixture();
    f.db.organizationIdentityConnection.findFirst.mockResolvedValue({ id: 'idp-a' });
    await expect(f.caller().authorizeKhataOverride(approval)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'OWNER_ACTION_REQUIRED',
    });
    expect(f.db.organizationIdentityConnection.findFirst).toHaveBeenCalledWith({
      where: { status: 'ACTIVE', enforceSso: true },
      select: { id: true },
    });
    expect(f.db.$executeRaw).not.toHaveBeenCalled();
    expect(recordAuthAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'LOGIN_FAILED',
        userId: 'owner-a',
        reason: expect.stringContaining('SSO'),
      })
    );
  });
  it('records a failed approval as an authentication failure without the secret', async () => {
    const f = fixture();
    await expect(
      f.caller().authorizeKhataOverride({ ...approval, password: 'wrong' })
    ).rejects.toMatchObject({ message: 'OWNER_ACTION_REQUIRED' });
    expect(recordAuthAudit).toHaveBeenCalledOnce();
    const event = vi.mocked(recordAuthAudit).mock.calls[0]![0];
    expect(event).toMatchObject({
      type: 'LOGIN_FAILED',
      organizationId: 'org-a',
      userId: 'owner-a',
      email: 'owner@example.test',
    });
    expect(JSON.stringify(event)).not.toContain('wrong');
  });
  it('spends a recovery code only when the approval evidence is recorded', async () => {
    const f = fixture();
    f.db.user.findFirst.mockResolvedValue({
      ...f.approver,
      twoFactorEnabledAt: new Date(),
      twoFactorSecret: null,
    });
    f.db.twoFactorRecoveryCode.findFirst.mockResolvedValue({ id: 'code-a' });
    f.db.twoFactorRecoveryCode.updateMany.mockResolvedValue({ count: 1 });
    // Account outside the sale: the transaction refuses before the code is spent.
    await expect(
      f.caller().authorizeKhataOverride({ ...approval, familyAccountId: 'foreign', totp: 'recovery-a' })
    ).rejects.toMatchObject({ message: 'ACCOUNT_NOT_FOUND' });
    expect(f.db.twoFactorRecoveryCode.updateMany).not.toHaveBeenCalled();
    expect(f.db.$executeRaw).not.toHaveBeenCalled();

    await f.caller().authorizeKhataOverride({ ...approval, totp: 'recovery-a' });
    expect(f.db.twoFactorRecoveryCode.updateMany).toHaveBeenCalledWith({
      where: { id: 'code-a', usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    expect(f.db.$executeRaw).toHaveBeenCalledOnce();
  });
  it.each([
    ['a wrong password', { password: 'wrong' }, {}],
    ['a cashier role', {}, { role: 'EMPLOYEE', organizationRole: { key: 'cashier', isSystem: true } }],
    ['a custom role named manager', {}, { role: 'EMPLOYEE', organizationRole: { key: 'manager', isSystem: false } }],
    ['a deactivated approver', {}, { status: 'INACTIVE' }],
    ['a missing authentication code', {}, { twoFactorEnabledAt: new Date(), twoFactorSecret: 'secret' }],
    ['an unknown approver', { approverEmail: 'ghost@example.test' }, null],
  ])('refuses %s with one indistinct error and no evidence', async (_label, change, row) => {
    const f = fixture();
    f.db.user.findFirst.mockResolvedValue(row === null ? null : { ...f.approver, ...row });
    await expect(
      f.caller().authorizeKhataOverride({ ...approval, ...change })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'OWNER_ACTION_REQUIRED' });
    expect(f.db.$executeRaw).not.toHaveBeenCalled();
  });
  it('requires counter write access before checking any secret', async () => {
    const f = fixture([{ capability: 'reports:financial', effect: 'ALLOW' }]);
    await expect(f.caller().authorizeKhataOverride(approval)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(f.db.user.findFirst).not.toHaveBeenCalled();
    expect(f.db.$executeRaw).not.toHaveBeenCalled();
  });
  it('throttles password and code guessing without exhausting the approver login budget', async () => {
    const f = fixture();
    for (let attempt = 0; attempt < 10; attempt += 1)
      await expect(
        f.caller().authorizeKhataOverride({ ...approval, password: 'wrong' })
      ).rejects.toMatchObject({ message: 'OWNER_ACTION_REQUIRED' });
    await expect(f.caller().authorizeKhataOverride(approval)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(f.db.$executeRaw).not.toHaveBeenCalled();
    // A cashier guessing here must not lock the owner out of their own sign-in.
    expect((await rateLimit('login:acct:owner@example.test', 10, 5 * 60_000)).ok).toBe(true);
  });
  it('consumes bound evidence once when the tender uses it', async () => {
    const f = fixture();
    // The approver is the session owner: the owner template grants pharmacy:*.
    f.member.organizationRole.permissions.push({ capability: 'pharmacy:*', effect: 'ALLOW' });
    routeRaw(f, evidence(), approverRow);
    await f.caller().tender({
      ...input,
      amountMinor: 101,
      ownerOverride: true,
      overrideReason: 'Exception',
      approvalId,
    });
    expect(f.db.$executeRaw).toHaveBeenCalledOnce();
    expect(f.db.pharmacyKhataLimitDecision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownerActorId: 'owner-a',
        reasons: expect.objectContaining({ approvalId, overrideReason: 'Exception' }),
      }),
    });

    routeRaw(f, null, approverRow);
    await expect(
      f.caller().tender({
        ...input,
        amountMinor: 102,
        ownerOverride: true,
        overrideReason: 'Exception',
        approvalId,
        idempotencyKey: 'key-b',
      })
    ).rejects.toMatchObject({ message: 'OWNER_ACTION_REQUIRED' });
  });
  it('refuses evidence whose approved limit a later charge would exceed', async () => {
    const f = fixture();
    routeRaw(f, { ...evidence(), approvedLimitMinor: 100 }, approverRow);
    await expect(
      f.caller().tender({
        ...input,
        amountMinor: 101,
        ownerOverride: true,
        overrideReason: 'Exception',
        approvalId,
      })
    ).rejects.toMatchObject({ message: 'OWNER_ACTION_REQUIRED' });
    expect(f.db.$executeRaw).not.toHaveBeenCalled();
  });
  it('observes approver branch unassignment inside the tender transaction', async () => {
    const f = fixture();
    routeRaw(f, evidence(), { ...approverRow, branchAssigned: false });
    await expect(
      f.caller().tender({
        ...input,
        amountMinor: 101,
        ownerOverride: true,
        overrideReason: 'Exception',
        approvalId,
      })
    ).rejects.toMatchObject({ message: 'OWNER_ACTION_REQUIRED' });
    expect(f.db.$executeRaw).not.toHaveBeenCalled();
  });
  it.each([
    ['manager', 'pharmacy:manage', ['pharmacy:manage']],
    ['manager', 'pharmacy:*', ['pharmacy:manage']],
    ['owner', 'pharmacy:*', ['pharmacy:*']],
  ])(
    'observes a DENY added after issuance for a %s on %s inside the tender transaction',
    async (roleKey, denied, permissions) => {
      const f = fixture();
      approverRules(f, 'manager-b', permissions, [{ capability: denied, effect: 'DENY' }]);
      routeRaw(
        f,
        { ...evidence(), approverId: 'manager-b' },
        { ...approverRow, id: 'manager-b', roleKey }
      );
      await expect(
        f.caller().tender({
          ...input,
          amountMinor: 101,
          ownerOverride: true,
          overrideReason: 'Exception',
          approvalId,
        })
      ).rejects.toMatchObject({ message: 'OWNER_ACTION_REQUIRED' });
      expect(f.db.$executeRaw).not.toHaveBeenCalled();
      expect(f.db.pharmacyKhataLimitDecision.create).not.toHaveBeenCalled();
    }
  );
  it('observes an ADMIN approver admin:access DENY inside the tender transaction', async () => {
    const f = fixture();
    approverRules(f, 'admin-b', [], [{ capability: 'admin:access', effect: 'DENY' }]);
    routeRaw(
      f,
      { ...evidence(), approverId: 'admin-b' },
      { ...approverRow, id: 'admin-b', role: 'ADMIN', roleKey: null, isSystem: null }
    );
    await expect(
      f.caller().tender({
        ...input,
        amountMinor: 101,
        ownerOverride: true,
        overrideReason: 'Exception',
        approvalId,
      })
    ).rejects.toMatchObject({ message: 'OWNER_ACTION_REQUIRED' });
    expect(f.db.$executeRaw).not.toHaveBeenCalled();
  });
  it('observes approver role revocation inside the tender transaction', async () => {
    const f = fixture();
    routeRaw(f, evidence(), { ...approverRow, roleKey: 'cashier' });
    await expect(
      f.caller().tender({
        ...input,
        amountMinor: 101,
        ownerOverride: true,
        overrideReason: 'Exception',
        approvalId,
      })
    ).rejects.toMatchObject({ message: 'OWNER_ACTION_REQUIRED' });
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
