import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  transactionGroupBy: vi.fn(async () => []),
  invoiceGroupBy: vi.fn(async () => []),
  invoiceFindMany: vi.fn(),
  recurringFindMany: vi.fn(async () => []),
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
  });

  it('subtracts partial payments from outstanding totals per currency', async () => {
    mocks.invoiceFindMany.mockResolvedValue([
      { total: 1_000, currency: 'USD', payments: [{ amount: 600 }] },
      { total: 25.55, currency: 'USD', payments: [{ amount: 5.1 }] },
      { total: 2_000, currency: 'PKR', payments: [{ amount: 750 }] },
    ]);

    const summary = await caller().getFinancialSummary();

    expect(mocks.invoiceFindMany).toHaveBeenCalledWith({
      where: { status: { in: ['SENT', 'OVERDUE'] } },
      select: {
        total: true,
        currency: true,
        payments: { select: { amount: true } },
      },
    });
    expect(summary.totalOutstanding).toEqual([
      { currency: 'USD', amount: 420.45 },
      { currency: 'PKR', amount: 1_250 },
    ]);
    expect(summary.outstandingCount).toBe(3);
  });
});
