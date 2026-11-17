import { describe, expect, it, vi } from 'vitest';
import { allocateForSale } from './stock-ledger';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier' };
const at = new Date('2026-11-17T00:00:00Z');
const input = { medicineId: 'med-a', requiredUnits: 10, at, idempotencyKeyPrefix: 'label-scan' };
function dbWithLots() {
  const rows = ['early', 'late'].map((id, index) => ({
    inventoryLotId: id,
    stockLocationId: 'shelf',
    ...scope,
    batchState: 'ACTIVE',
    disposition: 'AVAILABLE',
    expiresAt: new Date(`${2027 + index}-01-01T00:00:00Z`),
    receivedAt: at,
    availableUnits: 10,
    unitsPerPack: 10,
    sealedPacks: 1,
    looseUnits: 0,
  }));
  return {
    $queryRaw: vi.fn(async () => rows),
    pharmacyStockMovement: { create: vi.fn(async () => ({ id: 'movement' })) },
    pharmacyAllocationOverride: { create: vi.fn(async () => ({ id: 'override' })) },
  };
}

describe('shelf-label allocation under stock locks', () => {
  it.each(['late', 'foreign-lot', 'exhausted-lot'])(
    'refuses %s instead of substituting FEFO stock',
    async (expectedInventoryLotId) => {
      const db = dbWithLots();
      await expect(
        allocateForSale(db as never, scope, { ...input, expectedInventoryLotId })
      ).rejects.toThrow('BLOCKED_STOCK');
      expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
      expect(db.pharmacyAllocationOverride.create).not.toHaveBeenCalled();
    }
  );

  it('refuses spilling a labelled lot into a second lot before any movement', async () => {
    const db = dbWithLots();
    await expect(
      allocateForSale(db as never, scope, {
        ...input,
        requiredUnits: 20,
        expectedInventoryLotId: 'early',
      })
    ).rejects.toThrow('BLOCKED_STOCK');
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('sells the exact FEFO lot without manufacturing an approval', async () => {
    const db = dbWithLots();
    const result = await allocateForSale(db as never, scope, {
      ...input,
      expectedInventoryLotId: 'early',
    });
    expect(result.allocations).toEqual([
      expect.objectContaining({ inventoryLotId: 'early', units: 10 }),
    ]);
    expect(db.pharmacyAllocationOverride.create).not.toHaveBeenCalled();
  });

  it('uses the existing approved override for a non-FEFO label', async () => {
    const db = dbWithLots();
    const result = await allocateForSale(db as never, scope, {
      ...input,
      expectedInventoryLotId: 'late',
      override: {
        inventoryLotId: 'late',
        reason: 'Labelled pack selected',
        approvalPolicy: 'verified-pharmacist',
      },
    });
    expect(result.allocations).toEqual([
      expect.objectContaining({ inventoryLotId: 'late', units: 10 }),
    ]);
    expect(db.pharmacyAllocationOverride.create).toHaveBeenCalledOnce();
  });
});
