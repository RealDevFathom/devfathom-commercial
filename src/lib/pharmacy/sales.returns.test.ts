import { describe, expect, it, vi } from 'vitest';
import { returnedLineValue, returnSaleLine, readReturnHistory } from './sales';

const scope = { organizationId: 'o', branchId: 'b', actorId: 'a' };
const input = {
  saleLineId: 'line',
  canonicalUnits: 6,
  disposition: 'RESTOCK' as const,
  reason: 'WRONG_ITEM',
  integrityDecision: 'sealed, storage verified',
  idempotencyKey: 'key',
};
function fixture() {
  const line = {
    id: 'line',
    saleId: 'sale',
    canonicalUnits: 10,
    sale: { status: 'COMPLETED' },
    allocations: [
      { id: 'a1', inventoryLotId: 'lot1', stockLocationId: 'shelf1', canonicalUnits: 4 },
      { id: 'a2', inventoryLotId: 'lot2', stockLocationId: 'shelf2', canonicalUnits: 6 },
    ],
    returnLines: [{ inventoryLotId: 'lot1', canonicalUnits: 2 }],
  };
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacySaleLine: { findFirst: vi.fn().mockResolvedValue(line) },
    pharmacySaleEvent: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    pharmacyStockLocation: { findFirst: vi.fn().mockResolvedValue({ id: 'shelf' }) },
    pharmacyInventoryLot: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ batch: { state: 'ACTIVE', expiresAt: new Date('2099-01-01') } }),
    },
    pharmacySaleReturn: {
      create: vi.fn().mockResolvedValue({ id: 'return' }),
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: 'return', lines: [{ stockMovementId: 'movement' }] }),
    },
    pharmacyStockMovement: {
      create: vi.fn().mockResolvedValue({ id: 'movement' }),
      findFirst: vi.fn().mockResolvedValue({ id: 'movement' }),
    },
    pharmacySaleReturnLine: { create: vi.fn().mockResolvedValue({}) },
  };
  return { db, line };
}
describe('counter return boundaries', () => {
  it('restocks remaining allocations without returning already-returned units twice', async () => {
    const { db } = fixture();
    await returnSaleLine(db as never, scope, input);
    expect(db.pharmacyStockMovement.create.mock.calls.map(([v]) => v.data)).toEqual([
      expect.objectContaining({
        inventoryLotId: 'lot1',
        stockLocationId: 'shelf1',
        disposition: 'AVAILABLE',
        quantityUnits: 2,
      }),
      expect.objectContaining({
        inventoryLotId: 'lot2',
        stockLocationId: 'shelf2',
        disposition: 'AVAILABLE',
        quantityUnits: 4,
      }),
    ]);
    expect(db.pharmacySaleEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: 'a',
          payload: expect.objectContaining({
            disposition: 'RESTOCK',
            integrityDecision: input.integrityDecision,
          }),
        }),
      })
    );
  });
  it.each(['RECALLED', 'QUARANTINED', 'EXPIRED'])(
    'refuses unsafe %s restock before a stock movement',
    async (state) => {
      const { db } = fixture();
      db.pharmacyInventoryLot.findFirst.mockResolvedValue({
        batch: {
          state: state === 'EXPIRED' ? 'ACTIVE' : state,
          expiresAt: new Date(state === 'EXPIRED' ? '2000-01-01' : '2099-01-01'),
        },
      });
      await expect(returnSaleLine(db as never, scope, input)).rejects.toThrow('UNSAFE_STOCK');
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    }
  );
  it('rejects cross-branch quarantine locations', async () => {
    const { db } = fixture();
    db.pharmacyStockLocation.findFirst.mockResolvedValue(null);
    await expect(
      returnSaleLine(db as never, scope, {
        ...input,
        disposition: 'QUARANTINE',
        quarantineLocationId: 'other',
      })
    ).rejects.toThrow('CROSS_BRANCH_REFERENCE');
    expect(db.pharmacySaleReturn.create).not.toHaveBeenCalled();
  });
  it('replays exact return evidence and rejects changed payloads', async () => {
    const { db } = fixture();
    await returnSaleLine(db as never, scope, input);
    const payload = db.pharmacySaleEvent.create.mock.calls[0][0].data.payload;
    db.pharmacySaleEvent.findFirst.mockResolvedValue({ payload });
    expect(await returnSaleLine(db as never, scope, input)).toMatchObject({
      returnId: 'return',
      replayed: true,
    });
    expect(db.pharmacySaleReturn.create).toHaveBeenCalledTimes(1);
    await expect(
      returnSaleLine(db as never, scope, { ...input, canonicalUnits: 3 })
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });
  it('rounds cumulative partial value to the exact discounted total', () => {
    const line = { quantity: 1, unitPriceMinor: 100, discountMinor: 2, canonicalUnits: 3 };
    expect([1, 2, 3].map((n) => returnedLineValue(line, n))).toEqual([32, 65, 98]);
  });
  it('does not disclose another branch receipt history', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    await expect(
      readReturnHistory({ pharmacySale: { findFirst } } as never, scope, 'other')
    ).rejects.toThrow('NOT_FOUND');
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'o', branchId: 'b' }),
      })
    );
  });
});
