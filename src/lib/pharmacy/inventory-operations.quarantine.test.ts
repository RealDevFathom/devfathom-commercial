import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { releaseQuarantine, writeOff } from './inventory-operations';

const scope = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'actor_a' };

function fixture(onHandUnits = 12) {
  const createMovement = vi
    .fn()
    .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: `movement_${data.disposition}`,
      ...data,
    }));
  const db = {
    pharmacyInventoryLot: {
      findFirst: vi.fn().mockResolvedValue({ id: 'lot_a', unitsPerPack: 10 }),
    },
    pharmacyStockBalance: {
      findFirst: vi.fn().mockResolvedValue({ onHandUnits, sealedPacks: 1, looseUnits: 2 }),
    },
    pharmacyStockMovement: { create: createMovement },
    pharmacyCustodyRecord: {
      create: vi
        .fn()
        .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'custody_a',
          ...data,
        })),
    },
  };
  return { db: db as unknown as ScopedDb, raw: db, createMovement };
}

describe('manual quarantine disposition', () => {
  it('writes quarantined units off and preserves witness custody evidence', async () => {
    const { db, raw, createMovement } = fixture();

    await writeOff(db, scope, {
      inventoryLotId: 'lot_a',
      stockLocationId: 'location_a',
      units: 2,
      witnessId: 'witness_b',
      reason: 'Manual recall confirmed',
      evidenceRef: 'destruction-certificate-1',
      idempotencyKey: 'write-off-1',
      disposition: 'QUARANTINE',
    });

    expect(raw.pharmacyStockBalance.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        organizationId: 'org_a',
        branchId: 'branch_a',
        disposition: 'QUARANTINE',
      }),
    });
    expect(createMovement).toHaveBeenCalledWith({
      data: expect.objectContaining({ disposition: 'QUARANTINE', quantityUnits: -2 }),
    });
    expect(raw.pharmacyCustodyRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'actor_a',
        witnessId: 'witness_b',
        evidenceRef: 'destruction-certificate-1',
      }),
    });
  });

  it('releases quarantine with balanced, tenant-scoped ledger movements', async () => {
    const { db, raw, createMovement } = fixture();

    await releaseQuarantine(db, scope, {
      inventoryLotId: 'lot_a',
      stockLocationId: 'location_a',
      units: 12,
      reason: 'Recall cleared',
      idempotencyKeyPrefix: 'release-1',
    });

    expect(raw.pharmacyStockBalance.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        organizationId: 'org_a',
        branchId: 'branch_a',
        disposition: 'QUARANTINE',
      }),
    });
    expect(createMovement).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        organizationId: 'org_a',
        branchId: 'branch_a',
        disposition: 'QUARANTINE',
        quantityUnits: -12,
        idempotencyKey: 'release-1:out',
      }),
    });
    expect(createMovement).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        organizationId: 'org_a',
        branchId: 'branch_a',
        disposition: 'AVAILABLE',
        quantityUnits: 12,
        idempotencyKey: 'release-1:in',
      }),
    });
  });
});
