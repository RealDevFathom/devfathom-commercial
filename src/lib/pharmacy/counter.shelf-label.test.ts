/**
 * DEV-90: scanning a shelf sticker at the counter selects the exact lot it was
 * printed for, in this branch only.
 */
import { describe, expect, it, vi } from 'vitest';

import { searchCounterCatalog } from './counter';
import { counterLabelScanDecision } from './counter-label-scan';
import { shelfLabelCode } from './shelf-label-code';

const scope = { organizationId: 'org-a', branchId: 'branch-a' };
const at = new Date('2026-11-15T06:00:00Z');

function lot(
  id: string,
  labelNumber: number,
  expiresAt: string,
  state = 'ACTIVE',
  pack: { packLevelId: string; unitsPerPack: number; printedMrpMinor: number } = {
    packLevelId: 'pack-box',
    unitsPerPack: 10,
    printedMrpMinor: 1_000,
  }
) {
  return {
    id,
    shelfLabelNumber: labelNumber,
    ...pack,
    receivedAt: new Date('2026-01-01T00:00:00Z'),
    batch: { batchNumber: `B-${id}`, expiresAt: new Date(expiresAt), state, medicineId: 'med-a' },
  };
}

function counterDb(options: { lots: ReturnType<typeof lot>[]; registeredBarcode?: boolean }) {
  return {
    medicineBarcode: {
      findFirst: vi.fn(async () =>
        options.registeredBarcode ? { presentation: { medicineId: 'med-a' } } : null
      ),
    },
    medicineAlias: { findMany: vi.fn(async () => []) },
    medicineStrengthComponent: { findMany: vi.fn(async () => []) },
    presentation: { findMany: vi.fn(async () => []) },
    medicine: {
      findMany: vi.fn(async ({ include }: { include?: unknown }) =>
        include
          ? [
              {
                id: 'med-a',
                productName: 'Paracetamol',
                brandName: null,
                manufacturer: null,
                rx: false,
                otc: true,
                restricted: false,
                controlled: false,
                highAlert: false,
                lasa: false,
                coldChain: false,
                strengths: [],
                presentations: [{ id: 'p', presentation: 'Tablet', dosageForm: null, route: null }],
              },
            ]
          : []
      ),
    },
    pharmacyInventoryLot: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { organizationId: string; branchId: string; shelfLabelNumber: number };
        }) => {
          const found = options.lots.find(
            (entry) =>
              where.organizationId === scope.organizationId &&
              where.branchId === scope.branchId &&
              entry.shelfLabelNumber === where.shelfLabelNumber
          );
          return found ? { id: found.id, batch: { medicineId: found.batch.medicineId } } : null;
        }
      ),
      findMany: vi.fn(async () => options.lots),
    },
    packLevel: {
      findMany: vi.fn(async () => [
        {
          id: 'pack-box',
          level: 'BOX',
          parentPackLevelId: null,
          unitsPerParent: 1,
          presentationId: 'p',
        },
        {
          id: 'pack-tab',
          level: 'TABLET',
          parentPackLevelId: 'pack-box',
          unitsPerParent: 10,
          presentationId: 'p',
        },
        // A smaller standalone pack of the same presentation: five units.
        {
          id: 'pack-five',
          level: 'POUCH',
          parentPackLevelId: null,
          unitsPerParent: 5,
          presentationId: 'p',
        },
      ]),
    },
    medicinePackMrp: { findMany: vi.fn(async () => []) },
    pharmacyStockBalance: {
      findMany: vi.fn(async () =>
        options.lots.map((entry) => ({
          inventoryLotId: entry.id,
          stockLocationId: 'shelf',
          disposition: 'AVAILABLE',
          onHandUnits: 30,
        }))
      ),
    },
    pharmacyStockLocation: {
      findMany: vi.fn(async () => [{ id: 'shelf', kind: 'SHELF', code: 'A1', name: 'Shelf A' }]),
    },
  };
}

const early = lot('early', 7, '2027-01-01T00:00:00Z');
const late = lot('late', 8, '2028-01-01T00:00:00Z');

describe('DEV-90 shelf sticker scan at the counter', () => {
  it('resolves the sticker to its exact lot in this branch', async () => {
    const db = counterDb({ lots: [early, late] });
    const { rows } = await searchCounterCatalog(db as never, scope, {
      query: shelfLabelCode(8),
      at,
    });
    expect(db.pharmacyInventoryLot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org-a', branchId: 'branch-a', shelfLabelNumber: 8 },
      })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      medicineId: 'med-a',
      matchedOn: 'BARCODE',
      recommendedLotId: 'early',
      labelLot: {
        inventoryLotId: 'late',
        batchNumber: 'B-late',
        printedMrpMinor: 1_000,
        sellableUnits: 30,
        blockedBy: null,
      },
    });
    // The labelled lot is not FEFO's: selling it is the existing, approved override.
    expect(counterLabelScanDecision(rows[0]!)).toEqual({
      kind: 'OVERRIDE',
      inventoryLotId: 'late',
      message: expect.stringContaining('batch B-late'),
    });
  });

  it('quotes and stages the labelled lot with its own pack conversion and price', async () => {
    const pouch = lot('pouch', 10, '2028-01-01T00:00:00Z', 'ACTIVE', {
      packLevelId: 'pack-five',
      unitsPerPack: 5,
      printedMrpMinor: 600,
    });
    const { rows } = await searchCounterCatalog(
      counterDb({ lots: [early, pouch] }) as never,
      scope,
      { query: shelfLabelCode(10), at }
    );
    expect(rows[0]).toMatchObject({
      recommendedLotId: 'early',
      packLevelId: 'pack-five',
      unitsPerPack: 5,
      printedMrpMinor: 600,
      labelLot: { inventoryLotId: 'pouch' },
    });
    expect(rows[0]!.saleUnits[0]).toEqual({
      kind: 'PACK',
      packLevelId: 'pack-five',
      levelLabel: 'POUCH',
      canonicalUnitsPerSaleUnit: 5,
    });
    expect(rows[0]!.saleableUnits[0]).toMatchObject({ kind: 'PACK', unitPriceMinor: 600 });
  });

  it('keeps quoting the FEFO lot when the labelled lot cannot be sold', async () => {
    const pouch = lot('pouch', 10, '2028-01-01T00:00:00Z', 'RECALLED', {
      packLevelId: 'pack-five',
      unitsPerPack: 5,
      printedMrpMinor: 600,
    });
    const { rows } = await searchCounterCatalog(
      counterDb({ lots: [early, pouch] }) as never,
      scope,
      { query: shelfLabelCode(10), at }
    );
    expect(rows[0]).toMatchObject({ packLevelId: 'pack-box', unitsPerPack: 10 });
    expect(rows[0]!.labelLot).toMatchObject({ blockedBy: 'RECALLED' });
  });

  it('sells straight through when the labelled lot is the FEFO lot', async () => {
    const { rows } = await searchCounterCatalog(
      counterDb({ lots: [early, late] }) as never,
      scope,
      { query: shelfLabelCode(7), at }
    );
    expect(rows[0]!.labelLot?.inventoryLotId).toBe('early');
    expect(counterLabelScanDecision(rows[0]!)).toEqual({ kind: 'FEFO' });
  });

  it('reports a labelled lot that cannot be sold instead of staging it', async () => {
    const recalled = lot('recalled', 9, '2027-06-01T00:00:00Z', 'RECALLED');
    const { rows } = await searchCounterCatalog(
      counterDb({ lots: [early, recalled] }) as never,
      scope,
      { query: shelfLabelCode(9), at }
    );
    expect(rows[0]!.labelLot).toMatchObject({ inventoryLotId: 'recalled', blockedBy: 'RECALLED' });
    expect(counterLabelScanDecision(rows[0]!)).toMatchObject({
      kind: 'BLOCKED',
      message: expect.stringContaining('it is recalled'),
    });
  });

  it('finds nothing for a sticker from another branch, and does not fall back to fuzzy search', async () => {
    const db = counterDb({ lots: [early] });
    const { rows } = await searchCounterCatalog(db as never, scope, {
      query: shelfLabelCode(999),
      at,
    });
    expect(rows).toEqual([]);
    expect(db.medicineAlias.findMany).not.toHaveBeenCalled();
    expect(db.medicine.findMany).not.toHaveBeenCalled();
  });

  it('does not reveal a lot from another organization', async () => {
    const db = counterDb({ lots: [early, late] });
    const result = await searchCounterCatalog(
      db as never,
      { ...scope, organizationId: 'org-other' },
      { query: shelfLabelCode(8), at }
    );
    expect(result.rows).toEqual([]);
    expect(db.medicine.findMany).not.toHaveBeenCalled();
  });

  it('does not fuzzy-match an internal code with a bad checksum', async () => {
    const db = counterDb({ lots: [early] });
    const code = shelfLabelCode(7);
    const result = await searchCounterCatalog(db as never, scope, {
      query: code.slice(0, -1) + ((Number(code.at(-1)) + 1) % 10),
      at,
    });
    expect(result.rows).toEqual([]);
    expect(db.pharmacyInventoryLot.findFirst).not.toHaveBeenCalled();
    expect(db.medicineAlias.findMany).not.toHaveBeenCalled();
  });

  it('returns nothing if the labelled lot disappears before the catalogue read', async () => {
    const db = counterDb({ lots: [early, late] });
    db.pharmacyInventoryLot.findMany.mockResolvedValue([early]);
    const result = await searchCounterCatalog(db as never, scope, { query: shelfLabelCode(8), at });
    expect(result.rows).toEqual([]);
  });

  it('quotes availability from the labelled lot alone', async () => {
    const { rows } = await searchCounterCatalog(
      counterDb({ lots: [early, late] }) as never,
      scope,
      { query: shelfLabelCode(8), at }
    );
    expect(rows[0]?.onHandUnits).toBe(30);
    expect(rows[0]?.saleableUnits[0]?.wholeUnits).toBe(3);
  });

  it('keeps a registered barcode ahead of the sticker format', async () => {
    const db = counterDb({ lots: [early, late], registeredBarcode: true });
    const { rows } = await searchCounterCatalog(db as never, scope, {
      query: shelfLabelCode(8),
      at,
    });
    expect(db.pharmacyInventoryLot.findFirst).not.toHaveBeenCalled();
    expect(rows[0]!.labelLot).toBeUndefined();
    expect(counterLabelScanDecision(rows[0]!)).toEqual({ kind: 'NONE' });
  });
});
