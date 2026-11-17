import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  move: vi.fn(),
  pin: vi.fn(),
  earn: vi.fn(),
  post: vi.fn(),
  complete: vi.fn(),
}));
vi.mock('./prepaid-tiers', async () => ({
  ...(await vi.importActual<typeof import('./prepaid-tiers')>('./prepaid-tiers')),
  movePrepaid: mocks.move,
  assertPrepaidPin: mocks.pin,
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
import { applyPharmacyTender, refundPharmacyTender } from './settlement';
import { PrepaidPinError } from './prepaid-tiers';
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
            createdAt: new Date('2026-11-17T08:00:00Z'),
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
const withPin = { prepaidPin: '4821' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.pin.mockResolvedValue(undefined);
  mocks.move.mockResolvedValue({});
  mocks.complete.mockResolvedValue(41);
});
describe('prepaid wallet at the counter', () => {
  it('settles the discounted total, debits the wallet once and still earns points', async () => {
    const db = fixture();
    await expect(
      applyPharmacyTender(db as never, scope, input, undefined, withPin)
    ).resolves.toMatchObject({
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
    await expect(
      applyPharmacyTender(db as never, scope, input, undefined, withPin)
    ).rejects.toThrow('Insufficient');
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.earn).not.toHaveBeenCalled();
  });
  it('never spends a prepaid balance without the customer’s own PIN', async () => {
    const db = fixture();
    mocks.pin.mockRejectedValueOnce(new PrepaidPinError());
    await expect(applyPharmacyTender(db as never, scope, input)).rejects.toBeInstanceOf(
      PrepaidPinError
    );
    expect(mocks.pin).toHaveBeenCalledWith(db, 'org-a', 'customer-a', undefined);
    expect(db.pharmacyTender.create).not.toHaveBeenCalled();
    expect(mocks.move).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    mocks.pin.mockClear();
    await applyPharmacyTender(db as never, scope, input, undefined, withPin);
    expect(mocks.pin).toHaveBeenCalledWith(db, 'org-a', 'customer-a', '4821');
  });
  it('refuses a cash fallback on a prepaid refund instead of paying cash and crediting the balance', async () => {
    const refund = {
      originalTenderId: 'tender-a',
      deviceId: 'counter-a',
      businessDate: new Date('2026-11-17'),
      amountMinor: 980,
      reason: 'Returned',
      idempotencyKey: 'refund-123',
      manualCashFallback: true,
    };
    const db = {
      ...fixture(),
      pharmacyMoneyIdempotencyKey: {
        findUnique: vi.fn(async () => ({
          id: 'key-b',
          commandType: 'refund',
          payloadHash: createHash('sha256').update(JSON.stringify(refund)).digest('hex'),
          resultPayload: null,
        })),
        update: vi.fn(),
      },
      pharmacyTender: {
        findFirst: vi.fn(async () => ({
          id: 'tender-a',
          saleId: 'sale-a',
          type: 'WALLET',
          provider: 'CUSTOMER_PREPAID',
          amountMinor: 980,
          providerRef: null,
          refunds: [],
          sale: { customerId: 'customer-a', status: 'OPEN' },
        })),
      },
      pharmacySale: { findFirst: vi.fn(async () => null), count: vi.fn(async () => 1) },
      pharmacyRefund: { create: vi.fn() },
    };
    await expect(refundPharmacyTender(db as never, scope, refund)).rejects.toThrow(
      'PREPAID_REFUND_RESTORES_BALANCE'
    );
    expect(db.pharmacyRefund.create).not.toHaveBeenCalled();
    expect(db.pharmacyDrawerMovement.create).not.toHaveBeenCalled();
    expect(mocks.move).not.toHaveBeenCalled();
  });
});
