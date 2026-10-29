import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  findUnique: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  updateMany: vi.fn(),
  aggregate: vi.fn(),
  createPayment: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({ hasModule: vi.fn(() => true) }));
vi.mock('../activity', () => ({ logActivity: mocks.logActivity }));
vi.mock('../audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import type { TRPCContext } from '../trpc';
import { financeRouter } from './finance';

function caller() {
  const tx = {
    invoice: {
      findUnique: mocks.findUnique,
      findUniqueOrThrow: mocks.findUniqueOrThrow,
      updateMany: mocks.updateMany,
    },
    payment: { aggregate: mocks.aggregate, create: mocks.createPayment },
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
    mocks.findUniqueOrThrow.mockResolvedValue({
      id: 'invoice-1',
      invoiceNumber: 'INV-1',
      status: 'SENT',
      total: 100,
      client: { name: 'Acme' },
    });
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
          ...(status === 'SENT' && { sentAt: null }),
        },
      });
    }
  );

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
