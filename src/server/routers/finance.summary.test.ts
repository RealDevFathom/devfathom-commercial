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

  it('subtracts multiple payments and rounds each invoice balance to cents', async () => {
    mocks.invoiceFindMany.mockResolvedValue([
      { total: 1_000, currency: 'USD', payments: [{ amount: 333.33 }, { amount: 266.67 }] },
      { total: 0.3, currency: 'USD', payments: [{ amount: 0.1 }, { amount: 0.1 }] },
    ]);

    const summary = await caller().getFinancialSummary();

    expect(summary.totalOutstanding).toEqual([{ currency: 'USD', amount: 400.1 }]);
    expect(summary.outstandingCount).toBe(2);
  });
});
