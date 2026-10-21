import { describe, expect, it, vi } from 'vitest';

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

function dbWith(
  lots: unknown[],
  onHandUnits = 10,
  historical: { printedMrpMinor: number; unitsPerPack: number } | null = {
    printedMrpMinor: 1_000,
    unitsPerPack: 10,
  }
) {
  return {
    medicine: { findFirst: async () => requested },
    pharmacyStockBalance: {
      aggregate: async () => ({ _sum: { onHandUnits } }),
    },
    pharmacyInventoryLot: { findMany: async () => lots, findFirst: async () => historical },
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
      pharmacyStockBalance: {
        aggregate: async () => ({ _sum: { onHandUnits: 10 } }),
      },
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
        medicine: {
          saleable: true,
          controlled: false,
          rx: false,
          restricted: false,
          AND: [{ strengths: { some: { ingredientId: 'ingredient-a' } } }],
        },
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

  it('never suggests pricier alternatives even when out of stock', async () => {
    const input = {
      medicineId: 'requested',
      presentationId: 'presentation-requested',
      quantityCanonicalUnits: 10,
    };
    expect(
      await findSubstituteProposals(
        dbWith([lot({ id: 'dearer', printedMrpMinor: 2_000 })], 10) as never,
        scope,
        input
      )
    ).toEqual([]);
    const rows = await findSubstituteProposals(
      dbWith([lot({ id: 'dearer', printedMrpMinor: 2_000 })], 0) as never,
      scope,
      input
    );
    expect(
      rows.map((row) => [row.inventoryLotId, row.priceMinor, row.priceDifferenceMinor])
    ).toEqual([]);
  });

  it('ignores an inflated client price when applying cheaper-only and the savings label', async () => {
    const rows = await findSubstituteProposals(
      dbWith(
        [lot({ id: 'dearer', printedMrpMinor: 900 }), lot({ id: 'cheaper', printedMrpMinor: 700 })],
        10,
        { printedMrpMinor: 800, unitsPerPack: 10 }
      ) as never,
      scope,
      {
        medicineId: 'requested',
        presentationId: 'presentation-requested',
        quantityCanonicalUnits: 10,
        referencePriceMinor: 10_000,
      } as never
    );
    expect(
      rows.map((row) => [row.inventoryLotId, row.priceMinor, row.priceDifferenceMinor])
    ).toEqual([['cheaper', 700, 100]]);
  });

  it('refuses a candidate whose controlled, prescription, or restricted flag differs', async () => {
    const rows = await findSubstituteProposals(
      dbWith([
        lot({
          id: 'controlled',
          batch: {
            medicine: {
              id: 'controlled-med',
              productName: 'Controlled twin',
              strengths: strength(),
              controlled: true,
            },
          },
        }),
        lot({
          id: 'rx',
          batch: {
            medicine: {
              id: 'rx-med',
              productName: 'Rx twin',
              strengths: strength(),
              rx: true,
            },
          },
        }),
        lot({
          id: 'restricted',
          batch: {
            medicine: {
              id: 'restricted-med',
              productName: 'Restricted twin',
              strengths: strength(),
              restricted: true,
            },
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

  it('puts matching regulatory flags on the proposal', async () => {
    const regulated = { ...requested, controlled: true, rx: true, restricted: true };
    const db = {
      medicine: { findFirst: async () => regulated },
      pharmacyStockBalance: { aggregate: async () => ({ _sum: { onHandUnits: 0 } }) },
      pharmacyInventoryLot: {
        findFirst: async () => ({ printedMrpMinor: 1000, unitsPerPack: 10 }),
        findMany: async () => [
          lot({
            id: 'regulated-lot',
            batch: {
              medicine: {
                id: 'alternate',
                productName: 'Regulated generic',
                strengths: strength(),
                controlled: true,
                rx: true,
                restricted: true,
              },
            },
          }),
        ],
      },
    };
    const rows = await findSubstituteProposals(db as never, scope, {
      medicineId: 'requested',
      presentationId: 'presentation-requested',
      quantityCanonicalUnits: 10,
    });
    expect(rows[0]).toMatchObject({
      inventoryLotId: 'regulated-lot',
      controlled: true,
      rx: true,
      restricted: true,
    });
  });

  it('fails closed when no reference price exists', async () => {
    const db = {
      medicine: { findFirst: async () => requested },
      pharmacyStockBalance: { aggregate: async () => ({ _sum: { onHandUnits: 0 } }) },
      pharmacyInventoryLot: {
        findFirst: async () => null,
        findMany: async () => [lot({ id: 'in-stock', printedMrpMinor: 1_500 })],
      },
    };
    const rows = await findSubstituteProposals(db as never, scope, {
      medicineId: 'requested',
      presentationId: 'presentation-requested',
      quantityCanonicalUnits: 1,
    });
    expect(rows).toEqual([]);
  });

  it('includes equal-price alternatives', async () => {
    const rows = await findSubstituteProposals(
      dbWith([lot({ printedMrpMinor: 1000 })]) as never,
      scope,
      {
        medicineId: 'requested',
        presentationId: 'presentation-requested',
        quantityCanonicalUnits: 10,
      }
    );
    expect(rows[0].priceDifferenceMinor).toBe(0);
  });

  it('rejects an override without a reason', async () => {
    await expect(
      findSubstituteProposals(
        dbWith([]) as never,
        { ...scope, actorId: 'pharmacist' },
        {
          medicineId: 'requested',
          presentationId: 'presentation-requested',
          quantityCanonicalUnits: 10,
          pharmacistOverride: { reason: '  ' },
        }
      )
    ).rejects.toMatchObject({ code: 'OVERRIDE_REASON_REQUIRED' });
  });

  it('records the pharmacist reason before offering a pricier substitute', async () => {
    const create = vi.fn(async () => ({}));
    const db = { ...dbWith([lot({ printedMrpMinor: 2000 })], 0), auditLog: { create } };
    const rows = await findSubstituteProposals(
      db as never,
      { ...scope, actorId: 'pharmacist' },
      {
        medicineId: 'requested',
        presentationId: 'presentation-requested',
        quantityCanonicalUnits: 10,
        pharmacistOverride: { reason: 'Patient requested available brand' },
      }
    );
    expect(rows[0].priceMinor).toBe(2000);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: 'org-a',
          actorId: 'pharmacist',
          metadata: expect.objectContaining({ reason: 'Patient requested available brand' }),
        }),
      })
    );
  });

  it('does not offer override results if the audit cannot be persisted', async () => {
    const db = {
      ...dbWith([lot({ printedMrpMinor: 2000 })]),
      auditLog: {
        create: vi.fn(async () => {
          throw new Error('Audit unavailable');
        }),
      },
    };
    await expect(
      findSubstituteProposals(
        db as never,
        { ...scope, actorId: 'pharmacist' },
        {
          medicineId: 'requested',
          presentationId: 'presentation-requested',
          quantityCanonicalUnits: 10,
          pharmacistOverride: { reason: 'Patient requested available brand' },
        }
      )
    ).rejects.toThrow('Audit unavailable');
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
