import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  findUnique: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  updateMany: vi.fn(),
  queryRaw: vi.fn(),
  update: vi.fn(),
  aggregate: vi.fn(),
  createPayment: vi.fn(),
  findPayment: vi.fn(),
  deletePayment: vi.fn(),
  logActivity: vi.fn(),
  emitEvent: vi.fn(),
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
  const tx = {
    $queryRaw: mocks.queryRaw,
    invoice: {
      findUnique: mocks.findUnique,
      findUniqueOrThrow: mocks.findUniqueOrThrow,
      updateMany: mocks.updateMany,
      update: mocks.update,
    },
    payment: {
      aggregate: mocks.aggregate,
      create: mocks.createPayment,
      findUnique: mocks.findPayment,
      delete: mocks.deletePayment,
    },
  };
  return financeRouter.createCaller({
    db: {
      ...tx,
      $transaction: vi.fn(async (callback) => callback(tx)),
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
    mocks.aggregate.mockResolvedValue({ _sum: { amount: 25 } });
    mocks.createPayment.mockResolvedValue({});
    mocks.queryRaw.mockResolvedValue([{ id: 'invoice-1' }]);
    mocks.findUniqueOrThrow.mockResolvedValue({
      id: 'invoice-1',
      invoiceNumber: 'INV-1',
      status: 'SENT',
      total: 100,
      currency: 'USD',
      clientId: 'client-1',
      client: { name: 'Acme' },
    });
  });

  it('emits invoice.paid and logs invoice_paid after a manual settlement commits', async () => {
    mocks.findUnique
      .mockResolvedValueOnce({ status: 'SENT' })
      .mockResolvedValueOnce({ id: 'invoice-1', total: 100, currency: 'USD' });

    await caller().updateInvoiceStatus({ id: 'invoice-1', status: 'PAID' });

    expect(mocks.emitEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'invoice.paid',
      { invoiceId: 'invoice-1', total: 100, currency: 'USD', clientId: 'client-1' }
    );
    expect(mocks.logActivity).toHaveBeenCalledWith(
      expect.anything(),
      'admin-1',
      expect.objectContaining({ type: 'invoice_paid', entityId: 'invoice-1' })
    );
  });

  it.each(['SENT', 'OVERDUE'])(
    'records the outstanding balance when marking %s paid',
    async (status) => {
      mocks.findUnique
        .mockResolvedValueOnce({ status })
        .mockResolvedValueOnce({ id: 'invoice-1', total: 100, currency: 'USD' });

      await caller().updateInvoiceStatus({ id: 'invoice-1', status: 'PAID' });

      expect(mocks.createPayment).toHaveBeenCalledWith({
        data: {
          invoiceId: 'invoice-1',
          amount: 75,
          currency: 'USD',
          method: 'Manual status update',
        },
      });
      expect(mocks.updateMany).toHaveBeenCalledWith({
        where: { id: 'invoice-1', status },
        data: {
          status: 'PAID',
          paidAt: expect.any(Date),
        },
      });
      expect(mocks.queryRaw).toHaveBeenCalledWith(
        ['SELECT id FROM invoices WHERE id = ', ' FOR UPDATE'],
        'invoice-1'
      );
      expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.aggregate.mock.invocationCallOrder[0]
      );
    }
  );

  it('records an exact cent balance in the invoice currency', async () => {
    mocks.findUnique
      .mockResolvedValueOnce({ status: 'SENT' })
      .mockResolvedValueOnce({ id: 'invoice-1', total: 100.01, currency: 'PKR' });
    mocks.aggregate.mockResolvedValue({ _sum: { amount: 100 } });

    await caller().updateInvoiceStatus({ id: 'invoice-1', status: 'PAID' });

    expect(mocks.createPayment).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: 0.01, currency: 'PKR' }),
    });
  });

  it.each([0, 100])('does not create a zero payment for a covered total of %s', async (total) => {
    mocks.findUnique
      .mockResolvedValueOnce({ status: 'SENT' })
      .mockResolvedValueOnce({ id: 'invoice-1', total, currency: 'USD' });
    mocks.aggregate.mockResolvedValue({ _sum: { amount: total || null } });

    await caller().updateInvoiceStatus({ id: 'invoice-1', status: 'PAID' });

    expect(mocks.updateMany).toHaveBeenCalledOnce();
    expect(mocks.createPayment).not.toHaveBeenCalled();
  });

  it('does not duplicate payment or timestamps for an already paid invoice', async () => {
    mocks.findUnique.mockResolvedValue({ status: 'PAID' });

    await caller().updateInvoiceStatus({ id: 'invoice-1', status: 'PAID' });

    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.aggregate).not.toHaveBeenCalled();
    expect(mocks.createPayment).not.toHaveBeenCalled();
  });

  it.each(['DRAFT', 'CANCELLED'])('rejects settling an unissued %s invoice', async (status) => {
    mocks.findUnique.mockResolvedValue({ status });

    await expect(
      caller().updateInvoiceStatus({ id: 'invoice-1', status: 'PAID' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.createPayment).not.toHaveBeenCalled();
  });

  it('does not record a payment if another caller changes status before settlement', async () => {
    mocks.findUnique
      .mockResolvedValueOnce({ status: 'SENT' })
      .mockResolvedValueOnce({ id: 'invoice-1', total: 100, currency: 'USD' });
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      caller().updateInvoiceStatus({ id: 'invoice-1', status: 'PAID' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(mocks.createPayment).not.toHaveBeenCalled();
    expect(mocks.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
    expect(mocks.emitEvent).not.toHaveBeenCalled();
  });

  it('locks payment entry before reading the ledger used by settlement', async () => {
    mocks.findUnique.mockResolvedValue({
      id: 'invoice-1',
      status: 'SENT',
      total: 100,
      currency: 'USD',
      clientId: 'client-1',
    });

    const result = await caller().addPayment({ invoiceId: 'invoice-1', amount: 25 });

    expect(result).toMatchObject({ amountPaid: 50, balance: 50, status: 'SENT' });
    expect(mocks.queryRaw).toHaveBeenCalledWith(
      ['SELECT id FROM invoices WHERE id = ', ' FOR UPDATE'],
      'invoice-1'
    );
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.findUnique.mock.invocationCallOrder[0]
    );
  });

  it('locks payment removal before deleting and recalculating the balance', async () => {
    mocks.findPayment.mockResolvedValue({ id: 'payment-1', invoiceId: 'invoice-1' });
    mocks.findUnique.mockResolvedValue({ id: 'invoice-1', status: 'PAID', total: 100 });

    const result = await caller().deletePayment({ id: 'payment-1' });

    expect(result).toEqual({ invoiceId: 'invoice-1', amountPaid: 25, balance: 75 });
    expect(mocks.queryRaw).toHaveBeenCalledWith(
      ['SELECT id FROM invoices WHERE id = ', ' FOR UPDATE'],
      'invoice-1'
    );
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deletePayment.mock.invocationCallOrder[0]
    );
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'invoice-1' },
      data: { status: 'SENT', paidAt: null },
    });
  });

  it.each(['OVERDUE', 'CANCELLED'] as const)(
    'preserves sentAt when changing SENT to %s using a status compare-and-set',
    async (status) => {
      mocks.findUnique.mockResolvedValue({ status: 'SENT' });

      await caller().updateInvoiceStatus({ id: 'invoice-1', status });

      expect(mocks.updateMany).toHaveBeenCalledWith({
        where: { id: 'invoice-1', status: 'SENT' },
        data: { status },
      });
    }
  );

  it('preserves sentAt when bulk marking past-due invoices overdue', async () => {
    await caller().markOverdueInvoices();

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { status: 'SENT', dueDate: { lt: expect.any(Date) } },
      data: { status: 'OVERDUE' },
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
