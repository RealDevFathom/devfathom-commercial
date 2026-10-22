import { describe, expect, it } from 'vitest';

import { declineSubstitute, findSubstituteProposals } from './substitute-finder';

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
    pharmacyInventoryLot: {
      findFirst: async () => ({ printedMrpMinor: 1_000, unitsPerPack: 10 }),
      findMany: async () => lots,
    },
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
      }
    );
    expect(rows).toEqual([]);
  });

  it('never returns unsaleable stock and sends all safety predicates to the database', async () => {
    let where: unknown;
    const db = {
      medicine: { findFirst: async () => requested },
      pharmacyInventoryLot: {
        findFirst: async () => ({ printedMrpMinor: 1_000, unitsPerPack: 10 }),
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
      }
    );
    expect(
      rows.map((row) => [row.inventoryLotId, row.priceMinor, row.priceDifferenceMinor])
    ).toEqual([
      ['lot-a', 800, 200],
      ['lot-z', 900, 100],
    ]);
  });

  it('derives the comparison price from the latest matching presentation lot', async () => {
    let referenceQuery: unknown;
    const db = {
      medicine: { findFirst: async () => requested },
      pharmacyInventoryLot: {
        findFirst: async (args: unknown) => {
          referenceQuery = args;
          return { printedMrpMinor: 900, unitsPerPack: 10 };
        },
        findMany: async () => [lot({ printedMrpMinor: 800 })],
      },
    };

    const rows = await findSubstituteProposals(db as never, scope, {
      medicineId: 'requested',
      presentationId: 'presentation-requested',
      quantityCanonicalUnits: 10,
    });

    expect(referenceQuery).toMatchObject({
      where: {
        organizationId: 'org-a',
        branchId: 'branch-a',
        receivedAt: { not: null },
        batch: { medicineId: 'requested' },
        packLevel: { presentationId: 'presentation-requested' },
      },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    });
    expect(rows[0]).toMatchObject({ priceMinor: 800, priceDifferenceMinor: 100 });
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
