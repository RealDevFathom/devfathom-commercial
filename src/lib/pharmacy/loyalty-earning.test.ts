import { describe, expect, it, vi } from 'vitest';
import { accrueSalePoints } from './customer-loyalty';
import { earnCollectedKhata } from './loyalty-collection';
import { loyaltyBalance, configureLoyaltyProgram, loyaltyReconciliation } from './loyalty-program';
vi.mock('server-only', () => ({}));
vi.mock('./consent-writer', () => ({ lockCustomerConsent: vi.fn() }));
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'owner-a' };
function fixture() {
  const program = {
    id: 'version-2',
    version: 2,
    mode: 'PERCENT',
    rewardPoints: 1,
    spendMinor: 10_000,
    khataEnabled: true,
  };
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacyCustomer: { findFirst: vi.fn().mockResolvedValue({ patientId: 'patient-a' }) },
    patientConsent: { findFirst: vi.fn().mockResolvedValue({ granted: true, revokedAt: null }) },
    pharmacyLoyaltyProgramVersion: {
      findFirst: vi.fn().mockResolvedValue(program),
      create: vi.fn(),
    },
    pharmacyLoyaltyMigration: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    pharmacyLoyaltyWallet: {
      findUnique: vi.fn().mockResolvedValue({ points: BigInt(123) }),
      createMany: vi.fn(),
    },
    pharmacyLoyaltyPointsEntry: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }) => data),
      aggregate: vi.fn().mockResolvedValue({ _sum: { points: 12 } }),
    },
    pharmacySale: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'sale-a',
        customerId: 'customer-a',
        tenders: [
          { type: 'CASH', amountMinor: 100_000 },
          { type: 'CREDIT', amountMinor: 500_000 },
          { type: 'LOYALTY', amountMinor: 10_000 },
        ],
      }),
    },
    pharmacyTender: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'tender-a',
        saleId: 'sale-a',
        amountMinor: 500_000,
        sale: { customerId: 'customer-a' },
      }),
    },
    pharmacyKhataEvent: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'payment-a',
        familyAccountId: 'family-a',
        settlesChargeId: 'khata:tender-a',
        amountMinor: 50_000,
      }),
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'payment-a',
          kind: 'PAYMENT',
          settlesChargeId: 'khata:tender-a',
          amountMinor: 50_000,
        },
      ]),
    },
  };
}

describe('DEV-746 earning at the right time', () => {
  it('uses the owner rate and excludes unpaid credit and redeemed points at sale time', async () => {
    const db = fixture();
    expect(await accrueSalePoints(db as never, scope, 'sale-a')).toMatchObject({
      points: 10,
      netPaidMinor: 100_000,
      programVersionId: 'version-2',
    });
    expect(db.patientConsent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-a', patientId: 'patient-a', purpose: 'LOYALTY' },
      })
    );
  });
  it.each(['missing', 'revoked', 'unconfigured'])(
    'does not earn with %s consent or setup',
    async (condition) => {
      const db = fixture();
      if (condition === 'missing') db.patientConsent.findFirst.mockResolvedValue(null);
      if (condition === 'revoked')
        db.patientConsent.findFirst.mockResolvedValue({ granted: true, revokedAt: new Date() });
      if (condition === 'unconfigured')
        db.pharmacyLoyaltyProgramVersion.findFirst.mockResolvedValue(null);
      expect(await accrueSalePoints(db as never, scope, 'sale-a')).toBeNull();
      expect(db.pharmacyLoyaltyPointsEntry.create).not.toHaveBeenCalled();
    }
  );
  it('earns only on a partial collection with its immutable rate and receipt identity', async () => {
    const db = fixture();
    expect(await earnCollectedKhata(db as never, scope, 'payment-a', 'receipt-a')).toMatchObject({
      points: 5,
      netPaidMinor: 50_000,
      earnStartMinor: 0,
      collectionId: 'receipt-a',
      tenderId: 'tender-a',
      programVersionId: 'version-2',
    });
  });
  it.each(['disabled', 'revoked', 'legacy', 'replay'])(
    'prevents duplicate or disallowed collection earning: %s',
    async (condition) => {
      const db = fixture();
      if (condition === 'disabled')
        (await db.pharmacyLoyaltyProgramVersion.findFirst()).khataEnabled = false;
      if (condition === 'revoked')
        db.patientConsent.findFirst.mockResolvedValue({ granted: false, revokedAt: null });
      if (condition === 'legacy')
        db.pharmacyLoyaltyPointsEntry.findFirst.mockResolvedValue({ points: 5000 });
      if (condition === 'replay')
        db.pharmacyLoyaltyPointsEntry.findUnique.mockResolvedValue({ points: 5 });
      await earnCollectedKhata(db as never, scope, 'payment-a', 'receipt-a');
      expect(db.pharmacyLoyaltyPointsEntry.create).not.toHaveBeenCalled();
    }
  );
  it('reads a migrated wallet across branches but always within the organization', async () => {
    const db = fixture();
    db.pharmacyLoyaltyMigration.findUnique.mockResolvedValue({ organizationId: 'org-a' });
    expect(await loyaltyBalance(db as never, 'org-a', 'branch-b', 'customer-a')).toBe(123);
    expect(db.pharmacyLoyaltyWallet.findUnique).toHaveBeenCalledWith({
      where: { organizationId_customerId: { organizationId: 'org-a', customerId: 'customer-a' } },
    });
    expect(db.pharmacyLoyaltyPointsEntry.aggregate).not.toHaveBeenCalled();
  });
  it('preserves branch-local balances until reconciliation is approved', async () => {
    const db = fixture();
    expect(await loyaltyBalance(db as never, 'org-a', 'branch-b', 'customer-a')).toBe(12);
    expect(db.pharmacyLoyaltyPointsEntry.aggregate).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', branchId: 'branch-b', customerId: 'customer-a' },
      _sum: { points: true },
    });
  });
  it('refuses a stale balance approval without writing wallets or a rate', async () => {
    const db = fixture();
    await expect(
      configureLoyaltyProgram(db as never, 'org-a', 'owner-a', {
        mode: 'PERCENT',
        rewardPoints: 1,
        spendMinor: 10_000,
        khataEnabled: true,
        reconciliationDigest: 'stale',
      })
    ).rejects.toThrow('Balances changed');
    expect(db.pharmacyLoyaltyWallet.createMany).not.toHaveBeenCalled();
    expect(db.pharmacyLoyaltyProgramVersion.create).not.toHaveBeenCalled();
  });
  it('migrates each customer sum once and retains a durable branch reconciliation', async () => {
    const db = fixture();
    const totals = [
      { branchId: 'branch-a', customerId: 'customer-a', count: 2, points: '7' },
      { branchId: 'branch-b', customerId: 'customer-a', count: 3, points: '-2' },
    ];
    db.$queryRaw.mockImplementation(async (query) =>
      String(query.strings ?? query).includes('GROUP BY') ? totals : []
    );
    const snapshot = await loyaltyReconciliation(db as never, 'org-a');
    await configureLoyaltyProgram(db as never, 'org-a', 'owner-a', {
      mode: 'STEP',
      rewardPoints: 1,
      spendMinor: 100_000,
      khataEnabled: false,
      reconciliationDigest: snapshot.digest,
    });
    expect(db.pharmacyLoyaltyWallet.createMany).toHaveBeenCalledWith({
      data: [{ organizationId: 'org-a', customerId: 'customer-a', points: BigInt(5) }],
    });
    expect(db.pharmacyLoyaltyMigration.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org-a',
        actorId: 'owner-a',
        sourceCount: 5,
        sourcePoints: BigInt(5),
        branchTotals: totals,
      },
    });
    expect(db.pharmacyLoyaltyPointsEntry.create).not.toHaveBeenCalled();
    db.pharmacyLoyaltyMigration.findUnique.mockResolvedValue({ organizationId: 'org-a' });
    await configureLoyaltyProgram(db as never, 'org-a', 'owner-a', {
      mode: 'STEP',
      rewardPoints: 1,
      spendMinor: 100_000,
      khataEnabled: false,
      reconciliationDigest: snapshot.digest,
    });
    expect(db.pharmacyLoyaltyWallet.createMany).toHaveBeenCalledTimes(1);
  });
});
