import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('server-only', () => ({}));

import {
  exportInsightReports,
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
  netSales: D('120.25'),
  compTotal: D('5.25'),
  refundTotal: D('10.00'),
  voidTotal: D('2.00'),
  drawerVariance: D('-0.50'),
  loyaltyLiability: D('999'),
  loyaltyLiabilityFact: { liability: D('18.75') },
  computedAt,
  createdAt: computedAt,
  updatedAt: computedAt,
  branch: { name: 'Main', timezone: 'Asia/Karachi' },
  sourceDailyClose: { supersededBy: [] },
};

const db = {
  insightDailyRollup: { findMany: vi.fn() },
  labourCostFact: { findFirst: vi.fn(), create: vi.fn() },
};

beforeEach(() => {
  vi.clearAllMocks();
  db.insightDailyRollup.findMany.mockResolvedValue([dailyRow]);
  db.labourCostFact.findFirst.mockResolvedValue(null);
});

describe('insight report serialization', () => {
  it('returns Decimal money as strings and UTC plus branch-local freshness timestamps', async () => {
    const [row] = await listInsightReports(db as unknown as ScopedDb, 'financial', {
      branchId: 'branch_1',
    });
    expect(row).toMatchObject({
      grossSales: '125.5',
      drawerVariance: '-0.5',
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

  it('emits organization liability once in a consolidated multi-branch export', async () => {
    db.insightDailyRollup.findMany.mockResolvedValue([
      dailyRow,
      {
        ...dailyRow,
        id: 'rollup_2',
        branchId: 'branch_2',
        branch: { name: 'Second', timezone: 'Asia/Karachi' },
      },
    ]);
    const exported = await exportInsightReports(db as unknown as ScopedDb, 'financial', {
      from: '2026-08-20',
      to: '2026-08-20',
    });
    const [header, ...rows] = exported.content.split('\n');
    const liabilityIndex = header!.split(',').indexOf('loyaltyLiability');
    expect(rows.map((row) => row.split(',')[liabilityIndex])).toEqual(['18.75', '']);
  });

  it('falls back to the untouched legacy value while an old writer has not linked a fact', async () => {
    db.insightDailyRollup.findMany.mockResolvedValue([
      { ...dailyRow, loyaltyLiability: D('7.25'), loyaltyLiabilityFact: null },
    ]);
    const [row] = await listInsightReports(db as unknown as ScopedDb, 'financial', {
      branchId: 'branch_1',
    });
    expect(row).toMatchObject({ loyaltyLiability: '7.25' });
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
