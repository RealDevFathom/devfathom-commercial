import { describe, expect, it } from 'vitest';
import type { AllocationCandidate } from './inventory';

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

function dbWith(lots: ReturnType<typeof lot>[]) {
  const db = {
    medicine: { findFirst: async () => requested },
    pharmacyInventoryLot: { findMany: async () => lots },
    async $transaction(work: (tx: unknown) => Promise<unknown>): Promise<unknown> {
      return work(this);
    },
    $queryRaw: async (query: unknown): Promise<unknown[]> => {
      if (Array.isArray(query)) return [{ branch: '' }]; // branch-context statements
      return lots.flatMap((item) =>
        item.balances.map((balance) => ({
          ...balance,
          inventoryLotId: item.id,
          stockLocationId: 'shelf',
          batchState: 'ACTIVE',
          disposition: 'AVAILABLE',
          expiresAt: new Date('2099-01-01T00:00:00Z'),
          receivedAt: new Date('2026-01-01T00:00:00Z'),
          availableUnits: balance.onHandUnits,
        }))
      );
    },
  };
  return db;
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

  it('uses ledger availability instead of raw on-hand units and binds branch RLS', async () => {
    const db = dbWith([lot()]);
    const statements: unknown[] = [];
    const contextValues: unknown[][] = [];
    db.$queryRaw = async (query: unknown, ...values: unknown[]) => {
      statements.push(query);
      if (Array.isArray(query)) {
        contextValues.push(values);
        return [{ branch: 'previous-branch' }];
      }
      return [
        {
          ...scope,
          inventoryLotId: 'lot-a',
          stockLocationId: 'shelf',
          batchState: 'ACTIVE',
          disposition: 'AVAILABLE',
          receivedAt: new Date('2026-01-01T00:00:00Z'),
          expiresAt: new Date('2099-01-01T00:00:00Z'),
          availableUnits: 5,
        },
      ] satisfies AllocationCandidate[];
    };
    const input = {
      medicineId: 'requested',
      presentationId: 'presentation-requested',
      quantityCanonicalUnits: 10,
    };
    await expect(findMarginOptimizedBrandProposals(db as never, scope, input)).resolves.toEqual([]);
    const rows = await findMarginOptimizedBrandProposals(db as never, scope, {
      ...input,
      quantityCanonicalUnits: 5,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.availableCanonicalUnits).toBe(5);
    const ledgerQuery = statements.find((statement) => !Array.isArray(statement)) as {
      sql: string;
      values: unknown[];
    };
    expect(ledgerQuery.sql).toContain('pharmacy_supplier_claims');
    expect(ledgerQuery.sql).toContain('pharmacy_restock_reservations');
    expect(ledgerQuery.values).toEqual([scope.organizationId, scope.branchId, 'alternate']);
    expect(contextValues).toEqual([
      [],
      [scope.branchId],
      ['previous-branch'],
      [],
      [scope.branchId],
      ['previous-branch'],
    ]);
  });

  it('does not count foreign tenant or branch balances as available stock', async () => {
    let query: { where: unknown; include: unknown } | undefined;
    const db = {
      ...dbWith([
        lot({
          balances: [
            { organizationId: 'org-b', branchId: 'branch-a', onHandUnits: 100 },
            { organizationId: 'org-a', branchId: 'branch-b', onHandUnits: 100 },
            { organizationId: 'org-a', branchId: 'branch-a', onHandUnits: 2 },
          ],
        }),
      ]),
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

  it.each([
    { label: 'same branch', branches: ['branch-a', 'branch-a'], initialBranch: '' },
    { label: 'different branches', branches: ['branch-a', 'branch-b'], initialBranch: '' },
    {
      label: 'different branches with an existing scope',
      branches: ['branch-a', 'branch-b'],
      initialBranch: 'previous-branch',
    },
  ])('keeps concurrent comparisons for $label bound through every ledger read', async ({
    branches,
    initialBranch,
  }) => {
    const lots = [...new Set(branches)].flatMap((branchId) =>
      ['single', 'first', 'second'].map((medicineId) =>
        lot({
          id: `${branchId}-${medicineId}`,
          balances: [{ organizationId: scope.organizationId, branchId, onHandUnits: 20 }],
          batch: {
            medicine: {
              id: medicineId,
              productName: medicineId,
              strengths: strength('ingredient-a', medicineId === 'single' ? '250' : '500'),
            },
          },
        })
      )
    );
    const db = dbWith(lots);
    db.medicine.findFirst = async (args?: { where: { id: string } }) => ({
      ...requested,
      strengths: strength('ingredient-a', args?.where.id === 'requested-single' ? '250' : '500'),
    });
    let currentBranch = initialBranch;
    db.pharmacyInventoryLot.findMany = async (args?: { where: { branchId: string } }) => {
      expect(currentBranch).toBe(args?.where.branchId);
      return lots.filter((item) => item.balances[0]!.branchId === args?.where.branchId);
    };
    const readScopes: { requested: unknown; actual: string }[] = [];
    // Model the HTTP batch's one connection: only individual statements queue.
    let statementQueue = Promise.resolve();
    db.$queryRaw = (query: unknown, ...values: unknown[]) => {
      const result = statementQueue.then(() => {
        if (Array.isArray(query)) {
          if (query[0].includes('current_setting')) return [{ branch: currentBranch }];
          currentBranch = String(values[0]);
          return [];
        }
        const [, branchId, medicineId] = (query as { values: unknown[] }).values;
        readScopes.push({ requested: branchId, actual: currentBranch });
        // Branch RLS hides sibling stock; an empty scope hides restock holds.
        if (currentBranch && currentBranch !== branchId) return [];
        return lots
          .filter(
            (item) => item.balances[0]!.branchId === branchId && item.batch.medicine.id === medicineId
          )
          .map(
            (item) =>
              ({
                organizationId: scope.organizationId,
                branchId: String(branchId),
                inventoryLotId: item.id,
                stockLocationId: 'shelf',
                batchState: 'ACTIVE',
                disposition: 'AVAILABLE',
                receivedAt: new Date('2026-01-01T00:00:00Z'),
                expiresAt: new Date('2099-01-01T00:00:00Z'),
                availableUnits: currentBranch === branchId ? 5 : 20,
              }) satisfies AllocationCandidate
          );
      });
      statementQueue = result.then(() => undefined);
      return result;
    };
    const results = await Promise.all(
      branches.map((branchId, index) =>
        findMarginOptimizedBrandProposals(
          db as never,
          { ...scope, branchId },
          {
            // The shorter comparison must not restore scope during the other's second read.
            medicineId: index === 0 ? 'requested-single' : 'requested',
            presentationId: 'presentation-requested',
            quantityCanonicalUnits: 5,
          }
        )
      )
    );
    results.forEach((rows, index) => {
      expect(rows.map((row) => [row.inventoryLotId, row.availableCanonicalUnits])).toEqual(
        (index === 0 ? ['single'] : ['first', 'second']).map((medicineId) => [
          `${branches[index]}-${medicineId}`,
          5,
        ])
      );
    });
    expect(readScopes).toEqual(
      branches.flatMap((branchId, index) =>
        Array.from({ length: index === 0 ? 1 : 2 }, () => ({
          requested: branchId,
          actual: branchId,
        }))
      )
    );
    expect(currentBranch).toBe(initialBranch);
  });

  it('restores branch scope and releases a queued comparison when a ledger read fails', async () => {
    const db = dbWith([lot()]);
    const readLedger = db.$queryRaw;
    let currentBranch = 'previous-branch';
    let failRead = true;
    db.$queryRaw = async (query: unknown, ...values: unknown[]) => {
      if (Array.isArray(query)) {
        if (query[0].includes('current_setting')) return [{ branch: currentBranch }];
        currentBranch = String(values[0]);
        return [];
      }
      expect(currentBranch).toBe(scope.branchId);
      if (failRead) {
        failRead = false;
        throw new Error('ledger read failed');
      }
      return readLedger(query);
    };
    const input = {
      medicineId: 'requested',
      presentationId: 'presentation-requested',
      quantityCanonicalUnits: 10,
    };
    const [failed, succeeded] = await Promise.allSettled([
      findMarginOptimizedBrandProposals(db as never, scope, input),
      findMarginOptimizedBrandProposals(db as never, scope, input),
    ]);
    expect(failed).toMatchObject({ status: 'rejected', reason: new Error('ledger read failed') });
    expect(succeeded).toMatchObject({
      status: 'fulfilled',
      value: [{ inventoryLotId: 'lot-a', availableCanonicalUnits: 20 }],
    });
    expect(currentBranch).toBe('previous-branch');
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

  it.each([
    { name: 'missing strengths', strengths: [] },
    { name: 'blank strength unit', strengths: [{ ...strength()[0]!, unit: ' ' }] },
    { name: 'missing dosage form', dosageForm: null },
    { name: 'blank dosage form', dosageForm: ' ' },
    { name: 'missing route', route: null },
    { name: 'blank route', route: ' ' },
  ])('does not infer exact equivalence from $name on both medicines', async (facts) => {
    const strengths = facts.strengths ?? strength();
    const presentation = { ...requested.presentations[0]!, ...facts };
    const db = {
      ...dbWith([
        lot({
          batch: { medicine: { id: 'unrelated', productName: 'Unrelated', strengths } },
          packLevel: { presentation: { ...presentation, id: 'unrelated-presentation' } },
        }),
      ]),
      medicine: {
        findFirst: async () => ({ ...requested, strengths, presentations: [presentation] }),
      },
    };
    await expect(
      findMarginOptimizedBrandProposals(db as never, scope, {
        medicineId: 'requested',
        presentationId: 'presentation-requested',
        quantityCanonicalUnits: 10,
      })
    ).resolves.toEqual([]);
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
