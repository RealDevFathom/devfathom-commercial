import { describe, expect, it, vi } from 'vitest';
import { readDiscountSuggestions, recordCompetitorPrice } from './smart-discount-service';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'manager-a' };
const NOW = new Date('2026-11-15T00:00:00Z');

function suggestionDb() {
  return {
    pharmacyBranch: { findFirst: vi.fn(async () => ({ discountPolicy: { minMarginBps: 2_000 } })) },
    medicine: {
      findMany: vi.fn(async () => [
        {
          id: 'medicine-a',
          productName: 'Hand cream',
          rx: false,
          restricted: false,
          controlled: false,
        },
      ]),
    },
    pharmacyInventoryLot: {
      findMany: vi.fn(async (_args: { where: Record<string, unknown> }) => [
        { packLevelId: 'pack-box', printedMrpMinor: 1_200, unitCostMinor: 80, unitsPerPack: 10 },
        // A different pack size: never mixed into the box's cap or floor.
        { packLevelId: 'pack-strip', printedMrpMinor: 100, unitCostMinor: 999, unitsPerPack: 1 },
      ]),
    },
    pharmacyCompetitorPriceObservation: {
      findFirst: vi.fn(async (_args: { where: Record<string, unknown> }) => ({
        observedPriceMinor: 1_100,
      })),
    },
    pharmacySaleLine: { findMany: vi.fn(async () => []) },
  };
}

describe('DEV-66 discount suggestions read', () => {
  it('reads only saleable live lots and compares competitor prices for the same pack', async () => {
    const db = suggestionDb();
    const [row] = await readDiscountSuggestions(db as never, scope, {
      medicineIds: ['medicine-a'],
      now: NOW,
    });

    const lotArgs = db.pharmacyInventoryLot.findMany.mock.calls[0]![0];
    const lotWhere = lotArgs.where;
    // No row cap: the cap and floor must see every eligible lot of the pack.
    expect(lotArgs).not.toHaveProperty('take');
    expect(lotWhere).toMatchObject({
      organizationId: 'org-a',
      branchId: 'branch-a',
      receivedAt: { not: null },
      batch: { state: 'ACTIVE', expiresAt: { gt: NOW }, medicine: { saleable: true } },
      balances: { some: { disposition: 'AVAILABLE', onHandUnits: { gt: 0 } } },
    });
    const competitorArgs = db.pharmacyCompetitorPriceObservation.findFirst.mock.calls[0]![0];
    const competitorWhere = competitorArgs.where;
    expect(competitorWhere).toMatchObject({ medicineId: 'medicine-a', packLevelId: 'pack-box' });

    expect(row).toMatchObject({
      packLevelId: 'pack-box',
      suggestion: {
        kind: 'SUGGEST',
        basis: 'COMPETITOR',
        ceilingPriceMinor: 1_200,
        floorPriceMinor: 1_000,
        suggestedPriceMinor: 1_100,
      },
    });
  });
});

describe('DEV-66 competitor price log', () => {
  it('refuses a pack level that is not a pack of the medicine', async () => {
    const create = vi.fn();
    const db = {
      packLevel: { findFirst: vi.fn(async () => null) },
      pharmacyCompetitorPriceObservation: { create },
    };
    await expect(
      recordCompetitorPrice(db as never, scope, {
        medicineId: 'medicine-a',
        packLevelId: 'pack-of-another-medicine',
        competitorLabel: 'Store across the road',
        observedPriceMinor: 900,
        observedAt: NOW,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.packLevel.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-a',
          id: 'pack-of-another-medicine',
          presentation: { medicineId: 'medicine-a' },
        },
      })
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('records the observed pack with the price', async () => {
    const create = vi.fn(async () => ({ id: 'obs-a', observedAt: NOW }));
    const db = {
      packLevel: { findFirst: vi.fn(async () => ({ id: 'pack-box' })) },
      pharmacyCompetitorPriceObservation: { create },
    };
    await recordCompetitorPrice(db as never, scope, {
      medicineId: 'medicine-a',
      packLevelId: 'pack-box',
      competitorLabel: 'Store across the road',
      observedPriceMinor: 900,
      observedAt: NOW,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          branchId: 'branch-a',
          medicineId: 'medicine-a',
          packLevelId: 'pack-box',
          recordedByUserId: 'manager-a',
        }),
      })
    );
  });
});
-a',
          medicineId: 'medicine-a',
          packLevelId: 'pack-box',
          recordedByUserId: 'manager-a',
        }),
      })
    );
  });
});
