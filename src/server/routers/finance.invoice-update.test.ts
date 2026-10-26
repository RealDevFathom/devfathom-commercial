import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  findUnique: vi.fn(),
  update: vi.fn(),
  aggregate: vi.fn(),
  findPayment: vi.fn(),
  createPayment: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn(),
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

const testDb = {
  $transaction: mocks.transaction,
  $queryRaw: mocks.queryRaw,
  invoice: { findUnique: mocks.findUnique, update: mocks.update },
  payment: {
    aggregate: mocks.aggregate,
    findUnique: mocks.findPayment,
    create: mocks.createPayment,
  },
};

function caller() {
  return financeRouter.createCaller({
    db: testDb,
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

describe('finance.updateInvoice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.queryRaw.mockResolvedValue([{ id: 'invoice-1' }]);
    mocks.findUnique.mockResolvedValue({ status: 'DRAFT', discount: 10, tax: 0 });
    mocks.aggregate.mockResolvedValue({ _sum: { amount: null } });
    mocks.findPayment.mockResolvedValue(null);
    mocks.transaction.mockImplementation(async (work) => work(testDb));
    mocks.update.mockResolvedValue({
      id: 'invoice-1',
      total: 90,
      payments: [],
      client: { contacts: [] },
      project: null,
    });
  });

  it('preserves a stored discount when another field is updated', async () => {
    const dueDate = new Date('2026-11-30T00:00:00.000Z');

    await caller().updateInvoice({
      id: 'invoice-1',
      items: [{ description: 'Consulting', quantity: 1, rate: 100 }],
      dueDate,
    });

    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'invoice-1', organizationId: 'org-1' },
        data: expect.objectContaining({
          subtotal: 100,
          discount: 10,
          tax: 0,
          total: 90,
          dueDate,
        }),
      })
    );
  });

  it('does not read or update an invoice outside the active organization', async () => {
    mocks.queryRaw.mockResolvedValue([]);

    await expect(
      caller().updateInvoice({
        id: 'foreign-invoice',
        items: [{ description: 'Consulting', quantity: 1, rate: 100 }],
      })
    ).rejects.toThrow('Invoice not found');

    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.aggregate).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('does not record a payment against an invoice outside the active organization', async () => {
    mocks.queryRaw.mockResolvedValue([]);

    await expect(
      caller().addPayment({
        invoiceId: 'foreign-invoice',
        idempotencyKey: 'payment-request-1',
        amount: 25,
      })
    ).rejects.toThrow('Invoice not found');

    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.aggregate).not.toHaveBeenCalled();
    expect(mocks.createPayment).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('scopes payment reads and writes to the active organization', async () => {
    mocks.findUnique.mockResolvedValue({
      id: 'invoice-1',
      status: 'SENT',
      total: 100,
      currency: 'USD',
      clientId: 'client-1',
    });
    mocks.createPayment.mockResolvedValue({ id: 'payment-1' });

    await caller().addPayment({
      invoiceId: 'invoice-1',
      idempotencyKey: 'payment-request-1',
      amount: 25,
    });

    expect(mocks.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'invoice-1', organizationId: 'org-1' } })
    );
    expect(mocks.aggregate).toHaveBeenCalledWith({
      where: { invoiceId: 'invoice-1', organizationId: 'org-1' },
      _sum: { amount: true },
    });
    expect(mocks.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: 'org-1',
          invoiceId: 'invoice-1',
          idempotencyKey: 'payment-request-1',
        }),
      })
    );
  });

  it('returns an existing payment when its idempotency key is retried', async () => {
    mocks.findPayment.mockResolvedValue({
      id: 'payment-1',
      invoiceId: 'invoice-1',
      amount: 25,
      invoice: { status: 'SENT', total: 100 },
    });
    mocks.aggregate.mockResolvedValue({ _sum: { amount: 25 } });

    const result = await caller().addPayment({
      invoiceId: 'invoice-1',
      idempotencyKey: 'payment-request-1',
      amount: 25,
    });

    expect(result).toMatchObject({ amountPaid: 25, balance: 75, status: 'SENT' });
    expect(mocks.createPayment).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('rejects a reduction below payments collected inside the locked transaction', async () => {
    mocks.aggregate.mockResolvedValue({ _sum: { amount: 95 } });

    await expect(
      caller().updateInvoice({
        id: 'invoice-1',
        items: [{ description: 'Consulting', quantity: 1, rate: 100 }],
      })
    ).rejects.toThrow('Invoice total cannot be less than the 95.00 already paid');

    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('rechecks status only after acquiring the invoice lock', async () => {
    const order: string[] = [];
    mocks.queryRaw.mockImplementation(async () => {
      order.push('lock');
      return [{ id: 'invoice-1' }];
    });
    mocks.findUnique.mockImplementation(async () => {
      order.push('read');
      return { status: 'PAID', discount: 0, tax: 0 };
    });

    await expect(
      caller().updateInvoice({
        id: 'invoice-1',
        items: [{ description: 'Consulting', quantity: 1, rate: 100 }],
      })
    ).rejects.toThrow("A paid invoice can't be edited");

    expect(order).toEqual(['lock', 'read']);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
