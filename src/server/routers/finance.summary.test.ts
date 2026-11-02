import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  transactionGroupBy: vi.fn(),
  paymentGroupBy: vi.fn(),
  invoiceGroupBy: vi.fn(),
  queryRaw: vi.fn(),
  recurringFindMany: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({ hasModule: vi.fn(() => true) }));
vi.mock('../audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import type { TRPCContext } from '../trpc';
import { financeRouter } from './finance';

function caller() {
  return financeRouter.createCaller({
    db: {
      $queryRaw: mocks.queryRaw,
      transaction: { groupBy: mocks.transactionGroupBy },
      payment: { groupBy: mocks.paymentGroupBy },
      invoice: { groupBy: mocks.invoiceGroupBy },
      recurringExpense: { findMany: mocks.recurringFindMany },
    },
    entitlements: { organizationId: 'org-1', enabledModules: [], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'admin-1', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('finance.getFinancialSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 2, 12));
    mocks.can.mockResolvedValue(true);
    mocks.transactionGroupBy.mockResolvedValue([]);
    mocks.paymentGroupBy.mockResolvedValue([]);
    mocks.invoiceGroupBy.mockResolvedValue([]);
    mocks.queryRaw.mockResolvedValue([]);
    mocks.recurringFindMany.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts a $100 invoice payment as monthly and yearly revenue', async () => {
    mocks.paymentGroupBy.mockResolvedValue([{ currency: 'USD', _sum: { amount: 100 } }]);

    const summary = await caller().getFinancialSummary();

    expect(summary.monthlyIncome).toEqual([{ currency: 'USD', amount: 100 }]);
    expect(summary.yearlyIncome).toEqual([{ currency: 'USD', amount: 100 }]);
    expect(summary.monthlyProfit).toEqual([{ currency: 'USD', amount: 100 }]);
    expect(mocks.paymentGroupBy).toHaveBeenCalledTimes(2);
    expect(mocks.paymentGroupBy).toHaveBeenNthCalledWith(1, {
      by: ['currency'],
      _sum: { amount: true },
      where: { paidAt: { gte: new Date(2026, 10, 1), lte: new Date() } },
    });
    expect(mocks.paymentGroupBy).toHaveBeenNthCalledWith(2, {
      by: ['currency'],
      _sum: { amount: true },
      where: { paidAt: { gte: new Date(2026, 0, 1), lte: new Date() } },
    });
  });

  it('combines payments with manual income while keeping USD and PKR separate', async () => {
    mocks.transactionGroupBy
      .mockResolvedValueOnce([
        { currency: 'USD', _sum: { amount: 50 } },
        { currency: 'PKR', _sum: { amount: 200 } },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { currency: 'USD', _sum: { amount: 250 } },
        { currency: 'PKR', _sum: { amount: 300 } },
      ])
      .mockResolvedValueOnce([]);
    mocks.paymentGroupBy
      .mockResolvedValueOnce([
        { currency: 'USD', _sum: { amount: 100 } },
        { currency: 'PKR', _sum: { amount: 10_000 } },
      ])
      .mockResolvedValueOnce([
        { currency: 'USD', _sum: { amount: 400 } },
        { currency: 'PKR', _sum: { amount: 20_000 } },
      ]);

    const summary = await caller().getFinancialSummary();

    expect(summary.monthlyIncome).toEqual([
      { currency: 'USD', amount: 150 },
      { currency: 'PKR', amount: 10_200 },
    ]);
    expect(summary.yearlyIncome).toEqual([
      { currency: 'USD', amount: 650 },
      { currency: 'PKR', amount: 20_300 },
    ]);
  });

  it('subtracts partial payments from outstanding invoices by currency', async () => {
    mocks.queryRaw.mockResolvedValue([
      { currency: 'PKR', amount: 15_000, count: BigInt(1) },
      { currency: 'USD', amount: 115.24, count: BigInt(2) },
    ]);

    const summary = await caller().getFinancialSummary();

    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    const sql = (mocks.queryRaw.mock.calls[0]?.[0] as { sql: string }).sql;
    expect(sql).toContain("i.status IN ('SENT', 'OVERDUE')");
    expect(sql).toContain('SUM(GREATEST(i.total - COALESCE(p.paid, 0), 0))');
    expect(summary.totalOutstanding).toEqual([
      { currency: 'USD', amount: 115.24 },
      { currency: 'PKR', amount: 15_000 },
    ]);
    expect(summary.outstandingCount).toBe(3);
  });

  it('clamps the balance of an anomalously overpaid open invoice to zero', async () => {
    mocks.queryRaw.mockResolvedValue([{ currency: 'USD', amount: 0, count: BigInt(1) }]);

    const summary = await caller().getFinancialSummary();

    expect(summary.totalOutstanding).toEqual([{ currency: 'USD', amount: 0 }]);
    expect(summary.outstandingCount).toBe(1);
  });
});
