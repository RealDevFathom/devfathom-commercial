import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  transactionGroupBy: vi.fn(),
  transactionCreateMany: vi.fn(),
  invoiceGroupBy: vi.fn(async () => []),
  recurringFindMany: vi.fn(),
  recurringUpdate: vi.fn(),
  dbTransaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
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
import { createInvoiceInputSchema, financeRouter } from './finance';

function caller() {
  return financeRouter.createCaller({
    db: {
      $transaction: mocks.dbTransaction,
      transaction: {
        groupBy: mocks.transactionGroupBy,
        createMany: mocks.transactionCreateMany,
      },
      invoice: { groupBy: mocks.invoiceGroupBy },
      recurringExpense: {
        findMany: mocks.recurringFindMany,
        update: mocks.recurringUpdate,
      },
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

const validInvoice = {
  clientId: 'client-1',
  items: [{ description: 'Consulting', quantity: 1, rate: 100, amount: 100 }],
  subtotal: 100,
  tax: 0,
  total: 100,
  dueDate: new Date('2026-10-31T00:00:00.000Z'),
};

describe('createInvoiceInputSchema', () => {
  it('requires at least one line item', () => {
    const result = createInvoiceInputSchema.safeParse({ ...validInvoice, items: [] });

    expect(result.success).toBe(false);
  });

  it.each(['subtotal', 'tax', 'total'] as const)('rejects a negative %s', (field) => {
    const result = createInvoiceInputSchema.safeParse({ ...validInvoice, [field]: -1 });

    expect(result.success).toBe(false);
  });

  it('accepts a non-negative invoice with a line item', () => {
    expect(createInvoiceInputSchema.safeParse(validInvoice).success).toBe(true);
  });
});

describe('finance.getFinancialSummary', () => {
  it('reports a due recurring expense once after posting it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T12:34:56.000Z'));

    const transactions: Array<{
      type: 'EXPENSE';
      amount: number;
      currency: 'USD';
      date: Date;
    }> = [];
    const recurring = {
      id: 'recurring-1',
      name: 'Hosting',
      amount: 100,
      currency: 'USD' as const,
      category: 'HOSTING' as const,
      interval: 'monthly',
      nextDueDate: new Date('2026-10-01T00:00:00.000Z'),
      vendorName: null,
      active: true,
    };

    mocks.recurringFindMany.mockResolvedValue([recurring]);
    mocks.transactionCreateMany.mockImplementation(async ({ data }: { data: typeof transactions }) => {
      transactions.push(...data);
      return { count: data.length };
    });
    mocks.recurringUpdate.mockImplementation(async ({ data }: { data: { nextDueDate: Date } }) => {
      recurring.nextDueDate = data.nextDueDate;
      return recurring;
    });
    mocks.transactionGroupBy.mockImplementation(
      async ({
        where,
      }: {
        where: { type: 'INCOME' | 'EXPENSE'; date: { gte: Date; lte: Date } };
      }) => {
        const amount = transactions
          .filter(
            (transaction) =>
              transaction.type === where.type &&
              transaction.date >= where.date.gte &&
              transaction.date <= where.date.lte
          )
          .reduce((sum, transaction) => sum + transaction.amount, 0);
        return amount === 0 ? [] : [{ currency: 'USD', _sum: { amount } }];
      }
    );

    const finance = caller();
    await expect(finance.postDueRecurringExpenses()).resolves.toMatchObject({ posted: 1 });
    const summary = await finance.getFinancialSummary();

    expect(transactions).toHaveLength(1);
    expect(summary.monthlyExpense).toEqual([{ currency: 'USD', amount: 100 }]);
    expect(summary.yearlyExpense).toEqual([{ currency: 'USD', amount: 100 }]);
    expect(summary.monthlyProfit).toEqual([{ currency: 'USD', amount: -100 }]);
    expect(summary.yearlyProfit).toEqual([{ currency: 'USD', amount: -100 }]);
  });

  it('counts a posted recurring expense only once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-26T12:34:56.000Z'));
    mocks.transactionGroupBy.mockImplementation(
      ({ where }: { where: { type: 'INCOME' | 'EXPENSE'; date: { gte: Date } } }) => {
        const yearly = where.date.gte.getUTCMonth() === 0;
        const amount = where.type === 'EXPENSE' ? (yearly ? 400 : 100) : yearly ? 1200 : 300;
        return Promise.resolve([
          {
            currency: 'USD',
            _sum: { amount },
          },
        ]);
      }
    );
    mocks.recurringFindMany.mockResolvedValue([
      { amount: 100, currency: 'USD', interval: 'monthly' },
    ]);

    const summary = await caller().getFinancialSummary();

    expect(summary.monthlyExpense).toEqual([{ currency: 'USD', amount: 100 }]);
    expect(summary.monthlyProfit).toEqual([{ currency: 'USD', amount: 200 }]);
    expect(summary.yearlyExpense).toEqual([{ currency: 'USD', amount: 400 }]);
    expect(summary.yearlyProfit).toEqual([{ currency: 'USD', amount: 800 }]);
    expect(mocks.transactionGroupBy).toHaveBeenCalledTimes(4);
    expect(mocks.transactionGroupBy.mock.calls.map(([query]) => query)).toEqual([
      {
        by: ['currency'],
        _sum: { amount: true },
        where: {
          type: 'INCOME',
          date: { gte: new Date('2026-10-01T00:00:00.000Z'), lte: new Date() },
        },
      },
      {
        by: ['currency'],
        _sum: { amount: true },
        where: {
          type: 'EXPENSE',
          date: { gte: new Date('2026-10-01T00:00:00.000Z'), lte: new Date() },
        },
      },
      {
        by: ['currency'],
        _sum: { amount: true },
        where: {
          type: 'INCOME',
          date: { gte: new Date('2026-01-01T00:00:00.000Z'), lte: new Date() },
        },
      },
      {
        by: ['currency'],
        _sum: { amount: true },
        where: {
          type: 'EXPENSE',
          date: { gte: new Date('2026-01-01T00:00:00.000Z'), lte: new Date() },
        },
      },
    ]);
    expect(mocks.recurringFindMany).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });
});
