import { beforeEach, describe, expect, it, vi } from 'vitest';

const allocateForSale = vi.hoisted(() => vi.fn());

vi.mock('./stock-ledger', async () => ({
  ...(await vi.importActual<typeof import('./stock-ledger')>('./stock-ledger')),
  allocateForSale,
}));

import { addSaleLine } from './sales';

describe('sale posting MRP rounding', () => {
  beforeEach(() => {
    allocateForSale.mockReset();
  });

  it('accepts the preview price for the allocated lot batch', async () => {
    allocateForSale.mockResolvedValue({
      allocations: [{ inventoryLotId: 'lot-a', stockLocationId: 'shelf-a', units: 1 }],
      movementIds: ['movement-a'],
    });
    let postedLine: Record<string, unknown> | undefined;
    const findMrps = vi.fn(async () => [
      {
        packLevelId: 'pack-a',
        batchReference: 'batch-a',
        roundingIncrementMinor: 5,
      },
      {
        packLevelId: 'pack-a',
        batchReference: 'another-batch',
        roundingIncrementMinor: 1,
      },
    ]);
    const db = {
      pharmacySale: {
        findFirst: async () => ({ id: 'sale-a', status: 'OPEN' }),
        updateMany: async () => ({ count: 1 }),
      },
      medicine: {
        findFirst: async () => ({ rx: false, restricted: false, controlled: false }),
      },
      pharmacyInventoryLot: {
        findMany: async () => [
          {
            id: 'lot-a',
            packLevelId: 'pack-a',
            unitsPerPack: 100,
            printedMrpMinor: 999,
            unitCostMinor: 1,
            batch: { batchNumber: 'batch-a' },
          },
        ],
      },
      medicinePackMrp: {
        findMany: findMrps,
      },
      pharmacySaleLine: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          postedLine = data;
          return { id: 'line-a', ...data };
        },
      },
      pharmacySaleLineAllocation: { create: async () => ({ id: 'allocation-a' }) },
      pharmacySaleEvent: { create: async () => ({ id: 'event-a' }) },
    };

    await addSaleLine(
      db as never,
      {
        organizationId: 'org-a',
        branchId: 'branch-a',
        actorId: 'user-a',
      },
      {
        saleId: 'sale-a',
        medicineId: 'medicine-a',
        presentationId: 'presentation-a',
        packLevelId: 'pack-a',
        saleUnit: 'UNIT',
        quantity: 1,
        canonicalUnitsPerSaleUnit: 1,
        expectedUnitPriceMinor: 5,
        idempotencyKey: 'line-a',
      }
    );

    expect(postedLine).toMatchObject({ unitPriceMinor: 5, proRataCeilingMinor: 9 });
    expect(findMrps).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-a',
          OR: [{ packLevelId: 'pack-a', batchReference: 'batch-a' }],
        },
      })
    );
  });

  it('refuses a multi-batch allocation when its prices differ from the preview', async () => {
    allocateForSale.mockResolvedValue({
      allocations: [
        { inventoryLotId: 'lot-a', stockLocationId: 'shelf-a', units: 1 },
        { inventoryLotId: 'lot-b', stockLocationId: 'shelf-a', units: 1 },
      ],
      movementIds: ['movement-a', 'movement-b'],
    });
    const createLine = vi.fn();
    const findMrps = vi.fn(async () => [
      { packLevelId: 'pack-a', batchReference: 'batch-a', roundingIncrementMinor: 5 },
      { packLevelId: 'pack-a', batchReference: 'batch-b', roundingIncrementMinor: 1 },
    ]);
    const db = {
      pharmacySale: {
        findFirst: async () => ({ id: 'sale-a', status: 'OPEN' }),
        updateMany: async () => ({ count: 1 }),
      },
      medicine: {
        findFirst: async () => ({ rx: false, restricted: false, controlled: false }),
      },
      pharmacyInventoryLot: {
        findMany: async () => [
          {
            id: 'lot-a',
            packLevelId: 'pack-a',
            unitsPerPack: 100,
            printedMrpMinor: 999,
            unitCostMinor: 1,
            batch: { batchNumber: 'batch-a' },
          },
          {
            id: 'lot-b',
            packLevelId: 'pack-a',
            unitsPerPack: 100,
            printedMrpMinor: 999,
            unitCostMinor: 1,
            batch: { batchNumber: 'batch-b' },
          },
        ],
      },
      medicinePackMrp: {
        findMany: findMrps,
      },
      pharmacySaleLine: { create: createLine },
    };

    await expect(
      addSaleLine(
        db as never,
        {
          organizationId: 'org-a',
          branchId: 'branch-a',
          actorId: 'user-a',
        },
        {
          saleId: 'sale-a',
          medicineId: 'medicine-a',
          presentationId: 'presentation-a',
          packLevelId: 'pack-a',
          saleUnit: 'UNIT',
          quantity: 2,
          canonicalUnitsPerSaleUnit: 1,
          expectedUnitPriceMinor: 5,
          idempotencyKey: 'line-a',
        }
      )
    ).rejects.toMatchObject({ reason: 'PRICE_CHANGED' });
    expect(findMrps).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-a',
          OR: [
            { packLevelId: 'pack-a', batchReference: 'batch-a' },
            { packLevelId: 'pack-a', batchReference: 'batch-b' },
          ],
        },
      })
    );
    expect(createLine).not.toHaveBeenCalled();
  });
});
