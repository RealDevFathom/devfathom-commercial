import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  create: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  queryRaw: vi.fn(),
  paymentFindUnique: vi.fn(),
  paymentDelete: vi.fn(),
  paymentAggregate: vi.fn(),
  paymentCreate: vi.fn(),
  logActivity: vi.fn(),
  emitEvent: vi.fn(),
  groupBy: vi.fn(),
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
  const db = {
    client: { findMany: vi.fn().mockResolvedValue([{ id: 'client-1' }]) },
    project: { findMany: vi.fn() },
    invoice: {
      count: vi.fn().mockResolvedValue(0),
      create: mocks.create,
      findUnique: mocks.findUnique,
      update: mocks.update,
    },
    payment: {
      findUnique: mocks.paymentFindUnique,
      delete: mocks.paymentDelete,
      aggregate: mocks.paymentAggregate,
      create: mocks.paymentCreate,
    },
    $queryRaw: mocks.queryRaw,
    transaction: { groupBy: mocks.groupBy },
  };
  return financeRouter.createCaller({
    db: {
      ...db,
      $transaction: vi.fn(async (work: (tx: typeof db) => Promise<unknown>) => work(db)),
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

describe('finance.createInvoice money calculation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.create.mockResolvedValue({
      id: 'invoice-1',
      invoiceNumber: 'INV-2026-001',
      total: 2.03,
      client: { name: 'Acme' },
    });
  });

  it('rounds each half-cent line and the tax half up before persisting totals', async () => {
    await caller().createInvoice({
      clientId: 'client-1',
      items: [
        { description: 'First', quantity: 1, rate: 1.005, amount: 0 },
        { description: 'Second', quantity: 3, rate: 0.335, amount: 0 },
      ],
      subtotal: 0,
      tax: 0.005,
      total: 0,
      currency: 'USD',
      dueDate: new Date('2026-11-30T00:00:00.000Z'),
    });

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          items: [
            { description: 'First', quantity: 1, rate: 1.005, amount: 1.01 },
            { description: 'Second', quantity: 3, rate: 0.335, amount: 1.01 },
          ],
          subtotal: 2.02,
          discount: 0,
          tax: 0.01,
          total: 2.03,
        }),
      })
    );
  });

  it.each([
    ['line amount', [{ description: 'Too large', quantity: 2, rate: 9_999_999_999.99 }], 0],
    [
      'subtotal',
      [
        { description: 'First', quantity: 1, rate: 5_000_000_000 },
        { description: 'Second', quantity: 1, rate: 5_000_000_000 },
      ],
      0,
    ],
    ['total', [{ description: 'At limit', quantity: 1, rate: 9_999_999_999.99 }], 0.01],
  ])('rejects a derived %s overflow before persistence', async (_kind, items, tax) => {
    await expect(
      caller().createInvoice({
        clientId: 'client-1',
        items: items.map((item) => ({ ...item, amount: 0 })),
        subtotal: 0,
        tax,
        total: 0,
        currency: 'USD',
        dueDate: new Date('2026-11-30T00:00:00.000Z'),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('finance.updateInvoice money calculation and settlement serialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.queryRaw.mockResolvedValue([{ id: 'invoice-1' }]);
  });

  it('rounds updated line items and tax half up before persisting totals', async () => {
    mocks.findUnique.mockResolvedValue({ status: 'DRAFT', tax: 0, discount: 0 });
    mocks.paymentAggregate.mockResolvedValue({ _sum: { amount: null } });
    mocks.update.mockResolvedValue({
      id: 'invoice-1',
      total: 2.03,
      payments: [],
    });

    await caller().updateInvoice({
      id: 'invoice-1',
      items: [
        { description: 'First', quantity: 1, rate: 1.005 },
        { description: 'Second', quantity: 3, rate: 0.335 },
      ],
      tax: 0.005,
    });

    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          items: [
            { description: 'First', quantity: 1, rate: 1.005, amount: 1.01 },
            { description: 'Second', quantity: 3, rate: 0.335, amount: 1.01 },
          ],
          subtotal: 2.02,
          discount: 0,
          tax: 0.01,
          total: 2.03,
        },
      })
    );
  });

  it('rejects an updated line amount overflow before opening a transaction', async () => {
    await expect(
      caller().updateInvoice({
        id: 'invoice-1',
        items: [{ description: 'Too large', quantity: 2, rate: 9_999_999_999.99 }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mocks.queryRaw).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('locks before rechecking status and refuses an invoice settled by a concurrent payment', async () => {
    mocks.findUnique.mockResolvedValue({ status: 'PAID' });

    await expect(
      caller().updateInvoice({
        id: 'invoice-1',
        items: [{ description: 'Work', quantity: 1, rate: 10 }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.findUnique.mock.invocationCallOrder[0]
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe('invoice payment settlement serialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.queryRaw.mockResolvedValue([{ id: 'invoice-1' }]);
    mocks.paymentFindUnique.mockResolvedValue(null);
  });

  it('locks the invoice before adding and aggregating a payment', async () => {
    mocks.findUnique.mockResolvedValue({
      id: 'invoice-1',
      status: 'SENT',
      total: 10,
      currency: 'USD',
      clientId: 'client-1',
    });
    mocks.paymentAggregate.mockResolvedValue({ _sum: { amount: 0 } });
    mocks.paymentCreate.mockResolvedValue({ id: 'payment-1', amount: 5 });

    await caller().addPayment({
      invoiceId: 'invoice-1',
      idempotencyKey: 'payment-command-1',
      amount: 5,
    });

    expect(mocks.queryRaw).toHaveBeenNthCalledWith(
      2,
      [
        '\n          SELECT id FROM invoices\n          WHERE id = ',
        ' AND "organizationId" = ',
        '\n          FOR UPDATE\n        ',
      ],
      'invoice-1',
      'org-1'
    );
    expect(mocks.queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.findUnique.mock.invocationCallOrder[0]
    );
    expect(mocks.queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.paymentAggregate.mock.invocationCallOrder[0]
    );
  });

  it('resolves the invoice then locks it before deleting and recomputing', async () => {
    mocks.paymentFindUnique.mockResolvedValue({ id: 'payment-1', invoiceId: 'invoice-1' });
    mocks.paymentDelete.mockResolvedValue({ id: 'payment-1' });
    mocks.findUnique.mockResolvedValue({ id: 'invoice-1', status: 'PAID', total: 10 });
    mocks.paymentAggregate.mockResolvedValue({ _sum: { amount: 5 } });
    mocks.update.mockResolvedValue({ id: 'invoice-1', status: 'SENT' });

    await caller().deletePayment({ id: 'payment-1' });

    expect(mocks.queryRaw).toHaveBeenCalledWith(
      ['SELECT id FROM invoices WHERE id = ', ' FOR UPDATE'],
      'invoice-1'
    );
    expect(mocks.paymentFindUnique.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.queryRaw.mock.invocationCallOrder[0]
    );
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.paymentDelete.mock.invocationCallOrder[0]
    );
    expect(mocks.paymentDelete.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.findUnique.mock.invocationCallOrder[0]
    );
    expect(mocks.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.paymentAggregate.mock.invocationCallOrder[0]
    );
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'invoice-1' },
      data: { status: 'SENT', paidAt: null },
    });
  });

  it('settles using the same rounded cents that are persisted for the payment', async () => {
    mocks.findUnique.mockResolvedValue({
      id: 'invoice-1',
      status: 'SENT',
      total: 1.21,
      currency: 'USD',
      clientId: 'client-1',
    });
    mocks.paymentAggregate.mockResolvedValue({ _sum: { amount: 0.2 } });
    mocks.paymentCreate.mockResolvedValue({ id: 'payment-1', amount: 1.01 });

    const result = await caller().addPayment({
      invoiceId: 'invoice-1',
      idempotencyKey: 'payment-command-1',
      amount: 1.005,
    });

    expect(mocks.paymentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 1.01 }) })
    );
    expect(result).toMatchObject({ amountPaid: 1.21, balance: 0, status: 'PAID' });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'invoice-1', organizationId: 'org-1' },
      data: { status: 'PAID', paidAt: expect.any(Date) },
    });
    expect(mocks.emitEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'invoice.paid',
      { invoiceId: 'invoice-1', total: 1.21, currency: 'USD', clientId: 'client-1' }
    );
  });

  it('rejects an overpayment when binary addition would hide its last cent', async () => {
    mocks.findUnique.mockResolvedValue({
      id: 'invoice-1',
      status: 'SENT',
      total: 1.2,
      currency: 'USD',
      clientId: 'client-1',
    });
    mocks.paymentAggregate.mockResolvedValue({ _sum: { amount: 0.2 } });

    await expect(
      caller().addPayment({
        invoiceId: 'invoice-1',
        idempotencyKey: 'payment-command-1',
        amount: 1.005,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mocks.paymentCreate).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('rejects a positive payment that rounds to zero cents', async () => {
    mocks.findUnique.mockResolvedValue({
      id: 'invoice-1',
      status: 'SENT',
      total: 10,
      currency: 'USD',
      clientId: 'client-1',
    });
    mocks.paymentAggregate.mockResolvedValue({ _sum: { amount: 0 } });

    await expect(
      caller().addPayment({
        invoiceId: 'invoice-1',
        idempotencyKey: 'payment-command-1',
        amount: 0.001,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mocks.paymentCreate).not.toHaveBeenCalled();
  });
});

describe('finance.getPnlReport loss rounding', () => {
  it('reports a twenty-cent loss when income is 0.10 and expenses are 0.30', async () => {
    mocks.groupBy
      .mockResolvedValueOnce([{ currency: 'USD', _sum: { amount: '0.10' } }])
      .mockResolvedValueOnce([{ currency: 'USD', _sum: { amount: '0.30' } }])
      .mockResolvedValueOnce([]);

    const report = await caller().getPnlReport({ months: 1, period: 'monthly' });

    expect(report.byCurrency.USD.data[0]).toMatchObject({
      income: 0.1,
      expense: 0.3,
      profit: -0.2,
    });
  });
});
