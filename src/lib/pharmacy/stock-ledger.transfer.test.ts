import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { transferStock } from './stock-ledger';

const AT = new Date('2027-01-15T10:00:00.000Z');
const SCOPE = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'user_owner' };

function fakeDb(
  destination: { id: string; coldChain: boolean } | null = { id: 'loc_back', coldChain: false },
  medicineColdChain = false
) {
  const source = {
    inventoryLotId: 'lot_1',
    stockLocationId: 'loc_store',
    organizationId: 'org_a',
    branchId: 'branch_a',
    batchState: 'ACTIVE',
    disposition: 'AVAILABLE',
    expiresAt: new Date('2028-01-01T00:00:00.000Z'),
    receivedAt: new Date('2026-12-01T00:00:00.000Z'),
    availableUnits: 100,
    unitsPerPack: 10,
    sealedPacks: 10,
    looseUnits: 0,
  };
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([source]),
    pharmacyStockLocation: { findFirst: vi.fn().mockResolvedValue(destination) },
    pharmacyInventoryLot: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ batch: { medicine: { coldChain: medicineColdChain } } }),
    },
    pharmacyStockMovement: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'm', ...data })),
    },
  };
  return db;
}

const INPUT = {
  inventoryLotId: 'lot_1',
  fromStockLocationId: 'loc_store',
  toStockLocationId: 'loc_back',
  units: 20,
  at: AT,
  idempotencyKeyPrefix: 'move-1',
};

describe('same-branch location transfer (DEV-608)', () => {
  it('lands the moved units AVAILABLE at the destination, not stranded IN_TRANSIT', async () => {
    const db = fakeDb();
    const { out, received } = await transferStock(db as unknown as ScopedDb, SCOPE, INPUT);

    expect(out).toMatchObject({
      kind: 'TRANSFER_OUT',
      disposition: 'AVAILABLE',
      stockLocationId: 'loc_store',
      quantityUnits: -20,
    });
    expect(received).toMatchObject({
      kind: 'TRANSFER_IN',
      disposition: 'AVAILABLE',
      stockLocationId: 'loc_back',
      quantityUnits: 20,
    });
    // No leg of a same-branch move is left in a bucket nothing can receive.
    for (const [{ data }] of db.pharmacyStockMovement.create.mock.calls) {
      expect(data.disposition).not.toBe('IN_TRANSIT');
    }
  });

  it('refuses a destination outside the acting branch or retired, before moving anything', async () => {
    const db = fakeDb(null);
    await expect(transferStock(db as unknown as ScopedDb, SCOPE, INPUT)).rejects.toMatchObject({
      reason: 'NOT_FOUND',
    });

    expect(db.pharmacyStockLocation.findFirst).toHaveBeenCalledWith({
      where: { id: 'loc_back', organizationId: 'org_a', branchId: 'branch_a', active: true },
      select: { id: true, coldChain: true },
    });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('refuses to move cold-chain stock AVAILABLE into an unvalidated zone, before moving anything', async () => {
    const db = fakeDb({ id: 'loc_back', coldChain: false }, true);
    await expect(transferStock(db as unknown as ScopedDb, SCOPE, INPUT)).rejects.toMatchObject({
      reason: 'COLD_CHAIN_STORAGE_REQUIRED',
    });
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('moves cold-chain stock between validated cold-chain zones', async () => {
    const db = fakeDb({ id: 'loc_back', coldChain: true }, true);
    const { received } = await transferStock(db as unknown as ScopedDb, SCOPE, INPUT);
    expect(received).toMatchObject({ kind: 'TRANSFER_IN', disposition: 'AVAILABLE' });
  });
});
