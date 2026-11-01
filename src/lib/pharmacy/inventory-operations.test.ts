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
    $queryRaw: vi.fn().mockResolvedValue(witness ? [witness] : []),
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
  it('requires a locked active tenant witness with an active assignment to the current branch', async () => {
    const db = database(null);

    await expect(writeOff(db as unknown as ScopedDb, scope, input)).rejects.toMatchObject({
      reason: 'COAUTH_REQUIRED',
    });

    expect(db.$queryRaw).toHaveBeenCalledOnce();
    const query = db.$queryRaw.mock.calls[0]![0];
    const sql = query.strings.join('?');
    expect(sql).toContain("u.status = 'ACTIVE'");
    expect(sql).toContain('pharmacy_branch_assignments');
    expect(sql).toContain('a.active = true');
    expect(sql).toContain('FOR UPDATE');
    expect(query.values).toEqual([
      input.witnessId,
      scope.organizationId,
      scope.organizationId,
      scope.branchId,
    ]);
    expect(db.pharmacyInventoryLot.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacyCustodyRecord.create).not.toHaveBeenCalled();
  });

  it('rejects self-witnessing before querying or writing stock', async () => {
    const db = database({ id: scope.actorId });

    await expect(
      writeOff(db as unknown as ScopedDb, scope, { ...input, witnessId: scope.actorId })
    ).rejects.toMatchObject({ reason: 'COAUTH_REQUIRED' });

    expect(db.$queryRaw).not.toHaveBeenCalled();
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

    expect(db.pharmacyStockMovement.create).toHaveBeenCalledOnce();
    expect(db.pharmacyCustodyRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        actorId: scope.actorId,
        witnessId: input.witnessId,
      }),
    });
  });
});
