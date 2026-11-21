import type { AssistantHelpers } from '@/lib/ai/context';
import { buildFinanceTools } from '@/lib/ai/tools/finance';
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

function caller(timezone?: string) {
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
    organization: { id: 'org-1', timezone },
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

  it.each(['router', 'assistant'])(
    'uses the Karachi month and day at 00:30 for %s finance',
    async (surface) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const at = new Date('2026-11-01T00:30:00+05:00');
        vi.setSystemTime(at);
        // This stored occurrence was at 23:59 on 31 October in Karachi.
        mocks.recurringFindMany.mockResolvedValue([
          { nextDueDate: new Date('2026-10-31T18:59Z'), interval: 'monthly' },
        ]);
        const server = caller('Asia/Karachi');
        const assistant = buildFinanceTools({
          db: {
            transaction: { groupBy: mocks.transactionGroupBy },
            recurringExpense: { findMany: mocks.recurringFindMany },
            organization: { findUnique: vi.fn().mockResolvedValue({ timezone: 'Asia/Karachi' }) },
          },
          ctx: { organizationId: 'org-1' },
          isAdmin: true,
          now: () => at,
        } as unknown as AssistantHelpers) as unknown as {
          getPnlReport: { execute(input: { months: number }): Promise<unknown> };
          listRecurringExpenses: { execute(input: object): Promise<{ nextDueDate: Date }[]> };
        };
        if (surface === 'router') await server.getPnlReport({ months: 1 });
        else await assistant.getPnlReport.execute({ months: 1 });
        expect(mocks.transactionGroupBy.mock.calls[0]?.[0].where.date.gte).toEqual(
          new Date('2026-10-31T19:00Z')
        );
        const expenses =
          surface === 'router'
            ? await server.getRecurringExpenses()
            : await assistant.listRecurringExpenses.execute({});
        expect(expenses[0]?.nextDueDate.getTime()).toBeGreaterThan(at.getTime());
      } finally {
        vi.useRealTimers();
      }
    }
  );
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

it('bounds date-only transaction searches and new charges on the Karachi clock', async () => {
  const findMany = vi.fn().mockResolvedValue([]);
  const create = vi.fn(async ({ data }) => ({ ...data, id: 'recurring' }));
  const tools = buildFinanceTools({
    isAdmin: true,
    ctx: { organizationId: 'org' },
    audit: vi.fn(),
    db: {
      organization: { findUnique: vi.fn().mockResolvedValue({ timezone: 'Asia/Karachi' }) },
      transaction: { findMany },
      recurringExpense: { create },
    },
  } as unknown as AssistantHelpers) as unknown as Record<
    'listTransactions' | 'createRecurringExpense',
    { execute(input: Record<string, unknown>): Promise<unknown> }
  >;
  await tools.listTransactions.execute({ startDate: '2026-11-02', endDate: '2026-11-02' });
  expect(findMany.mock.calls[0]?.[0].where.date.gte).toEqual(new Date('2026-11-01T19:00:00Z'));
  await tools.createRecurringExpense.execute({
    name: 'Subscription',
    amount: 120,
    category: 'SOFTWARE',
    interval: 'monthly',
    nextDueDate: '2026-11-02',
  });
  expect(create).toHaveBeenCalledWith({
    data: expect.objectContaining({ nextDueDate: new Date('2026-11-01T19:00:00Z') }),
  });
});
