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
    user: {
      findUnique: vi.fn().mockResolvedValue({
        status: 'ACTIVE',
        organizationId: 'org-a',
        organizationRole: {
          permissions: [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }],
        },
        permissionOverrides: [],
      }),
    },
    pharmacyBranchAssignment: {
      findMany: vi.fn().mockResolvedValue([{ branchId: 'branch-a' }]),
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

  it.each(['capability', 'assignment'])(
    'denies a Khata refund without %s before ledger writes',
    async (missing) => {
      const f = fixture();
      f.user.role = 'EMPLOYEE';
      if (missing === 'capability') {
        f.db.user.findUnique.mockResolvedValue({
          status: 'ACTIVE',
          organizationId: 'org-a',
          organizationRole: { permissions: [] },
          permissionOverrides: [],
        });
      } else {
        f.db.pharmacyBranchAssignment.findMany.mockResolvedValue([]);
      }

      await expect(
        f.caller().refundTender({
          branchId: 'branch-a',
          originalTenderId: 'tender-a',
          deviceId: 'device-a',
          businessDate: input.businessDate,
          amountMinor: 50,
          reason: 'Return',
          idempotencyKey: 'refund-denied',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.$transaction).not.toHaveBeenCalled();
      expect(refundPharmacyTender).not.toHaveBeenCalled();
      expect(f.db.pharmacyKhataEvent.create).not.toHaveBeenCalled();
    }
  );
});
