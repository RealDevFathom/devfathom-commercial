import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { writeOff } from './inventory-operations';

const SCOPE = {
  organizationId: 'org_a',
  branchId: 'branch_a',
  actorId: 'operator',
  at: new Date('2026-10-22T00:00:00.000Z'),
};

const INPUT = {
  inventoryLotId: 'lot_1',
  stockLocationId: 'location_1',
  units: 2,
  witnessId: 'witness',
  reason: 'Damaged stock',
  evidenceRef: 'damage-photo-1',
  idempotencyKey: 'write-off-1',
};

function database(witness: { id: string } | null) {
  return {
    user: { findFirst: vi.fn().mockResolvedValue(witness) },
    pharmacyInventoryLot: {
      findFirst: vi.fn().mockResolvedValue({ id: 'lot_1', unitsPerPack: 10 }),
    },
    pharmacyStockBalance: {
      findFirst: vi.fn().mockResolvedValue({ onHandUnits: 12, sealedPacks: 1, looseUnits: 2 }),
    },
    pharmacyStockMovement: { create: vi.fn().mockResolvedValue({ id: 'movement_1' }) },
    pharmacyCustodyRecord: { create: vi.fn().mockResolvedValue({ id: 'custody_1' }) },
  };
}

describe('INV-06 write-off witness', () => {
  it('rejects a witness who is not an active user in the operator tenant before writing stock', async () => {
    const db = database(null);

    await expect(writeOff(db as unknown as ScopedDb, SCOPE, INPUT)).rejects.toMatchObject({
      reason: 'COAUTH_REQUIRED',
    });

    expect(db.user.findFirst).toHaveBeenCalledWith({
      where: { id: 'witness', organizationId: 'org_a', status: 'ACTIVE' },
      select: { id: true },
    });
    expect(db.pharmacyInventoryLot.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacyCustodyRecord.create).not.toHaveBeenCalled();
  });

  it('allows an active tenant witness and records that witness in custody', async () => {
    const db = database({ id: 'witness' });

    await writeOff(db as unknown as ScopedDb, SCOPE, INPUT);

    expect(db.pharmacyCustodyRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org_a',
        actorId: 'operator',
        witnessId: 'witness',
      }),
    });
  });
});
