import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));

import { Prisma } from '@/generated/prisma/client';
import {
  csvCell,
  exportRestaurantReportCsv,
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

  it('selects one deterministic latest unsuperseded fork tip for overview and payments', async () => {
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
      cashExpected: money(0),
      cashCounted: money(0),
      cashVariance: money(0),
    });
    const db = {
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
    expect(paymentsCsv.content).toContain(
      '\n2026-01-01,2026-01-01,20,20,10,6,2,0,0,0,0,0,0,0,0,0,0'
    );
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
      totalEstimatedMovementCount: 2,
      totalUnvaluedMovementCount: 0,
      totalActivityCost: decimal(16),
    };
    const db = { $queryRaw: vi.fn(async () => [row]) } as unknown as ScopedDb;

    const report = await readStockMovementReport(db, boundedRange);

    expect(report.totals).toEqual({
      movementCount: 3,
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
