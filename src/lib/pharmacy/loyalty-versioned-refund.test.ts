import { describe, expect, it, vi } from 'vitest';
import { reverseVersionedEarns } from './loyalty-versioned-refund';
vi.mock('server-only', () => ({}));
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'owner-a' };
function fixture(credit = false, refund = 15_000, reversed = 0) {
  return {
    pharmacyKhataEvent: {
      findFirst: vi
        .fn()
        .mockResolvedValue({
          id: 'payment-a',
          familyAccountId: 'family-a',
          settlesChargeId: 'khata:credit-a',
        }),
      findMany: vi
        .fn()
        .mockResolvedValue([
          {
            id: 'payment-a',
            kind: 'PAYMENT',
            settlesChargeId: 'khata:credit-a',
            amountMinor: 100_000,
          },
        ]),
    },
    pharmacyLoyaltyPointsEntry: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'earn-a',
          idempotencyKey: 'loyalty:collection:payment-a',
          points: 10,
          netPaidMinor: 100_000,
          programVersionId: 'old-rate',
          programVersion: { mode: 'PERCENT', rewardPoints: 1, spendMinor: 10_000 },
          collectionId: credit ? 'receipt-a' : null,
          tenderId: credit ? 'credit-a' : null,
          earnStartMinor: 0,
          tender: credit ? { amountMinor: 1_000_000 } : null,
        },
      ]),
      aggregate: vi.fn().mockResolvedValue({ _sum: { points: reversed } }),
      create: vi.fn().mockImplementation(async ({ data }) => data),
    },
    pharmacyRefund: { aggregate: vi.fn().mockResolvedValue({ _sum: { amountMinor: refund } }) },
  };
}
const input = { refundId: 'refund-a', saleId: 'sale-a', customerId: 'customer-a' };
describe('DEV-746 immutable earning refund curves', () => {
  it('uses the earning version, not a newly configured rate', async () => {
    const db = fixture();
    expect(await reverseVersionedEarns(db as never, scope, input)).toEqual([
      expect.objectContaining({
        points: -2,
        netPaidMinor: 85_000,
        programVersionId: 'old-rate',
      }),
    ]);
    expect(db.pharmacyRefund.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          originalTender: { type: { notIn: ['LOYALTY', 'CREDIT'] } },
        }),
      })
    );
  });
  it('does not claw back collected points when only unpaid debt was cancelled', async () => {
    const db = fixture(true, 200_000);
    expect(await reverseVersionedEarns(db as never, scope, input)).toEqual([]);
  });
  it('caps remaining collected eligibility at refunded tender value and posts only the delta', async () => {
    const db = fixture(true, 950_000, -2);
    expect(await reverseVersionedEarns(db as never, scope, input)).toEqual([
      expect.objectContaining({ points: -3, netPaidMinor: 50_000, collectionId: 'receipt-a' }),
    ]);
  });
  it('replays without a second reversal and never restores a reversed receipt earn', async () => {
    const db = fixture(true, 950_000, -10);
    expect(await reverseVersionedEarns(db as never, scope, input)).toEqual([]);
    expect(db.pharmacyLoyaltyPointsEntry.create).not.toHaveBeenCalled();
  });
});
