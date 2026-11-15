import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redeemSalePoints } from './customer-loyalty';
import { postSaleLineEntry, postTenderEntry } from './finance-postings';
import { requestCounterEvidence } from './counter-evidence';

vi.mock('./finance-postings', () => ({ postSaleLineEntry: vi.fn(), postTenderEntry: vi.fn() }));
vi.mock('./counter-evidence', () => ({ requestCounterEvidence: vi.fn() }));
// #659: the batch re-check has its own PostgreSQL suite (sale-batch-safety.db.test.ts).
vi.mock('./sale-batch-safety', () => ({ assertSaleBatchesSellable: vi.fn(async () => new Map()) }));
vi.mock('./regulatory', async (original) => ({
  ...(await original<typeof import('./regulatory')>()),
  assertStoredPharmacyMayOperate: vi.fn(async () => undefined),
}));

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'actor-a' };
const input = {
  saleId: 'sale-a',
  points: 2,
  deviceId: 'device-a',
  businessDate: new Date('2026-10-08'),
  idempotencyKey: 'ordinary-a',
};
function fixture() {
  const line = {
    id: 'line-a',
    ...scope,
    medicineId: 'medicine-a',
    presentationId: 'presentation-a',
    quantity: 1,
    canonicalUnits: 1,
    unitPriceMinor: 200,
    grossMinor: 200,
    discountMinor: 0,
    medicine: {
      organizationId: scope.organizationId,
      productName: 'Synthetic item',
      strengths: [],
    },
    presentation: {
      organizationId: scope.organizationId,
      medicineId: 'medicine-a',
      presentation: 'Tablet',
    },
    allocations: [
      {
        id: 'allocation-a',
        ...scope,
        inventoryLotId: 'lot-a',
        canonicalUnits: 1,
        lot: {
          ...scope,
          batch: {
            organizationId: scope.organizationId,
            medicineId: 'medicine-a',
            batchNumber: 'synthetic-a',
            expiresAt: new Date('2030-01-01'),
          },
        },
      },
    ],
  };
  const sale = {
    id: input.saleId,
    ...scope,
    customerId: 'customer-a',
    status: 'OPEN',
    lines: [line],
    tenders: [],
  };
  const db = {
    $queryRaw: vi
      .fn()
      .mockImplementation(async (q) =>
        q.strings.join('').includes('receipt_number_sequences')
          ? [{ receipt_number: 42 }]
          : [{ id: sale.id, patientId: 'patient-a' }]
      ),
    pharmacySale: { findFirst: vi.fn().mockResolvedValue(sale), update: vi.fn() },
    pharmacyCustomer: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: 'customer-a', patientId: 'patient-a', active: true }),
    },
    patientConsent: { findFirst: vi.fn().mockResolvedValue({ granted: true, revokedAt: null }) },
    pharmacyTender: {
      create: vi.fn().mockResolvedValue({ id: 'tender-a', createdAt: new Date() }),
    },
    pharmacySaleEvent: { create: vi.fn() },
    // DEV-764: redemption reads the redemption value in force; none set means PKR 1 per point.
    pharmacyLoyaltyProgramVersion: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyLoyaltyPointsEntry: {
      findUnique: vi.fn().mockResolvedValue(null),
      aggregate: vi.fn().mockResolvedValue({ _sum: { points: 10 } }),
      // DEV-764: no lot past expiry, so the whole balance can be spent.
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
    },
  };
  return { db, sale };
}
describe('ordinary loyalty settlement completion (held policy fixtures excluded)', () => {
  beforeEach(() => vi.clearAllMocks());
  it('refuses revoked consent before tender or point writes', async () => {
    const { db } = fixture();
    db.patientConsent.findFirst.mockResolvedValue({ granted: false, revokedAt: null });
    await expect(redeemSalePoints(db as never, scope, input)).rejects.toThrow(
      'LOYALTY_CONSENT_REQUIRED'
    );
    expect(db.pharmacyTender.create).not.toHaveBeenCalled();
    expect(db.pharmacyLoyaltyPointsEntry.create).not.toHaveBeenCalled();
  });
  it('posts redemption and sale, freezes receipt allocation identity, requests evidence', async () => {
    const { db } = fixture();
    expect(await redeemSalePoints(db as never, scope, input)).toMatchObject({
      settled: true,
      receiptNumber: 42,
    });
    expect(postTenderEntry).toHaveBeenCalledWith(
      db,
      scope,
      expect.objectContaining({ tenderId: 'tender-a' })
    );
    expect(postSaleLineEntry).toHaveBeenCalledWith(
      db,
      scope,
      expect.objectContaining({ saleLineId: 'line-a' })
    );
    expect(db.pharmacySaleEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'COMPLETED',
          payload: expect.objectContaining({
            receiptIdentitySnapshotVersion: 1,
            receiptNumber: 42,
          }),
        }),
      })
    );
    expect(requestCounterEvidence).toHaveBeenCalledWith(db, scope, {
      kind: 'TENDER',
      subjectId: 'tender-a',
    });
  });
  it('propagates posting failure to the enclosing transaction', async () => {
    const { db } = fixture();
    vi.mocked(postTenderEntry).mockRejectedValueOnce(new Error('POSTING_FAILED'));
    await expect(redeemSalePoints(db as never, scope, input)).rejects.toThrow('POSTING_FAILED');
    expect(db.pharmacySale.update).not.toHaveBeenCalled();
  });
  it('rechecks committed replay after waiting for the sale lock', async () => {
    const { db } = fixture();
    db.$queryRaw.mockImplementationOnce(async () => {
      db.pharmacyLoyaltyPointsEntry.findUnique.mockResolvedValue({
        saleId: input.saleId,
        branchId: scope.branchId,
        requestedPoints: 2,
        points: -2,
        tender: { amountMinor: 200 },
      });
      return [{ id: input.saleId }];
    });
    expect(await redeemSalePoints(db as never, scope, input)).toMatchObject({ replayed: true });
    expect(db.pharmacyTender.create).not.toHaveBeenCalled();
  });
});

describe('DEV-764 redemption at the owner-set point value', () => {
  beforeEach(() => vi.clearAllMocks());
  it('takes the current redemption value off the bill, not a fixed PKR 1', async () => {
    const { db } = fixture();
    // PKR 0.50 a point: 2 points take PKR 1 (100 minor) off a PKR 2 bill.
    db.pharmacyLoyaltyProgramVersion.findFirst.mockResolvedValue({
      id: 'program-2',
      redemptionValueMinor: 50,
    });
    expect(await redeemSalePoints(db as never, scope, input)).toMatchObject({
      points: 2,
      amountMinor: 100,
      settled: false,
    });
    expect(db.pharmacyTender.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'LOYALTY', amountMinor: 100 }),
    });
    expect(db.pharmacyLoyaltyPointsEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'REDEEM', points: -2, requestedPoints: 2 }),
    });
  });
});

describe('DEV-764 points past expiry cannot be redeemed before the sweep', () => {
  beforeEach(() => vi.clearAllMocks());
  it('refuses to spend points of a lot already past its expiry date', async () => {
    const { db } = fixture();
    // 10 points in the balance, all from one lot that expired yesterday and is not yet swept.
    db.pharmacyLoyaltyPointsEntry.count.mockResolvedValue(1);
    Object.assign(db.pharmacyLoyaltyPointsEntry, {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'earn-a',
          kind: 'EARN',
          points: 10,
          saleId: 'sale-old',
          tenderId: null,
          programVersionId: 'program-1',
          reversesEntryId: null,
          expiresAt: new Date(Date.now() - 86_400_000),
          occurredAt: new Date(Date.now() - 40 * 86_400_000),
        },
      ]),
    });
    await expect(redeemSalePoints(db as never, scope, input)).rejects.toThrow(
      'INSUFFICIENT_POINTS'
    );
    expect(db.pharmacyTender.create).not.toHaveBeenCalled();
    expect(db.pharmacyLoyaltyPointsEntry.create).not.toHaveBeenCalled();
  });
});
