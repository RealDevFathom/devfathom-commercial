import type { AssistantHelpers } from '@/lib/ai/context';
import { buildInsightsTools } from '@/lib/ai/tools/insights';
import { dashboardRouter } from './dashboard';
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

function context(timezone?: string) {
  return {
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
  } as unknown as TRPCContext;
}

function caller(timezone?: string) {
  return financeRouter.createCaller(context(timezone));
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

  it('lists overdue unsupported charges without advancing or projecting them', async () => {
    const date = new Date('2020-01-31');
    const weekly = { id: 'w', name: 'Weekly rent', interval: 'weekly' };
    const charges = [
      { ...weekly, amount: 99 },
      { id: 'm', name: 'Monthly rent', interval: 'monthly', amount: 12 },
    ].map((row) => ({ ...row, nextDueDate: date, billingDay: 31, currency: 'USD' }));
    mocks.recurringFindMany.mockResolvedValue(charges);
    const router = caller('UTC');
    const assistant = buildFinanceTools({
      db: {
        recurringExpense: { findMany: mocks.recurringFindMany },
        organization: { findUnique: async () => ({ timezone: 'UTC' }) },
      },
      ctx: { organizationId: 'org-1' },
      isAdmin: true,
      now: () => new Date(),
    } as unknown as AssistantHelpers) as unknown as {
      listRecurringExpenses: { execute(input: object): Promise<unknown[]> };
    };
    const unsupported = expect.objectContaining({
      ...weekly,
      nextDueDate: date,
      intervalLabel: 'Interval not supported',
    });
    expect(await router.getRecurringExpenses()).toContainEqual(unsupported);
    expect(await assistant.listRecurringExpenses.execute({})).toContainEqual(unsupported);
    const summary = await router.getFinancialSummary();
    expect(summary.unsupported).toEqual([weekly]);
    expect(summary.monthlyExpense).toEqual([{ currency: 'USD', amount: 12 }]);
    expect(summary.yearlyExpense).toEqual([{ currency: 'USD', amount: 144 }]);
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
          { nextDueDate: new Date('2026-10-31T18:59Z'), interval: 'monthly', billingDay: 31 },
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
  it.each(['summary', 'stats', 'chart', 'assistant'] as const)(
    'counts the first 00:30 Karachi income in January on the %s surface',
    async (surface) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const event = new Date('2027-01-01T00:30:00+05:00');
        const previous = new Date('2026-12-31T23:59:59+05:00');
        const now = new Date('2027-01-01T00:31:00+05:00');
        vi.setSystemTime(now);
        type Filter = { where: { type: string; date: { gte: Date; lte?: Date; lt?: Date } } };
        const amount = ({ where: { date, type } }: Filter) =>
          type === 'INCOME'
            ? [previous, event].filter(
                (d) => d >= date.gte && (!date.lte || d <= date.lte) && (!date.lt || d < date.lt)
              ).length
            : 0;
        mocks.transactionGroupBy.mockImplementation((q: Filter) => [
          { currency: 'PKR', _sum: { amount: amount(q) } },
        ]);
        const ctx = context('Asia/Karachi');
        const count = vi.fn().mockResolvedValue(0);
        const db = {
          ...ctx.db,
          project: { count },
          task: { count },
          leaveRequest: { count },
          invoice: { ...ctx.db.invoice, count },
          organization: { findUnique: vi.fn().mockResolvedValue({ timezone: 'Asia/Karachi' }) },
          transaction: {
            ...ctx.db.transaction,
            aggregate: vi.fn((q: Filter) => ({ _sum: { amount: amount(q) } })),
          },
        };
        const dashboard = dashboardRouter.createCaller({ ...ctx, db } as unknown as TRPCContext);
        if (surface === 'summary') {
          const result = await caller('Asia/Karachi').getFinancialSummary();
          expect(result.monthlyIncome).toEqual([{ currency: 'PKR', amount: 1 }]);
          expect(result.yearlyIncome).toEqual([{ currency: 'PKR', amount: 1 }]);
        } else if (surface === 'stats') {
          expect((await dashboard.getStats()).revenue).toEqual([{ currency: 'PKR', amount: 1 }]);
        } else if (surface === 'chart') {
          const chart = await dashboard.getRevenueChart();
          expect(chart.byCurrency.PKR?.slice(-2)).toMatchObject([
            { month: 'Dec 2026', income: 1 },
            { month: 'Jan 2027', income: 1 },
          ]);
        } else {
          const tools = buildInsightsTools({
            db,
            ctx: { organizationId: 'org-1', userId: 'admin-1' },
            isAdmin: true,
            now: () => now,
          } as unknown as AssistantHelpers) as unknown as {
            getDashboardStats: { execute(): Promise<{ revenueThisMonth: number }> };
          };
          expect((await tools.getDashboardStats.execute()).revenueThisMonth).toBe(1);
        }
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it.each(['router', 'post', 'assistant'])(
    'advances the Karachi May 1 charge to June 1 at 00:30 for %s',
    async (surface) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const now = new Date('2026-06-01T00:30:00+05:00');
        vi.setSystemTime(now);
        const due = new Date('2026-05-01T00:00:00+05:00');
        mocks.recurringFindMany.mockResolvedValue([
          { id: 'r', name: 'Subscription', interval: 'monthly', billingDay: 1, nextDueDate: due },
        ]);
        const ctx = context('Asia/Karachi');
        const createMany = vi.fn();
        const db = {
          ...ctx.db,
          organization: { findUnique: vi.fn().mockResolvedValue({ timezone: 'Asia/Karachi' }) },
          transaction: { ...ctx.db.transaction, createMany },
          recurringExpense: { ...ctx.db.recurringExpense, update: vi.fn() },
          $queryRaw: mocks.recurringFindMany,
          recurringExpensePosting: {
            createManyAndReturn: ({ data }: { data: { dueDate: Date }[] }) => data,
          },
          $transaction: (run: (tx: unknown) => Promise<unknown>) => run(db),
        };
        const router = financeRouter.createCaller({ ...ctx, db } as unknown as TRPCContext);
        const june = new Date('2026-05-31T19:00Z');
        if (surface === 'post') {
          await router.postDueRecurringExpenses();
          expect(createMany.mock.calls[0]?.[0].data.map((row: { date: Date }) => row.date)).toEqual(
            [due, june]
          );
        } else if (surface === 'router') {
          expect((await router.getRecurringExpenses())[0]?.nextDueDate).toEqual(june);
        } else {
          const tools = buildFinanceTools({
            db,
            ctx: { organizationId: 'org-1' },
            isAdmin: true,
            now: () => now,
          } as unknown as AssistantHelpers) as unknown as {
            listRecurringExpenses: { execute(input: object): Promise<{ nextDueDate: Date }[]> };
          };
          expect((await tools.listRecurringExpenses.execute({}))[0]?.nextDueDate).toEqual(june);
        }
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
    data: expect.objectContaining({ nextDueDate: new Date('2026-11-01T19:00:00Z'), billingDay: 2 }),
  });
});

// Golden billing days. The two leap-year schedules cover Jan 2028 through Feb 2029.
const monthlySchedules = [
  { name: 'first of the month', year: 2026, days: Array<number>(12).fill(1), nextDay: 1 },
  {
    name: '31 January, common year',
    year: 2026,
    days: [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
    nextDay: 31,
  },
  ...[30, 31].map((start) => ({
    name: start + ' January, leap year',
    year: 2028,
    days: [start, 29, start, 30, start, 30, start, start, 30, start, 30, start, start, 28],
    nextDay: start,
  })),
];

describe.each(['America/New_York', 'Asia/Karachi', 'UTC'] as const)(
  'recurring expense cycles in %s',
  (zone) => {
    describe.each(monthlySchedules)('$name', ({ year, days, nextDay }) => {
      it.each([
        { clock: 'legacy UTC date', successive: false },
        { clock: 'legacy UTC date', successive: true },
        { clock: 'local 00:30', successive: false },
        { clock: 'local 00:30', successive: true },
      ])(
        'posts each month once ($clock, successive=$successive)',
        async ({ clock, successive }) => {
          function expectedOccurrence(day: number, index: number, posting = false) {
            const carrier = new Date(Date.UTC(year, index, day));
            const label = carrier.toISOString().slice(0, 10);
            if (!posting && clock === 'legacy UTC date') return carrier;
            // At 00:30 on these fixture dates New York observes daylight time on
            // April–November firsts in 2026, and March–October month ends.
            const month = carrier.getUTCMonth() + 1;
            const daylight = day === 1 ? month >= 4 && month <= 11 : month >= 3 && month <= 10;
            const offsets = {
              'America/New_York': daylight ? '-04:00' : '-05:00',
              'Asia/Karachi': '+05:00',
              UTC: 'Z',
            };
            return new Date(label + (posting ? 'T00:00:00' : 'T00:30:00') + offsets[zone]);
          }
          const expected = days.map((day, index) => expectedOccurrence(day, index));
          const ledgerDates = days.map((day, index) => expectedOccurrence(day, index, true));
          const expense = {
            id: 'r',
            name: 'Subscription',
            interval: 'monthly',
            billingDay: days[0],
            nextDueDate: expected[0]!,
          };
          mocks.recurringFindMany.mockImplementation(async () => [{ ...expense }]);
          const ctx = context(zone);
          const posted: Date[] = [];
          const db = {
            ...ctx.db,
            organization: { findUnique: async () => ({ timezone: zone }) },
            transaction: {
              ...ctx.db.transaction,
              createMany: ({ data }: { data: { date: Date }[] }) =>
                posted.push(...data.map((row) => row.date)),
            },
            recurringExpense: {
              ...ctx.db.recurringExpense,
              update: ({ data }: { data: { nextDueDate: Date } }) => Object.assign(expense, data),
            },
            $queryRaw: mocks.recurringFindMany,
            recurringExpensePosting: {
              createManyAndReturn: ({ data }: { data: { dueDate: Date }[] }) => data,
            },
            $transaction: (run: (tx: unknown) => Promise<unknown>) => run(db),
          };
          const router = financeRouter.createCaller({ ...ctx, db } as unknown as TRPCContext);
          const assistant = buildFinanceTools({
            db,
            ctx: { organizationId: 'org-1' },
            isAdmin: true,
            now: () => new Date(),
          } as unknown as AssistantHelpers) as unknown as {
            listRecurringExpenses: { execute(input: object): Promise<{ nextDueDate: Date }[]> };
          };
          vi.useFakeTimers({ toFake: ['Date'] });
          try {
            for (const due of expected) {
              vi.setSystemTime(
                clock === 'legacy UTC date' ? new Date(due.getTime() + 12 * 3_600_000) : due
              );
              expect((await router.getRecurringExpenses())[0]?.nextDueDate).toEqual(due);
              expect((await assistant.listRecurringExpenses.execute({}))[0]?.nextDueDate).toEqual(
                due
              );
              if (successive) {
                expect((await router.postDueRecurringExpenses()).posted).toBe(1);
                expect((await router.postDueRecurringExpenses()).posted).toBe(0);
              }
            }
            expect((await router.postDueRecurringExpenses()).posted).toBe(
              successive ? 0 : expected.length
            );
            expect(posted).toEqual(ledgerDates);
            expect((await router.postDueRecurringExpenses()).posted).toBe(0);
            expect(posted).toEqual(ledgerDates);
            expect(expense.nextDueDate).toEqual(expectedOccurrence(nextDay, days.length));
          } finally {
            vi.useRealTimers();
          }
        }
      );
    });
  }
);

it.each(['weekly', 'daily', 'constructor'])(
  'refuses to save interval %s in plain words',
  async (interval) => {
    const ctx = context('UTC');
    const create = vi.fn();
    const router = financeRouter.createCaller({
      ...ctx,
      db: { ...ctx.db, recurringExpense: { create } },
    } as unknown as TRPCContext);
    await expect(
      router.createRecurringExpense({
        name: 'Subscription',
        amount: 12,
        category: 'SOFTWARE',
        interval,
        nextDueDate: new Date('2027-01-01'),
      })
    ).rejects.toThrow('Choose monthly, quarterly or yearly');
    expect(create).not.toHaveBeenCalled();
  }
);

it.each(['monthly', 'quarterly', 'yearly'])(
  'stores the Karachi billing day for a %s charge',
  async (interval) => {
    const ctx = context('Asia/Karachi');
    const create = vi.fn();
    const router = financeRouter.createCaller({
      ...ctx,
      db: { ...ctx.db, recurringExpense: { create } },
    } as unknown as TRPCContext);
    const nextDueDate = new Date('2027-01-30T19:00:00Z');
    await router.createRecurringExpense({
      name: 'Service',
      amount: 12,
      category: 'SOFTWARE',
      interval,
      nextDueDate,
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ interval, nextDueDate, billingDay: 31 }),
    });
  }
);
