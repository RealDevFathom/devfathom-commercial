import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
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
  foldExpectedCash,
  readPharmacyTenderOutcome,
  refundPharmacyTender,
} from '@/lib/pharmacy/settlement';
import { can } from '@/lib/abac';
import { annotateAudit } from '@/server/audit';
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
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
    pharmacyBranch: {
      findFirst: vi.fn().mockResolvedValue({ id: 'branch-a' }),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
    },
    pharmacyBranchAssignment: {
      findFirst: vi.fn().mockResolvedValue({ id: 'assignment-a' }),
    },
    pharmacyTender: { findFirst: vi.fn().mockResolvedValue({ type: 'CREDIT' }) },
    pharmacySale: { findFirst: vi.fn().mockResolvedValue({ customerId: 'customer-a' }) },
    pharmacyFamilyAccount: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'family-a',
        displayName: 'Family',
        creditLimitMinor: 100,
        active: true,
      }),
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
    pharmacyDrawerSession: {
      findFirst: vi.fn().mockResolvedValue({ id: 'drawer-a' }),
    },
    pharmacyDrawerMovement: { create: vi.fn().mockResolvedValue({}) },
    financeJournalEntry: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'journal-a' }),
      findFirstOrThrow: vi.fn().mockResolvedValue({ id: 'journal-a', lines: [] }),
    },
    financeJournalLine: { create: vi.fn().mockResolvedValue({}) },
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
describe('Khata router trust and recovery boundary', () => {
  it('adds a cash Khata collection to the actor drawer without trusting a client device', async () => {
    const f = fixture();
    f.db.pharmacyKhataEvent.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: 'charge-a', kind: 'CHARGE', amountMinor: 250, occurredAt: new Date() },
    ] as never);
    f.db.pharmacyKhataEvent.create.mockResolvedValue({ id: 'payment-a', amountMinor: 250 } as never);

    await f.caller().settleFamilyKhata({
      branchId: 'branch-a',
      familyAccountId: 'family-a',
      amountMinor: 250,
      paymentMethod: 'CASH',
      idempotencyKey: 'collection-a',
    });

    expect(f.db.pharmacyDrawerSession.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ openedByActorId: 'owner-a', status: 'OPEN' }),
      select: { id: true },
    });
    expect(f.db.pharmacyDrawerMovement.create).toHaveBeenCalledWith({ data: {
      organizationId: 'org-a',
      drawerSessionId: 'drawer-a',
      kind: 'CASH_SALE',
      amountMinor: 250,
      reason: 'Khata cash collection',
      actorId: 'owner-a',
    } });
    expect(f.db.financeJournalLine.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ accountCode: 'CASH', side: 'DEBIT', amountMinor: 250 }),
    });
    expect(foldExpectedCash([
      { kind: 'OPENING_FLOAT', amountMinor: 1_000 },
      { kind: 'CASH_SALE', amountMinor: 250 },
    ])).toBe(1_250);
  });

  it.each(['CARD', 'BANK_TRANSFER', 'WALLET'] as const)('posts a %s Khata collection to bank and not the cash drawer', async (paymentMethod) => {
    const f = fixture();
    f.db.pharmacyKhataEvent.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: 'charge-a', kind: 'CHARGE', amountMinor: 250, occurredAt: new Date() },
    ] as never);
    f.db.pharmacyKhataEvent.create.mockResolvedValue({ id: 'payment-a', amountMinor: 250 } as never);

    await f.caller().settleFamilyKhata({
      branchId: 'branch-a',
      familyAccountId: 'family-a',
      amountMinor: 250,
      paymentMethod,
      idempotencyKey: `collection-${paymentMethod.toLowerCase()}-a`,
    });

    expect(f.db.pharmacyDrawerSession.findFirst).not.toHaveBeenCalled();
    expect(f.db.pharmacyDrawerMovement.create).not.toHaveBeenCalled();
    expect(f.db.financeJournalLine.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ accountCode: 'BANK', side: 'DEBIT', amountMinor: 250 }),
    });
  });

  it.each([1, 99, 100])(
    'allows a cashier with only pharmacy:counter to charge %i minor units within the limit',
    async (amountMinor) => {
      const f = fixture();
      f.user.role = 'EMPLOYEE';
      vi.mocked(can).mockImplementation(async (_subject, action) => action === 'pharmacy:counter');

      await expect(f.caller().tender({ ...input, amountMinor })).resolves.toMatchObject({
        tenderId: 'tender-a',
      });

      expect(can).toHaveBeenCalledWith(
        f.user,
        'pharmacy:counter',
        undefined,
        expect.objectContaining({ db: f.db, source: 'TRPC' })
      );
      expect(can).not.toHaveBeenCalledWith(
        expect.anything(),
        'pharmacy:dispense',
        expect.anything(),
        expect.anything()
      );
      expect(applyPharmacyTender).toHaveBeenCalledTimes(1);
      expect(f.db.pharmacyKhataLimitDecision.create).not.toHaveBeenCalled();
    }
  );

  it.each(['ADMIN', 'EMPLOYEE'])(
    'audits a reason and real history for owner/manager %s',
    async (role) => {
      const f = fixture();
      f.user.role = role;
      vi.mocked(can).mockImplementation(
        async (_s, action) => action === 'pharmacy:counter' || action === 'pharmacy:manage'
      );
      const charge = {
        id: 'history-charge',
        kind: 'CHARGE',
        amountMinor: 50,
        occurredAt: new Date(Date.now() - 20 * 86400000),
        dueAt: new Date(Date.now() - 10 * 86400000),
      };
      f.db.pharmacyKhataEvent.findMany.mockResolvedValue([charge] as never);
      await f.caller().tender({
        ...input,
        amountMinor: 101,
        ownerOverride: true,
        overrideReason: '  Emergency approved  ',
      });
      expect(f.db.pharmacyKhataEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: 'org-a',
            branchId: 'branch-a',
            familyAccountId: 'family-a',
            occurredAt: { gte: expect.any(Date), lte: expect.any(Date) },
          }),
        })
      );
      const decision = f.db.pharmacyKhataLimitDecision.create.mock.calls[0]![0].data;
      expect(decision).toMatchObject({
        organizationId: 'org-a',
        branchId: 'branch-a',
        saleId: 'sale-a',
        kind: 'OVERRIDDEN',
        ownerActorId: 'owner-a',
        score: 88,
        reasons: {
          reasons: expect.arrayContaining([
            '1 charge(s) in the stated window',
            '1 overdue unsettled charge(s)',
            'Charge amount: 101 minor units',
            'Credit limit before override: 100 minor units',
            'Override reason: Emergency approved',
          ]),
        },
      });
      expect(decision.windowEnd.getTime() - decision.windowStart.getTime()).toBe(180 * 86400000);
      expect(applyPharmacyTender).toHaveBeenCalledTimes(1);
    }
  );

  it('allows a manager override with a reason and audits actor, customer and excess amount', async () => {
    const f = fixture();
    f.user.role = 'EMPLOYEE';
    vi.mocked(can).mockImplementation(
      async (_subject, action) => action === 'pharmacy:counter' || action === 'pharmacy:manage'
    );

    await expect(
      f.caller().tender({
        ...input,
        amountMinor: 125,
        ownerOverride: true,
        overrideReason: '  Manager approved essential medicine  ',
      })
    ).resolves.toMatchObject({ tenderId: 'tender-a' });

    expect(annotateAudit).toHaveBeenCalledWith(
      f.context,
      expect.objectContaining({
        action: 'khata_credit_limit_override',
        targetType: 'PharmacyCustomer',
        targetId: 'customer-a',
        metadata: expect.objectContaining({
          actorId: 'owner-a',
          customerId: 'customer-a',
          familyAccountId: 'family-a',
          amountOverLimitMinor: 25,
          reason: 'Manager approved essential medicine',
        }),
      })
    );
    expect(applyPharmacyTender).toHaveBeenCalledTimes(1);
    expect(f.db.pharmacyFamilyAccount.update).not.toHaveBeenCalled();
  });

  it('refuses a manager override at a branch they are not assigned to', async () => {
    const f = fixture();
    f.user.role = 'EMPLOYEE';
    f.db.pharmacyBranchAssignment.findFirst.mockResolvedValue(null as never);
    vi.mocked(can).mockImplementation(
      async (_subject, action) => action === 'pharmacy:counter' || action === 'pharmacy:manage'
    );

    await expect(
      f.caller().tender({
        ...input,
        amountMinor: 125,
        ownerOverride: true,
        overrideReason: 'Requested from another branch',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.pharmacyKhataLimitDecision.create).not.toHaveBeenCalled();
    expect(applyPharmacyTender).not.toHaveBeenCalled();
  });

  it('refuses a manager override when its reason is blank', async () => {
    const f = fixture();
    f.user.role = 'EMPLOYEE';
    vi.mocked(can).mockImplementation(
      async (_subject, action) => action === 'pharmacy:counter' || action === 'pharmacy:manage'
    );

    await expect(
      f.caller().tender({ ...input, amountMinor: 101, ownerOverride: true, overrideReason: '   ' })
    ).rejects.toBeDefined();
    expect(annotateAudit).not.toHaveBeenCalled();
    expect(applyPharmacyTender).not.toHaveBeenCalled();
  });

  it('keeps a cashier capped at the Khata credit limit even with a reason', async () => {
    const f = fixture();
    f.user.role = 'EMPLOYEE';
    vi.mocked(can).mockImplementation(async (_subject, action) => action === 'pharmacy:counter');

    await expect(
      f.caller().tender({
        ...input,
        amountMinor: 101,
        ownerOverride: true,
        overrideReason: 'Cashier cannot authorize this',
      })
    ).rejects.toMatchObject({ message: 'OWNER_ACTION_REQUIRED' });
    expect(f.db.pharmacyKhataLimitDecision.create).not.toHaveBeenCalled();
    expect(annotateAudit).not.toHaveBeenCalled();
    expect(applyPharmacyTender).not.toHaveBeenCalled();
  });

  it.each(['ADMIN', 'EMPLOYEE'])('requires a reason for owner/manager %s', async (role) => {
    for (const overrideReason of [undefined, '', '   ']) {
      const f = fixture();
      f.user.role = role;
      await expect(
        f.caller().tender({ ...input, amountMinor: 101, ownerOverride: true, overrideReason })
      ).rejects.toBeDefined();
      expect(f.db.pharmacyKhataLimitDecision.create).not.toHaveBeenCalled();
      expect(f.db.pharmacyFamilyAccount.update).not.toHaveBeenCalled();
    }
    expect(applyPharmacyTender).not.toHaveBeenCalled();
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
    await f.caller().tender({
      ...input,
      amountMinor: 101,
      ownerOverride: true,
      overrideReason: 'Trusted customer emergency',
    });
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
      f.caller().tender({
        ...input,
        amountMinor: 101,
        ownerOverride: true,
        overrideReason: 'Trusted customer emergency',
      })
    ).rejects.toMatchObject({ message: 'OWNER_ACTION_REQUIRED' });
    f.user.passwordAuthenticatedAt = Date.now();
    f.user.role = 'EMPLOYEE';
    vi.mocked(can).mockImplementation(async (_s, action) => action !== 'pharmacy:manage');
    await expect(
      f.caller().tender({
        ...input,
        amountMinor: 101,
        ownerOverride: true,
        overrideReason: 'Trusted customer emergency',
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
        .tender({ ...input, ownerOverride: true, overrideReason: 'Trusted customer emergency' })
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
    vi.mocked(can).mockResolvedValue(false);
    await expect(f.caller().tender(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
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
