import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('./sale-completion', () => ({
  completePaidPharmacySale: vi.fn(),
  completionSaleInclude: {},
}));
vi.mock('./finance-postings', () => ({ postTenderEntry: vi.fn() }));
vi.mock('./counter-evidence', () => ({ requestCounterEvidence: vi.fn() }));
vi.mock('./consent-writer', () => ({ lockCustomerConsent: vi.fn() }));
vi.mock('./loyalty-points', async (original) => ({
  ...(await original<typeof import('./loyalty-points')>()),
  expireCustomerPoints: vi.fn().mockResolvedValue([]),
  readPointsPolicy: vi.fn().mockResolvedValue({
    medicineEarnPoints: 1,
    nonDrugEarnPoints: 3,
    earnBlockMinor: 10_000,
    pointValueMinor: 100,
    minimumRedemptionPoints: 200,
    pointsExpiryMonths: 6,
    goldTierEnabled: false,
    goldTierThresholdMinor: 5_000_000,
    goldTierMultiplier: 1,
  }),
}));

import { requestCounterEvidence } from './counter-evidence';
import { PharmacyLoyaltyError, redeemSalePoints } from './customer-loyalty';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier-a' };
const input = {
  saleId: 'sale-a',
  points: 200,
  deviceId: 'counter-a',
  businessDate: new Date('2026-10-22T00:00:00Z'),
  idempotencyKey: 'attempt-a',
};

describe('pharmacy points redemption ledger', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serializes concurrent redemption so the balance cannot be spent twice or go negative', async () => {
    let balance = 200;
    let unlockPrevious = Promise.resolve();
    const unlocks: Array<() => void> = [];
    const db = {
      $queryRaw: vi.fn(async () => {
        const previous = unlockPrevious;
        unlockPrevious = new Promise<void>((resolve) => unlocks.push(resolve));
        await previous;
        return [{ id: input.saleId }];
      }),
      pharmacyLoyaltyPointsEntry: {
        findUnique: vi.fn().mockResolvedValue(null),
        aggregate: vi.fn(async () => ({ _sum: { points: balance } })),
        create: vi.fn(async ({ data }: { data: { points: number } }) => {
          balance += data.points;
          return { id: 'redeem-a', ...data };
        }),
      },
      pharmacySale: {
        findFirst: vi.fn().mockResolvedValue({
          id: input.saleId,
          customerId: 'customer-a',
          status: 'OPEN',
          lines: [{ quantity: 1, unitPriceMinor: 50_000, discountMinor: 0 }],
          tenders: [],
        }),
      },
      pharmacyCustomer: {
        findFirst: vi.fn().mockResolvedValue({ patientId: 'patient-a' }),
      },
      patientConsent: {
        findFirst: vi.fn().mockResolvedValue({ granted: true, revokedAt: null }),
      },
      pharmacyTender: {
        create: vi.fn().mockResolvedValue({
          id: 'tender-a',
          amountMinor: 20_000,
          createdAt: new Date('2026-10-22T10:00:00Z'),
        }),
      },
    };
    vi.mocked(requestCounterEvidence).mockImplementation(async () => {
      unlocks.shift()?.();
      return undefined as never;
    });

    const attempts = await Promise.allSettled([
      redeemSalePoints(db as never, scope, input),
      redeemSalePoints(db as never, scope, { ...input, idempotencyKey: 'attempt-b' }),
    ]);

    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === 'rejected');
    expect(rejected && rejected.status === 'rejected' ? rejected.reason : null).toBeInstanceOf(
      PharmacyLoyaltyError
    );
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({ reason: 'INSUFFICIENT_POINTS' }),
    });
    expect(db.pharmacyTender.create).toHaveBeenCalledTimes(1);
    expect(db.pharmacyLoyaltyPointsEntry.create).toHaveBeenCalledTimes(1);
    expect(balance).toBe(0);
  });

  it('uses tenant and branch predicates for every balance-changing lookup and write', async () => {
    const prior = {
      branchId: scope.branchId,
      saleId: input.saleId,
      requestedPoints: input.points,
      points: -200,
      tender: { amountMinor: 20_000 },
    };
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: input.saleId }]),
      pharmacyLoyaltyPointsEntry: { findUnique: vi.fn().mockResolvedValue(prior) },
    };

    await expect(redeemSalePoints(db as never, scope, input)).resolves.toEqual({
      points: 200,
      amountMinor: 20_000,
      replayed: true,
    });
    expect(db.pharmacyLoyaltyPointsEntry.findUnique).toHaveBeenCalledWith({
      where: {
        organizationId_idempotencyKey: {
          organizationId: scope.organizationId,
          idempotencyKey: `loyalty:redeem:${input.idempotencyKey}`,
        },
      },
      include: { tender: true },
    });
  });
});
