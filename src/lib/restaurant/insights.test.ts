import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('server-only', () => ({}));

import {
  exportInsightReports,
  readInsightReport,
  formatBranchTimestamp,
  importLabourCost,
  listInsightReports,
} from './insights';

const D = (value: string) => new Prisma.Decimal(value);
const computedAt = new Date('2026-08-21T12:34:56.000Z');
const dailyRow = {
  id: 'rollup_1',
  branchId: 'branch_1',
  businessDate: new Date('2026-08-20T00:00:00.000Z'),
  sourceDailyCloseId: 'close_1',
  orderCount: 4,
  coverCount: 11,
  grossSales: D('125.50'),
  deliveryFeeSales: D('12.00'),
  deliveryFeeRefunds: D('3.00'),
  netSales: D('120.25'),
  compTotal: D('5.25'),
  refundTotal: D('10.00'),
  voidTotal: D('2.00'),
  drawerVariance: D('-0.50'),
  loyaltyLiability: D('18.75'),
  computedAt,
  createdAt: computedAt,
  updatedAt: computedAt,
  branch: { name: 'Main', timezone: 'Asia/Karachi' },
  sourceDailyClose: {
    grossSales: D('125.50'),
    netSales: D('120.25'),
    compTotal: D('5.25'),
    discountTotal: D('0'),
    refundTotal: D('10'),
    supersededBy: [],
  },
};

const db = {
  insightDailyRollup: { findMany: vi.fn(), findFirst: vi.fn() },
  insightItemMixRollup: { findMany: vi.fn().mockResolvedValue([]) },
  insightLoyaltyLiability: { findMany: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
  labourCostFact: { findFirst: vi.fn(), create: vi.fn() },
};

beforeEach(() => {
  vi.clearAllMocks();
  db.insightDailyRollup.findMany.mockResolvedValue([dailyRow]);
  db.insightLoyaltyLiability.findMany.mockResolvedValue([
    { businessDate: dailyRow.businessDate, liability: D('18.75') },
  ]);
  db.labourCostFact.findFirst.mockResolvedValue(null);
});

describe('insight report serialization', () => {
  it('returns Decimal money as strings and UTC plus branch-local freshness timestamps', async () => {
    const [row] = await listInsightReports(db as unknown as ScopedDb, 'financial', {
      branchId: 'branch_1',
    });
    expect(row).toMatchObject({
      grossSales: '125.5',
      deliveryFeeSales: '12',
      deliveryFeeRefunds: '3',
      drawerVariance: '-0.5',
      loyaltyLiability: '18.75',
      freshness: {
        status: 'CURRENT',
        computedAtUtc: '2026-08-21T12:34:56.000Z',
        computedAtLocal: '2026-08-21T17:34:56[Asia/Karachi]',
      },
    });
  });

  it('never includes money or labour fields in ordinary operational payloads', async () => {
    const [row] = await listInsightReports(db as unknown as ScopedDb, 'operational', {});
    expect(row).toMatchObject({ orderCount: 4, coverCount: 11 });
    expect(row).not.toHaveProperty('grossSales');
    expect(row).not.toHaveProperty('labourCost');
    expect(row).not.toHaveProperty('labourHours');
  });

  it('formats branch-local timestamps deterministically', () => {
    expect(formatBranchTimestamp(computedAt, 'UTC')).toBe('2026-08-21T12:34:56[UTC]');
  });
});

describe('append-only labour import', () => {
  it('creates one fact with Decimal inputs and returns string money', async () => {
    db.labourCostFact.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'labour_1',
        ...data,
        importedAt: computedAt,
        createdAt: computedAt,
        branch: { name: 'Main', timezone: 'UTC' },
      })
    );
    const result = await importLabourCost(db as unknown as ScopedDb, {
      branchId: 'branch_1',
      businessDate: '2026-08-20',
      labourHours: '8.50',
      labourCost: '123.45',
      source: 'vendor.csv',
      idempotencyKey: 'labour-2026-08-20',
    });
    expect(result.deduplicated).toBe(false);
    expect(result.fact).toMatchObject({ labourHours: '8.5', labourCost: '123.45' });
    expect(db.labourCostFact.create.mock.calls[0]![0].data).toMatchObject({
      labourHours: expect.any(Prisma.Decimal),
      labourCost: expect.any(Prisma.Decimal),
    });
  });

  it('returns an existing idempotency row without creating another', async () => {
    db.labourCostFact.findFirst.mockResolvedValue({
      id: 'labour_existing',
      branchId: 'branch_1',
      businessDate: new Date('2026-08-20T00:00:00.000Z'),
      labourHours: D('8.5'),
      labourCost: D('123.45'),
      source: 'vendor.csv',
      idempotencyKey: 'same',
      importedAt: computedAt,
      createdAt: computedAt,
      branch: { name: 'Main', timezone: 'UTC' },
    });
    const result = await importLabourCost(db as unknown as ScopedDb, {
      branchId: 'branch_1',
      businessDate: '2026-08-20',
      labourHours: '8.50',
      labourCost: '123.45',
      source: 'vendor.csv',
      idempotencyKey: 'same',
    });
    expect(result.deduplicated).toBe(true);
    expect(db.labourCostFact.create).not.toHaveBeenCalled();
  });
});

it.each(['7', '4'])(
  'normalizes existing cached net %s from source close without writes',
  async (stored) => {
    const row = {
      ...dailyRow,
      netSales: D(stored),
      sourceDailyClose: {
        grossSales: D('10'),
        // Legacy close: net persisted before any refund deduction.
        netSales: D('7'),
        compTotal: D('2'),
        discountTotal: D('1'),
        refundTotal: D('3'),
        supersededBy: [],
      },
    };
    db.insightDailyRollup.findMany.mockResolvedValue([row]);
    const [report] = await listInsightReports(db as unknown as ScopedDb, 'financial', {});
    expect(report.netSales).toBe('4');
    db.insightDailyRollup.findFirst.mockResolvedValue(row);
    const detail = await readInsightReport(db as unknown as ScopedDb, 'financial', {
      branchId: row.branchId,
      businessDate: '2026-08-20',
    });
    expect(detail.netSales).toBe('4');
    const csv = await exportInsightReports(db as unknown as ScopedDb, 'financial', {});
    const [header, line] = csv.content.split('\n');
    expect(line!.split(',')[header!.split(',').indexOf('netSales')]).toBe('4');
    expect(row.netSales.toString()).toBe(stored);
    expect(db.insightDailyRollup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          sourceDailyClose: expect.objectContaining({
            select: expect.objectContaining({
              netSales: true,
              discountTotal: true,
              refundTotal: true,
            }),
          }),
        }),
      })
    );
  }
);

it('reports the close net sales when refunds include tax and service charge', async () => {
  // Bill subtotal 100 + tax 16 + service 10, fully refunded: refundTotal 126
  // carries tax/service, but the close's netSales deducts only the sales part.
  const row = {
    ...dailyRow,
    netSales: D('0'),
    refundTotal: D('126'),
    sourceDailyClose: {
      grossSales: D('100'),
      netSales: D('0'),
      compTotal: D('0'),
      discountTotal: D('0'),
      refundTotal: D('126'),
      supersededBy: [],
    },
  };
  db.insightDailyRollup.findMany.mockResolvedValue([row]);
  const [report] = await listInsightReports(db as unknown as ScopedDb, 'financial', {});
  expect(report.netSales).toBe('0');
  db.insightDailyRollup.findFirst.mockResolvedValue(row);
  const detail = await readInsightReport(db as unknown as ScopedDb, 'financial', {
    branchId: row.branchId,
    businessDate: '2026-08-20',
  });
  expect(detail.netSales).toBe('0');
});
