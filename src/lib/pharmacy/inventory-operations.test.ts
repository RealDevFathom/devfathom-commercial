import { describe, expect, it, vi } from 'vitest';

import { writeOff } from './inventory-operations';

describe('inventory write-off witness', () => {
  it('rejects a witness who is not an active user in the tenant before writing stock', async () => {
    const db = {
      user: { findFirst: vi.fn().mockResolvedValue(null) },
      pharmacyInventoryLot: {
        findFirst: vi.fn().mockResolvedValue({ id: 'lot', unitsPerPack: 10 }),
      },
      pharmacyStockBalance: {
        findFirst: vi.fn().mockResolvedValue({ onHandUnits: 10, looseUnits: 0 }),
      },
      pharmacyStockMovement: { create: vi.fn().mockResolvedValue({ id: 'movement' }) },
      pharmacyCustodyRecord: { create: vi.fn().mockResolvedValue({ id: 'custody' }) },
    };

    await expect(
      writeOff(
        db as never,
        { organizationId: 'org', branchId: 'branch', actorId: 'actor' },
        {
          inventoryLotId: 'lot',
          stockLocationId: 'location',
          units: 10,
          witnessId: 'witness',
          reason: 'damaged',
          evidenceRef: 'evidence',
          idempotencyKey: 'write-off',
        }
      )
    ).rejects.toMatchObject({ reason: 'COAUTH_REQUIRED' });
    expect(db.user.findFirst).toHaveBeenCalledWith({
      where: { id: 'witness', organizationId: 'org', status: 'ACTIVE' },
      select: { id: true },
    });
    expect(db.pharmacyInventoryLot.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacyCustodyRecord.create).not.toHaveBeenCalled();
  });
});
