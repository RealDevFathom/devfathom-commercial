import { describe, expect, it, vi } from 'vitest';

import { writeOff } from './inventory-operations';

describe('inventory write-off witness', () => {
  function database(witness: { id: string } | null) {
    return {
      $queryRaw: vi.fn().mockResolvedValue(witness ? [witness] : []),
      pharmacyInventoryLot: {
        findFirst: vi.fn().mockResolvedValue({ id: 'lot', unitsPerPack: 10 }),
      },
      pharmacyStockBalance: {
        findFirst: vi.fn().mockResolvedValue({ onHandUnits: 10, looseUnits: 0 }),
      },
      pharmacyStockMovement: { create: vi.fn().mockResolvedValue({ id: 'movement' }) },
      pharmacyCustodyRecord: { create: vi.fn().mockResolvedValue({ id: 'custody' }) },
    };
  }

  const input = {
    inventoryLotId: 'lot',
    stockLocationId: 'location',
    units: 10,
    witnessId: 'witness',
    reason: 'damaged',
    evidenceRef: 'evidence',
    idempotencyKey: 'write-off',
  };

  it('rejects a witness who does not satisfy the active tenant-user lookup before writing stock', async () => {
    const db = database(null);

    await expect(
      writeOff(db as never, { organizationId: 'org', branchId: 'branch', actorId: 'actor' }, input)
    ).rejects.toMatchObject({ reason: 'COAUTH_REQUIRED' });
    expect(db.$queryRaw).toHaveBeenCalledOnce();
    const query = db.$queryRaw.mock.calls[0]![0];
    expect(query.strings.join('?')).toContain("status = 'ACTIVE'");
    expect(query.strings.join('?')).toContain('FOR UPDATE');
    expect(query.values).toEqual(['witness', 'org']);
    expect(db.pharmacyInventoryLot.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacyCustodyRecord.create).not.toHaveBeenCalled();
  });

  it('allows an active user in the tenant to witness the write-off', async () => {
    const db = database({ id: 'witness' });

    await expect(
      writeOff(db as never, { organizationId: 'org', branchId: 'branch', actorId: 'actor' }, input)
    ).resolves.toEqual({ movement: { id: 'movement' }, custody: { id: 'custody' } });
    expect(db.pharmacyStockMovement.create).toHaveBeenCalledOnce();
    expect(db.pharmacyCustodyRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org',
        branchId: 'branch',
        actorId: 'actor',
        witnessId: 'witness',
      }),
    });
  });
});
