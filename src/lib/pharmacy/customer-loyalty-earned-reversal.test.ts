import { TRPCError } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';
import { reverseRefundedEarnedPoints } from './customer-loyalty-earned-reversal';

vi.mock('./consent-writer', () => ({ lockCustomerConsent: vi.fn() }));
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'actor-a' };
function fixture(refunded = 475, priorPoints = 0) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'sale-a' }]),
    pharmacyRefund: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'refund-a',
        saleId: 'sale-a',
        originalTenderId: 'tender-a',
        sale: { customerId: 'customer-a' },
        originalTender: { type: 'CASH', saleId: 'sale-a', branchId: scope.branchId },
      }),
      aggregate: vi.fn().mockResolvedValue({ _sum: { amountMinor: refunded } }),
    },
    pharmacyLoyaltyPointsEntry: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue({ points: 9, netPaidMinor: 950 }),
      aggregate: vi.fn().mockResolvedValue({ _sum: { points: priorPoints } }),
      create: vi.fn().mockImplementation(async ({ data }) => ({ id: 'reversal-a', ...data })),
    },
  };
}

describe('ordinary earned-point refund allocation', () => {
  it.each([
    [475, 0, -5, 475],
    [950, -5, -4, 0],
    [50, 0, 0, 900],
    [51, 0, -1, 899],
  ])(
    'allocates cumulative money %i after prior points %i',
    async (money, prior, points, remaining) => {
      const db = fixture(money, prior);
      const result = await reverseRefundedEarnedPoints(db as never, scope, 'refund-a');
      if (!points) {
        expect(result).toBeNull();
        expect(db.pharmacyLoyaltyPointsEntry.create).not.toHaveBeenCalled();
      } else
        expect(result).toMatchObject({
          ...scope,
          saleId: 'sale-a',
          customerId: 'customer-a',
          refundId: 'refund-a',
          tenderId: 'tender-a',
          kind: 'EARN_REVERSAL',
          points,
          netPaidMinor: remaining,
          replayed: false,
        });
      expect(db.pharmacyRefund.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            saleId: 'sale-a',
            originalTender: { type: { not: 'LOYALTY' } },
          },
        })
      );
    }
  );
  it('replays the exact refund without another delta', async () => {
    const db = fixture();
    const prior = {
      saleId: 'sale-a',
      customerId: 'customer-a',
      branchId: scope.branchId,
      refundId: 'refund-a',
      points: -5,
    };
    db.pharmacyLoyaltyPointsEntry.findUnique.mockResolvedValue(prior);
    expect(await reverseRefundedEarnedPoints(db as never, scope, 'refund-a')).toEqual({
      ...prior,
      replayed: true,
    });
    expect(db.pharmacyLoyaltyPointsEntry.create).not.toHaveBeenCalled();
  });
  it('rejects foreign or absent refunds before loyalty writes', async () => {
    const db = fixture();
    db.pharmacyRefund.findFirst.mockResolvedValue(null);
    await expect(reverseRefundedEarnedPoints(db as never, scope, 'foreign')).rejects.toThrow(
      'unavailable'
    );
    expect(db.pharmacyLoyaltyPointsEntry.create).not.toHaveBeenCalled();
  });
  it('excludes loyalty tender restoration from earned reversal', async () => {
    const db = fixture();
    const refund = await db.pharmacyRefund.findFirst();
    refund.originalTender.type = 'LOYALTY';
    expect(await reverseRefundedEarnedPoints(db as never, scope, 'refund-a')).toBeNull();
    expect(db.pharmacyRefund.aggregate).not.toHaveBeenCalled();
  });
  it('refuses a historical earn basis inconsistent with the existing curve', async () => {
    const db = fixture();
    db.pharmacyLoyaltyPointsEntry.findFirst.mockResolvedValue({ points: 10, netPaidMinor: 950 });
    await expect(reverseRefundedEarnedPoints(db as never, scope, 'refund-a')).rejects.toThrow(
      'accounting review'
    );
    expect(db.pharmacyLoyaltyPointsEntry.create).not.toHaveBeenCalled();
  });
});

describe('an earn basis that needs accounting review', () => {
  it.each([
    ['no recorded net paid', { points: 9, netPaidMinor: null }],
    ['points that do not match it', { points: 12, netPaidMinor: 950 }],
  ])('stops the refund with %s, as a refusal the operator reads', async (_label, earn) => {
    const db = fixture();
    db.pharmacyLoyaltyPointsEntry.findFirst.mockResolvedValue(earn as never);
    const refused = reverseRefundedEarnedPoints(db as never, scope, 'refund-a');
    // A deliberate TRPCError, so a production client still reads the sentence.
    await expect(refused).rejects.toBeInstanceOf(TRPCError);
    await expect(refused).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Earn basis requires accounting review.',
    });
    expect(db.pharmacyLoyaltyPointsEntry.create).not.toHaveBeenCalled();
  });
});
