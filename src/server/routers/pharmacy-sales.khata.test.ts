import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
// DEV-647: the manager/owner refund gate has its own suite (pharmacy-sales.refund-pin.test.ts).
vi.mock('@/lib/pharmacy/refund-authorization', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/refund-authorization')>()),
  actorMayRefund: async () => true,
  authenticateRefundPin: async () => ({ verified: true }),
}));
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
  recordAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/settlement', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/settlement')>()),
  refundPharmacyTender: vi.fn(),
  applyPharmacyTender: vi.fn(),
  readPharmacyTenderOutcome: vi.fn(),
}));
vi.mock('@/lib/pharmacy/khata-repayment', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/khata-repayment')>()),
  recordKhataRepayment: vi.fn(),
  searchKhataRepaymentAccounts: vi.fn(),
}));
import {
  applyPharmacyTender,
  readPharmacyTenderOutcome,
  refundPharmacyTender,
} from '@/lib/pharmacy/settlement';
import { FamilyKhataError } from '@/lib/pharmacy/family-khata';
import {
  recordKhataRepayment,
  searchKhataRepaymentAccounts,
} from '@/lib/pharmacy/khata-repayment';
import { can, subjectFromSession } from '@/lib/abac';
import * as abac from '@/lib/abac';
import { pharmacyRegulatoryFixture } from '@/lib/test-support/pharmacy-regulatory';
import { recordAudit } from '@/server/audit';
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
  const { rules, profile } = pharmacyRegulatoryFixture('branch-a');
  const db = {
    organization: { findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    branchRegulatoryProfile: {
      findFirst: vi.fn().mockResolvedValue({
        ...profile,
        branch: { active: true, provinceCode: 'PB', addressLine: '1 Test Road', city: 'Lahore' },
        jurisdictionRuleSet: rules,
      }),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
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
  // DEV-647: the manager PIN is checked by the router and never reaches settlement.
  const settlement = {
    branchId: 'branch-a',
    originalTenderId: 'tender-a',
    deviceId: 'device-a',
    businessDate: input.businessDate,
    amountMinor: 50,
    reason: 'Return',
    idempotencyKey: 'refund-a',
  };
  const refund = { ...settlement, managerPin: '1234' };

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
        settlement
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
          managerPin: '1234',
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
  it.each(['KHATA', 'CREDIT'] as const)(
    'refuses %s for onboarding organizations and branches without a profile, even with owner override',
    async (type) => {
      const f = fixture();
      f.db.organization.findUnique.mockResolvedValue({ status: 'ONBOARDING' });
      await expect(
        f.caller().tender({ ...input, type, ownerOverride: true })
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'ORGANIZATION_NOT_ACTIVE',
      });
      expect(f.db.branchRegulatoryProfile.findFirst).not.toHaveBeenCalled();

      f.db.organization.findUnique.mockResolvedValue({ status: 'ACTIVE' });
      f.db.branchRegulatoryProfile.findFirst.mockResolvedValue(null);
      await expect(
        f.caller().tender({ ...input, type, ownerOverride: true })
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'PROFILE_MISSING',
      });
      for (const errorCode of ['ORGANIZATION_NOT_ACTIVE', 'PROFILE_MISSING'])
        expect(recordAudit).toHaveBeenCalledWith(
          expect.objectContaining({ organizationId: 'org-a', targetId: 'branch-a', errorCode })
        );
      expect(applyPharmacyTender).not.toHaveBeenCalled();
      expect(f.db.pharmacyKhataEvent.create).not.toHaveBeenCalled();
      expect(f.db.pharmacyKhataLimitDecision.create).not.toHaveBeenCalled();
      // Only the gate's share locks ran; the sale row was never locked for a charge.
      const statements = f.db.$queryRaw.mock.calls.map(([sql]) =>
        Array.isArray(sql) ? sql.join('?') : String((sql as { sql?: string }).sql)
      );
      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement).toContain('FOR SHARE');
        expect(statement).not.toContain('pharmacy_sales');
      }
    }
  );

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
          managerPin: '1234',
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
      managerPin: '1234',
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
  it('hands only the fresh server-session claim to the audited owner gate', async () => {
    const f = fixture();
    await f.caller().tender({ ...input, amountMinor: 101, ownerOverride: true });
    expect(f.db.pharmacyKhataLimitDecision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reasons: expect.objectContaining({
          ownerAuthorizedByUserId: 'owner-a',
          ownerReauthenticatedAt: new Date(f.user.passwordAuthenticatedAt).toISOString(),
        }),
      }),
    });
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
  it('rejects stale owner evidence and non-owner override', async () => {
    const f = fixture();
    f.user.passwordAuthenticatedAt -= 301000;
    await expect(
      f.caller().tender({ ...input, amountMinor: 101, ownerOverride: true })
    ).rejects.toMatchObject({ message: 'OWNER_ACTION_REQUIRED' });
    f.user.passwordAuthenticatedAt = Date.now();
    f.user.role = 'EMPLOYEE';
    await expect(
      f.caller().tender({ ...input, amountMinor: 101, ownerOverride: true })
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
    expect(await f.caller().tender({ ...input, ownerOverride: true })).toEqual({
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
      managerPin: '1234',
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

describe('DEV-716 khataSignup', () => {
  const signup = {
    branchId: 'branch-a',
    saleId: 'sale-a',
    displayName: 'Ayesha',
    phone: '0300 1234567',
    consentGranted: true as const,
  };
  function signupDb(f: ReturnType<typeof fixture>) {
    const db = f.db as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
    db.pharmacyPatient = {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi
        .fn()
        .mockResolvedValue({ id: 'patient-a', displayName: 'Ayesha', phone: '03001234567' }),
    };
    let consented = false;
    db.patientConsent = {
      findFirst: vi.fn(async () => (consented ? { granted: true, revokedAt: null } : null)),
      create: vi.fn(async () => {
        consented = true;
        return { id: 'consent-a' };
      }),
    };
    db.pharmacySaleLine = { findFirst: vi.fn().mockResolvedValue(null) };
    db.pharmacyCustomer = {
      upsert: vi
        .fn()
        .mockResolvedValue({ id: 'customer-a', displayName: 'Ayesha', phoneLast4: '4567' }),
    };
    db.pharmacySale = {
      findFirst: vi.fn().mockResolvedValue({ id: 'sale-a', status: 'OPEN' }),
      update: vi.fn().mockResolvedValue({}),
    };
    db.pharmacyFamilyAccount.findFirst = vi.fn().mockResolvedValue(null);
    db.pharmacyFamilyAccount.create = vi.fn().mockResolvedValue({ id: 'family-new' });
    db.pharmacyFamilyMember = { create: vi.fn().mockResolvedValue({ id: 'member-new' }) };
    db.pharmacyLoyaltyPointsEntry = { findFirst: vi.fn().mockResolvedValue(null) };
    f.db.$queryRaw.mockResolvedValue([{ id: 'patient-a' }]);
    return db;
  }

  it('lets a counter cashier open a 0-limit account linked to the sale', async () => {
    const f = fixture([{ capability: 'pharmacy:counter', effect: 'ALLOW' }], 'EMPLOYEE');
    const db = signupDb(f);
    await expect(f.caller().khataSignup(signup)).resolves.toEqual({
      customerId: 'customer-a',
      familyAccountId: 'family-new',
      created: true,
    });
    expect(db.patientConsent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ purpose: 'LOYALTY', granted: true, patientId: 'patient-a' }),
    });
    expect(db.pharmacySale.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { customerId: 'customer-a' } })
    );
    expect(db.pharmacyFamilyAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ creditLimitMinor: 0 }) })
    );
  });

  it('rejects a client-supplied limit and missing consent at the input boundary', async () => {
    const f = fixture();
    const db = signupDb(f);
    await expect(
      f.caller().khataSignup({ ...signup, creditLimitMinor: 500000 } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      f.caller().khataSignup({ ...signup, consentGranted: false } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(f.caller().khataSignup({ ...signup, phone: undefined })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(db.pharmacyFamilyAccount.create).not.toHaveBeenCalled();
  });

  it('denies finance-only and dispense-only operators before any write', async () => {
    for (const capability of ['reports:financial', 'pharmacy:dispense']) {
      const f = fixture([{ capability, effect: 'ALLOW' }], 'EMPLOYEE');
      const db = signupDb(f);
      await expect(f.caller().khataSignup(signup)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.$transaction).not.toHaveBeenCalled();
      expect(db.pharmacyPatient.create).not.toHaveBeenCalled();
      expect(db.pharmacyFamilyAccount.create).not.toHaveBeenCalled();
    }
  });

  it('refuses a sale that is no longer open without opening an account', async () => {
    const f = fixture();
    const db = signupDb(f);
    db.pharmacySale.findFirst.mockResolvedValue(null);
    await expect(f.caller().khataSignup(signup)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.pharmacyFamilyAccount.create).not.toHaveBeenCalled();
  });
});

describe('K4 counter khata repayment (DEV-731)', () => {
  const payment = {
    branchId: 'branch-a',
    familyAccountId: 'family-a',
    amountMinor: 500,
    tender: 'CASH' as const,
    deviceId: 'device-a',
    businessDate: input.businessDate,
    idempotencyKey: 'khata-payment:1',
  };
  const slip = {
    receiptReference: 'KP-0123456789',
    familyAccountId: 'family-a',
    accountName: 'Family',
    amountMinor: 500,
    tender: 'CASH' as const,
    payerReference: null,
    balanceAfterMinor: 0,
    recordedAt: new Date('2026-11-15T06:00:00.000Z'),
    currency: 'PKR',
    replayed: false,
  };
  const counterScope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'owner-a' };

  it('records a counter repayment in one transaction bound to the branch', async () => {
    vi.mocked(recordKhataRepayment).mockResolvedValue(slip);
    const f = fixture();
    await expect(f.caller().recordKhataPayment(payment)).resolves.toEqual(slip);
    expect(f.db.$transaction).toHaveBeenCalledTimes(1);
    expect(f.db.$queryRaw).toHaveBeenCalled();
    expect(recordKhataRepayment).toHaveBeenCalledExactlyOnceWith(f.db, counterScope, payment);
  });

  it('lists repayment accounts for counter users without a sale', async () => {
    vi.mocked(searchKhataRepaymentAccounts).mockResolvedValue([]);
    const f = fixture();
    await expect(
      f.caller().khataPaymentAccounts({ branchId: 'branch-a', query: 'Khan' })
    ).resolves.toEqual([]);
    expect(searchKhataRepaymentAccounts).toHaveBeenCalledExactlyOnceWith(
      f.db,
      counterScope,
      'Khan'
    );
  });

  it('denies reports-only users the repayment write before opening a transaction', async () => {
    const f = fixture([{ capability: 'reports:financial', effect: 'ALLOW' }], 'EMPLOYEE');
    await expect(f.caller().recordKhataPayment(payment)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Pharmacy counter permission required.',
    });
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(recordKhataRepayment).not.toHaveBeenCalled();
  });

  it('lets a counter DENY override owner access for repayments', async () => {
    const f = fixture([{ capability: '*', effect: 'ALLOW' }], 'ADMIN', [
      { capability: 'pharmacy:counter', effect: 'DENY' },
    ]);
    await expect(f.caller().recordKhataPayment(payment)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(recordKhataRepayment).not.toHaveBeenCalled();
  });

  it('answers ledger refusals as typed bad requests', async () => {
    vi.mocked(recordKhataRepayment).mockRejectedValue(
      new FamilyKhataError('PAYMENT_EXCEEDS_BALANCE')
    );
    const f = fixture();
    await expect(f.caller().recordKhataPayment(payment)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'PAYMENT_EXCEEDS_BALANCE',
    });
  });

  it('rejects a khata (credit) tender as the repayment tender', async () => {
    const f = fixture();
    await expect(
      f.caller().recordKhataPayment({ ...payment, tender: 'KHATA' as never })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(recordKhataRepayment).not.toHaveBeenCalled();
  });
});
