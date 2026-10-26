import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  transactionGroupBy: vi.fn(),
  paymentGroupBy: vi.fn(),
  invoiceGroupBy: vi.fn(),
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 22, 12));
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.transactionGroupBy.mockResolvedValue([]);
    mocks.paymentGroupBy.mockResolvedValue([{ currency: 'USD', _sum: { amount: 100 } }]);
    mocks.invoiceGroupBy.mockResolvedValue([]);
    mocks.recurringFindMany.mockResolvedValue([]);
  });

  afterEach(() => vi.useRealTimers());

  it('includes a paid invoice receipt in monthly revenue', async () => {
    const summary = await caller().getFinancialSummary();

    expect(summary.monthlyIncome).toEqual([{ currency: 'USD', amount: 100 }]);
    expect(summary.monthlyProfit).toEqual([{ currency: 'USD', amount: 100 }]);
    expect(summary.yearlyIncome).toEqual([{ currency: 'USD', amount: 100 }]);
    expect(summary.yearlyProfit).toEqual([{ currency: 'USD', amount: 100 }]);
    expect(mocks.paymentGroupBy).toHaveBeenCalledWith({
      by: ['currency'],
      _sum: { amount: true },
      where: {
        organizationId: 'org-1',
        paidAt: {
          gte: new Date(2026, 9, 1),
          lte: new Date(2026, 9, 22, 12),
        },
      },
    });
    expect(mocks.paymentGroupBy).toHaveBeenCalledWith({
      by: ['currency'],
      _sum: { amount: true },
      where: {
        organizationId: 'org-1',
        paidAt: {
          gte: new Date(2026, 0, 1),
          lte: new Date(2026, 9, 22, 12),
        },
      },
    });
  });

  it('adds invoice receipts to manual income without mixing currencies', async () => {
    mocks.transactionGroupBy
      .mockResolvedValueOnce([
        { currency: 'USD', _sum: { amount: 25 } },
        { currency: 'PKR', _sum: { amount: 500 } },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const invoiceReceipts = [
      { currency: 'USD', _sum: { amount: 100 } },
      { currency: 'PKR', _sum: { amount: 1_000 } },
    ];
    mocks.paymentGroupBy
      .mockResolvedValueOnce(invoiceReceipts)
      .mockResolvedValueOnce(invoiceReceipts);

    const summary = await caller().getFinancialSummary();

    expect(summary.monthlyIncome).toEqual([
      { currency: 'USD', amount: 125 },
      { currency: 'PKR', amount: 1_500 },
    ]);
    expect(summary.yearlyIncome).toEqual([
      { currency: 'USD', amount: 100 },
      { currency: 'PKR', amount: 1_000 },
    ]);
  });

  it('keeps earlier yearly invoice receipts out of monthly revenue', async () => {
    mocks.paymentGroupBy
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ currency: 'USD', _sum: { amount: 40 } }]);

    const summary = await caller().getFinancialSummary();

    expect(summary.monthlyIncome).toEqual([]);
    expect(summary.monthlyProfit).toEqual([]);
    expect(summary.yearlyIncome).toEqual([{ currency: 'USD', amount: 40 }]);
    expect(summary.yearlyProfit).toEqual([{ currency: 'USD', amount: 40 }]);
  });
});
