import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  move: vi.fn(),
  earn: vi.fn(),
  post: vi.fn(),
  complete: vi.fn(),
}));
vi.mock('./prepaid-tiers', async () => ({
  ...(await vi.importActual<typeof import('./prepaid-tiers')>('./prepaid-tiers')),
  movePrepaid: mocks.move,
}));
vi.mock('./customer-loyalty', () => ({
  accrueSalePoints: mocks.earn,
  restoreRefundedLoyaltyPoints: vi.fn(),
}));
vi.mock('./finance-postings', () => ({
  postTenderEntry: mocks.post,
  postTenderRefundEntry: vi.fn(),
  postDailyCloseEntry: vi.fn(),
}));
vi.mock('./sale-completion', () => ({
  completionSaleInclude: {},
  completePaidPharmacySale: mocks.complete,
}));
vi.mock('./sale-batch-safety', () => ({ assertSaleBatchesSellable: vi.fn() }));
vi.mock('./rx-sale-gate', () => ({ assertRxSaleAllowed: vi.fn() }));
vi.mock('./rx-prescription-reference', () => ({ assertRxLinesPrescribed: vi.fn() }));
vi.mock('./regulatory', () => ({ assertStoredPharmacyMayOperate: vi.fn() }));
vi.mock('./counter-evidence', () => ({ requestCounterEvidence: vi.fn() }));
import { applyPharmacyTender } from './settlement';
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier-a' };
const input = {
  saleId: 'sale-a',
  deviceId: 'counter-a',
  type: 'WALLET' as const,
  businessDate: new Date('2026-11-17'),
  amountMinor: 980,
  idempotencyKey: 'wallet-123',
};
function fixture() {
  const db = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    pharmacyMoneyIdempotencyKey: {
      findUnique: vi.fn(async () => ({
        id: 'key-a',
        commandType: 'tender',
        payloadHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
        resultPayload: null,
      })),
      update: vi.fn(),
    },
    pharmacyDailyClose: { findFirst: vi.fn(async () => null) },
    pharmacySale: {
      findFirst: vi.fn(async () => ({
        id: 'sale-a',
        organizationId: 'org-a',
        customerId: 'customer-a',
        status: 'OPEN',
        tenders: [],
        lines: [
          {
            id: 'line-a',
            quantity: 1,
            unitPriceMinor: 1000,
            grossMinor: 1000,
            discountMinor: 0,
            medicine: { rx: false, restricted: false, controlled: false },
            allocations: [
              {
                id: 'alloc-a',
                canonicalUnits: 1,
                grossMinor: 1000,
                discountMinor: 0,
                lot: { unitCostMinor: 800 },
              },
            ],
          },
        ],
      })),
    },
    pharmacyCustomer: {
      findFirst: vi.fn(async () => ({
        prepaidAccount: {
          balanceMinor: 10000,
          tierName: 'Bronze',
          discountBasisPoints: 200,
          tierVersionId: 'tier-v1',
        },
      })),
    },
    pharmacyPrepaidTierVersion: { findFirst: vi.fn(async () => ({ actorId: 'owner-a' })) },
    pharmacySaleLine: { update: vi.fn() },
    pharmacyTender: { create: vi.fn(async () => ({ id: 'tender-a', createdAt: new Date() })) },
    pharmacyDrawerMovement: { create: vi.fn() },
  };
  return db;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.move.mockResolvedValue({});
  mocks.complete.mockResolvedValue(41);
});
describe('prepaid wallet at the counter', () => {
  it('settles the discounted total, debits the wallet once and still earns points', async () => {
    const db = fixture();
    await expect(applyPharmacyTender(db as never, scope, input)).resolves.toMatchObject({
      settled: true,
      remainingMinor: 0,
    });
    expect(db.pharmacyTender.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'WALLET',
        provider: 'CUSTOMER_PREPAID',
        amountMinor: 980,
      }),
    });
    expect(mocks.move).toHaveBeenCalledWith(
      db,
      scope,
      expect.objectContaining({
        kind: 'SPEND',
        customerId: 'customer-a',
        amountMinor: 980,
        tenderId: 'tender-a',
      })
    );
    expect(mocks.earn).toHaveBeenCalledWith(db, scope, 'sale-a');
    expect(db.pharmacyDrawerMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacySaleLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          discountMinor: 20,
          tierDiscountMinor: 20,
          approvedByUserId: 'owner-a',
        }),
      })
    );
  });
  it('cannot complete or post a payment when the wallet debit refuses', async () => {
    const db = fixture();
    mocks.move.mockRejectedValue(new Error('Insufficient prepaid balance'));
    await expect(applyPharmacyTender(db as never, scope, input)).rejects.toThrow('Insufficient');
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.earn).not.toHaveBeenCalled();
  });
});
