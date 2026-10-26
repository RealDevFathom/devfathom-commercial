import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  transactionGroupBy: vi.fn(),
  invoiceGroupBy: vi.fn(),
  invoiceFindMany: vi.fn(),
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
      invoice: { groupBy: mocks.invoiceGroupBy, findMany: mocks.invoiceFindMany },
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
    mocks.invoiceFindMany.mockResolvedValue([]);
    mocks.recurringFindMany.mockResolvedValue([]);
  });

  it('subtracts partial payments from outstanding invoice totals by currency', async () => {
    mocks.invoiceFindMany.mockResolvedValue([
      { total: 1_000, currency: 'USD', payments: [{ amount: 600 }] },
      { total: 250, currency: 'USD', payments: [{ amount: 50 }] },
      { total: 500, currency: 'PKR', payments: [] },
    ]);

    const summary = await caller().getFinancialSummary();

    expect(summary.totalOutstanding).toEqual([
      { currency: 'USD', amount: 600 },
      { currency: 'PKR', amount: 500 },
    ]);
    expect(summary.outstandingCount).toBe(3);
    expect(mocks.invoiceFindMany).toHaveBeenCalledWith({
      where: { status: { in: ['SENT', 'OVERDUE'] } },
      select: {
        total: true,
        currency: true,
        payments: { select: { amount: true } },
      },
    });
  });

  it('reports only the unpaid balance of a partially paid invoice', async () => {
    mocks.invoiceFindMany.mockResolvedValue([
      { total: 1_000, currency: 'USD', payments: [{ amount: 600 }] },
    ]);

    const summary = await caller().getFinancialSummary();

    expect(summary.totalOutstanding).toEqual([{ currency: 'USD', amount: 400 }]);
    expect(summary.outstandingCount).toBe(1);
  });

  it('subtracts multiple payments using exact cent arithmetic', async () => {
    mocks.invoiceFindMany.mockResolvedValue([
      { total: 1_000, currency: 'USD', payments: [{ amount: 333.33 }, { amount: 266.67 }] },
      { total: 0.3, currency: 'USD', payments: [{ amount: 0.1 }, { amount: 0.1 }] },
    ]);

    const summary = await caller().getFinancialSummary();

    expect(summary.totalOutstanding).toEqual([{ currency: 'USD', amount: 400.1 }]);
    expect(summary.outstandingCount).toBe(2);
  });

  it('keeps cent arithmetic exact at the Decimal(12,2) upper bound', async () => {
    mocks.invoiceFindMany.mockResolvedValue([
      { total: 9_999_999_999.99, currency: 'USD', payments: [{ amount: 0.01 }] },
    ]);

    const summary = await caller().getFinancialSummary();

    expect(summary.totalOutstanding).toEqual([{ currency: 'USD', amount: 9_999_999_999.98 }]);
  });

  it('does not accumulate rounding drift across a large invoice set', async () => {
    mocks.invoiceFindMany.mockResolvedValue(
      Array.from({ length: 10_000 }, () => ({
        total: 0.01,
        currency: 'USD',
        payments: [],
      }))
    );

    const summary = await caller().getFinancialSummary();

    expect(summary.totalOutstanding).toEqual([{ currency: 'USD', amount: 100 }]);
    expect(summary.outstandingCount).toBe(10_000);
  });

  it('rejects an aggregate that cannot preserve every cent in the number DTO', async () => {
    // 9,007 maximum-value invoices plus this remainder total exactly
    // 9,007,199,254,740,993 cents: Number.MAX_SAFE_INTEGER + 2.
    mocks.invoiceFindMany.mockResolvedValue([
      ...Array.from({ length: 9_007 }, () => ({
        total: 9_999_999_999.99,
        currency: 'USD',
        payments: [],
      })),
      { total: 1_992_547_500, currency: 'USD', payments: [] },
    ]);

    await expect(caller().getFinancialSummary()).rejects.toThrow(
      'Outstanding balance exceeds the safely representable amount'
    );
  });

  it('rejects a safe-integer cent aggregate when the dollar DTO loses a cent', async () => {
    // 9,007 maximum-value invoices plus this remainder total exactly
    // 9,007,199,254,740,990 cents. The integer is safe, but converting it to
    // dollars and back rounds it to 9,007,199,254,740,991 cents.
    mocks.invoiceFindMany.mockResolvedValue([
      ...Array.from({ length: 9_007 }, () => ({
        total: 9_999_999_999.99,
        currency: 'USD',
        payments: [],
      })),
      { total: 1_992_547_499.97, currency: 'USD', payments: [] },
    ]);

    await expect(caller().getFinancialSummary()).rejects.toThrow(
      'Outstanding balance exceeds the safely representable amount'
    );
  });
});
