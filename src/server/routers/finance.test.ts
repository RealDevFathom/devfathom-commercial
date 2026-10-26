import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  transactionGroupBy: vi.fn(),
  invoiceGroupBy: vi.fn(async () => []),
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
import { createInvoiceInputSchema, financeRouter } from './finance';

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
