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
    entitlements: { organizationId: 'agency-1', enabledModules: [], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'admin-1', role: 'ADMIN', status: 'ACTIVE', organizationId: 'agency-1' },
    },
    organization: {
      id: 'agency-1',
      timezone: 'Asia/Karachi',
      currency: 'PKR',
      vertical: 'AGENCY',
    },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('finance.getFinancialSummary monthly revenue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-22T12:00:00.000Z'));
    mocks.transactionGroupBy.mockResolvedValue([]);
    mocks.invoiceGroupBy.mockResolvedValue([]);
    mocks.recurringFindMany.mockResolvedValue([]);
  });

  afterEach(() => vi.useRealTimers());

  it('sums paid invoice payments in integer minor units and excludes invoices without a payment', async () => {
    mocks.paymentGroupBy.mockResolvedValue([
      { currency: 'PKR', _sum: { amount: '1250.50' } },
    ]);

    const summary = await caller().getFinancialSummary();

    expect(summary.monthlyRevenue).toEqual([{ currency: 'PKR', amountMinor: 125_050 }]);
    expect(summary.tenantCurrency).toBe('PKR');
    expect(mocks.paymentGroupBy).toHaveBeenCalledOnce();
  });

  it('does not treat an invoice without a payment as collected revenue', async () => {
    mocks.paymentGroupBy.mockResolvedValue([]);
    mocks.invoiceGroupBy.mockResolvedValue([
      { currency: 'PKR', _sum: { total: '9000.00' }, _count: 1 },
    ]);

    const summary = await caller().getFinancialSummary();

    expect(summary.monthlyRevenue).toEqual([]);
  });

  it('uses Asia/Karachi month boundaries and explicit tenant scope', async () => {
    mocks.paymentGroupBy.mockResolvedValue([]);

    await caller().getFinancialSummary();

    expect(mocks.paymentGroupBy).toHaveBeenCalledWith({
      by: ['currency'],
      _sum: { amount: true },
      where: {
        organizationId: 'agency-1',
        paidAt: {
          gte: new Date('2026-09-30T19:00:00.000Z'),
          lt: new Date('2026-10-31T19:00:00.000Z'),
          lte: new Date('2026-10-22T12:00:00.000Z'),
        },
      },
    });
  });
});
