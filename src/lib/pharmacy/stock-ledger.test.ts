import { describe, expect, it, vi } from 'vitest';

import { blockReasonFor } from './inventory';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { allocateForSale, expiryInstant, normalizeExpiryBoundary } from './stock-ledger';

const SCOPE = {
  organizationId: 'org_a',
  branchId: 'branch_a',
  at: new Date('2027-06-30T19:00:00.000Z'), // 2027-07-01 00:00 PKT
};

describe('printed pharmacy expiry', () => {
  it('makes a month-precision pack unsaleable at Pakistan midnight after its printed month', () => {
    const expiresAt = expiryInstant(new Date('2027-06-01T00:00:00.000Z'), 'MONTH');

    expect(expiresAt.toISOString()).toBe('2027-06-30T19:00:00.000Z');
    expect(
      blockReasonFor(
        {
          inventoryLotId: 'lot_1',
          stockLocationId: 'loc_1',
          organizationId: 'org_a',
          branchId: 'branch_a',
          batchState: 'ACTIVE',
          disposition: 'AVAILABLE',
          expiresAt,
          receivedAt: new Date('2027-01-01T00:00:00.000Z'),
          availableUnits: 10,
        },
        SCOPE
      )
    ).toBe('EXPIRED');
  });

  it('uses the same Pakistan-local boundary for day-precision expiry', () => {
    expect(expiryInstant(new Date('2027-06-30T00:00:00.000Z'), 'DAY').toISOString()).toBe(
      '2027-06-30T19:00:00.000Z'
    );
  });
});

describe('stored pharmacy expiry boundaries', () => {
  it.each([
    ['2027-06-16T00:00:00.000Z', '2027-06-15T19:00:00.000Z'],
    ['2027-07-01T00:00:00.000Z', '2027-06-30T19:00:00.000Z'],
    ['2028-01-01T00:00:00.000Z', '2027-12-31T19:00:00.000Z'],
    ['2028-03-01T00:00:00.000Z', '2028-02-29T19:00:00.000Z'],
  ])('normalizes legacy %s exactly once to %s', (legacy, pkt) => {
    const stored = new Date(legacy);
    const normalized = normalizeExpiryBoundary(stored);
    expect(normalized).toEqual(new Date(pkt));
    expect(normalizeExpiryBoundary(normalized)).toEqual(new Date(pkt));
    expect(stored).toEqual(new Date(legacy));
  });

  it.each(['2027-06-30T19:00:00.000Z', '2027-07-01T00:00:00.001Z', '2027-07-01T12:00:00.000Z'])(
    'preserves nonlegacy instant %s exactly',
    (instant) => {
      expect(normalizeExpiryBoundary(new Date(instant))).toEqual(new Date(instant));
    }
  );
});

describe('#719 shelf-label allocation identity', () => {
  const scope = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'operator' };
  const at = new Date('2026-10-31T09:00:00.000Z');
  function fixture() {
    const rows = [
      {
        ...scope, inventoryLotId: 'lot-a', stockLocationId: 'store', batchState: 'ACTIVE',
        disposition: 'AVAILABLE', expiresAt: new Date('2027-01-01'), receivedAt: new Date('2026-09-01'),
        availableUnits: 100, unitsPerPack: 10, sealedPacks: 10, looseUnits: 0,
      },
      {
        ...scope, inventoryLotId: 'lot-b', stockLocationId: 'store', batchState: 'ACTIVE',
        disposition: 'AVAILABLE', expiresAt: new Date('2027-06-01'), receivedAt: new Date('2026-10-01'),
        availableUnits: 60, unitsPerPack: 30, sealedPacks: 2, looseUnits: 0,
      },
    ];
    const db = {
      $queryRaw: vi.fn().mockResolvedValue(rows),
      pharmacyStockMovement: { create: vi.fn().mockResolvedValue({ id: 'movement' }) },
      pharmacyAllocationOverride: { create: vi.fn().mockResolvedValue({ id: 'override' }) },
    };
    return { db, rows };
  }
  const input = {
    medicineId: 'medicine', requiredUnits: 30, at, idempotencyKeyPrefix: 'label', labelLotId: 'lot-b',
    override: { inventoryLotId: 'lot-b', reason: 'Customer has this pack', approvalPolicy: 'PHARMACIST_ON_DUTY' },
  };

  it('allocates a labelled pack entirely from that lot with the real FEFO recommendation', async () => {
    const { db } = fixture();
    const result = await allocateForSale(db as unknown as ScopedDb, scope, input);
    expect(result).toMatchObject({
      recommendedLotId: 'lot-a', overrideId: 'override',
      allocations: [{ inventoryLotId: 'lot-b', stockLocationId: 'store', units: 30 }],
    });
    expect(db.pharmacyStockMovement.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      inventoryLotId: 'lot-b', quantityUnits: -30, sealedPackDelta: -1,
    }) });
  });

  it('pins a FEFO label without recording an override', async () => {
    const { db } = fixture();
    const result = await allocateForSale(db as unknown as ScopedDb, scope, {
      ...input, labelLotId: 'lot-a', override: undefined, requiredUnits: 10,
    });
    expect(result.allocations).toEqual([{ inventoryLotId: 'lot-a', stockLocationId: 'store', units: 10 }]);
    expect(db.pharmacyAllocationOverride.create).not.toHaveBeenCalled();
  });

  it('refuses an old FEFO label if another lot now leads FEFO', async () => {
    const { db } = fixture();
    await expect(allocateForSale(db as unknown as ScopedDb, scope, { ...input, override: undefined }))
      .rejects.toThrow('OVERRIDE_EVIDENCE_MISSING');
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
  });

  it('refuses a stale override naming a different lot', async () => {
    const { db } = fixture();
    await expect(allocateForSale(db as unknown as ScopedDb, scope, { ...input, labelLotId: 'lot-a' }))
      .rejects.toThrow('OVERRIDE_EVIDENCE_MISSING');
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacyAllocationOverride.create).not.toHaveBeenCalled();
  });

  it('refuses spillover into another lot even when total branch stock is sufficient', async () => {
    const { db } = fixture();
    await expect(allocateForSale(db as unknown as ScopedDb, scope, { ...input, requiredUnits: 90 }))
      .rejects.toThrow('INSUFFICIENT_STOCK');
    expect(db.pharmacyStockMovement.create).not.toHaveBeenCalled();
    expect(db.pharmacyAllocationOverride.create).not.toHaveBeenCalled();
  });
});
