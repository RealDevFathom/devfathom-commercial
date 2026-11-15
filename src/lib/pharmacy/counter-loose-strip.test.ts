/**
 * DEV-705: a "10x10" box received as one standalone pack level must sell at
 * the counter as a box, a strip and a loose tablet, and the server must post
 * exactly the price the counter quoted for each.
 */
import { describe, expect, it, vi } from 'vitest';

import { searchCounterCatalog } from './counter';
import { addSaleLine } from './sales';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier-a' };

// Box of 10 strips x 10 tablets, printed MRP PKR 250.00.
const lot = {
  id: 'lot-a',
  packLevelId: 'pack-box',
  unitsPerPack: 100,
  printedMrpMinor: 25_000,
  unitCostMinor: 150,
  receivedAt: new Date('2026-01-01T00:00:00Z'),
  batch: {
    batchNumber: 'QA-B2',
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    state: 'ACTIVE',
    medicineId: 'medicine-a',
  },
};

function counterDb(presentationText: string) {
  return {
    medicineBarcode: { findFirst: vi.fn(async () => null) },
    medicineAlias: { findMany: vi.fn(async () => []) },
    medicineStrengthComponent: { findMany: vi.fn(async () => []) },
    presentation: { findMany: vi.fn(async () => []) },
    medicine: {
      findMany: vi.fn(async ({ include }: { include?: unknown }) =>
        include
          ? [
              {
                id: 'medicine-a',
                productName: 'Paracetamol 500mg Tablets',
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
                presentations: [
                  {
                    id: 'presentation-a',
                    presentation: presentationText,
                    dosageForm: 'Tablet',
                    route: null,
                  },
                ],
              },
            ]
          : [{ id: 'medicine-a' }]
      ),
    },
    pharmacyInventoryLot: { findMany: vi.fn(async () => [lot]) },
    // What publishing a "10x10" medicine creates: one standalone BOX of 100.
    packLevel: {
      findMany: vi.fn(async () => [
        {
          id: 'pack-box',
          level: 'BOX',
          parentPackLevelId: null,
          unitsPerParent: 100,
          presentationId: 'presentation-a',
        },
      ]),
    },
    medicinePackMrp: { findMany: vi.fn(async () => []) },
    pharmacyStockBalance: {
      findMany: vi.fn(async () => [
        {
          inventoryLotId: 'lot-a',
          stockLocationId: 'shelf-a',
          disposition: 'AVAILABLE',
          onHandUnits: 100,
        },
      ]),
    },
    pharmacyStockLocation: {
      findMany: vi.fn(async () => [{ id: 'shelf-a', kind: 'SHELF', code: 'A1', name: 'Shelf A' }]),
    },
  };
}

function saleDb() {
  const candidate = {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    inventoryLotId: 'lot-a',
    stockLocationId: 'shelf-a',
    batchState: 'ACTIVE',
    disposition: 'AVAILABLE',
    expiresAt: lot.batch.expiresAt,
    receivedAt: lot.receivedAt,
    availableUnits: 100,
    unitsPerPack: 100,
    // An opened box: strips and tablets are sold from loose stock, as a
    // sealed box must be opened with an explicit BREAK_PACK first.
    sealedPacks: 0,
    looseUnits: 100,
  };
  return {
    $queryRaw: vi.fn(async () => [candidate]),
    pharmacyStockMovement: {
      create: vi.fn(async ({ data }: { data: { idempotencyKey: string } }) => ({
        ...data,
        id: `movement:${data.idempotencyKey}`,
      })),
    },
    pharmacySale: {
      findFirst: vi.fn(async () => ({ id: 'sale-a', status: 'OPEN' })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    medicine: {
      findFirst: vi.fn(async () => ({
        id: 'medicine-a',
        saleable: true,
        rx: false,
        restricted: false,
        controlled: false,
      })),
    },
    pharmacyInventoryLot: { findMany: vi.fn(async () => [lot]) },
    medicinePackMrp: { findMany: vi.fn(async () => []) },
    pharmacySaleLine: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'sale-line-a',
        ...data,
      })),
    },
    pharmacySaleLineAllocation: { create: vi.fn() },
    pharmacySaleEvent: { create: vi.fn() },
  };
}

async function search(presentationText: string) {
  const { rows } = await searchCounterCatalog(counterDb(presentationText) as never, scope, {
    query: 'Paracetamol',
    at: new Date('2026-06-01T00:00:00Z'),
  });
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe('counter sale units for a standalone 10x10 box (DEV-705)', () => {
  it('offers box, strip and loose tablet with pro-rata prices', async () => {
    const row = await search('10x10');

    expect(
      row.saleUnits.map(({ kind, canonicalUnitsPerSaleUnit }) => [kind, canonicalUnitsPerSaleUnit])
    ).toEqual([
      ['PACK', 100],
      ['STRIP', 10],
      ['UNIT', 1],
    ]);
    expect(
      row.saleableUnits.map(({ kind, unitPriceMinor, wholeUnits }) => [
        kind,
        unitPriceMinor,
        wholeUnits,
      ])
    ).toEqual([
      ['PACK', 25_000, 1],
      ['STRIP', 2_500, 10],
      ['UNIT', 250, 100],
    ]);
  });

  it('posts a strip and a loose tablet at the price the counter quoted', async () => {
    const row = await search('Blister 10 x 10');
    const quoted = new Map(row.saleableUnits.map((unit) => [unit.kind, unit.unitPriceMinor]));

    const strip = await addSaleLine(saleDb() as never, scope, {
      saleId: 'sale-a',
      medicineId: 'medicine-a',
      presentationId: 'presentation-a',
      packLevelId: 'pack-box',
      saleUnit: 'STRIP',
      quantity: 1,
      canonicalUnitsPerSaleUnit: 10,
      idempotencyKey: 'line-strip',
    });
    expect(strip.line).toMatchObject({ canonicalUnits: 10, unitPriceMinor: 2_500 });
    expect(strip.line.unitPriceMinor).toBe(quoted.get('STRIP'));

    const loose = await addSaleLine(saleDb() as never, scope, {
      saleId: 'sale-a',
      medicineId: 'medicine-a',
      presentationId: 'presentation-a',
      packLevelId: 'pack-box',
      saleUnit: 'UNIT',
      quantity: 3,
      canonicalUnitsPerSaleUnit: 1,
      idempotencyKey: 'line-loose',
    });
    expect(loose.line).toMatchObject({ canonicalUnits: 3, unitPriceMinor: 250, grossMinor: 750 });
    expect(loose.line.unitPriceMinor).toBe(quoted.get('UNIT'));
  });

  it('invents no strip when the pack wording does not describe one', async () => {
    for (const text of ['100 tablets', 'Box', '5 x 2 x 10']) {
      const row = await search(text);
      expect(row.saleUnits.map((option) => option.kind)).toEqual(['PACK', 'UNIT']);
    }
  });
});
