import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  logActivity: vi.fn(),
  emitEvent: vi.fn(),
  invoiceFindUnique: vi.fn(),
  invoiceUpdate: vi.fn(),
  paymentAggregate: vi.fn(),
  paymentCreate: vi.fn(),
  transaction: vi.fn(),
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

function transactionClient() {
  return {
    invoice: { findUnique: mocks.invoiceFindUnique, update: mocks.invoiceUpdate },
    payment: { aggregate: mocks.paymentAggregate, create: mocks.paymentCreate },
  };
}

function caller() {
  return financeRouter.createCaller({
    db: {
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

describe('finance.addPayment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.invoiceFindUnique.mockResolvedValue({
      id: 'invoice-1',
      invoiceNumber: 'INV-1',
      status: 'SENT',
      total: 100,
      currency: 'USD',
      clientId: 'client-1',
    });
    mocks.paymentAggregate.mockResolvedValue({ _sum: { amount: 40 } });
    mocks.paymentCreate.mockResolvedValue({ id: 'payment-1', amount: 60 });
    mocks.invoiceUpdate.mockResolvedValue({});
    mocks.transaction.mockImplementation(
      async (callback: (transaction: ReturnType<typeof transactionClient>) => unknown) =>
        callback(transactionClient())
    );
  });

  it.each(['SENT', 'OVERDUE'] as const)(
    'logs invoice_paid when a payment covers the outstanding balance of a %s invoice',
    async (status) => {
      mocks.invoiceFindUnique.mockResolvedValue({
        id: 'invoice-1',
        invoiceNumber: 'INV-1',
        status,
        total: 100,
        currency: 'USD',
        clientId: 'client-1',
      });

      const result = await caller().addPayment({ invoiceId: 'invoice-1', amount: 60 });

      expect(result.status).toBe('PAID');
      expect(mocks.invoiceFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({ invoiceNumber: true }),
        })
      );
      expect(mocks.invoiceUpdate).toHaveBeenCalledOnce();
      expect(mocks.logActivity).toHaveBeenCalledOnce();
      expect(mocks.logActivity).toHaveBeenCalledWith(expect.anything(), 'admin-1', {
        type: 'invoice_paid',
        message: 'marked invoice INV-1 as paid ($100)',
        entityType: 'Invoice',
        entityId: 'invoice-1',
      });
      expect(mocks.emitEvent).toHaveBeenCalledOnce();
      expect(mocks.emitEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'invoice.paid',
        {
          invoiceId: 'invoice-1',
          total: 100,
          currency: 'USD',
          clientId: 'client-1',
        }
      );
    }
  );

  it('does not log invoice_paid for a partial payment', async () => {
    mocks.paymentCreate.mockResolvedValue({ id: 'payment-1', amount: 50 });

    await caller().addPayment({ invoiceId: 'invoice-1', amount: 50 });

    expect(mocks.paymentCreate).toHaveBeenCalledOnce();
    expect(mocks.invoiceUpdate).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
    expect(mocks.emitEvent).not.toHaveBeenCalled();
  });

  it.each(['DRAFT', 'PAID', 'CANCELLED'] as const)(
    'does not log invoice_paid when the invoice is %s',
    async (status) => {
      mocks.invoiceFindUnique.mockResolvedValue({
        id: 'invoice-1',
        invoiceNumber: 'INV-1',
        status,
        total: 100,
        currency: 'USD',
        clientId: 'client-1',
      });

      await expect(
        caller().addPayment({ invoiceId: 'invoice-1', amount: 60 })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      expect(mocks.paymentCreate).not.toHaveBeenCalled();
      expect(mocks.logActivity).not.toHaveBeenCalled();
      expect(mocks.emitEvent).not.toHaveBeenCalled();
    }
  );

  it('does not log invoice_paid when an overpayment is rejected', async () => {
    await expect(caller().addPayment({ invoiceId: 'invoice-1', amount: 61 })).rejects.toMatchObject(
      {
        code: 'BAD_REQUEST',
      }
    );

    expect(mocks.paymentCreate).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
    expect(mocks.emitEvent).not.toHaveBeenCalled();
  });

  it('does not log invoice_paid when the payment transaction fails to commit', async () => {
    mocks.transaction.mockImplementation(
      async (callback: (transaction: ReturnType<typeof transactionClient>) => unknown) => {
        await callback(transactionClient());
        throw new Error('commit failed');
      }
    );

    await expect(caller().addPayment({ invoiceId: 'invoice-1', amount: 60 })).rejects.toThrow(
      'commit failed'
    );

    expect(mocks.invoiceUpdate).toHaveBeenCalledOnce();
    expect(mocks.logActivity).not.toHaveBeenCalled();
    expect(mocks.emitEvent).not.toHaveBeenCalled();
  });

  it('logs invoice_paid only after the payment transaction commits', async () => {
    mocks.transaction.mockImplementation(
      async (callback: (transaction: ReturnType<typeof transactionClient>) => unknown) => {
        const result = await callback(transactionClient());

        expect(mocks.logActivity).not.toHaveBeenCalled();
        expect(mocks.emitEvent).not.toHaveBeenCalled();

        return result;
      }
    );

    await caller().addPayment({ invoiceId: 'invoice-1', amount: 60 });

    expect(mocks.logActivity).toHaveBeenCalledOnce();
    expect(mocks.emitEvent).toHaveBeenCalledOnce();
  });
});
