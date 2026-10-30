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
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';
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
function fixture() {
  const member = {
    status: 'ACTIVE',
    organizationId: 'org-a',
    organizationRole: {
      permissions: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }],
    },
    permissionOverrides: [] as { capability: string; effect: string }[],
  };
  const db = {
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
    role: 'ADMIN',
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

describe('Khata router trust and recovery boundary', () => {
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
