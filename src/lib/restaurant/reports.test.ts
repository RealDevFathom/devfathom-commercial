import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));

const recipeMocks = vi.hoisted(() => ({
  computeRecipeCost: vi.fn(),
  computeRecipeCostInDb: vi.fn(),
}));
vi.mock('./recipe-costing', async () => ({
  ...(await vi.importActual<typeof import('./recipe-costing')>('./recipe-costing')),
  computeRecipeCost: recipeMocks.computeRecipeCost,
  computeRecipeCostInDb: recipeMocks.computeRecipeCostInDb,
}));

import { Prisma } from '@/generated/prisma/client';
import {
  csvCell,
  exportRestaurantReportCsv,
  readCateringReport,
  readDishProfitabilityReport,
  readFoodCostReport,
  readInventoryReport,
  readOverviewReport,
  readPaymentsReport,
  readPurchasingReport,
  readSopReport,
  readStockMovementReport,
  readWastageReport,
  readWorkforceReport,
  rowsToCsv,
  validateRestaurantReportRange,
} from './reports';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

beforeEach(() => {
  recipeMocks.computeRecipeCost.mockReset();
  recipeMocks.computeRecipeCostInDb.mockReset();
});

describe('restaurant report range and CSV safety', () => {
  it('accepts 90 days and rejects 91 or reversed dates', () => {
    expect(
      validateRestaurantReportRange({ branchIds: ['b1'], from: '2026-01-01', to: '2026-03-31' })
        .days
    ).toBe(90);
    expect(() =>
      validateRestaurantReportRange({ branchIds: ['b1'], from: '2026-01-01', to: '2026-04-01' })
    ).toThrow('90');
    expect(() =>
      validateRestaurantReportRange({ branchIds: ['b1'], from: '2026-02-01', to: '2026-01-01' })
    ).toThrow('must not be after');
  });

  it('neutralizes spreadsheet formulas before deterministic RFC-style quoting', () => {
    expect(csvCell('=2+2')).toBe("'=2+2");
    expect(csvCell('  @SUM(A1)')).toBe("'  @SUM(A1)");
    expect(rowsToCsv([{ label: '=cmd', value: 'a,b' }], ['label', 'value'])).toBe(
      'label,value\n\'=cmd,"a,b"'
    );
  });
});

describe('restaurant food-cost and dish-profitability reports', () => {
  const salesRow = (
    productId: string,
    productName: string,
    quantity: number,
    netSales: number,
    variantId: string | null = null
  ) => ({
    branchId: 'b1',
    branchName: 'Main',
    productId,
    productName,
    variantId,
    categoryId: 'cat-1',
    categoryName: 'Mains',
    quantity: BigInt(quantity),
    netSales: new Prisma.Decimal(netSales),
  });
  const recipeCost = (cost: number, missing: string[] = []) => ({
    costPerPortion: new Prisma.Decimal(cost),
    missing,
  });

  it('allocates settled-bill net sales, reports complete costs, and separates every exception', async () => {
    const db = {
      $queryRaw: vi.fn(async () => [
        salesRow('p1', '=Burger', 10, 100),
        salesRow('p2', 'Soup', 5, 50),
        salesRow('p3', 'Curry', 3, 30),
      ]),
      restaurantRecipe: {
        findMany: vi.fn(async () => [
          { id: 'r1', organizationId: 'org1', productId: 'p1', variantId: null },
          { id: 'r3', organizationId: 'org1', productId: 'p3', variantId: null },
        ]),
      },
    } as unknown as ScopedDb;
    recipeMocks.computeRecipeCost.mockImplementation(async ({ recipeId }: { recipeId: string }) =>
      recipeId === 'r1' ? recipeCost(3) : recipeCost(2, ['ingredient-missing'])
    );

    const report = await readFoodCostReport(db, boundedRange);

    expect(report.totals).toEqual({
      netSales: '180',
      costedNetSales: '100',
      uncostedNetSales: '80',
      theoreticalCost: '30',
      foodCostPercent: '30',
      grossMargin: '70',
    });
    expect(report.products).toEqual([
      expect.objectContaining({
        productId: 'p1',
        quantity: '10',
        theoreticalCost: '30',
        grossMargin: '70',
        marginPerItem: '7',
      }),
    ]);
    expect(report.categories).toEqual([
      expect.objectContaining({ name: 'Mains', netSales: '100', theoreticalCost: '30' }),
    ]);
    expect(report.branches).toEqual([
      expect.objectContaining({ name: 'Main', netSales: '100', grossMargin: '70' }),
    ]);
    expect(report.uncostedProducts).toEqual([
      expect.objectContaining({ productId: 'p3', reason: 'MISSING_INGREDIENT_COST' }),
      expect.objectContaining({ productId: 'p2', reason: 'NO_RECIPE' }),
    ]);
    const sql = queryText((db.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(sql).toContain('bill."status" = \'SETTLED\'');
    expect(sql).toContain('bill_lines."discountTotal" * bill_lines."eligibleSales"');

    const exported = await exportRestaurantReportCsv(db, 'food-cost', boundedRange, {
      includeLabourCosts: false,
    });
    expect(exported.content).toContain("'=Burger");
    expect(exported.content).toContain('MISSING_INGREDIENT_COST');
    expect(exported.content).toContain('NO_RECIPE');
  });

  it('ranks dishes by volume and contribution margin around deterministic medians', async () => {
    const db = {
      $queryRaw: vi.fn(async () => [
        salesRow('star', 'Star', 10, 100),
        salesRow('plowhorse', 'Plowhorse', 10, 30),
        salesRow('puzzle', 'Puzzle', 2, 20),
        salesRow('dog', 'Dog', 2, 4),
      ]),
      restaurantRecipe: {
        findMany: vi.fn(async () =>
          ['star', 'plowhorse', 'puzzle', 'dog'].map((productId) => ({
            id: `r-${productId}`,
            organizationId: 'org1',
            productId,
            variantId: null,
          }))
        ),
      },
    } as unknown as ScopedDb;
    recipeMocks.computeRecipeCost.mockImplementation(async ({ recipeId }: { recipeId: string }) =>
      recipeId === 'r-star' || recipeId === 'r-plowhorse' ? recipeCost(2) : recipeCost(1)
    );

    const report = await readDishProfitabilityReport(db, boundedRange);

    expect(report.thresholds).toEqual({ medianVolume: '6', medianMargin: '4.5' });
    expect(
      Object.fromEntries(report.menuEngineering.map((row) => [row.productId, row.quadrant]))
    ).toEqual({ star: 'STAR', plowhorse: 'PLOWHORSE', puzzle: 'PUZZLE', dog: 'DOG' });
    expect(report.byMargin.map((row) => row.productId)).toEqual([
      'puzzle',
      'star',
      'dog',
      'plowhorse',
    ]);
    expect(report.byVolume.slice(0, 2).map((row) => row.productId)).toEqual(['star', 'plowhorse']);
  });
});

const cateringEventDate = new Date('2026-01-10T00:00:00Z');

function afterKey(id: string) {
  return [
    { eventDate: { gt: cateringEventDate } },
    { eventDate: cateringEventDate, id: { gt: id } },
  ];
}

type KeysetQuery = {
  take: number;
  where: { OR?: [{ eventDate: { gt: Date } }, { eventDate: Date; id: { gt: string } }] };
};

function keysetPage<T extends { id: string; eventDate: Date }>(orders: T[]) {
  return async (query: KeysetQuery) => {
    const after = query.where.OR;
    const rows = after
      ? orders.filter(
          (order) =>
            order.eventDate > after[0].eventDate.gt ||
            (order.eventDate.getTime() === after[1].eventDate.getTime() &&
              order.id > after[1].id.gt)
        )
      : orders;
    return rows.slice(0, query.take);
  };
}

describe('restaurant catering report', () => {
  it('does not mark an exact detail-limit page as truncated', async () => {
    const orders = Array.from({ length: 500 }, (_, index) => ({
      id: `o${String(index + 1).padStart(3, '0')}`,
      organizationId: 'org1',
      eventName: `Event ${index + 1}`,
      eventDate: new Date('2026-01-10T00:00:00Z'),
      status: 'DRAFT',
      quotedTotal: new Prisma.Decimal(1),
      branch: { id: 'b1', name: 'Main' },
      lines: [],
      extraCosts: [],
      delivery: null,
    }));
    const findMany = vi.fn(keysetPage(orders));
    const db = { restaurantCateringOrder: { findMany } } as unknown as ScopedDb;

    const report = await readCateringReport(db, boundedRange, 500);

    expect(report.orders).toHaveLength(500);
    expect(report.totals.orderCount).toBe(500);
    expect(report.truncated).toBe(false);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[1][0]).toMatchObject({
      where: { OR: afterKey('o500') },
    });
    expect(findMany.mock.calls[1][0]).not.toHaveProperty('cursor');
  });

  it('aggregates across every cursor page while retaining only the bounded detail rows', async () => {
    const orders = Array.from({ length: 1001 }, (_, index) => ({
      id: `o${String(index + 1).padStart(4, '0')}`,
      organizationId: 'org1',
      eventName: `Event ${index + 1}`,
      eventDate: new Date('2026-01-10T00:00:00Z'),
      status: index === 1000 ? 'DELIVERED' : 'DRAFT',
      quotedTotal: new Prisma.Decimal(100),
      branch: { id: 'b1', name: 'Main' },
      lines:
        index === 1000
          ? [
              {
                recipeId: 'later-page-recipe',
                description: 'Later page menu line',
                portions: new Prisma.Decimal(2),
                costPerPortionSnapshot: null,
              },
            ]
          : [],
      extraCosts: [],
      delivery:
        index === 1000
          ? {
              scheduledAt: new Date('2026-01-10T12:00:00Z'),
              deliveredAt: new Date('2026-01-10T12:05:00Z'),
            }
          : null,
    }));
    const findMany = vi.fn(keysetPage(orders));
    const db = {
      restaurantCateringOrder: { findMany },
    } as unknown as ScopedDb;
    recipeMocks.computeRecipeCostInDb.mockResolvedValue({
      costPerPortion: new Prisma.Decimal(3),
      missing: [],
    });

    const report = await readCateringReport(db, boundedRange);

    expect(report.orders).toHaveLength(200);
    expect(report.orders[0]?.id).toBe('o0001');
    expect(report.orders.at(-1)?.id).toBe('o0200');
    expect(report.orders).not.toContainEqual(expect.objectContaining({ id: 'o1001' }));
    expect(report.truncated).toBe(true);
    expect(report.totals).toMatchObject({
      orderCount: 1001,
      revenue: '100100',
      knownIngredientCost: '6',
      deliveredCount: 1,
      deliveredOnTimeCount: 0,
      deliveredOnTimeRate: '0',
    });
    expect(report.byStatus).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'DRAFT', orderCount: 1000, revenue: '100000' }),
        expect.objectContaining({ status: 'DELIVERED', orderCount: 1, revenue: '100' }),
      ])
    );
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: {
        branchId: { in: boundedRange.branchIds },
        eventDate: {
          gte: new Date('2026-01-01T00:00:00.000Z'),
          lte: new Date('2026-01-31T00:00:00.000Z'),
        },
      },
      orderBy: [{ eventDate: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty('OR');
    expect(findMany.mock.calls[1][0]).toMatchObject({
      take: 500,
      where: { OR: afterKey('o0500') },
    });
    expect(findMany.mock.calls[2][0]).toMatchObject({
      take: 500,
      where: { OR: afterKey('o1000') },
    });
    for (const [query] of findMany.mock.calls) {
      expect(query).not.toHaveProperty('cursor');
      expect(query).not.toHaveProperty('skip');
    }
    expect(recipeMocks.computeRecipeCostInDb).toHaveBeenCalledWith(db, {
      organizationId: 'org1',
      recipeId: 'later-page-recipe',
    });
    expect(recipeMocks.computeRecipeCost).not.toHaveBeenCalled();
  });

  it('combines quoted revenue, recipe snapshots, extras, margins, status and delivery timing', async () => {
    const order = (
      id: string,
      status: string,
      quotedTotal: Prisma.Decimal | null,
      lines: Array<{
        recipeId: string | null;
        portions: Prisma.Decimal;
        costPerPortionSnapshot: Prisma.Decimal | null;
      }>,
      deliveredAt: string | null
    ) => ({
      id,
      organizationId: 'org1',
      eventName: id === 'o1' ? '=Launch' : `Event ${id}`,
      eventDate: new Date('2026-01-10T00:00:00Z'),
      status,
      quotedTotal,
      branch: { id: 'b1', name: 'Main' },
      lines: lines.map((line) => ({ ...line, description: 'Menu line' })),
      extraCosts: id === 'o1' ? [{ amount: new Prisma.Decimal(10) }] : [],
      delivery: deliveredAt
        ? {
            scheduledAt: new Date('2026-01-10T12:00:00Z'),
            deliveredAt: new Date(deliveredAt),
          }
        : null,
    });
    const db = {
      restaurantCateringOrder: {
        findMany: vi.fn(async () => [
          order(
            'o1',
            'DELIVERED',
            new Prisma.Decimal(100),
            [
              {
                recipeId: 'r1',
                portions: new Prisma.Decimal(10),
                costPerPortionSnapshot: new Prisma.Decimal(3),
              },
            ],
            '2026-01-10T11:55:00Z'
          ),
          order(
            'o2',
            'CLOSED',
            new Prisma.Decimal(80),
            [
              {
                recipeId: 'r2',
                portions: new Prisma.Decimal(5),
                costPerPortionSnapshot: null,
              },
            ],
            '2026-01-10T12:05:00Z'
          ),
          order(
            'o3',
            'DRAFT',
            null,
            [
              {
                recipeId: null,
                portions: new Prisma.Decimal(1),
                costPerPortionSnapshot: null,
              },
            ],
            null
          ),
        ]),
      },
    } as unknown as ScopedDb;
    recipeMocks.computeRecipeCostInDb.mockResolvedValue({
      costPerPortion: new Prisma.Decimal(2),
      missing: [],
    });

    const report = await readCateringReport(db, boundedRange);

    expect(report.totals).toEqual({
      orderCount: 3,
      revenue: '180',
      knownIngredientCost: '40',
      extras: '10',
      margin: null,
      missingCostLineCount: 1,
      missingRevenueOrderCount: 1,
      deliveredCount: 2,
      deliveredOnTimeCount: 1,
      deliveredOnTimeRate: '50',
    });
    expect(report.orders).toEqual([
      expect.objectContaining({
        id: 'o1',
        ingredientCost: '30',
        margin: '60',
        deliveredOnTime: true,
      }),
      expect.objectContaining({
        id: 'o2',
        ingredientCost: '10',
        margin: '70',
        deliveredOnTime: false,
      }),
      expect.objectContaining({ id: 'o3', ingredientCost: null, margin: null }),
    ]);
    expect(report.byStatus).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'DELIVERED', margin: '60' }),
        expect.objectContaining({ status: 'DRAFT', margin: null, incompleteMarginCount: 1 }),
      ])
    );

    const exported = await exportRestaurantReportCsv(db, 'catering', boundedRange, {
      includeLabourCosts: false,
    });
    expect(exported.content).toContain("'=Launch");
    expect(exported.content).toContain('Event o3');
  });
});

describe('restaurant corrected-close backbone', () => {
  it('queries only chain tips and marks a matching projection current without double count', async () => {
    const close = {
      id: 'corrected',
      branchId: 'b1',
      businessDate: new Date('2026-01-01T00:00:00Z'),
      supersedesCloseId: 'original',
      createdAt: new Date(),
      branch: { name: 'One' },
      tenderTotals: [],
    };
    const db = {
      restaurantDailyClose: { findMany: vi.fn(async () => [close]) },
      insightDailyRollup: {
        findMany: vi.fn(async () => [
          {
            id: 'r1',
            branchId: 'b1',
            businessDate: close.businessDate,
            sourceDailyCloseId: 'corrected',
            orderCount: 7,
            coverCount: 9,
            computedAt: new Date(),
          },
        ]),
      },
      $queryRaw: vi.fn(async () => []),
    } as unknown as ScopedDb;
    const report = await readOverviewReport(db, {
      branchIds: ['b1'],
      from: '2026-01-01',
      to: '2026-01-01',
    });
    expect(report.orderCount).toBe(7);
    expect(report.freshness).toMatchObject({
      status: 'CURRENT',
      closedDayCount: 1,
      correctedDayCount: 1,
    });
    expect(db.restaurantDailyClose.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ supersededBy: expect.anything() }),
      })
    );
  });

  it('marks a corrected close stale when projection still pins original close', async () => {
    const date = new Date('2026-01-01T00:00:00Z');
    const db = {
      restaurantDailyClose: {
        findMany: vi.fn(async () => [
          {
            id: 'corrected',
            branchId: 'b1',
            businessDate: date,
            supersedesCloseId: 'original',
            createdAt: new Date(),
            branch: { name: 'One' },
            tenderTotals: [],
          },
        ]),
      },
      insightDailyRollup: {
        findMany: vi.fn(async () => [
          {
            id: 'r1',
            branchId: 'b1',
            businessDate: date,
            sourceDailyCloseId: 'original',
            orderCount: 7,
            coverCount: 9,
            computedAt: new Date(),
          },
        ]),
      },
      $queryRaw: vi.fn(async () => []),
    } as unknown as ScopedDb;
    const report = await readOverviewReport(db, {
      branchIds: ['b1'],
      from: '2026-01-01',
      to: '2026-01-01',
    });
    expect(report.freshness).toMatchObject({ status: 'STALE', staleDayCount: 1 });
    expect(report.orderCount).toBe(0);
  });

  it.each([
    [null, 0, '0', 'INCOMPLETE', 0, 0],
    ['0', 0, '0', 'COMPLETE', 0, 0],
    [null, 100, '-100', 'INCOMPLETE', 0, 0],
    ['0', 100, '-100', 'COMPLETE', 0, 0],
    ['0', 0, '0', 'INCOMPLETE', 1, 0],
    ['0.01', 0, '0', 'INCOMPLETE', 0, 1],
  ] as const)(
    'selects one deterministic fork tip and qualifies count %s, expected %s, variance %s, coverage %s, unverified %s, mismatch %s',
    async (countedCash, cashExpected, cashVariance, coverage, unverified, mismatch) => {
      const date = new Date('2026-01-01T00:00:00Z');
      const money = (value: number) => new Prisma.Decimal(value);
      const close = (id: string, createdAt: string, netSales: number) => ({
        id,
        branchId: 'b1',
        businessDate: date,
        supersedesCloseId: 'original',
        createdAt: new Date(createdAt),
        branch: { name: 'One' },
        tenderTotals: [
          { tenderType: 'CARD', amount: money(netSales), tipAmount: money(0), count: 1 },
        ],
        grossSales: money(netSales),
        deliveryFeeSales: money(6),
        deliveryFeeRefunds: money(2),
        netSales: money(netSales),
        taxTotal: money(0),
        serviceChargeTotal: money(0),
        tipTotal: money(0),
        compTotal: money(0),
        discountTotal: money(0),
        refundTotal: money(0),
        voidTotal: money(0),
        cashExpected: money(cashExpected),
        cashCounted: money(0),
        cashVariance: new Prisma.Decimal(cashVariance),
      });
      const db = {
        restaurantDrawerSession: {
          findMany: vi.fn(async () => [
            {
              branchId: 'b1',
              businessDate: date,
              createdAt: new Date('2026-01-01T12:00:00Z'),
              closedAt: new Date(unverified ? '2026-01-03T00:00:01Z' : '2026-01-01T23:00:00Z'),
              status: 'CLOSED',
              countedCash: countedCash === null ? null : new Prisma.Decimal(countedCash),
            },
          ]),
        },
        restaurantDailyClose: {
          findMany: vi.fn(async () => [
            close('fork-old', '2026-01-02T00:00:00Z', 10),
            close('fork-new', '2026-01-03T00:00:00Z', 20),
          ]),
        },
        insightDailyRollup: {
          findMany: vi.fn(async () => [
            {
              id: 'old-rollup',
              branchId: 'b1',
              businessDate: date,
              sourceDailyCloseId: 'fork-old',
              orderCount: 99,
              coverCount: 99,
              computedAt: new Date(),
            },
            {
              id: 'new-rollup',
              branchId: 'b1',
              businessDate: date,
              sourceDailyCloseId: 'fork-new',
              orderCount: 2,
              coverCount: 3,
              computedAt: new Date(),
            },
          ]),
        },
        $queryRaw: vi.fn(async () => []),
      } as unknown as ScopedDb;
      const range = { branchIds: ['b1'], from: '2026-01-01', to: '2026-01-01' };
      const overview = await readOverviewReport(db, range);
      const payments = await readPaymentsReport(db, range);
      expect(overview).toMatchObject({
        orderCount: 2,
        coverCount: 3,
        freshness: { closedDayCount: 1 },
      });
      expect(payments).toMatchObject({
        netSales: '20',
        averageCheck: '10',
        deliveryFeeSales: '6',
        deliveryFeeRefunds: '2',
        cashExpected: String(cashExpected),
        cashCounted: '0',
        cashVariance,
        cashCountCoverage: {
          status: coverage,
          drawerSessionCount: 1,
          missingCountSessionCount: countedCash === null ? 1 : 0,
          unverifiedCloseSessionCount: unverified,
          mismatchedCloseDayCount: mismatch,
        },
      });
      expect(db.restaurantDrawerSession.findMany).toHaveBeenCalledWith({
        take: 500,
        orderBy: { id: 'asc' },
        where: { branchId: { in: ['b1'] }, businessDate: { gte: date, lte: date } },
        select: {
          id: true,
          branchId: true,
          businessDate: true,
          createdAt: true,
          closedAt: true,
          status: true,
          countedCash: true,
        },
      });
      expect(payments.tenders).toEqual([
        expect.objectContaining({ tenderType: 'CARD', amount: '20', count: 1 }),
      ]);
      const overviewCsv = await exportRestaurantReportCsv(db, 'overview', range, {
        includeLabourCosts: false,
      });
      const paymentsCsv = await exportRestaurantReportCsv(db, 'payments', range, {
        includeLabourCosts: false,
      });
      expect(overviewCsv.content).toContain('\n2026-01-01,2026-01-01,CURRENT,2,3,1,1');
      expect(paymentsCsv).toMatchObject({
        filename: 'restaurant-payments-2026-01-01-to-2026-01-01.csv',
        contentType: 'text/csv; charset=utf-8',
        truncated: false,
      });
      const [header, row] = paymentsCsv.content.split('\n');
      expect(header).toBe(
        'from,to,grossSales,netSales,averageCheck,deliveryFeeSales,deliveryFeeRefunds,tax,service,tips,discounts,comps,refunds,voids,cashExpected,cashCounted,cashVariance,cashCountCoverage,cashDrawerSessionCount,cashMissingCountSessionCount,cashUnverifiedCloseSessionCount,cashMismatchedCloseDayCount,cashCountDefinition'
      );
      // Original monetary columns and their order remain exact; only unsupported
      // count/variance values become blank. Known negative variance stays escaped.
      const exportedCash =
        coverage === 'COMPLETE' ? (cashExpected === 100 ? "0,'-100" : '0,0') : ',';
      expect(row).toBe(
        `2026-01-01,2026-01-01,20,20,10,6,2,0,0,0,0,0,0,0,${cashExpected},${exportedCash},${coverage},1,${countedCash === null ? 1 : 0},${unverified},${mismatch},` +
          '"Blank cashCounted/cashVariance means unavailable count evidence; populated values are source-close amounts with COMPLETE count coverage. ' +
          payments.cashCountCoverage.definition +
          '"'
      );
    }
  );

  it('exports unavailable cash with explicit coverage when no days are closed', async () => {
    const db = {
      restaurantDailyClose: { findMany: vi.fn(async () => []) },
      insightDailyRollup: { findMany: vi.fn(async () => []) },
      restaurantDrawerSession: { findMany: vi.fn() },
    } as unknown as ScopedDb;
    const exported = await exportRestaurantReportCsv(db, 'payments', boundedRange, {
      includeLabourCosts: false,
    });
    expect(exported.content).toContain(
      '\n2026-01-01,2026-01-31,0,0,0,0,0,0,0,0,0,0,0,0,0,,,NO_CLOSED_DAYS,0,0,0,0,'
    );
    expect(exported.content).toContain('Blank cashCounted/cashVariance means unavailable');
    expect(db.restaurantDrawerSession.findMany).not.toHaveBeenCalled();
  });
});

function queryText(query: unknown): string {
  return (query as { strings?: readonly string[] }).strings?.join(' ') ?? '';
}

const boundedRange = { branchIds: ['b1'], from: '2026-01-01', to: '2026-01-31' };

describe('restaurant wastage and stock movement reports', () => {
  const aggregate = {
    movementCount: 1,
    quantity: new Prisma.Decimal(2),
    cost: new Prisma.Decimal(4),
    estimatedCost: new Prisma.Decimal(4),
    estimatedMovementCount: 1,
    unvaluedMovementCount: 0,
  };

  it('values and groups wastage with complete totals, shares, and bounded ingredients', async () => {
    const queries: string[] = [];
    const db = {
      $queryRaw: vi.fn(async (query: unknown) => {
        const text = queryText(query);
        queries.push(text);
        if (text.includes('GROUP BY "reason"')) {
          return [
            { ...aggregate, reason: 'SPOILAGE' },
            {
              ...aggregate,
              reason: 'MANUAL_CORRECTION',
              movementCount: 2,
              quantity: new Prisma.Decimal(3),
              cost: new Prisma.Decimal(6),
              estimatedCost: new Prisma.Decimal(0),
              estimatedMovementCount: 0,
            },
          ];
        }
        if (text.includes('AS "day"')) {
          return [
            {
              ...aggregate,
              day: '2026-01-02',
              movementCount: 3,
              quantity: new Prisma.Decimal(5),
              cost: new Prisma.Decimal(10),
            },
          ];
        }
        return Array.from({ length: 201 }, (_, index) => ({
          ...aggregate,
          stockItemId: `stock-${index}`,
          ingredientName: index === 0 ? '=Tomatoes' : `Ingredient ${index}`,
          canonicalUnit: 'kg',
          movementCount: 3,
          quantity: new Prisma.Decimal(5),
          cost: new Prisma.Decimal(10),
        }));
      }),
    } as unknown as ScopedDb;

    const report = await readWastageReport(db, {
      ...boundedRange,
      stockLocationId: 'location-1',
    });

    expect(report.totals).toEqual({
      movementCount: 3,
      quantity: '5',
      cost: '10',
      estimatedCost: '4',
      estimatedMovementCount: 1,
      unvaluedMovementCount: 0,
    });
    expect(report.byReason).toEqual([
      expect.objectContaining({ reason: 'SPOILAGE', shareOfTotal: '40', estimated: true }),
      expect.objectContaining({
        reason: 'MANUAL_CORRECTION',
        shareOfTotal: '60',
        estimated: false,
      }),
    ]);
    expect(report.byIngredient[0]).toMatchObject({
      ingredientName: '=Tomatoes',
      quantity: '5',
      cost: '10',
      shareOfTotal: '100',
    });
    expect(report.byIngredient).toHaveLength(200);
    expect(report.truncated).toBe(true);
    expect(queries.every((text) => text.includes('movement."locationId" ='))).toBe(true);
    expect(
      queries.every((text) => text.includes('movement."reason" = \'MANUAL_CORRECTION\''))
    ).toBe(true);
    const rawQueries = (db.$queryRaw as ReturnType<typeof vi.fn>).mock.calls.map(
      ([query]) => query as { values: unknown[] }
    );
    expect(
      rawQueries.every(
        (query) => query.values.includes('location-1') && query.values.includes('b1')
      )
    ).toBe(true);
    for (const sql of queries) {
      expect(sql).toMatch(
        /COALESCE\(\s*movement\."unitCost",\s*current_costs\."weightedAverageCost",\s*ingredient\."referenceCost"\s*\)/
      );
      expect(sql).toContain("ELSE 'UNAVAILABLE'");
      expect(sql).toContain(`FILTER (WHERE "valuationSource" <> 'RECORDED')`);
      expect(sql).toContain('movement."occurredAt" >=');
      expect(sql).toContain('movement."occurredAt" <');
    }
    expect(report.byDay[0]).toMatchObject({ day: '2026-01-02', movementCount: 3 });
    expect(report.byIngredient[0].canonicalUnit).toBe('kg');
  });

  it('derives opening, in, out, net, and closing movement balances with complete totals', async () => {
    const decimal = (value: string | number) => new Prisma.Decimal(value);
    const row = {
      stockItemId: 'stock-1',
      ingredientName: 'Flour',
      canonicalUnit: 'kg',
      movementCount: 3,
      openingQuantity: decimal(10),
      inQuantity: decimal(5),
      outQuantity: decimal(3),
      netQuantity: decimal(2),
      closingQuantity: decimal(12),
      openingCost: decimal(20),
      inCost: decimal(10),
      outCost: decimal(6),
      netCost: decimal(4),
      closingCost: decimal(24),
      estimatedMovementCount: 2,
      unvaluedMovementCount: 0,
      totalOpeningQuantity: decimal(10),
      totalInQuantity: decimal(5),
      totalOutQuantity: decimal(3),
      totalNetQuantity: decimal(2),
      totalClosingQuantity: decimal(12),
      totalOpeningCost: decimal(20),
      totalInCost: decimal(10),
      totalOutCost: decimal(6),
      totalNetCost: decimal(4),
      totalClosingCost: decimal(24),
      totalMovementCount: 3,
      totalIngredientCount: 1,
      totalEstimatedMovementCount: 2,
      totalUnvaluedMovementCount: 0,
      totalActivityCost: decimal(16),
    };
    const db = { $queryRaw: vi.fn(async () => [row]) } as unknown as ScopedDb;

    const report = await readStockMovementReport(db, boundedRange);

    expect(report.totals).toEqual({
      movementCount: 3,
      ingredientCount: 1,
      openingQuantity: '10',
      inQuantity: '5',
      outQuantity: '3',
      netQuantity: '2',
      closingQuantity: '12',
      openingCost: '20',
      inCost: '10',
      outCost: '6',
      netCost: '4',
      closingCost: '24',
      estimatedMovementCount: 2,
      unvaluedMovementCount: 0,
    });
    expect(report.ingredients).toEqual([
      expect.objectContaining({
        ingredientName: 'Flour',
        canonicalUnit: 'kg',
        movementCount: 3,
        inQuantity: '5',
        outQuantity: '3',
        netQuantity: '2',
        openingQuantity: '10',
        closingQuantity: '12',
        estimated: true,
        shareOfTotal: '100',
      }),
    ]);
    expect(queryText((db.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      'HAVING COUNT(*) FILTER'
    );
  });

  it.each([
    { status: 'RECORDED', movementCount: 2, estimatedMovementCount: 0, unvaluedMovementCount: 0 },
    { status: 'ESTIMATED', movementCount: 2, estimatedMovementCount: 2, unvaluedMovementCount: 0 },
    { status: 'UNVALUED', movementCount: 2, estimatedMovementCount: 2, unvaluedMovementCount: 2 },
    { status: 'MIXED', movementCount: 2, estimatedMovementCount: 1, unvaluedMovementCount: 0 },
    { status: 'MIXED', movementCount: 2, estimatedMovementCount: 2, unvaluedMovementCount: 1 },
    { status: 'MIXED', movementCount: 2, estimatedMovementCount: 1, unvaluedMovementCount: 1 },
  ])(
    'classifies reason and ingredient $status valuation with inclusive counts ($estimatedMovementCount/$unvaluedMovementCount)',
    async ({ status, ...counts }) => {
      const row = { ...aggregate, ...counts };
      const db = {
        $queryRaw: vi.fn(async (query: unknown) => {
          const text = queryText(query);
          if (text.includes('GROUP BY "reason"')) return [{ ...row, reason: 'WASTAGE' }];
          if (text.includes('AS "day"')) return [{ ...row, day: '2026-01-02' }];
          return [{ ...row, stockItemId: 'stock-1', ingredientName: 'Flour', canonicalUnit: 'kg' }];
        }),
      } as unknown as ScopedDb;
      const report = await readWastageReport(db, boundedRange);
      expect(report.byReason[0]).toMatchObject({ valuationStatus: status, ...counts });
      expect(report.byIngredient[0]).toMatchObject({
        valuationStatus: status,
        canonicalUnit: 'kg',
        ...counts,
      });
      expect(report.totals.estimatedMovementCount).toBe(counts.estimatedMovementCount);
      expect(report.byDay[0].movementCount).toBe(2);
    }
  );

  it('counts all 312 moved ingredients before the 200-row display cap in one scoped query', async () => {
    const decimal = new Prisma.Decimal(1);
    const rows = Array.from({ length: 201 }, (_, index) => ({
      stockItemId: `stock-${index}`,
      ingredientName: `Ingredient ${index}`,
      canonicalUnit: 'kg',
      movementCount: 3,
      openingQuantity: decimal,
      inQuantity: decimal,
      outQuantity: decimal,
      netQuantity: new Prisma.Decimal(0),
      closingQuantity: decimal,
      openingCost: decimal,
      inCost: decimal,
      outCost: decimal,
      netCost: new Prisma.Decimal(0),
      closingCost: decimal,
      estimatedMovementCount: 0,
      unvaluedMovementCount: 0,
      totalOpeningQuantity: new Prisma.Decimal(312),
      totalInQuantity: new Prisma.Decimal(312),
      totalOutQuantity: new Prisma.Decimal(312),
      totalNetQuantity: new Prisma.Decimal(0),
      totalClosingQuantity: new Prisma.Decimal(312),
      totalOpeningCost: new Prisma.Decimal(312),
      totalInCost: new Prisma.Decimal(312),
      totalOutCost: new Prisma.Decimal(312),
      totalNetCost: new Prisma.Decimal(0),
      totalClosingCost: new Prisma.Decimal(312),
      totalMovementCount: 936,
      totalIngredientCount: 312,
      totalEstimatedMovementCount: 0,
      totalUnvaluedMovementCount: 0,
      totalActivityCost: new Prisma.Decimal(624),
    }));
    const db = { $queryRaw: vi.fn(async () => rows) } as unknown as ScopedDb;
    const report = await readStockMovementReport(db, {
      ...boundedRange,
      stockLocationId: 'location-1',
    });
    expect(report.totals).toMatchObject({
      ingredientCount: 312,
      movementCount: 936,
      closingQuantity: '312',
    });
    expect(report.ingredients).toHaveLength(200);
    expect(report.truncated).toBe(true);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    const query = (db.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      values: unknown[];
    };
    const sql = queryText(query);
    expect(sql).toMatch(
      /COUNT\(\*\) OVER \(\)::int AS "totalIngredientCount"[\s\S]*FROM grouped[\s\S]*LIMIT/
    );
    expect(query.values).toEqual(expect.arrayContaining(['b1', 'location-1', 201]));
    expect(query.values.filter((value) => value instanceof Date)).toEqual(
      expect.arrayContaining([
        new Date('2026-01-01T00:00:00.000Z'),
        new Date('2026-02-01T00:00:00.000Z'),
      ])
    );
    expect(sql).toContain('movement."locationId" =');
    expect(sql).toContain('movement."occurredAt" <');
    expect(sql).toContain('WHERE "occurredAt" <');
    expect(sql).toContain('HAVING COUNT(*) FILTER');
    expect(sql).toContain('unit."abbreviation", unit."name"');
  });

  it('reports zero moved ingredients for an empty filtered ledger', async () => {
    const db = { $queryRaw: vi.fn(async () => []) } as unknown as ScopedDb;
    const report = await readStockMovementReport(db, boundedRange);
    expect(report.totals.ingredientCount).toBe(0);
    expect(report.ingredients).toEqual([]);
    expect(report.truncated).toBe(false);
  });

  it('exports formula-safe wastage detail with the same stock-location filter', async () => {
    const db = {
      $queryRaw: vi.fn(async () =>
        Array.from({ length: 5_001 }, (_, index) => ({
          id: `movement-${index}`,
          day: '2026-01-02',
          branchName: 'One',
          locationName: 'Main',
          ingredientName: index === 0 ? '=CMD()' : `Ingredient ${index}`,
          canonicalUnit: 'kg',
          reason: 'WASTAGE',
          quantity: new Prisma.Decimal(2),
          effectiveUnitCost: new Prisma.Decimal(3),
          cost: new Prisma.Decimal(6),
          valuationSource: 'REFERENCE',
        }))
      ),
    } as unknown as ScopedDb;

    const exported = await exportRestaurantReportCsv(
      db,
      'wastage',
      { ...boundedRange, stockLocationId: 'location-1' },
      { includeLabourCosts: false }
    );

    expect(exported.content).toContain("'=CMD()");
    expect(exported.content).toContain('REFERENCE,true');
    expect(exported.content.split('\n')).toHaveLength(5_001);
    expect(exported.truncated).toBe(true);
    expect(queryText((db.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
      'movement."locationId" ='
    );
  });
});

describe('restaurant complete summaries with bounded details', () => {
  it.each([
    { count: 201, expected: 201, truncated: false },
    { count: 5_001, expected: 5_000, truncated: true },
  ])(
    'exports inventory independently at $count rows while interactive stays capped',
    async ({ count, expected, truncated }) => {
      const exportRows = Array.from({ length: count }, (_, index) => ({
        branchId: 'b1',
        stockItemId: `stock-${index}`,
        ingredientName: `Ingredient ${index}`,
        locationId: 'location-1',
        locationName: 'Main',
        onHand: new Prisma.Decimal(1),
        weightedAverageCost: new Prisma.Decimal(2),
      }));
      const db = { $queryRaw: vi.fn(async () => exportRows) } as unknown as ScopedDb;
      const exported = await exportRestaurantReportCsv(db, 'inventory', boundedRange, {
        includeLabourCosts: false,
      });
      expect(exported.content.split('\n')).toHaveLength(expected + 1);
      expect(exported.truncated).toBe(truncated);
      expect(queryText((db.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain(
        'LIMIT'
      );
    }
  );

  it('returns explicit empty, unlimited inventory detail state', async () => {
    const db = {
      $queryRaw: vi.fn(async () => []),
      restaurantStockMovement: { findMany: vi.fn(async () => []) },
    } as unknown as ScopedDb;

    const report = await readInventoryReport(db, boundedRange);
    expect(report).toMatchObject({
      negativeStockCount: 0,
      lowStockCount: 0,
      onHand: [],
      lowStock: [],
      movements: [],
      detailLimits: { onHand: false, lowStock: false, movements: false },
      truncated: false,
    });
  });

  it('keeps inventory totals complete while independently flagging capped detail lists', async () => {
    const onHand = Array.from({ length: 201 }, (_, index) => ({
      branchId: 'b1',
      stockItemId: `stock-${index}`,
      ingredientName: `Ingredient ${index}`,
      locationId: 'location-1',
      locationName: 'Main',
      onHand: new Prisma.Decimal(index === 0 ? -1 : 1),
      weightedAverageCost: new Prisma.Decimal(2),
    }));
    const lowStock = Array.from({ length: 201 }, (_, index) => ({
      ruleId: `rule-${index}`,
      stockItemId: `stock-${index}`,
      locationId: 'location-1',
      threshold: new Prisma.Decimal(3),
      onHand: new Prisma.Decimal(1),
    }));
    const movements = Array.from({ length: 201 }, (_, index) => ({
      id: `movement-${index}`,
      stockItemId: 'stock-1',
      locationId: 'location-1',
      reason: 'ADJUSTMENT',
      quantity: new Prisma.Decimal(1),
      unitCost: null,
      occurredAt: new Date(`2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`),
    }));
    const db = {
      $queryRaw: vi.fn(async (query: unknown) => {
        const text = queryText(query);
        if (text.includes('"negativeStockCount"'))
          return [
            {
              negativeStockCount: 37,
              lowStockCount: 43,
              valuation: new Prisma.Decimal(9999),
              wastageMovementCount: 321,
              wastageQuantity: new Prisma.Decimal(456),
            },
          ];
        if (text.includes('"ingredientName"')) return onHand;
        if (text.includes('"ruleId"')) return lowStock;
        throw new Error(`Unexpected query: ${text}`);
      }),
      restaurantStockMovement: { findMany: vi.fn(async () => movements) },
    } as unknown as ScopedDb;

    const report = await readInventoryReport(db, boundedRange);
    expect(report).toMatchObject({
      negativeStockCount: 37,
      lowStockCount: 43,
      valuation: '9999',
      wastage: { movementCount: 321, quantity: '456' },
      detailLimits: { onHand: true, lowStock: true, movements: true },
      truncated: true,
    });
    expect(report.onHand).toHaveLength(200);
    expect(report.lowStock).toHaveLength(200);
    expect(report.movements).toHaveLength(200);
  });

  it('keeps purchasing aggregates and status groups complete beyond capped discrepancies', async () => {
    const discrepancies = Array.from({ length: 201 }, (_, index) => ({
      id: `discrepancy-${index}`,
      kind: 'SHORTAGE',
      purchaseReceipt: {
        receivedAt: new Date('2026-01-15T00:00:00Z'),
        supplier: { name: 'Supplier' },
      },
    }));
    const db = {
      $queryRaw: vi.fn(async (query: unknown) => {
        const text = queryText(query);
        if (text.includes('"purchaseOrderCount"'))
          return [
            {
              purchaseOrderCount: 250,
              purchaseOrderValue: new Prisma.Decimal(10000),
              receiptCount: 240,
              receivedSupplierSpend: new Prisma.Decimal(9000),
              discrepancyCount: 225,
            },
          ];
        if (text.includes('purchase_order."status"::text'))
          return [
            { status: 'DRAFT', count: 125 },
            { status: 'CLOSED', count: 125 },
          ];
        if (text.includes('"supplierName"'))
          return [{ supplierName: 'Supplier', amount: new Prisma.Decimal(9000) }];
        throw new Error(`Unexpected query: ${text}`);
      }),
      restaurantReceivingDiscrepancy: { findMany: vi.fn(async () => discrepancies) },
    } as unknown as ScopedDb;

    const report = await readPurchasingReport(db, boundedRange);
    expect(report).toMatchObject({
      purchaseOrderCount: 250,
      purchaseOrderValue: '10000',
      receiptCount: 240,
      receivedSupplierSpend: '9000',
      discrepancyCount: 225,
      statusCounts: { DRAFT: 125, CLOSED: 125 },
      truncated: true,
    });
    expect(report.discrepancies).toHaveLength(200);
  });

  it('aggregates every scheduled shift and labour fact without loading detail rows', async () => {
    const db = {
      $queryRaw: vi.fn(async () => [
        { scheduledShiftCount: 6001, scheduledHours: new Prisma.Decimal('12002.5') },
      ]),
      labourCostFact: {
        aggregate: vi.fn(async () => ({
          _sum: {
            labourHours: new Prisma.Decimal('11000.25'),
            labourCost: new Prisma.Decimal('275000.5'),
          },
        })),
      },
    } as unknown as ScopedDb;

    const report = await readWorkforceReport(db, boundedRange, { includeLabourCosts: true });
    expect(report).toMatchObject({
      scheduledShiftCount: 6001,
      scheduledHours: '12002.5',
      labourHours: '11000.25',
      labourCost: '275000.5',
      truncated: false,
    });
  });

  it('uses complete SOP aggregates while bounding attribution export detail', async () => {
    const attribution = Array.from({ length: 5001 }, (_, index) => ({
      staffProfileId: `staff-${index}`,
      displayName: `Staff ${index}`,
      department: 'OPERATIONS',
      owned: index === 0 ? 6001 : 0,
      completed: index === 0 ? 5999 : 0,
    }));
    const db = {
      $queryRaw: vi.fn(async (query: unknown) => {
        const text = queryText(query);
        if (text.includes('"performancePoints"'))
          return [
            {
              total: 6001,
              onTime: 5000,
              late: 500,
              withProof: 5500,
              verified: 5200,
              escalated: 20,
              performancePoints: new Prisma.Decimal(570095),
            },
          ];
        if (text.includes('occurrence."status"::text'))
          return [
            { status: 'VERIFIED', count: 5500 },
            { status: 'SCHEDULED', count: 501 },
          ];
        if (text.includes('"staffProfileId"')) return attribution;
        throw new Error(`Unexpected query: ${text}`);
      }),
    } as unknown as ScopedDb;

    const report = await readSopReport(db, boundedRange);
    expect(report).toMatchObject({
      total: 6001,
      outcomes: { VERIFIED: 5500, SCHEDULED: 501 },
      onTime: 5000,
      performanceScore: 95,
      truncated: true,
    });
    expect(report.attribution).toHaveLength(5000);

    const exported = await exportRestaurantReportCsv(db, 'sop', boundedRange, {
      includeLabourCosts: false,
    });
    expect(exported.content.split('\n')).toHaveLength(5001);
    expect(exported.truncated).toBe(true);
  });
});
