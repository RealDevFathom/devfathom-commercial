import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  transactionGroupBy: vi.fn(),
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
    mocks.transactionGroupBy.mockResolvedValue([]);
    mocks.invoiceGroupBy.mockResolvedValue([]);
    mocks.queryRaw.mockResolvedValue([]);
    mocks.recurringFindMany.mockResolvedValue([]);
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
