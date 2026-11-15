import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { writeOff } from './inventory-operations';

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
    user: { findFirst: vi.fn().mockResolvedValue(witness) },
    pharmacyInventoryLot: {
      findFirst: vi.fn().mockResolvedValue({ id: input.inventoryLotId, unitsPerPack: 10 }),
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
