import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  findUnique: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  updateMany: vi.fn(),
  sendEmail: vi.fn(),
  logActivity: vi.fn(),
  emitInvoicePaid: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({ hasModule: vi.fn(() => true) }));
vi.mock('../activity', () => ({ logActivity: mocks.logActivity }));
vi.mock('@/lib/finance/invoice-paid-event', () => ({ emitInvoicePaid: mocks.emitInvoicePaid }));
vi.mock('@/lib/email', async () => ({
  ...(await vi.importActual<typeof import('@/lib/email')>('@/lib/email')),
  sendEmail: mocks.sendEmail,
}));
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
    mocks.findUnique.mockResolvedValue({ status, total: 100 });

    await expect(
      caller().updateInvoiceStatus({ id: 'invoice-1', status: 'PAID' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it.each(['OVERDUE', 'CANCELLED'] as const)(
    'preserves sentAt when changing SENT to %s using a status compare-and-set',
    async (status) => {
      mocks.findUnique.mockResolvedValue({ status: 'SENT', total: 100 });

      await caller().updateInvoiceStatus({ id: 'invoice-1', status });

      expect(mocks.updateMany).toHaveBeenCalledWith({
        where: { id: 'invoice-1', status: 'SENT', total: 100 },
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
    mocks.findUnique.mockResolvedValue({ status: 'DRAFT', total: 100 });
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      caller().updateInvoiceStatus({ id: 'invoice-1', status: 'SENT' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it('issues and settles a fully discounted draft with a total compare-and-set', async () => {
    mocks.findUnique.mockResolvedValue({ status: 'DRAFT', total: 0 });
    const settled = { id: 'invoice-1', status: 'PAID', total: 0, client: { name: 'Acme' } };
    mocks.findUniqueOrThrow.mockResolvedValue(settled);
    await caller().updateInvoiceStatus({ id: 'invoice-1', status: 'SENT' });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: 'invoice-1', status: 'DRAFT', total: 0 },
      data: { status: 'PAID', sentAt: expect.any(Date), paidAt: expect.any(Date) },
    });
    expect(mocks.emitInvoicePaid).toHaveBeenCalledOnce();
    expect(mocks.emitInvoicePaid).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      settled
    );
  });

  it('does not emit invoice.paid for an ordinary status change', async () => {
    mocks.findUnique.mockResolvedValue({ status: 'DRAFT', total: 100 });
    await caller().updateInvoiceStatus({ id: 'invoice-1', status: 'SENT' });
    expect(mocks.emitInvoicePaid).not.toHaveBeenCalled();
  });

  it.each([0, 100])(
    'issues an emailed draft with total %s and settles only zero totals',
    async (total) => {
      mocks.findUnique.mockResolvedValue({
        id: 'invoice-1',
        invoiceNumber: 'INV-1',
        status: 'DRAFT',
        total,
        currency: 'USD',
        dueDate: new Date('2026-12-01'),
        client: { name: 'Acme', contacts: [{ name: 'Client', email: 'client@example.test' }] },
      });
      const result = await caller().sendInvoiceEmail({ id: 'invoice-1' });
      expect(mocks.sendEmail).toHaveBeenCalledOnce();
      expect(mocks.updateMany).toHaveBeenCalledWith({
        where: { id: 'invoice-1', status: 'DRAFT', total },
        data:
          total === 0
            ? { status: 'PAID', sentAt: expect.any(Date), paidAt: expect.any(Date) }
            : { status: 'SENT', sentAt: expect.any(Date) },
      });
      expect(result.status).toBe(total === 0 ? 'PAID' : 'SENT');
      expect(mocks.emitInvoicePaid).toHaveBeenCalledTimes(total === 0 ? 1 : 0);
    }
  );

  it('reports a conflict if an emailed draft changed while the email was being sent', async () => {
    mocks.findUnique.mockResolvedValue({
      id: 'invoice-1',
      invoiceNumber: 'INV-1',
      status: 'DRAFT',
      total: 0,
      currency: 'USD',
      dueDate: new Date('2026-12-01'),
      client: { name: 'Acme', contacts: [{ name: 'Client', email: 'client@example.test' }] },
    });
    mocks.updateMany.mockResolvedValue({ count: 0 });
    await expect(caller().sendInvoiceEmail({ id: 'invoice-1' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(mocks.logActivity).not.toHaveBeenCalled();
    expect(mocks.emitInvoicePaid).not.toHaveBeenCalled();
  });
});
