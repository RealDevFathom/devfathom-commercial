import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  transactionGroupBy: vi.fn(),
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
    mocks.can.mockResolvedValue(true);
    mocks.invoiceGroupBy.mockResolvedValue([]);
  });

  it('counts a posted recurring expense only through its EXPENSE transaction', async () => {
    mocks.transactionGroupBy.mockImplementation(({ where }: { where: { type: string } }) =>
      Promise.resolve(
        where.type === 'INCOME'
          ? [{ currency: 'USD', _sum: { amount: 500 } }]
          : [{ currency: 'USD', _sum: { amount: 100 } }]
      )
    );
    mocks.recurringFindMany.mockResolvedValue([
      { amount: 100, currency: 'USD', interval: 'monthly' },
    ]);

    const summary = await caller().getFinancialSummary();

    expect(summary.monthlyExpense).toEqual([{ currency: 'USD', amount: 100 }]);
    expect(summary.monthlyProfit).toEqual([{ currency: 'USD', amount: 400 }]);
    expect(summary.yearlyExpense).toEqual([{ currency: 'USD', amount: 100 }]);
    expect(mocks.recurringFindMany).not.toHaveBeenCalled();
  });
});
