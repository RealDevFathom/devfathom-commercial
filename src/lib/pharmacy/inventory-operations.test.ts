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
  it('requires the witness to be an active user in the current tenant', async () => {
    const db = database(null);

    await expect(writeOff(db as unknown as ScopedDb, scope, input)).rejects.toMatchObject({
      reason: 'COAUTH_REQUIRED',
    });

    expect(db.user.findFirst).toHaveBeenCalledWith({
      where: {
        id: input.witnessId,
        organizationId: scope.organizationId,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    expect(db.pharmacyInventoryLot.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacyCustodyRecord.create).not.toHaveBeenCalled();
  });

  it('records the write-off when the tenant-scoped witness is active', async () => {
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
