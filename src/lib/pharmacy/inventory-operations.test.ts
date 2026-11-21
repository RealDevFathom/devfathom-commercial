import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  approveCount,
  CYCLE_COUNT_MAX_SIZE,
  CYCLE_COUNT_REASON_MAX,
  dailyCycleCountList,
  recallTrace,
  writeOff,
} from './inventory-operations';

const scope = {
  organizationId: 'org_pharmacy',
  branchId: 'branch_main',
  actorId: 'user_actor',
};

const input = {
  inventoryLotId: 'lot_1',
  stockLocationId: 'location_1',
  units: 5,
  witnessId: 'user_witness',
  reason: 'Damaged stock',
  evidenceRef: 'photo-1',
  idempotencyKey: 'write-off-1',
};

function database(witness: { id: string } | null) {
  return {
    // DEV-825: the written-off balance is locked before it is read.
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: { findFirst: vi.fn().mockResolvedValue(witness) },
    pharmacyInventoryLot: {
      findFirst: vi.fn().mockResolvedValue({
        id: input.inventoryLotId,
        unitsPerPack: 10,
        manufacturingBatchId: 'batch_1',
      }),
    },
    // DEV-957: a write-off of good stock checks no counter holds its units.
    pharmacyManufacturingBatch: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ state: 'ACTIVE', expiresAt: new Date('2099-01-01T00:00:00.000Z') }),
    },
    pharmacyStockBalance: {
      findFirst: vi.fn().mockResolvedValue({ onHandUnits: 20, looseUnits: 5 }),
    },
    pharmacyStockMovement: {
      create: vi.fn().mockResolvedValue({ id: 'movement_1' }),
    },
    pharmacyCustodyRecord: {
      create: vi.fn().mockResolvedValue({ id: 'custody_1' }),
    },
  };
}

describe('writeOff witness validation', () => {
  it('requires an active tenant witness with an active assignment to the current branch', async () => {
    const db = database(null);

    await expect(writeOff(db as unknown as ScopedDb, scope, input)).rejects.toMatchObject({
      reason: 'COAUTH_REQUIRED',
    });

    expect(db.user.findFirst).toHaveBeenCalledWith({
      where: {
        id: input.witnessId,
        organizationId: scope.organizationId,
        status: 'ACTIVE',
        pharmacyBranchAssignments: {
          some: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            active: true,
          },
        },
      },
      select: { id: true },
    });
    expect(db.pharmacyInventoryLot.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacyCustodyRecord.create).not.toHaveBeenCalled();
  });

  it('rejects self-witnessing before querying or writing stock', async () => {
    const db = database({ id: scope.actorId });

    await expect(
      writeOff(db as unknown as ScopedDb, scope, { ...input, witnessId: scope.actorId })
    ).rejects.toMatchObject({ reason: 'COAUTH_REQUIRED' });

    expect(db.user.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyInventoryLot.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacyCustodyRecord.create).not.toHaveBeenCalled();
  });

  it('records a solo self-witness only when the PIN-verified solo flag is passed (DEV-628)', async () => {
    const db = database(null);

    await expect(
      writeOff(
        db as unknown as ScopedDb,
        scope,
        { ...input, witnessId: scope.actorId },
        { soloSelfWitness: true }
      )
    ).resolves.toEqual({ movement: { id: 'movement_1' }, custody: { id: 'custody_1' } });
    expect(db.pharmacyCustodyRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorId: scope.actorId, witnessId: scope.actorId }),
    });
  });

  it('refuses the solo flag for a write-off that names someone else (DEV-628)', async () => {
    const db = database({ id: input.witnessId });

    await expect(
      writeOff(db as unknown as ScopedDb, scope, input, { soloSelfWitness: true })
    ).rejects.toMatchObject({ reason: 'COAUTH_REQUIRED' });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('records the write-off when the active tenant witness is assigned to the branch', async () => {
    const db = database({ id: input.witnessId });

    await expect(writeOff(db as unknown as ScopedDb, scope, input)).resolves.toEqual({
      movement: { id: 'movement_1' },
      custody: { id: 'custody_1' },
    });

    expect(db.pharmacyCustodyRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: scope.organizationId,
        witnessId: input.witnessId,
      }),
    });
  });
});

describe('writeOff from a manual damaged hold', () => {
  it('debits the DAMAGED balance that quarantinePart({ damaged: true }) credits', async () => {
    const db = database({ id: input.witnessId });

    await writeOff(db as unknown as ScopedDb, scope, { ...input, disposition: 'DAMAGED' });

    expect(db.pharmacyStockBalance.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        inventoryLotId: input.inventoryLotId,
        stockLocationId: input.stockLocationId,
        disposition: 'DAMAGED',
      },
    });
    expect(db.pharmacyStockMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'WRITE_OFF',
        disposition: 'DAMAGED',
        quantityUnits: -input.units,
        looseUnitDelta: -5,
        sealedPackDelta: -0,
      }),
    });
    expect(db.pharmacyCustodyRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        movementId: 'movement_1',
        witnessId: input.witnessId,
        evidenceRef: input.evidenceRef,
      }),
    });
  });

  it('refuses when the damaged hold is short', async () => {
    const db = database({ id: input.witnessId });
    db.pharmacyStockBalance.findFirst.mockResolvedValue({ onHandUnits: 2, looseUnits: 2 });

    await expect(
      writeOff(db as unknown as ScopedDb, scope, { ...input, disposition: 'DAMAGED' })
    ).rejects.toMatchObject({ reason: 'INSUFFICIENT_STOCK' });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacyCustodyRecord.create).not.toHaveBeenCalled();
  });
});

describe('writeOff pack arrangement', () => {
  it('keeps whole sealed packs when the shelf holds more than a pack of loose units', async () => {
    const db = database({ id: input.witnessId });
    db.pharmacyStockBalance.findFirst.mockResolvedValue({
      onHandUnits: 35,
      sealedPacks: 2,
      looseUnits: 15,
    });

    await writeOff(db as unknown as ScopedDb, scope, {
      ...input,
      units: 20,
      disposition: 'DAMAGED',
    });

    expect(db.pharmacyStockMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        quantityUnits: -20,
        sealedPackDelta: -1,
        looseUnitDelta: -10,
      }),
    });
  });

  it('refuses a removal that would need a sealed pack broken', async () => {
    const db = database({ id: input.witnessId });
    db.pharmacyStockBalance.findFirst.mockResolvedValue({
      onHandUnits: 13,
      sealedPacks: 1,
      looseUnits: 3,
    });

    await expect(
      writeOff(db as unknown as ScopedDb, scope, { ...input, units: 5 })
    ).rejects.toMatchObject({ reason: 'INVALID_ARRANGEMENT' });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });
});

describe('recallTrace sold units', () => {
  it('leaves voided and never-completed sale allocations out of soldUnits', async () => {
    const db = {
      pharmacyRecallNotice: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: 'recall_1', batchId: 'batch_1', medicineId: null }),
      },
      $queryRaw: vi.fn().mockResolvedValue([]),
    };

    await recallTrace(db as unknown as ScopedDb, scope.organizationId, 'recall_1');

    const sql = (db.$queryRaw.mock.calls[0]![0] as { sql: string }).sql.replace(/\s+/g, ' ');
    // A voided draft restores its SALE movement with a linked reversal.
    expect(sql).toContain(
      'NOT EXISTS (SELECT 1 FROM "pharmacy_stock_movements" r WHERE r."organizationId"=m."organizationId" AND r."reversesMovementId"=m.id)'
    );
    // A SALE movement still held by an OPEN, HELD or VOID sale was never sold.
    expect(sql).toContain('a."stockMovementId"=m.id AND s.status<>\'COMPLETED\'');
  });
});

describe('DEV-682 approveCount variance reason', () => {
  function countDb(varianceUnits: number) {
    return {
      $queryRaw: vi.fn().mockResolvedValue([]),
      pharmacyInventoryCount: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'count_1',
          status: 'OPEN',
          createdById: 'user_counter',
          lines: [
            {
              id: 'line_1',
              inventoryLotId: 'lot_1',
              stockLocationId: 'location_1',
              varianceUnits,
              countedSealedPacks: 1,
              countedLooseUnits: 0,
              expectedSealedPacks: 1,
              expectedLooseUnits: 0,
            },
          ],
        }),
        update: vi.fn().mockImplementation(async ({ data }: { data: object }) => ({
          id: 'count_1',
          ...data,
        })),
      },
      pharmacyStockMovement: { create: vi.fn().mockResolvedValue({ id: 'movement_1' }) },
    };
  }

  it.each([undefined, '', '   '])(
    'refuses to post a variance without a reason (%j) and writes nothing',
    async (reason) => {
      const db = countDb(-3);
      await expect(
        approveCount(db as unknown as ScopedDb, scope, 'count_1', 'approve', reason)
      ).rejects.toMatchObject({ reason: 'VARIANCE_REASON_REQUIRED' });
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
      expect(db.pharmacyInventoryCount.update).not.toHaveBeenCalled();
    }
  );

  it('refuses a reason longer than the stored limit', async () => {
    const db = countDb(-3);
    await expect(
      approveCount(
        db as unknown as ScopedDb,
        scope,
        'count_1',
        'approve',
        'x'.repeat(CYCLE_COUNT_REASON_MAX + 1)
      )
    ).rejects.toMatchObject({ reason: 'VARIANCE_REASON_REQUIRED' });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('approves a count that matches the book without a reason', async () => {
    const db = countDb(0);
    await approveCount(db as unknown as ScopedDb, scope, 'count_1', 'approve');
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacyInventoryCount.update).toHaveBeenCalledWith({
      where: { id: 'count_1' },
      data: expect.objectContaining({ status: 'APPROVED', varianceReason: null }),
    });
  });
});

describe('DEV-682 dailyCycleCountList', () => {
  const at = new Date('2026-11-15T09:00:00.000Z');

  it('ranks fast movers and high-value positions in SQL, within the branch', async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          inventoryLotId: 'lot_fast',
          stockLocationId: 'location_1',
          medicineName: 'Medicine A',
          batchNumber: 'B-1',
          locationName: 'Rack',
          unitsPerPack: 10,
          soldUnits: BigInt(120),
          stockValueMinor: BigInt(50_000),
          fastRank: BigInt(1),
          valueRank: BigInt(4),
        },
        {
          inventoryLotId: 'lot_dear',
          stockLocationId: 'location_1',
          medicineName: 'Medicine B',
          batchNumber: 'B-2',
          locationName: 'Safe',
          unitsPerPack: 1,
          soldUnits: BigInt(0),
          stockValueMinor: BigInt(9_000_000),
          fastRank: BigInt(1),
          valueRank: BigInt(1),
        },
      ]),
    };

    const list = await dailyCycleCountList(db as unknown as ScopedDb, scope, at, 6);

    expect(list).toEqual([
      expect.objectContaining({
        inventoryLotId: 'lot_fast',
        soldUnits: 120,
        stockValueMinor: 50_000,
        basis: ['FAST_MOVER'],
      }),
      // A position with no sales is never called a fast mover.
      expect.objectContaining({
        inventoryLotId: 'lot_dear',
        soldUnits: 0,
        stockValueMinor: 9_000_000,
        basis: ['HIGH_VALUE'],
      }),
    ]);
    // The list is for a blind count: no book quantity is returned.
    expect(Object.keys(list[0]!)).not.toContain('onHandUnits');

    const query = db.$queryRaw.mock.calls[0]![0] as { sql: string; values: unknown[] };
    const sql = query.sql.replace(/\s+/g, ' ');
    expect(sql).toContain(`b.disposition = 'AVAILABLE'`);
    expect(sql).toContain(`mv.kind = 'SALE'`);
    // Unfinished baskets already hold SALE movements but sold nothing yet.
    expect(sql).toContain(`a."stockMovementId" = mv.id AND s.status <> 'COMPLETED'`);
    // A reversed sale (and the reversal itself) is not a sale.
    expect(sql).toContain(`mv."reversesMovementId" IS NULL`);
    expect(sql).toContain('"pharmacy_inventory_count_lines"');
    expect(query.values).toEqual(
      expect.arrayContaining([
        scope.organizationId,
        scope.branchId,
        new Date('2026-10-16T09:00:00.000Z'),
        new Date('2026-11-08T09:00:00.000Z'),
        3,
        6,
      ])
    );
  });

  it.each([0, -1, 1.5, CYCLE_COUNT_MAX_SIZE + 1])('refuses list size %s', async (size) => {
    const db = { $queryRaw: vi.fn() };
    await expect(
      dailyCycleCountList(db as unknown as ScopedDb, scope, at, size)
    ).rejects.toMatchObject({ reason: 'INVALID_QUANTITY' });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});
