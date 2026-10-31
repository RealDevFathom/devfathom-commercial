import { describe, expect, it, vi } from 'vitest';
import { addReservedSaleLine } from './sales';
import { allocateForSale, allocateReservedForSale } from './stock-ledger';

const scope = { organizationId: 'org', branchId: 'branch', actorId: 'staff' };
const row = {
  ...scope,
  inventoryLotId: 'reserved',
  stockLocationId: 'shelf-a',
  batchState: 'ACTIVE',
  disposition: 'AVAILABLE',
  expiresAt: new Date('2100-01-01'),
  receivedAt: new Date('2020-01-01'),
  availableUnits: 10,
  unitsPerPack: 1,
  sealedPacks: 0,
  looseUnits: 10,
};
const input = {
  medicineId: 'medicine',
  requiredUnits: 3,
  at: new Date(),
  idempotencyKeyPrefix: 'order:line',
};
const reservation = {
  expiresAt: new Date('2099-01-01'),
  allocations: [
    { inventoryLotId: 'reserved', stockLocationId: 'shelf-a', units: 1 },
    { inventoryLotId: 'reserved', stockLocationId: 'shelf-b', units: 1 },
    { inventoryLotId: 'split', stockLocationId: 'shelf-a', units: 1 },
  ],
};
function fixture() {
  return {
    $queryRaw: vi
      .fn()
      .mockResolvedValue([
        { ...row, inventoryLotId: 'earlier', expiresAt: new Date('2090-01-01') },
        row,
        { ...row, stockLocationId: 'shelf-b' },
        { ...row, inventoryLotId: 'split' },
      ]),
    pharmacyStockMovement: {
      create: vi.fn(async ({ data }) => ({ ...data, id: `movement:${data.idempotencyKey}` })),
    },
    pharmacySale: {
      findFirst: vi.fn().mockResolvedValue({ id: 'sale', status: 'OPEN' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    medicine: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ saleable: true, rx: false, restricted: false, controlled: false }),
    },
    pharmacyInventoryLot: {
      findMany: vi.fn().mockResolvedValue(
        ['reserved', 'split'].map((id) => ({
          id,
          printedMrpMinor: 100,
          unitsPerPack: 1,
          unitCostMinor: 50,
        }))
      ),
    },
    pharmacySaleLine: { create: vi.fn(async ({ data }) => ({ id: 'sale-line', ...data })) },
    pharmacySaleLineAllocation: { create: vi.fn() },
    pharmacySaleEvent: { create: vi.fn() },
  };
}
describe('internal reserved checkout allocation', () => {
  it('keeps receipt allocations and movement identities despite a newer earlier-expiry lot', async () => {
    const db = fixture();
    const result = await addReservedSaleLine(
      db as never,
      scope,
      {
        saleId: 'sale',
        medicineId: 'medicine',
        presentationId: 'presentation',
        packLevelId: 'pack',
        saleUnit: 'UNIT',
        quantity: 3,
        canonicalUnitsPerSaleUnit: 1,
        idempotencyKey: 'order-line',
      },
      reservation
    );
    expect(result.allocation.allocations).toEqual(reservation.allocations);
    expect(
      db.pharmacySaleLineAllocation.create.mock.calls.map(([{ data }]) => [
        data.inventoryLotId,
        data.stockLocationId,
        data.canonicalUnits,
        data.stockMovementId,
      ])
    ).toEqual(
      reservation.allocations.map((part, index) => [
        part.inventoryLotId,
        part.stockLocationId,
        part.units,
        `movement:sale:order-line:${index}`,
      ])
    );
    expect(
      db.pharmacyStockMovement.create.mock.calls.map(([{ data }]) => [
        data.inventoryLotId,
        data.stockLocationId,
        data.quantityUnits,
        data.allocationOverrideId,
      ])
    ).toEqual(
      reservation.allocations.map((part) => [
        part.inventoryLotId,
        part.stockLocationId,
        -part.units,
        null,
      ])
    );
    const sql = db.$queryRaw.mock.calls[0]![0];
    expect(sql.strings.join('')).toContain('lot."packLevelId"');
    expect(sql.values).toEqual(expect.arrayContaining(['org', 'branch', 'medicine', 'pack']));
  });
  it.each([
    { batchState: 'RECALLED' },
    { batchState: 'QUARANTINED' },
    { availableUnits: 0 },
    { organizationId: 'other' },
    { branchId: 'other' },
    { expiresAt: new Date('2020-01-01') },
  ])('rejects unsafe exact stock before movement writes: %j', async (change) => {
    const db = fixture();
    db.$queryRaw.mockResolvedValue([{ ...row, ...change }]);
    await expect(
      allocateReservedForSale(db as never, scope, { ...input, requiredUnits: 1 }, 'pack', {
        ...reservation,
        allocations: reservation.allocations.slice(0, 1),
      })
    ).rejects.toThrow('BLOCKED_STOCK');
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });
  it('rechecks reservation expiry after allocation lock wait', async () => {
    const db = fixture();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2098-12-31'));
      db.$queryRaw.mockImplementation(async () => {
        await Promise.resolve();
        vi.setSystemTime(reservation.expiresAt);
        return [row];
      });
      await expect(
        allocateReservedForSale(db as never, scope, input, 'pack', reservation)
      ).rejects.toThrow('BLOCKED_STOCK');
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it('preserves the margin guardrail', async () => {
    const db = fixture();
    db.pharmacyInventoryLot.findMany.mockResolvedValue(
      ['reserved', 'split'].map((id) => ({
        id,
        printedMrpMinor: 100,
        unitsPerPack: 1,
        unitCostMinor: 101,
      }))
    );
    await expect(
      addReservedSaleLine(
        db as never,
        scope,
        {
          saleId: 'sale',
          medicineId: 'medicine',
          presentationId: 'presentation',
          packLevelId: 'pack',
          saleUnit: 'UNIT',
          quantity: 3,
          canonicalUnitsPerSaleUnit: 1,
          idempotencyKey: 'order-line',
        },
        reservation
      )
    ).rejects.toThrow('MARGIN_GUARDRAIL');
    expect(db.pharmacySaleLine.create).not.toHaveBeenCalled();
  });
  it('enforces a persisted minimum margin for reserved-order discounts too', async () => {
    const db = {
      ...fixture(),
      pharmacySmartDiscountPolicy: {
        findUnique: vi.fn(async () => ({ minimumMarginBps: 6000 })),
      },
    };
    await expect(
      addReservedSaleLine(
        db as never,
        scope,
        {
          saleId: 'sale',
          medicineId: 'medicine',
          presentationId: 'presentation',
          packLevelId: 'pack',
          saleUnit: 'UNIT',
          quantity: 3,
          canonicalUnitsPerSaleUnit: 1,
          discountMinor: 3,
          discountKind: 'DISCOUNT',
          approvedByUserId: 'claimed-owner',
          approvalPolicy: 'claimed-policy',
          idempotencyKey: 'discounted-order-line',
        },
        reservation
      )
    ).rejects.toThrow('MARGIN_GUARDRAIL');
    expect(db.pharmacySaleLine.create).not.toHaveBeenCalled();
  });
});

describe('mixed sealed and loose physical depletion', () => {
  it.each([
    [100, 70, 3, -0, -1],
    [170, 70, 3, -70, -1],
    [200, 170, 3, -100, -1],
    [20, 70, 3, -20, -0],
    [370, 70, 3, -70, -3],
  ])(
    'dispenses %i from %i loose + %i sealed without breaking a pack',
    async (units, loose, sealed, looseDelta, sealedDelta) => {
      const db = fixture();
      db.$queryRaw.mockResolvedValue([
        {
          ...row,
          unitsPerPack: 100,
          looseUnits: loose,
          sealedPacks: sealed,
          availableUnits: sealed * 100 + loose,
        },
      ]);
      await allocateReservedForSale(
        db as never,
        scope,
        { ...input, requiredUnits: units },
        'pack',
        {
          expiresAt: reservation.expiresAt,
          allocations: [
            { inventoryLotId: row.inventoryLotId, stockLocationId: row.stockLocationId, units },
          ],
        }
      );
      expect(db.pharmacyStockMovement.create).toHaveBeenCalledExactlyOnceWith({
        data: expect.objectContaining({
          quantityUnits: -units,
          sealedPackDelta: sealedDelta,
          looseUnitDelta: looseDelta,
          kind: 'SALE',
        }),
      });
    }
  );
  it.each([80, 180])('refuses %i when dispensing requires opening another pack', async (units) => {
    const db = fixture();
    db.$queryRaw.mockResolvedValue([
      { ...row, unitsPerPack: 100, looseUnits: 70, sealedPacks: 3, availableUnits: 370 },
    ]);
    await expect(
      allocateReservedForSale(db as never, scope, { ...input, requiredUnits: units }, 'pack', {
        expiresAt: reservation.expiresAt,
        allocations: [
          { inventoryLotId: row.inventoryLotId, stockLocationId: row.stockLocationId, units },
        ],
      })
    ).rejects.toThrow('INVALID_ARRANGEMENT');
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });
});

describe('normal sale disposition-bound physical arrangement', () => {
  const available = {
    ...row,
    unitsPerPack: 100,
    availableUnits: 230,
    sealedPacks: 2,
    looseUnits: 30,
  };
  const quarantine = {
    ...available,
    disposition: 'QUARANTINE',
    availableUnits: 200,
    sealedPacks: 0,
    looseUnits: 200,
  };
  it.each([false, true])(
    'debits only AVAILABLE with quarantine first=%s',
    async (quarantineFirst) => {
      const db = fixture();
      db.$queryRaw.mockResolvedValue(
        quarantineFirst ? [quarantine, available] : [available, quarantine]
      );
      const before = structuredClone(quarantine);
      const result = await allocateForSale(db as never, scope, { ...input, requiredUnits: 100 });
      expect(result.allocations).toEqual([
        { inventoryLotId: row.inventoryLotId, stockLocationId: row.stockLocationId, units: 100 },
      ]);
      expect(result.blocked).toEqual([expect.objectContaining({ reason: 'QUARANTINED' })]);
      expect(db.pharmacyStockMovement.create).toHaveBeenCalledExactlyOnceWith({
        data: expect.objectContaining({
          disposition: 'AVAILABLE',
          quantityUnits: -100,
          sealedPackDelta: -1,
          looseUnitDelta: -0,
          inventoryLotId: row.inventoryLotId,
          stockLocationId: row.stockLocationId,
        }),
      });
      expect(quarantine).toEqual(before);
    }
  );
  it.each([false, true])(
    'refuses insufficient safe stock with quarantine first=%s',
    async (quarantineFirst) => {
      const db = fixture();
      db.$queryRaw.mockResolvedValue(
        quarantineFirst ? [quarantine, available] : [available, quarantine]
      );
      await expect(
        allocateForSale(db as never, scope, { ...input, requiredUnits: 300 })
      ).rejects.toThrow('INSUFFICIENT_STOCK');
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    }
  );
  it('emergency shortfall uses the same AVAILABLE arrangement and excludes quarantine', async () => {
    const db = {
      ...fixture(),
      pharmacyStockDiscrepancy: {
        create: vi.fn(async ({ data }) => ({ id: 'shortfall', ...data })),
      },
    };
    db.$queryRaw.mockResolvedValue([available, quarantine]);
    const result = await allocateForSale(db as never, scope, {
      ...input,
      requiredUnits: 300,
      emergency: { reason: 'Synthetic approved emergency' },
    });
    expect(result.allocations).toEqual([
      { inventoryLotId: row.inventoryLotId, stockLocationId: row.stockLocationId, units: 230 },
    ]);
    expect(db.pharmacyStockDiscrepancy.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ allocatedUnits: 230, shortfallUnits: 70 }),
    });
    expect(db.pharmacyStockMovement.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        disposition: 'AVAILABLE',
        quantityUnits: -230,
        sealedPackDelta: -2,
        looseUnitDelta: -30,
      }),
    });
  });
});
