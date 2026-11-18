import { describe, expect, it } from 'vitest';

import {
  declineSubstitute,
  findSubstituteProposals,
  rankSameSaltBrandsByMargin,
  suggestHigherMarginBrandMix,
} from './substitute-finder';

const scope = { organizationId: 'org-a', branchId: 'branch-a' };
const decimal = (value: string) => ({ toString: () => value });
const strength = (ingredientId = 'ingredient-a', value = '500') => [
  { ingredientId, value: decimal(value), unit: 'mg' },
];
const requested = {
  id: 'requested',
  strengths: strength(),
  presentations: [{ id: 'presentation-requested', dosageForm: 'Tablet', route: 'Oral' }],
};

function lot(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lot-a',
    packLevelId: 'pack-a',
    unitsPerPack: 10,
    printedMrpMinor: 800,
    balances: [{ onHandUnits: 20 }],
    batch: {
      medicine: { id: 'alternate', productName: 'Lower Cost Generic', strengths: strength() },
    },
    packLevel: {
      presentation: {
        id: 'presentation-alternate',
        dosageForm: 'Tablet',
        route: 'Oral',
      },
    },
    ...overrides,
  };
}

function dbWith(lots: unknown[]) {
  return {
    medicine: { findFirst: async () => requested },
    pharmacyInventoryLot: { findMany: async () => lots },
  };
}

describe('AI-05 deterministic substitute finder', () => {
  it('never proposes a different ingredient or strength', async () => {
    const rows = await findSubstituteProposals(
      dbWith([
        lot({
          id: 'wrong-ingredient',
          batch: { medicine: { id: 'a', productName: 'A', strengths: strength('ingredient-b') } },
        }),
        lot({
          id: 'wrong-strength',
          batch: {
            medicine: { id: 'b', productName: 'B', strengths: strength('ingredient-a', '250') },
          },
        }),
      ]) as never,
      scope,
      {
        medicineId: 'requested',
        presentationId: 'presentation-requested',
        quantityCanonicalUnits: 10,
        referencePriceMinor: 1_000,
      }
    );
    expect(rows).toEqual([]);
  });

  it('DEV-852: never treats two medicines without recorded strength as exact equivalents', async () => {
    const input = {
      medicineId: 'requested',
      presentationId: 'presentation-requested',
      quantityCanonicalUnits: 10,
      referencePriceMinor: 1_000,
    };
    const strengthless = lot({
      id: 'strengthless',
      batch: { medicine: { id: 'panadol', productName: 'Panadol', strengths: [] } },
    });
    const db = {
      medicine: { findFirst: async () => ({ ...requested, strengths: [] }) },
      pharmacyInventoryLot: { findMany: async () => [strengthless, lot()] },
    };
    expect(await findSubstituteProposals(db as never, scope, input)).toEqual([]);
    // A requested medicine with a strength is never matched to a strengthless one either.
    const rows = await findSubstituteProposals(
      dbWith([strengthless, lot()]) as never,
      scope,
      input
    );
    expect(rows.map((row) => row.inventoryLotId)).toEqual(['lot-a']);
  });

  it('never returns unsaleable stock and sends all safety predicates to the database', async () => {
    let where: unknown;
    const db = {
      medicine: { findFirst: async () => requested },
      pharmacyInventoryLot: {
        findMany: async (args: { where: unknown }) => {
          where = args.where;
          return [];
        },
      },
    };
    expect(
      await findSubstituteProposals(db as never, scope, {
        medicineId: 'requested',
        presentationId: 'presentation-requested',
        quantityCanonicalUnits: 10,
        referencePriceMinor: 1_000,
        at: new Date('2026-09-05T00:00:00Z'),
      })
    ).toEqual([]);
    expect(where).toMatchObject({
      organizationId: 'org-a',
      branchId: 'branch-a',
      receivedAt: { not: null },
      batch: {
        state: 'ACTIVE',
        // DEV-853: an unrecorded expiry is never treated as expired.
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date('2026-09-05T00:00:00Z') } }],
        medicine: { saleable: true },
      },
      balances: { some: { disposition: 'AVAILABLE', onHandUnits: { gt: 0 } } },
    });
  });

  it('ranks cheaper exact equivalents deterministically and shows the price difference', async () => {
    const rows = await findSubstituteProposals(
      dbWith([
        lot({ id: 'lot-z', printedMrpMinor: 900 }),
        lot({ id: 'lot-a', printedMrpMinor: 800 }),
      ]) as never,
      scope,
      {
        medicineId: 'requested',
        presentationId: 'presentation-requested',
        quantityCanonicalUnits: 10,
        referencePriceMinor: 1_000,
      }
    );
    expect(
      rows.map((row) => [row.inventoryLotId, row.priceMinor, row.priceDifferenceMinor])
    ).toEqual([
      ['lot-a', 800, 200],
      ['lot-z', 900, 100],
    ]);
  });

  it('closes a declined POS-10 event with reason substitute declined', async () => {
    let update: unknown;
    const db = {
      unfulfilledDemandEvent: {
        findFirst: async () => ({ id: 'demand-a' }),
        update: async (args: unknown) => {
          update = args;
          return args;
        },
      },
    };
    await declineSubstitute(db as never, scope, 'demand-a', new Date('2026-09-05T00:00:00Z'));
    expect(update).toMatchObject({
      data: {
        reason: 'SUBSTITUTE_DECLINED',
        status: 'CLOSED',
        closedAt: new Date('2026-09-05T00:00:00Z'),
      },
    });
  });
});

function brandLot(
  id: string,
  medicineId: string,
  productName: string,
  printedMrpMinor: number,
  unitCostMinor: number,
  overrides: Record<string, unknown> = {}
) {
  return lot({
    id,
    printedMrpMinor,
    unitCostMinor,
    batch: { medicine: { id: medicineId, productName, strengths: strength() } },
    ...overrides,
  });
}

const rankInput = {
  medicineId: 'requested',
  presentationId: 'presentation-requested',
  quantityCanonicalUnits: 10,
};

describe('#745 same-salt brand margin optimiser', () => {
  it('ranks same salt/strength brands, including the requested one, by margin', async () => {
    const rows = await rankSameSaltBrandsByMargin(
      dbWith([
        brandLot('lot-requested', 'requested', 'Requested Brand', 1_000, 80),
        brandLot('lot-high', 'high', 'High Margin Brand', 900, 40),
        brandLot('lot-low', 'low', 'Low Margin Brand', 1_200, 115),
      ]) as never,
      scope,
      rankInput
    );
    expect(
      rows.map((row) => [row.inventoryLotId, row.priceMinor, row.costMinor, row.marginMinor])
    ).toEqual([
      ['lot-high', 900, 400, 500],
      ['lot-requested', 1_000, 800, 200],
      ['lot-low', 1_200, 1_150, 50],
    ]);
    expect(rows.find((row) => row.inventoryLotId === 'lot-requested')?.requested).toBe(true);
    expect(rows[0]!.marginBasisPoints).toBe(5_555);
  });

  it('never suggests a different salt, strength, form or route even at a higher margin', async () => {
    const rows = await rankSameSaltBrandsByMargin(
      dbWith([
        brandLot('same', 'same', 'Same', 1_000, 90),
        lot({
          id: 'other-salt',
          printedMrpMinor: 5_000,
          unitCostMinor: 1,
          batch: { medicine: { id: 'a', productName: 'A', strengths: strength('ingredient-b') } },
        }),
        lot({
          id: 'other-strength',
          printedMrpMinor: 5_000,
          unitCostMinor: 1,
          batch: {
            medicine: { id: 'b', productName: 'B', strengths: strength('ingredient-a', '250') },
          },
        }),
        lot({
          id: 'combination',
          printedMrpMinor: 5_000,
          unitCostMinor: 1,
          batch: {
            medicine: {
              id: 'c',
              productName: 'C',
              strengths: [...strength(), ...strength('ingredient-b', '65')],
            },
          },
        }),
        brandLot('other-form', 'd', 'D', 5_000, 1, {
          packLevel: { presentation: { id: 'p-d', dosageForm: 'Syrup', route: 'Oral' } },
        }),
        brandLot('other-route', 'e', 'E', 5_000, 1, {
          packLevel: { presentation: { id: 'p-e', dosageForm: 'Tablet', route: 'Rectal' } },
        }),
      ]) as never,
      scope,
      rankInput
    );
    expect(rows.map((row) => row.inventoryLotId)).toEqual(['same']);
  });

  it('skips lots without enough stock and honours the limit', async () => {
    const rows = await rankSameSaltBrandsByMargin(
      dbWith([
        brandLot('short', 'short', 'Short', 5_000, 1, { balances: [{ onHandUnits: 5 }] }),
        brandLot('b', 'b', 'B', 1_000, 10),
        brandLot('c', 'c', 'C', 1_000, 20),
      ]) as never,
      scope,
      { ...rankInput, limit: 1 }
    );
    expect(rows.map((row) => row.inventoryLotId)).toEqual(['b']);
  });

  it('returns nothing when the requested medicine has no recorded strength', async () => {
    const db = {
      medicine: { findFirst: async () => ({ ...requested, strengths: [] }) },
      pharmacyInventoryLot: {
        findMany: async () => [
          brandLot('no-strength', 'x', 'X', 1_000, 10, {
            batch: { medicine: { id: 'x', productName: 'X', strengths: [] } },
          }),
        ],
      },
    };
    expect(await rankSameSaltBrandsByMargin(db as never, scope, rankInput)).toEqual([]);
  });

  it('rejects a presentation that does not belong to the requested medicine', async () => {
    await expect(
      rankSameSaltBrandsByMargin(dbWith([]) as never, scope, {
        ...rankInput,
        presentationId: 'someone-else',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('suggests a higher-margin brand mix only within an exact equivalence group', async () => {
    let args: { where: unknown; orderBy: unknown } | undefined;
    const db = {
      pharmacyInventoryLot: {
        findMany: async (received: { where: unknown; orderBy: unknown }) => {
          args = received;
          return [
            brandLot('newest-low', 'low', 'Low', 1_000, 90),
            brandLot('high', 'high', 'High', 1_000, 50),
            brandLot('older-low', 'low', 'Low', 1_000, 10, { balances: [{ onHandUnits: 7 }] }),
            lot({
              id: 'other-salt',
              printedMrpMinor: 1_000,
              unitCostMinor: 1,
              batch: {
                medicine: {
                  id: 'other',
                  productName: 'Other',
                  strengths: strength('ingredient-b'),
                },
              },
            }),
          ];
        },
      },
    };
    const at = new Date('2026-09-05T00:00:00Z');
    const groups = await suggestHigherMarginBrandMix(db as never, scope, { at });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.brands.map((brand) => [brand.medicineId, brand.packMarginMinor])).toEqual([
      ['high', 500],
      ['low', 100],
    ]);
    expect(groups[0]!.brands[1]!.availableCanonicalUnits).toBe(27);
    expect(groups[0]!.lowerMarginMedicineIds).toEqual(['low']);
    expect(args?.orderBy).toEqual([{ receivedAt: 'desc' }, { id: 'asc' }]);
    expect(args?.where).toMatchObject({
      organizationId: 'org-a',
      branchId: 'branch-a',
      batch: {
        state: 'ACTIVE',
        OR: [{ expiresAt: null }, { expiresAt: { gt: at } }],
        medicine: { saleable: true },
      },
    });

    // The gain threshold is configurable, never a hardcoded figure.
    expect(
      await suggestHigherMarginBrandMix(db as never, scope, { at, minUnitMarginGainMinor: 41 })
    ).toEqual([]);
    expect(
      await suggestHigherMarginBrandMix(db as never, scope, { at, minUnitMarginGainMinor: 40 })
    ).toHaveLength(1);
  });
});
