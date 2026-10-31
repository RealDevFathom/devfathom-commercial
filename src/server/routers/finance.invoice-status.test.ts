import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  findUnique: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  updateMany: vi.fn(),
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
    mocks.findUnique.mockResolvedValue({ status });

    await expect(
      caller().updateInvoiceStatus({ id: 'invoice-1', status: 'PAID' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
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
