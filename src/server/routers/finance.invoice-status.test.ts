import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  findUnique: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  updateMany: vi.fn(),
  transactionGroupBy: vi.fn(),
  paymentGroupBy: vi.fn(),
  invoiceGroupBy: vi.fn(),
  recurringFindMany: vi.fn(),
  paymentAggregate: vi.fn(),
  paymentCreate: vi.fn(),
  invoiceUpdate: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  emitEvent: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({ hasModule: vi.fn(() => true) }));
vi.mock('../activity', () => ({ logActivity: mocks.logActivity }));
vi.mock('@/lib/webhooks', () => ({ emitEvent: mocks.emitEvent }));
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
      invoice: {
        findUnique: mocks.findUnique,
        findUniqueOrThrow: mocks.findUniqueOrThrow,
        updateMany: mocks.updateMany,
        groupBy: mocks.invoiceGroupBy,
      },
      transaction: { groupBy: mocks.transactionGroupBy },
      payment: { groupBy: mocks.paymentGroupBy },
      recurringExpense: { findMany: mocks.recurringFindMany },
      $transaction: mocks.transaction,
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

describe('finance.updateInvoiceStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.findUniqueOrThrow.mockResolvedValue({
      id: 'invoice-1',
      invoiceNumber: 'INV-1',
      status: 'SENT',
      total: 100,
      client: { name: 'Acme' },
    });
  });

  it.each(['SENT', 'OVERDUE', 'PAID'])('rejects direct PAID from %s', async (status) => {
    mocks.findUnique.mockResolvedValue({ status });

    await expect(
      caller().updateInvoiceStatus({ id: 'invoice-1', status: 'PAID' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it('clears sentAt using a status compare-and-set', async () => {
    mocks.findUnique.mockResolvedValue({ status: 'SENT' });

    await caller().updateInvoiceStatus({ id: 'invoice-1', status: 'CANCELLED' });

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: 'invoice-1', status: 'SENT' },
      data: { status: 'CANCELLED', sentAt: null },
    });
  });

  it('reports a conflict and emits no activity if another caller wins', async () => {
    mocks.findUnique.mockResolvedValue({ status: 'DRAFT' });
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      caller().updateInvoiceStatus({ id: 'invoice-1', status: 'SENT' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });
});

describe('finance.getFinancialSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.transactionGroupBy.mockResolvedValue([]);
    mocks.paymentGroupBy.mockResolvedValue([{ currency: 'USD', _sum: { amount: 100 } }]);
    mocks.invoiceGroupBy.mockResolvedValue([]);
    mocks.recurringFindMany.mockResolvedValue([]);
  });

  it('includes a recorded invoice payment in monthly revenue', async () => {
    const summary = await caller().getFinancialSummary();

    expect(summary.monthlyIncome).toEqual([{ currency: 'USD', amount: 100 }]);
    expect(summary.monthlyProfit).toEqual([{ currency: 'USD', amount: 100 }]);
    expect(mocks.paymentGroupBy).toHaveBeenCalledWith({
      by: ['currency'],
      _sum: { amount: true },
      where: { paidAt: { gte: expect.any(Date), lte: expect.any(Date) } },
    });
  });
});

describe('finance.addPayment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.findUnique.mockResolvedValue({
      id: 'invoice-584',
      status: 'SENT',
      total: 100,
      currency: 'USD',
      clientId: 'client-1',
    });
    mocks.paymentAggregate.mockResolvedValue({ _sum: { amount: null } });
    mocks.paymentCreate.mockResolvedValue({ id: 'payment-584', amount: 100 });
    mocks.invoiceUpdate.mockResolvedValue({ id: 'invoice-584', status: 'PAID' });
    mocks.queryRaw.mockResolvedValue([{ id: 'invoice-584' }]);
    mocks.transaction.mockImplementation((run: (tx: Record<string, unknown>) => unknown) =>
      run({
        $queryRaw: mocks.queryRaw,
        invoice: { findUnique: mocks.findUnique, update: mocks.invoiceUpdate },
        payment: { aggregate: mocks.paymentAggregate, create: mocks.paymentCreate },
      })
    );
  });

  it('persists a full payment and transitions a sent invoice to paid', async () => {
    const result = await caller().addPayment({ invoiceId: 'invoice-584', amount: 100 });

    expect(mocks.paymentCreate).toHaveBeenCalledWith({
      data: {
        invoiceId: 'invoice-584',
        amount: 100,
        currency: 'USD',
        method: null,
        note: null,
      },
    });
    expect(mocks.invoiceUpdate).toHaveBeenCalledWith({
      where: { id: 'invoice-584' },
      data: { status: 'PAID', paidAt: expect.any(Date) },
    });
    expect(result).toMatchObject({ amountPaid: 100, balance: 0, status: 'PAID' });
  });

  it('locks the tenant-owned invoice before checking its status and balance', async () => {
    await caller().addPayment({ invoiceId: 'invoice-584', amount: 100 });

    const query = mocks.queryRaw.mock.calls[0]?.[0] as { sql?: string; values?: unknown[] };
    expect(query.sql).toContain('"organizationId"');
    expect(query.sql).toContain('FOR UPDATE');
    expect(query.values).toEqual(['invoice-584', 'org-1']);
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.findUnique.mock.invocationCallOrder[0]!
    );
    expect(mocks.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.paymentAggregate.mock.invocationCallOrder[0]!
    );
    expect(mocks.paymentAggregate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.paymentCreate.mock.invocationCallOrder[0]!
    );
  });

  it('does not read or write when the invoice cannot be locked in this tenant', async () => {
    mocks.queryRaw.mockResolvedValue([]);

    await expect(
      caller().addPayment({ invoiceId: 'invoice-from-another-tenant', amount: 100 })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.paymentAggregate).not.toHaveBeenCalled();
    expect(mocks.paymentCreate).not.toHaveBeenCalled();
  });
});
