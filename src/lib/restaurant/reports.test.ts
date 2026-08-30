import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));

import { Prisma } from '@/generated/prisma/client';
import {
  csvCell,
  readInventoryReport,
  readOverviewReport,
  readPurchasingReport,
  readSopReport,
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
      expect.objectContaining({ where: expect.objectContaining({ supersededBy: { none: {} } }) })
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
});

function queryText(query: unknown): string {
  return (query as { strings?: readonly string[] }).strings?.join(' ') ?? '';
}

const boundedRange = { branchIds: ['b1'], from: '2026-01-01', to: '2026-01-31' };

describe('restaurant complete summaries with bounded details', () => {
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
  });
});
