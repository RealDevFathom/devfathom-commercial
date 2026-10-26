import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  transactionGroupBy: vi.fn(),
  invoiceGroupBy: vi.fn(),
  paymentGroupBy: vi.fn(),
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
      transaction: { groupBy: mocks.transactionGroupBy },
      invoice: { groupBy: mocks.invoiceGroupBy },
      payment: { groupBy: mocks.paymentGroupBy },
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
    mocks.can.mockResolvedValue(true);
    mocks.transactionGroupBy.mockResolvedValue([]);
    mocks.invoiceGroupBy.mockResolvedValue([]);
    mocks.paymentGroupBy.mockResolvedValue([]);
    mocks.recurringFindMany.mockResolvedValue([]);
  });

  it('subtracts partial payments from outstanding invoice totals by currency', async () => {
    mocks.invoiceGroupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { currency: 'USD', _sum: { total: 1_250 }, _count: 2 },
      { currency: 'PKR', _sum: { total: 500 }, _count: 1 },
    ]);
    mocks.paymentGroupBy.mockResolvedValue([
      { currency: 'USD', _sum: { amount: 650 } },
    ]);

    const summary = await caller().getFinancialSummary();

    expect(summary.totalOutstanding).toEqual([
      { currency: 'USD', amount: 600 },
      { currency: 'PKR', amount: 500 },
    ]);
    expect(summary.outstandingCount).toBe(3);
    expect(mocks.invoiceGroupBy).toHaveBeenLastCalledWith({
      by: ['currency'],
      _sum: { total: true },
      _count: true,
      where: { status: { in: ['SENT', 'OVERDUE'] } },
    });
    expect(mocks.paymentGroupBy).toHaveBeenCalledWith({
      by: ['currency'],
      _sum: { amount: true },
      where: { invoice: { status: { in: ['SENT', 'OVERDUE'] } } },
    });
  });

  it('reports only the unpaid balance of a partially paid invoice', async () => {
    mocks.invoiceGroupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { currency: 'USD', _sum: { total: '1000.00' }, _count: 1 },
    ]);
    mocks.paymentGroupBy.mockResolvedValue([
      { currency: 'USD', _sum: { amount: '600.00' } },
    ]);

    const summary = await caller().getFinancialSummary();

    expect(summary.totalOutstanding).toEqual([{ currency: 'USD', amount: 400 }]);
    expect(summary.outstandingCount).toBe(1);
  });

  it('subtracts multiple payments using exact cent arithmetic', async () => {
    mocks.invoiceGroupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { currency: 'USD', _sum: { total: '1000.30' }, _count: 2 },
    ]);
    mocks.paymentGroupBy.mockResolvedValue([
      { currency: 'USD', _sum: { amount: '600.20' } },
    ]);

    const summary = await caller().getFinancialSummary();

    expect(summary.totalOutstanding).toEqual([{ currency: 'USD', amount: 400.1 }]);
    expect(summary.outstandingCount).toBe(2);
  });

  it('keeps cent arithmetic exact at the Decimal(12,2) upper bound', async () => {
    mocks.invoiceGroupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { currency: 'USD', _sum: { total: '9999999999.99' }, _count: 1 },
    ]);
    mocks.paymentGroupBy.mockResolvedValue([
      { currency: 'USD', _sum: { amount: '0.01' } },
    ]);

    const summary = await caller().getFinancialSummary();

    expect(summary.totalOutstanding).toEqual([{ currency: 'USD', amount: 9_999_999_999.98 }]);
  });

  it('does not accumulate rounding drift across a large invoice set', async () => {
    mocks.invoiceGroupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { currency: 'USD', _sum: { total: '100.00' }, _count: 10_000 },
    ]);

    const summary = await caller().getFinancialSummary();

    expect(summary.totalOutstanding).toEqual([{ currency: 'USD', amount: 100 }]);
    expect(summary.outstandingCount).toBe(10_000);
  });

  it('rejects an aggregate that cannot preserve every cent in the number DTO', async () => {
    // 9,007 maximum-value invoices plus this remainder total exactly
    // 9,007,199,254,740,993 cents: Number.MAX_SAFE_INTEGER + 2.
    mocks.invoiceGroupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { currency: 'USD', _sum: { total: '90071992547409.93' }, _count: 9_008 },
    ]);

    await expect(caller().getFinancialSummary()).rejects.toThrow(
      'Outstanding balance exceeds the safely representable amount'
    );
  });

  it('rejects a safe-integer cent aggregate when the dollar DTO loses a cent', async () => {
    // 9,007 maximum-value invoices plus this remainder total exactly
    // 9,007,199,254,740,990 cents. The integer is safe, but converting it to
    // dollars and back rounds it to 9,007,199,254,740,991 cents.
    mocks.invoiceGroupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { currency: 'USD', _sum: { total: '90071992547409.90' }, _count: 9_008 },
    ]);

    await expect(caller().getFinancialSummary()).rejects.toThrow(
      'Outstanding balance exceeds the safely representable amount'
    );
  });
});
