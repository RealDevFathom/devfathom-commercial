// @vitest-environment node
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  transactionGroupBy: vi.fn(),
  invoiceGroupBy: vi.fn(),
  paymentGroupBy: vi.fn(),
  outstandingQuery: vi.fn(),
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
      payment: { groupBy: mocks.paymentGroupBy },
      $queryRaw: mocks.outstandingQuery,
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
    mocks.paymentGroupBy.mockResolvedValue([]);
    mocks.outstandingQuery.mockResolvedValue([]);
    mocks.recurringFindMany.mockResolvedValue([]);
  });

  it('subtracts partial payments from outstanding invoice totals by currency', async () => {
    mocks.outstandingQuery.mockResolvedValue([
      { currency: 'USD', total: 1_250, paid: 650, count: 2 },
      { currency: 'PKR', total: 500, paid: 0, count: 1 },
    ]);

    const summary = await caller().getFinancialSummary();

    expect(summary.totalOutstanding).toEqual([
      { currency: 'USD', amount: 600 },
      { currency: 'PKR', amount: 500 },
    ]);
    expect(summary.outstandingCount).toBe(3);
    expect(mocks.invoiceGroupBy).toHaveBeenCalledExactlyOnceWith({
      by: ['currency'],
      _sum: { total: true },
      _count: true,
      where: { status: 'PAID' },
    });
    expect(mocks.outstandingQuery).toHaveBeenCalledTimes(1);
    expect(mocks.paymentGroupBy).not.toHaveBeenCalled();
  });

  it('reports only the unpaid balance of a partially paid invoice', async () => {
    mocks.outstandingQuery.mockResolvedValue([
      { currency: 'USD', total: '1000.00', paid: '600.00', count: 1 },
    ]);

    const summary = await caller().getFinancialSummary();

    expect(summary.totalOutstanding).toEqual([{ currency: 'USD', amount: 400 }]);
    expect(summary.outstandingCount).toBe(1);
  });

  it('subtracts multiple payments using exact cent arithmetic', async () => {
    mocks.outstandingQuery.mockResolvedValue([
      { currency: 'USD', total: '1000.30', paid: '600.20', count: 2 },
    ]);

    const summary = await caller().getFinancialSummary();

    expect(summary.totalOutstanding).toEqual([{ currency: 'USD', amount: 400.1 }]);
    expect(summary.outstandingCount).toBe(2);
  });

  it('keeps cent arithmetic exact at the Decimal(12,2) upper bound', async () => {
    mocks.outstandingQuery.mockResolvedValue([
      { currency: 'USD', total: '9999999999.99', paid: '0.01', count: 1 },
    ]);

    const summary = await caller().getFinancialSummary();

    expect(summary.totalOutstanding).toEqual([{ currency: 'USD', amount: 9_999_999_999.98 }]);
  });

  it('does not accumulate rounding drift across a large invoice set', async () => {
    mocks.outstandingQuery.mockResolvedValue([
      { currency: 'USD', total: '100.00', paid: '0', count: 10_000 },
    ]);

    const summary = await caller().getFinancialSummary();

    expect(summary.totalOutstanding).toEqual([{ currency: 'USD', amount: 100 }]);
    expect(summary.outstandingCount).toBe(10_000);
  });

  it('rejects an aggregate that cannot preserve every cent in the number DTO', async () => {
    // 9,007 maximum-value invoices plus this remainder total exactly
    // 9,007,199,254,740,993 cents: Number.MAX_SAFE_INTEGER + 2.
    mocks.outstandingQuery.mockResolvedValue([
      { currency: 'USD', total: '90071992547409.93', paid: '0', count: 9_008 },
    ]);

    await expect(caller().getFinancialSummary()).rejects.toThrow(
      'Outstanding balance exceeds the safely representable amount'
    );
  });

  it('rejects a safe-integer cent aggregate when the dollar DTO loses a cent', async () => {
    // 9,007 maximum-value invoices plus this remainder total exactly
    // 9,007,199,254,740,990 cents. The integer is safe, but converting it to
    // dollars and back rounds it to 9,007,199,254,740,991 cents.
    mocks.outstandingQuery.mockResolvedValue([
      { currency: 'USD', total: '90071992547409.90', paid: '0', count: 9_008 },
    ]);

    await expect(caller().getFinancialSummary()).rejects.toThrow(
      'Outstanding balance exceeds the safely representable amount'
    );
  });

  const databaseUrl = process.env.TEST_DATABASE_URL;
  describe.skipIf(!databaseUrl)('outstanding aggregate on PostgreSQL', () => {
    const client = new pg.Client({ connectionString: databaseUrl });

    beforeAll(async () => {
      await client.connect();
      await client.query('BEGIN');
      // Temporary tables shadow the application tables on this connection only.
      // No migrations or changes to the supplied database's data are needed.
      await client.query(`
        CREATE TEMP TABLE invoices (
          id text PRIMARY KEY, "organizationId" text NOT NULL,
          currency text NOT NULL, status text NOT NULL, total numeric(12,2) NOT NULL
        ) ON COMMIT DROP;
        CREATE TEMP TABLE payments (
          "invoiceId" text NOT NULL, "organizationId" text NOT NULL,
          currency text NOT NULL, amount numeric(12,2) NOT NULL
        ) ON COMMIT DROP;
      `);
    });

    afterAll(async () => {
      try {
        await client.query('ROLLBACK');
      } finally {
        await client.end();
      }
    });

    beforeEach(async () => {
      await client.query('TRUNCATE pg_temp.payments, pg_temp.invoices');
      mocks.outstandingQuery.mockImplementation(async (query: Prisma.Sql) => {
        const result = await client.query(query.text, query.values);
        return result.rows;
      });
    });

    it('returns an empty breakdown when there are no outstanding invoices', async () => {
      const summary = await caller().getFinancialSummary();
      expect(summary.totalOutstanding).toEqual([]);
      expect(summary.outstandingCount).toBe(0);
    });

    it('sums multiple payments without multiplying invoices and scopes both tables', async () => {
      await client.query(`
        INSERT INTO pg_temp.invoices VALUES
          ('sent', 'org-1', 'USD', 'SENT', 1000.30),
          ('overdue', 'org-1', 'USD', 'OVERDUE', 250),
          ('unpaid', 'org-1', 'USD', 'SENT', 50),
          ('pkr', 'org-1', 'PKR', 'SENT', 500),
          ('paid', 'org-1', 'USD', 'PAID', 100),
          ('draft', 'org-1', 'USD', 'DRAFT', 200),
          ('cancelled', 'org-1', 'USD', 'CANCELLED', 300),
          ('foreign', 'org-2', 'USD', 'SENT', 900);
        INSERT INTO pg_temp.payments VALUES
          ('sent', 'org-1', 'USD', 600.10),
          ('sent', 'org-1', 'USD', 0.10),
          ('overdue', 'org-1', 'USD', 50),
          ('pkr', 'org-1', 'PKR', 100),
          ('paid', 'org-1', 'USD', 100),
          ('draft', 'org-1', 'USD', 25),
          ('cancelled', 'org-1', 'USD', 25),
          ('foreign', 'org-2', 'USD', 800),
          ('sent', 'org-2', 'USD', 100);
      `);

      const summary = await caller().getFinancialSummary();

      expect(summary.totalOutstanding).toEqual([
        { currency: 'USD', amount: 650.1 },
        { currency: 'PKR', amount: 400 },
      ]);
      expect(summary.outstandingCount).toBe(4);
      expect(mocks.outstandingQuery).toHaveBeenCalledTimes(1);
      expect(mocks.paymentGroupBy).not.toHaveBeenCalled();
    });

    it('preserves every cent when PostgreSQL sums maximum-value invoices', async () => {
      await client.query(`
        INSERT INTO pg_temp.invoices VALUES
          ('large-a', 'org-1', 'USD', 'SENT', 9999999999.99),
          ('large-b', 'org-1', 'USD', 'OVERDUE', 9999999999.99);
        INSERT INTO pg_temp.payments VALUES
          ('large-a', 'org-1', 'USD', 9999999999.98),
          ('large-b', 'org-1', 'USD', 9999999999.97);
      `);

      const summary = await caller().getFinancialSummary();

      expect(summary.totalOutstanding).toEqual([{ currency: 'USD', amount: 0.03 }]);
      expect(summary.outstandingCount).toBe(2);
    });
  });
});
