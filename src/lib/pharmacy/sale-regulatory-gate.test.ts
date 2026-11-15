import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/audit', () => ({ recordAudit: vi.fn() }));
vi.mock('./regulatory', async (original) => ({
  ...(await original<typeof import('./regulatory')>()),
  assertStoredPharmacyMayOperate: vi.fn(),
}));

import { redeemSalePoints } from './customer-loyalty';
import { assertStoredPharmacyMayOperate, BranchOperationDeniedError } from './regulatory';
import { addReservedSaleLine, addSaleLine, changeSaleStatus, createSale } from './sales';
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

  it('createSale runs a caller precondition only after the gate, and never past a refusal', async () => {
    const db = { pharmacySale: { create: vi.fn() }, pharmacySaleEvent: { create: vi.fn() } };
    const beforeCreate = vi.fn();

    await expect(createSale(db as never, scope, false, beforeCreate)).rejects.toBe(denied);
    expect(beforeCreate).not.toHaveBeenCalled();

    vi.mocked(assertStoredPharmacyMayOperate).mockResolvedValueOnce(undefined);
    const closed = new Error('DRAWER_NOT_OPEN');
    beforeCreate.mockRejectedValueOnce(closed);
    await expect(createSale(db as never, scope, false, beforeCreate)).rejects.toBe(closed);
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
        findUnique: vi.fn(async () => ({
          commandType: 'tender',
          payloadHash,
          resultPayload: null,
        })),
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

  // #414: a sale opened while the licence was valid must not keep dispensing after it lapses.
  const lapsed = new BranchOperationDeniedError('LICENCE_INVALID');
  const lineInput = {
    saleId: 'sale-a',
    medicineId: 'medicine-a',
    presentationId: 'presentation-a',
    packLevelId: 'pack-a',
    saleUnit: 'STRIP',
    quantity: 1,
    canonicalUnitsPerSaleUnit: 10,
    idempotencyKey: 'line-a',
  } as Parameters<typeof addSaleLine>[2];
  const lineDb = () => ({
    pharmacySale: { findFirst: vi.fn(), updateMany: vi.fn() },
    medicine: { findFirst: vi.fn() },
    pharmacyInventoryLot: { findMany: vi.fn() },
    pharmacySaleLine: { create: vi.fn() },
    pharmacySaleLineAllocation: { create: vi.fn() },
    pharmacySaleEvent: { create: vi.fn() },
  });

  it('addSaleLine refuses on an expired licence before reading the sale or allocating stock', async () => {
    vi.mocked(assertStoredPharmacyMayOperate).mockRejectedValue(lapsed);
    const db = lineDb();

    await expect(addSaleLine(db as never, scope, lineInput)).rejects.toBe(lapsed);
    expect(assertStoredPharmacyMayOperate).toHaveBeenCalledWith(db, 'org-a', 'branch-a', {
      name: 'pharmacy.sale.dispense',
    });
    expect(db.pharmacySale.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacySale.updateMany).not.toHaveBeenCalled();
    expect(db.medicine.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacySaleLine.create).not.toHaveBeenCalled();
    expect(db.pharmacySaleLineAllocation.create).not.toHaveBeenCalled();
  });

  it('addReservedSaleLine (customer orders) refuses on an expired licence too', async () => {
    vi.mocked(assertStoredPharmacyMayOperate).mockRejectedValue(lapsed);
    const db = lineDb();

    await expect(addReservedSaleLine(db as never, scope, lineInput, {} as never)).rejects.toBe(
      lapsed
    );
    expect(assertStoredPharmacyMayOperate).toHaveBeenCalledWith(db, 'org-a', 'branch-a', {
      name: 'pharmacy.sale.dispense',
    });
    expect(db.pharmacySale.updateMany).not.toHaveBeenCalled();
    expect(db.pharmacySaleLine.create).not.toHaveBeenCalled();
  });

  it.each([
    ['resume', 'HELD'],
    ['convertQuotation', 'QUOTATION'],
  ] as const)(
    'changeSaleStatus %s refuses to re-open a sale on an expired licence',
    async (action, status) => {
      vi.mocked(assertStoredPharmacyMayOperate).mockRejectedValue(lapsed);
      const db = {
        pharmacySale: {
          findFirst: vi.fn(async () => ({ id: 'sale-a', status, lines: [] })),
          updateMany: vi.fn(),
        },
        pharmacySaleEvent: { create: vi.fn() },
      };

      await expect(changeSaleStatus(db as never, scope, 'sale-a', action)).rejects.toBe(lapsed);
      expect(assertStoredPharmacyMayOperate).toHaveBeenCalledWith(db, 'org-a', 'branch-a', {
        name: `pharmacy.sale.${action}`,
      });
      expect(db.pharmacySale.updateMany).not.toHaveBeenCalled();
      expect(db.pharmacySaleEvent.create).not.toHaveBeenCalled();
    }
  );

  it('changeSaleStatus still lets an expired branch hold a sale it cannot finish', async () => {
    vi.mocked(assertStoredPharmacyMayOperate).mockRejectedValue(lapsed);
    const sale = { id: 'sale-a', status: 'OPEN', lines: [] };
    const db = {
      pharmacySale: {
        findFirst: vi.fn(async () => sale),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      pharmacySaleEvent: { create: vi.fn() },
    };

    await expect(changeSaleStatus(db as never, scope, 'sale-a', 'hold')).resolves.toBe(sale);
    expect(assertStoredPharmacyMayOperate).not.toHaveBeenCalled();
    expect(db.pharmacySale.updateMany).toHaveBeenCalledOnce();
  });
});
