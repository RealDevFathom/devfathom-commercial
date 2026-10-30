import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/abac', () => ({
  can: vi.fn(async () => true),
  subjectFromSession: (user: unknown) => user,
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
import { can } from '@/lib/abac';
import { capabilityMatches } from '@/lib/abac/capabilities';
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
type Permission = { capability: string; effect: 'ALLOW' | 'DENY' };

function fixture(
  permissions: Permission[] = [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }],
  role: 'ADMIN' | 'EMPLOYEE' = 'ADMIN',
  overrides: Permission[] = []
) {
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
    user: {
      findUnique: vi.fn().mockResolvedValue({
        status: 'ACTIVE',
        organizationId: 'org-a',
        organizationRole: {
          permissions,
        },
        permissionOverrides: overrides,
      }),
    },
    pharmacyBranch: {
      findFirst: vi.fn().mockResolvedValue({ id: 'branch-a' }),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
    },
    pharmacyBranchAssignment: { findMany: vi.fn().mockResolvedValue([]) },
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
    user,
    context,
    caller: () => app.createCaller(context as unknown as TRPCContext).pharmacySales,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(can).mockResolvedValue(true);
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

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
    vi.mocked(can).mockImplementation(actual.can);
  });

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
describe('Khata router trust and recovery boundary', () => {
  it.each([
    ['bootstrap admin wildcard', '*', ['pharmacy:counter']],
    ['counter operator', 'pharmacy:counter', ['pharmacy:counter']],
    ['finance operator', 'reports:financial', ['pharmacy:counter', 'reports:financial']],
  ])(
    'admits a %s without requiring clinical dispense permission',
    async (_name, grant, actions) => {
      const f = fixture();
      vi.mocked(can).mockImplementation(async (_subject, action) =>
        capabilityMatches(grant, action)
      );

      await expect(
        f.caller().khataAccounts({ branchId: 'branch-a', saleId: 'sale-a' })
      ).resolves.toEqual([expect.objectContaining({ id: 'family-a' })]);
      expect(vi.mocked(can).mock.calls.map(([, action]) => action)).toEqual(actions);
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
    vi.mocked(can).mockImplementation(async (_subject, action) =>
      capabilityMatches('pharmacy:dispense', action)
    );

    await expect(
      f.caller().khataAccounts({ branchId: 'branch-a', saleId: 'sale-a' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Pharmacy counter or financial reports permission required.',
    });
    expect(vi.mocked(can).mock.calls.map(([, action]) => action)).toEqual([
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
    vi.mocked(can).mockImplementation(async (_subject, action) =>
      capabilityMatches('reports:financial', action)
    );

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
    expect(vi.mocked(can).mock.calls.map(([, action]) => action)).toEqual([
      'pharmacy:counter',
      'reports:financial',
      'pharmacy:counter',
      'reports:financial',
    ]);
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
    vi.mocked(can).mockImplementation(async (_subject, action) =>
      capabilityMatches('reports:financial', action)
    );
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
      message: 'Pharmacy counter permission required.',
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
    vi.mocked(can).mockResolvedValue(false);
    await expect(f.caller().tender(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    f.context.organization.vertical = 'RESTAURANT';
    await expect(
      f.caller().khataAccounts({ branchId: 'branch-a', saleId: 'sale-a' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(applyPharmacyTender).not.toHaveBeenCalled();
  });
  it('gates Khata with counter or finance access, never clinical dispense access', async () => {
    const f = fixture();
    vi.mocked(can).mockImplementation(async (_subject, action) => action === 'reports:financial');

    await expect(
      f.caller().khataAccounts({ branchId: 'branch-a', saleId: 'sale-a' })
    ).resolves.toEqual([expect.objectContaining({ id: 'family-a' })]);
    expect(can).toHaveBeenCalledWith(f.user, 'pharmacy:counter', undefined, {
      db: f.db,
      source: 'TRPC',
    });
    expect(can).toHaveBeenCalledWith(f.user, 'reports:financial', undefined, {
      db: f.db,
      source: 'TRPC',
    });
    expect(vi.mocked(can).mock.calls.map(([, action]) => action)).not.toContain(
      'pharmacy:dispense'
    );

    vi.mocked(can).mockImplementation(async (_subject, action) => action === 'pharmacy:dispense');
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
