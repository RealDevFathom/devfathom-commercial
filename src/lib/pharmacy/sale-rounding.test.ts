import { describe, expect, it, vi } from 'vitest';

import { searchCounterCatalog } from './counter';
import { previewSaleLine } from './counter-pricing';
import { addReservedSaleLine, addSaleLine } from './sales';

const scope = { organizationId: 'org', branchId: 'branch', actorId: 'cashier' };
const at = new Date('2026-10-24T12:00:00.000Z');
const policy = { packLevelId: 'box', batchReference: 'batch-a', roundingIncrementMinor: 5 };

function fixture(mrps = [policy]) {
  const medicine = {
    id: 'medicine',
    productName: 'Rounding tablet',
    saleable: true,
    rx: false,
    restricted: false,
    controlled: false,
    strengths: [],
    presentations: [{ id: 'presentation', presentation: 'Tablet' }],
  };
  const lot = {
    id: 'lot',
    packLevelId: 'box',
    printedMrpMinor: 1_003,
    unitsPerPack: 20,
    unitCostMinor: 1,
    receivedAt: new Date('2026-01-01'),
    batch: {
      medicineId: medicine.id,
      batchNumber: 'batch-a',
      expiresAt: new Date('2100-01-01'),
      state: 'ACTIVE',
    },
  };
  return {
    medicine: {
      findMany: vi.fn().mockResolvedValue([medicine]),
      findFirst: vi.fn().mockResolvedValue(medicine),
    },
    medicineBarcode: { findFirst: vi.fn().mockResolvedValue(null) },
    medicineAlias: { findMany: vi.fn().mockResolvedValue([]) },
    medicineStrengthComponent: { findMany: vi.fn().mockResolvedValue([]) },
    presentation: { findMany: vi.fn().mockResolvedValue([]) },
    packLevel: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'box',
          presentationId: 'presentation',
          parentPackLevelId: null,
          level: 'BOX',
          unitsPerParent: 1,
        },
        {
          id: 'strip',
          presentationId: 'presentation',
          parentPackLevelId: 'box',
          level: 'STRIP',
          unitsPerParent: 2,
        },
        {
          id: 'unit',
          presentationId: 'presentation',
          parentPackLevelId: 'strip',
          level: 'UNIT',
          unitsPerParent: 10,
        },
      ]),
    },
    medicinePackMrp: { findMany: vi.fn().mockResolvedValue(mrps) },
    pharmacyInventoryLot: { findMany: vi.fn().mockResolvedValue([lot]) },
    pharmacyStockBalance: {
      findMany: vi.fn().mockResolvedValue([
        {
          inventoryLotId: lot.id,
          stockLocationId: 'shelf',
          disposition: 'AVAILABLE',
          onHandUnits: 100,
        },
      ]),
    },
    pharmacyStockLocation: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: 'shelf', kind: 'STORE', code: 'STORE', name: 'Stock' }]),
    },
    // Real allocation/pricing code, with only the persistence boundary mocked.
    $queryRaw: vi.fn().mockResolvedValue([
      {
        ...scope,
        inventoryLotId: lot.id,
        stockLocationId: 'shelf',
        batchState: 'ACTIVE',
        disposition: 'AVAILABLE',
        expiresAt: lot.batch.expiresAt,
        receivedAt: lot.receivedAt,
        availableUnits: 100,
        unitsPerPack: 20,
        sealedPacks: 0,
        looseUnits: 100,
      },
    ]),
    pharmacyStockMovement: { create: vi.fn(async ({ data }) => ({ id: 'movement', ...data })) },
    pharmacySale: {
      findFirst: vi.fn().mockResolvedValue({ id: 'sale', status: 'OPEN' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    pharmacySaleLine: { create: vi.fn(async ({ data }) => ({ id: 'line', ...data })) },
    pharmacySaleLineAllocation: { create: vi.fn() },
    pharmacySaleEvent: { create: vi.fn() },
  };
}

const lineInput = {
  saleId: 'sale',
  medicineId: 'medicine',
  presentationId: 'presentation',
  packLevelId: 'strip',
  saleUnit: 'STRIP' as const,
  quantity: 1,
  canonicalUnitsPerSaleUnit: 10,
  idempotencyKey: 'line',
};

describe('SEC-643-01 counter quote to charged sale-unit rounding', () => {
  it.each([
    { kind: 'PACK', quantity: 2, expected: 1_003, ceiling: 1_003 },
    { kind: 'STRIP', quantity: 3, expected: 500, ceiling: 501 },
    { kind: 'UNIT', quantity: 4, expected: 50, ceiling: 50 },
  ] as const)(
    'persists the quoted $kind price, quantity $quantity',
    async ({ kind, quantity, expected, ceiling }) => {
      const db = fixture();
      const {
        rows: [row],
      } = await searchCounterCatalog(db as never, scope, { query: 'Rounding', at });
      const option = row!.saleUnits.find((unit) => unit.kind === kind)!;
      const preview = previewSaleLine({
        option,
        quantity,
        printedMrpMinor: row!.printedMrpMinor!,
        unitsPerPack: row!.unitsPerPack!,
        roundingIncrementMinor: row!.roundingIncrementMinor,
        availableUnits: row!.onHandUnits,
      });
      const { line } = await addSaleLine(db as never, scope, {
        ...lineInput,
        packLevelId: option.packLevelId,
        saleUnit: option.kind,
        quantity,
        canonicalUnitsPerSaleUnit: option.canonicalUnitsPerSaleUnit,
      });
      expect(row!.saleableUnits.find((unit) => unit.kind === kind)?.unitPriceMinor).toBe(expected);
      expect(preview.unitPriceMinor).toBe(expected);
      expect(line.unitPriceMinor).toBe(preview.unitPriceMinor);
      expect(line.proRataCeilingMinor).toBe(ceiling);
      expect(line.unitPriceMinor * line.quantity).toBe(preview.grossMinor);
      expect(line.canonicalUnits).toBe(preview.canonicalUnits);
      expect(line.unitPriceMinor).toBeLessThanOrEqual(line.proRataCeilingMinor);
      expect(db.medicinePackMrp.findMany).toHaveBeenLastCalledWith({
        where: {
          organizationId: scope.organizationId,
          OR: [{ packLevelId: 'box', batchReference: 'batch-a' }],
        },
        select: { packLevelId: true, batchReference: true, roundingIncrementMinor: true },
      });
    }
  );

  it.each([false, true])(
    'uses the batch policy regardless of record order (reverse=%s)',
    async (reverse) => {
      const policies = [
        policy,
        { ...policy, batchReference: 'other-batch', roundingIncrementMinor: 20 },
        { ...policy, packLevelId: 'other-pack', roundingIncrementMinor: 7 },
      ];
      const db = fixture(reverse ? policies.reverse() : policies);
      const {
        rows: [row],
      } = await searchCounterCatalog(db as never, scope, { query: 'Rounding', at });
      expect(row!.roundingIncrementMinor).toBe(5);
      const { line } = await addSaleLine(db as never, scope, lineInput);
      expect(line.unitPriceMinor).toBe(500);
    }
  );

  it('keeps the one-minor-unit default when only another batch has a policy', async () => {
    const db = fixture([{ ...policy, batchReference: 'other-batch', roundingIncrementMinor: 20 }]);
    const {
      rows: [row],
    } = await searchCounterCatalog(db as never, scope, { query: 'Rounding', at });
    expect(row!.roundingIncrementMinor).toBe(1);
    const { line } = await addSaleLine(db as never, scope, lineInput);
    expect(line.unitPriceMinor).toBe(501);
    expect(row!.saleableUnits.find((unit) => unit.kind === 'STRIP')?.unitPriceMinor).toBe(501);
  });

  it('keeps the counter-quoted FEFO price when fulfillment crosses into a later batch', async () => {
    const db = fixture([
      policy,
      { ...policy, batchReference: 'batch-b', roundingIncrementMinor: 6 },
    ]);
    const [first] = await db.pharmacyInventoryLot.findMany();
    const second = {
      ...first,
      id: 'lot-b',
      printedMrpMinor: 1_030,
      batch: { ...first.batch, batchNumber: 'batch-b' },
    };
    db.pharmacyInventoryLot.findMany.mockResolvedValue([first, second]);
    db.pharmacyStockBalance.findMany.mockResolvedValue([
      {
        inventoryLotId: first.id,
        stockLocationId: 'shelf',
        disposition: 'AVAILABLE',
        onHandUnits: 10,
      },
      {
        inventoryLotId: second.id,
        stockLocationId: 'shelf',
        disposition: 'AVAILABLE',
        onHandUnits: 20,
      },
    ]);
    db.$queryRaw.mockResolvedValue(
      [first, second].map((lot, index) => ({
        ...scope,
        inventoryLotId: lot.id,
        stockLocationId: 'shelf',
        batchState: 'ACTIVE',
        disposition: 'AVAILABLE',
        expiresAt: lot.batch.expiresAt,
        receivedAt: lot.receivedAt,
        availableUnits: index === 0 ? 10 : 20,
        unitsPerPack: 20,
        sealedPacks: 0,
        looseUnits: index === 0 ? 10 : 20,
      }))
    );
    const {
      rows: [row],
    } = await searchCounterCatalog(db as never, scope, { query: 'Rounding', at });
    const option = row!.saleUnits.find((unit) => unit.kind === 'STRIP')!;
    const preview = previewSaleLine({
      option,
      quantity: 3,
      printedMrpMinor: row!.printedMrpMinor!,
      unitsPerPack: row!.unitsPerPack!,
      roundingIncrementMinor: row!.roundingIncrementMinor,
      availableUnits: row!.onHandUnits,
    });
    const { line, allocation } = await addSaleLine(db as never, scope, {
      ...lineInput,
      quantity: 3,
    });
    expect(allocation.allocations).toHaveLength(2);
    expect(preview.grossMinor).toBe(1_500);
    expect(line.unitPriceMinor).toBe(500);
    expect(line.proRataCeilingMinor).toBe(501);
    expect(line.unitPriceMinor * line.quantity).toBe(preview.grossMinor);
  });

  it('applies the same rounding in reserved customer-order checkout', async () => {
    const db = fixture();
    const { line } = await addReservedSaleLine(
      db as never,
      scope,
      { ...lineInput, packLevelId: 'box' },
      {
        expiresAt: new Date('2100-01-01'),
        allocations: [{ inventoryLotId: 'lot', stockLocationId: 'shelf', units: 10 }],
      }
    );
    expect(line.unitPriceMinor).toBe(500);
    expect(line.proRataCeilingMinor).toBe(501);
  });

  it.each(
    (['counter', 'reserved'] as const).flatMap((checkout) => [
      { checkout, printedMrpMinor: 900, refused: true },
      { checkout, printedMrpMinor: 1_000, refused: false },
    ])
  )(
    'checks every allocated batch ceiling in $checkout checkout (MRP $printedMrpMinor)',
    async ({ checkout, printedMrpMinor, refused }) => {
      const db = fixture();
      const [first] = await db.pharmacyInventoryLot.findMany();
      const second = {
        ...first,
        id: 'lot-b',
        printedMrpMinor,
        batch: { ...first.batch, batchNumber: 'batch-b' },
      };
      db.pharmacyInventoryLot.findMany.mockResolvedValue([first, second]);
      db.$queryRaw.mockResolvedValue(
        [first, second].map((lot) => ({
          ...scope,
          inventoryLotId: lot.id,
          stockLocationId: 'shelf',
          batchState: 'ACTIVE',
          disposition: 'AVAILABLE',
          expiresAt: lot.batch.expiresAt,
          receivedAt: lot.receivedAt,
          availableUnits: 10,
          unitsPerPack: 20,
          sealedPacks: 0,
          looseUnits: 10,
        }))
      );
      const input = { ...lineInput, quantity: 2 };
      const result =
        checkout === 'counter'
          ? addSaleLine(db as never, scope, input)
          : addReservedSaleLine(
              db as never,
              scope,
              { ...input, packLevelId: 'box' },
              {
                expiresAt: new Date('2100-01-01'),
                allocations: [first, second].map((lot) => ({
                  inventoryLotId: lot.id,
                  stockLocationId: 'shelf',
                  units: 10,
                })),
              }
            );
      if (refused) {
        // The quoted strip costs 500, but the later batch permits at most 450.
        await expect(result).rejects.toThrow('PRICE_ABOVE_MRP');
        expect(db.pharmacySaleLine.create).not.toHaveBeenCalled();
        expect(db.pharmacySaleLineAllocation.create).not.toHaveBeenCalled();
        expect(db.pharmacySaleEvent.create).not.toHaveBeenCalled();
      } else {
        // A tighter ceiling that still covers the quote must remain saleable.
        const { line } = await result;
        expect(line.unitPriceMinor).toBe(500);
        expect(line.proRataCeilingMinor).toBe(500);
      }
    }
  );
});
