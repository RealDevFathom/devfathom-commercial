import { describe, expect, it, vi } from 'vitest';

// Stock planning is covered by stock-ledger tests; here it returns a fixed split.
vi.mock('./stock-ledger', async () => ({
  ...(await vi.importActual<typeof import('./stock-ledger')>('./stock-ledger')),
  allocateForSale: vi.fn(async () => ({
    allocations: [
      { inventoryLotId: 'lot-box', stockLocationId: 'shelf', units: 10 },
      { inventoryLotId: 'lot-strip', stockLocationId: 'shelf', units: 10 },
    ],
    movementIds: ['movement-box', 'movement-strip'],
  })),
}));
vi.mock('./finance-postings', () => ({
  postSaleReturnEntry: vi.fn().mockResolvedValue({}),
  postUnidentifiedSaleReturnEntry: vi.fn().mockResolvedValue({}),
  postSaleLineEntry: vi.fn().mockResolvedValue({}),
  postTenderEntry: vi.fn().mockResolvedValue({}),
  postTenderRefundEntry: vi.fn().mockResolvedValue({}),
}));

import { addSaleLine, returnSaleLine } from './sales';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'user-a' };

describe('split sale across lots received at different pack levels', () => {
  it('prices each lot at its own MRP when a strip sits under a box in one lot and is the received pack in another', async () => {
    // BOX(100 units) -> STRIP(10) -> UNIT. lot-box was received as a box,
    // lot-strip as a strip. Both sell the same STRIP level (10 canonical units),
    // even though the strip is the second level for one lot and the root for the other.
    const lineCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: 'line-a',
      ...args.data,
    }));
    const allocationCreate = vi.fn(async (args: { data: Record<string, unknown> }) => args.data);
    const db = {
      pharmacySale: {
        findFirst: async () => ({ id: 'sale-a', status: 'OPEN', lines: [] }),
        updateMany: async () => ({ count: 1 }),
      },
      medicine: {
        findFirst: async () => ({
          id: 'medicine-a',
          rx: false,
          restricted: false,
          controlled: false,
        }),
      },
      pharmacyInventoryLot: {
        findMany: async () => [
          { id: 'lot-box', printedMrpMinor: 10_000, unitsPerPack: 100, unitCostMinor: 50 },
          { id: 'lot-strip', printedMrpMinor: 900, unitsPerPack: 10, unitCostMinor: 50 },
        ],
      },
      pharmacySaleLine: { create: lineCreate },
      pharmacySaleLineAllocation: { create: allocationCreate },
      pharmacySaleEvent: { create: vi.fn(async () => ({})) },
    };

    await expect(
      addSaleLine(db as never, scope, {
        saleId: 'sale-a',
        medicineId: 'medicine-a',
        presentationId: 'presentation-a',
        packLevelId: 'level-strip',
        saleUnit: 'STRIP',
        quantity: 2,
        canonicalUnitsPerSaleUnit: 10,
        idempotencyKey: 'line-a',
      })
    ).resolves.toMatchObject({ line: { id: 'line-a' } });

    expect(lineCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        quantity: 2,
        canonicalUnits: 20,
        grossMinor: 1_900,
        unitPriceMinor: 950,
        proRataCeilingMinor: 1_000,
      }),
    });
    const allocationMoney = allocationCreate.mock.calls.map(([args]) => ({
      lot: args.data.inventoryLotId,
      gross: args.data.grossMinor,
      discount: args.data.discountMinor,
    }));
    expect(allocationMoney).toEqual([
      { lot: 'lot-box', gross: 1_000, discount: 0 },
      { lot: 'lot-strip', gross: 900, discount: 0 },
    ]);
  });
});

describe('identified returns after an unidentified hold', () => {
  function fixture() {
    const line = {
      id: 'line',
      saleId: 'sale',
      quantity: 10,
      unitPriceMinor: 100,
      grossMinor: 1_000,
      discountMinor: 0,
      canonicalUnits: 10,
      sale: { status: 'COMPLETED' },
      medicine: { controlled: false },
      allocations: [
        {
          id: 'a1',
          inventoryLotId: 'lot1',
          stockLocationId: 'shelf',
          canonicalUnits: 10,
          grossMinor: 1_000,
          discountMinor: 0,
          stockMovementId: null,
        },
      ],
      unidentifiedReturnHolds: [{ canonicalUnits: 1, grossMinor: 100, discountMinor: 0 }],
      returnLines: [] as Array<Record<string, unknown>>,
    };
    const returnLineCreate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: 'return-line',
      ...args.data,
    }));
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      pharmacySaleLine: { findFirst: vi.fn().mockResolvedValue(line) },
      pharmacySaleEvent: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      pharmacyStockLocation: { findFirst: vi.fn().mockResolvedValue({ id: 'quarantine' }) },
      pharmacySaleReturn: {
        create: vi.fn().mockResolvedValue({ id: 'return', createdAt: new Date('2026-11-01') }),
      },
      pharmacyStockMovement: { create: vi.fn().mockResolvedValue({ id: 'movement' }) },
      pharmacySaleReturnLine: { create: returnLineCreate },
    };
    return { db, returnLineCreate };
  }

  it('accepts a named-lot return of goods still unreturned and values it at the lot charge', async () => {
    const { db, returnLineCreate } = fixture();
    await expect(
      returnSaleLine(db as never, scope, {
        saleLineId: 'line',
        lotId: 'lot1',
        canonicalUnits: 1,
        disposition: 'QUARANTINE',
        quarantineLocationId: 'quarantine',
        reason: 'WRONG_ITEM',
        integrityDecision: 'sealed',
        idempotencyKey: 'second-return',
      })
    ).resolves.toMatchObject({ replayed: false });
    expect(returnLineCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        inventoryLotId: 'lot1',
        canonicalUnits: 1,
        grossMinor: 100,
        discountMinor: 0,
      }),
    });
  });

  it('still counts the held unit against the sold quantity', async () => {
    const { db, returnLineCreate } = fixture();
    await expect(
      returnSaleLine(db as never, scope, {
        saleLineId: 'line',
        lotId: 'lot1',
        canonicalUnits: 10,
        disposition: 'QUARANTINE',
        quarantineLocationId: 'quarantine',
        reason: 'WRONG_ITEM',
        integrityDecision: 'sealed',
        idempotencyKey: 'over-return',
      })
    ).rejects.toThrow('RETURN_EXCEEDS_SOLD');
    expect(returnLineCreate).not.toHaveBeenCalled();
  });
});
