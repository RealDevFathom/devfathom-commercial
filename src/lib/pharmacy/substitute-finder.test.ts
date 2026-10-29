import { describe, expect, it } from 'vitest';

import {
  declineSubstitute,
  findMarginOptimizedBrandProposals,
  findSubstituteProposals,
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
    unitCostMinor: 40,
    balances: [{ organizationId: 'org-a', branchId: 'branch-a', onHandUnits: 20 }],
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
        expiresAt: { gt: new Date('2026-09-05T00:00:00Z') },
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

  it('ranks in-stock exact equivalents by observed margin only', async () => {
    const rows = await findMarginOptimizedBrandProposals(
      dbWith([
        lot({ id: 'high-price-low-margin', printedMrpMinor: 1_000, unitCostMinor: 90 }),
        lot({ id: 'best-margin', printedMrpMinor: 900, unitCostMinor: 40 }),
      ]) as never,
      scope,
      {
        medicineId: 'requested',
        presentationId: 'presentation-requested',
        quantityCanonicalUnits: 10,
      }
    );
    expect(rows.map((row) => [row.inventoryLotId, row.marginMinor, row.marginBps])).toEqual([
      ['best-margin', 500, 5_555],
      ['high-price-low-margin', 100, 1_000],
    ]);
  });

  it('defines margin optimization as contribution, with rate only breaking ties', async () => {
    const rows = await findMarginOptimizedBrandProposals(
      dbWith([
        lot({ id: 'higher-rate', printedMrpMinor: 500, unitCostMinor: 10 }),
        lot({ id: 'higher-contribution', printedMrpMinor: 1_000, unitCostMinor: 40 }),
      ]) as never,
      scope,
      {
        medicineId: 'requested',
        presentationId: 'presentation-requested',
        quantityCanonicalUnits: 10,
      }
    );
    expect(rows.map((row) => [row.inventoryLotId, row.marginMinor, row.marginBps])).toEqual([
      ['higher-contribution', 600, 6_000],
      ['higher-rate', 400, 8_000],
    ]);
  });

  it('does not count foreign tenant or branch balances as available stock', async () => {
    let query: { where: unknown; include: unknown } | undefined;
    const db = {
      medicine: { findFirst: async () => requested },
      pharmacyInventoryLot: {
        findMany: async (args: { where: unknown; include: unknown }) => {
          query = args;
          return [
            lot({
              balances: [
                { organizationId: 'org-b', branchId: 'branch-a', onHandUnits: 100 },
                { organizationId: 'org-a', branchId: 'branch-b', onHandUnits: 100 },
                { organizationId: 'org-a', branchId: 'branch-a', onHandUnits: 2 },
              ],
            }),
          ];
        },
      },
    };
    expect(
      await findMarginOptimizedBrandProposals(db as never, scope, {
        medicineId: 'requested',
        presentationId: 'presentation-requested',
        quantityCanonicalUnits: 10,
      })
    ).toEqual([]);
    expect(query).toMatchObject({
      where: {
        balances: {
          some: {
            organizationId: 'org-a',
            branchId: 'branch-a',
            disposition: 'AVAILABLE',
            onHandUnits: { gt: 0 },
          },
        },
      },
      include: {
        balances: {
          where: {
            organizationId: 'org-a',
            branchId: 'branch-a',
            disposition: 'AVAILABLE',
            onHandUnits: { gt: 0 },
          },
        },
      },
    });
  });

  it('never margin-ranks a different ingredient, strength, form, or route', async () => {
    const rows = await findMarginOptimizedBrandProposals(
      dbWith([
        lot({
          batch: { medicine: { id: 'salt', productName: 'Salt', strengths: strength('other') } },
        }),
        lot({
          batch: {
            medicine: {
              id: 'strength',
              productName: 'Strength',
              strengths: strength('ingredient-a', '250'),
            },
          },
        }),
        lot({ packLevel: { presentation: { id: 'form', dosageForm: 'Capsule', route: 'Oral' } } }),
        lot({
          packLevel: { presentation: { id: 'route', dosageForm: 'Tablet', route: 'Topical' } },
        }),
      ]) as never,
      scope,
      {
        medicineId: 'requested',
        presentationId: 'presentation-requested',
        quantityCanonicalUnits: 10,
      }
    );
    expect(rows).toEqual([]);
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
