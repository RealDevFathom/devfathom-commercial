/**
 * MED-08 / DEV-187: the counter quote and the posted sale line must resolve the
 * MRP rounding increment from the same (pack level, batch) rule. MRP rules are
 * unique per pack level AND batch reference, so one pack level can carry
 * several increments; collapsing them by pack level (counter) or ignoring them
 * (posting) lets the cashier confirm one price and charge another.
 */
import { describe, expect, it, vi } from 'vitest';

import { searchCounterCatalog } from './counter';
import { mrpRoundingIncrementForLot } from './medicine';
import { addSaleLine } from './sales';

// The persisted regulatory gate has its own suites (regulatory.test.ts, sale-regulatory-gate.test.ts).
vi.mock('./regulatory', async () => ({
  ...(await vi.importActual<typeof import('./regulatory')>('./regulatory')),
  assertStoredPharmacyMayOperate: vi.fn(async () => undefined),
}));

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier-a' };

// 1234 / 10 = 123 minor units pro rata per tablet. Batch B-1 rounds down to 5
// (120); another batch of the same pack rounds to 1 (123).
const lot = {
  id: 'lot-a',
  packLevelId: 'pack-box',
  unitsPerPack: 10,
  printedMrpMinor: 1234,
  unitCostMinor: 50,
  receivedAt: new Date('2026-01-01T00:00:00Z'),
  batch: {
    batchNumber: 'B-1',
    expiresAt: new Date('2099-01-01T00:00:00Z'),
    state: 'ACTIVE',
    medicineId: 'medicine-a',
  },
};
// The matching rule is listed first so a by-pack-level map (last write wins)
// would pick the other batch's increment.
const mrpRules = [
  { packLevelId: 'pack-box', batchReference: 'B-1', roundingIncrementMinor: 5 },
  { packLevelId: 'pack-box', batchReference: 'B-OTHER', roundingIncrementMinor: 1 },
];

function mrpTable() {
  return {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where: { OR?: Array<{ packLevelId: string; batchReference: string }> };
      }) =>
        where.OR
          ? mrpRules.filter((rule) =>
              where.OR!.some(
                (pair) =>
                  pair.packLevelId === rule.packLevelId &&
                  pair.batchReference === rule.batchReference
              )
            )
          : mrpRules
    ),
  };
}

function counterDb() {
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
                presentations: [
                  { id: 'presentation-a', presentation: 'Tablet', dosageForm: null, route: null },
                ],
              },
            ]
          : [{ id: 'medicine-a' }]
      ),
    },
    pharmacyInventoryLot: { findMany: vi.fn(async () => [lot]) },
    packLevel: {
      findMany: vi.fn(async () => [
        {
          id: 'pack-box',
          level: 'BOX',
          parentPackLevelId: null,
          unitsPerParent: 1,
          presentationId: 'presentation-a',
        },
        {
          id: 'pack-tablet',
          level: 'UNIT',
          parentPackLevelId: 'pack-box',
          unitsPerParent: 10,
          presentationId: 'presentation-a',
        },
      ]),
    },
    medicinePackMrp: mrpTable(),
    pharmacyStockBalance: {
      findMany: vi.fn(async () => [
        {
          inventoryLotId: 'lot-a',
          stockLocationId: 'shelf-a',
          disposition: 'AVAILABLE',
          onHandUnits: 30,
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
    availableUnits: 30,
    unitsPerPack: 10,
    sealedPacks: 2,
    looseUnits: 10,
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
    // DEV-830: the server derives the sale unit from the same stored pack setup.
    packLevel: counterDb().packLevel,
    medicinePackMrp: mrpTable(),
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

describe('MRP rounding increment parity between counter quote and posting', () => {
  it('resolves the increment from the exact pack level and batch pair', () => {
    expect(
      mrpRoundingIncrementForLot(mrpRules, { packLevelId: 'pack-box', batchNumber: 'B-1' })
    ).toBe(5);
    expect(
      mrpRoundingIncrementForLot([...mrpRules].reverse(), {
        packLevelId: 'pack-box',
        batchNumber: 'B-1',
      })
    ).toBe(5);
    expect(
      mrpRoundingIncrementForLot(mrpRules, { packLevelId: 'pack-box', batchNumber: 'B-NONE' })
    ).toBe(1);
    expect(
      mrpRoundingIncrementForLot(mrpRules, { packLevelId: 'pack-strip', batchNumber: 'B-1' })
    ).toBe(1);
  });

  it('quotes the recommended lot with its own batch rule, not another batch of the pack', async () => {
    const { rows } = await searchCounterCatalog(counterDb() as never, scope, {
      query: 'Paracetamol',
      at: new Date('2026-06-01T00:00:00Z'),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ batchNumber: 'B-1', roundingIncrementMinor: 5 });
    expect(rows[0]!.saleableUnits.find((unit) => unit.kind === 'UNIT')).toMatchObject({
      unitPriceMinor: 120,
      proRataCeilingMinor: 123,
    });
  });

  it('posts the same rounded price the counter quoted', async () => {
    const { rows } = await searchCounterCatalog(counterDb() as never, scope, {
      query: 'Paracetamol',
      at: new Date('2026-06-01T00:00:00Z'),
    });
    const quoted = rows[0]!.saleableUnits.find((unit) => unit.kind === 'UNIT')!;

    const db = saleDb();
    const { line } = await addSaleLine(db as never, scope, {
      saleId: 'sale-a',
      medicineId: 'medicine-a',
      presentationId: 'presentation-a',
      packLevelId: 'pack-tablet',
      saleUnit: 'UNIT',
      quantity: 3,
      canonicalUnitsPerSaleUnit: 1,
      idempotencyKey: 'line-a',
    });

    expect(db.medicinePackMrp.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-a',
          OR: [{ packLevelId: 'pack-box', batchReference: 'B-1' }],
        },
      })
    );
    expect(line).toMatchObject({ unitPriceMinor: 120, grossMinor: 360 });
    expect(line.unitPriceMinor).toBe(quoted.unitPriceMinor);
  });
});
