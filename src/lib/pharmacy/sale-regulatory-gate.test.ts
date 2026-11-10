import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', () => ({ recordAudit: vi.fn() }));
vi.mock('./regulatory', async (original) => ({
  ...(await original<typeof import('./regulatory')>()),
  assertStoredPharmacyMayOperate: vi.fn(),
}));

import { redeemSalePoints } from './customer-loyalty';
import { assertStoredPharmacyMayOperate, BranchOperationDeniedError } from './regulatory';
import { createSale } from './sales';
import { applyPharmacyTender } from './settlement';

/**
 * The regulatory gate lives in the shared sale/settlement operations, so every
 * caller (counter router, loyalty redemption, offline replay, customer orders,
 * delivery, payment sandbox) is refused before any write.
 */
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'actor-a' };
const denied = new BranchOperationDeniedError('ORGANIZATION_NOT_ACTIVE');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(assertStoredPharmacyMayOperate).mockRejectedValue(denied);
});

describe('shared pharmacy sale operations enforce the persisted regulatory gate', () => {
  it('createSale refuses before creating a sale', async () => {
    const db = { pharmacySale: { create: vi.fn() }, pharmacySaleEvent: { create: vi.fn() } };

    await expect(createSale(db as never, scope)).rejects.toBe(denied);
    expect(assertStoredPharmacyMayOperate).toHaveBeenCalledWith(db, 'org-a', 'branch-a', {
      name: 'pharmacy.sale.create',
    });
    expect(db.pharmacySale.create).not.toHaveBeenCalled();
    expect(db.pharmacySaleEvent.create).not.toHaveBeenCalled();
  });

  it('createSale refuses a quotation too', async () => {
    const db = { pharmacySale: { create: vi.fn() } };

    await expect(createSale(db as never, scope, true)).rejects.toBe(denied);
    expect(db.pharmacySale.create).not.toHaveBeenCalled();
  });

  it('applyPharmacyTender refuses before the day lock, sale lock or any tender write', async () => {
    let payloadHash = '';
    const db = {
      $executeRaw: vi.fn(async (sql: { values: unknown[] }) => {
        payloadHash = String(sql.values[5]);
        return 1;
      }),
      pharmacyMoneyIdempotencyKey: {
        findUnique: vi.fn(async () => ({ commandType: 'tender', payloadHash, resultPayload: null })),
      },
      $queryRaw: vi.fn(async () => []),
      pharmacySale: { findFirst: vi.fn() },
      pharmacyTender: { create: vi.fn() },
    };

    await expect(
      applyPharmacyTender(db as never, scope, {
        saleId: 'sale-a',
        deviceId: 'device-a',
        businessDate: new Date('2026-10-01T00:00:00.000Z'),
        type: 'CASH',
        amountMinor: 100,
        idempotencyKey: 'tender-a',
      })
    ).rejects.toBe(denied);
    expect(assertStoredPharmacyMayOperate).toHaveBeenCalledWith(db, 'org-a', 'branch-a', {
      name: 'pharmacy.sale.tender',
    });
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.pharmacySale.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyTender.create).not.toHaveBeenCalled();
  });

  it('redeemSalePoints refuses before reading the sale or writing a points tender', async () => {
    const db = {
      $queryRaw: vi.fn(async () => []),
      pharmacyLoyaltyPointsEntry: { findUnique: vi.fn(async () => null), create: vi.fn() },
      pharmacySale: { findFirst: vi.fn() },
      pharmacyTender: { create: vi.fn() },
    };

    await expect(
      redeemSalePoints(db as never, scope, {
        saleId: 'sale-a',
        points: 2,
        deviceId: 'device-a',
        businessDate: new Date('2026-10-01T00:00:00.000Z'),
        idempotencyKey: 'redeem-a',
      })
    ).rejects.toBe(denied);
    expect(assertStoredPharmacyMayOperate).toHaveBeenCalledWith(db, 'org-a', 'branch-a', {
      name: 'pharmacy.sale.tender',
    });
    expect(db.pharmacySale.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyTender.create).not.toHaveBeenCalled();
    expect(db.pharmacyLoyaltyPointsEntry.create).not.toHaveBeenCalled();
  });
});
