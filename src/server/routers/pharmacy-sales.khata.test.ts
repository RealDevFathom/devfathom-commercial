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
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(),
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
    f.user.passwordAuthenticatedAt -= 301000;
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
