import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantHelpers } from '@/lib/ai/context';
import { PAID_STATUS_ERROR } from '@/lib/finance/invoice-status';

const mocks = vi.hoisted(() => ({
  entitlements: { organizationId: 'org-1', enabledModules: ['webhooks'] },
  emitInvoicePaid: vi.fn(),
  resolveOrganizationEntitlements: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/finance/invoice-paid-event', () => ({ emitInvoicePaid: mocks.emitInvoicePaid }));
vi.mock('@/lib/entitlements', async () => ({
  ...(await vi.importActual<typeof import('@/lib/entitlements')>('@/lib/entitlements')),
  resolveOrganizationEntitlements: mocks.resolveOrganizationEntitlements,
}));

import { buildFinanceTools } from './finance';

const invoice = {
  id: 'invoice-1',
  invoiceNumber: 'INV-2026-001',
  status: 'SENT',
  total: 100,
  currency: 'USD',
  paidAt: null,
  sentAt: null,
  client: { name: 'Acme' },
};

function setup(prior: string, changed = 1) {
  const db = {
    invoice: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: invoice.id, invoiceNumber: invoice.invoiceNumber, status: prior, total: 100 },
        ]),
      updateMany: vi.fn().mockResolvedValue({ count: changed }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ ...invoice, status: prior }),
    },
  };
  const helpers = {
    db,
    isAdmin: true,
    ctx: { userId: 'admin-1', organizationId: 'org-1' },
    now: () => new Date('2026-10-21T00:00:00Z'),
    activity: vi.fn(),
    audit: vi.fn(),
    notifyUsers: vi.fn(),
  } as unknown as AssistantHelpers;
  const tool = buildFinanceTools(helpers).updateInvoiceStatus as unknown as {
    execute(input: { invoiceNumber: string; status: string }): Promise<{ error?: string }>;
  };
  return { db, helpers, tool };
}

describe('assistant updateInvoiceStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveOrganizationEntitlements.mockResolvedValue(mocks.entitlements);
  });

  it.each(['SENT', 'OVERDUE', 'PAID'])(
    'rejects direct PAID from %s without side effects',
    async (prior) => {
      const { db, helpers, tool } = setup(prior);

      const result = await tool.execute({ invoiceNumber: invoice.invoiceNumber, status: 'PAID' });

      expect(result.error).toBe(PAID_STATUS_ERROR);
      expect(db.invoice.updateMany).not.toHaveBeenCalled();
      expect(helpers.activity).not.toHaveBeenCalled();
      expect(helpers.audit).not.toHaveBeenCalled();
      expect(helpers.notifyUsers).not.toHaveBeenCalled();
    }
  );

  it('preserves sentAt with a compare-and-set when SENT becomes OVERDUE', async () => {
    const { db, tool } = setup('SENT');

    await tool.execute({ invoiceNumber: invoice.invoiceNumber, status: 'OVERDUE' });

    expect(db.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: invoice.id, status: 'SENT', total: 100 },
      data: { status: 'OVERDUE' },
    });
  });

  it('suppresses every side effect when the compare-and-set loses a race', async () => {
    const { db, helpers, tool } = setup('DRAFT', 0);

    const result = await tool.execute({ invoiceNumber: invoice.invoiceNumber, status: 'SENT' });

    expect(result.error).toContain('concurrently');
    expect(db.invoice.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(helpers.activity).not.toHaveBeenCalled();
    expect(helpers.audit).not.toHaveBeenCalled();
    expect(helpers.notifyUsers).not.toHaveBeenCalled();
  });

  it('issues and settles a fully discounted draft and audits its actual status', async () => {
    const { db, helpers, tool } = setup('DRAFT');
    db.invoice.findMany.mockResolvedValue([
      { id: invoice.id, invoiceNumber: invoice.invoiceNumber, status: 'DRAFT', total: 0 },
    ]);
    await tool.execute({ invoiceNumber: invoice.invoiceNumber, status: 'SENT' });
    expect(db.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: invoice.id, status: 'DRAFT', total: 0 },
      data: { status: 'PAID', sentAt: expect.any(Date), paidAt: expect.any(Date) },
    });
    expect(helpers.audit).toHaveBeenCalledWith(
      expect.objectContaining({ changes: { status: { before: 'DRAFT', after: 'PAID' } } })
    );
  });

  it('emits invoice.paid once when issuing settles a zero-total draft', async () => {
    const { db, tool } = setup('DRAFT');
    const settled = { ...invoice, total: 0, status: 'PAID', clientId: 'client-1' };
    db.invoice.findMany.mockResolvedValue([
      { id: invoice.id, invoiceNumber: invoice.invoiceNumber, status: 'DRAFT', total: 0 },
    ]);
    db.invoice.findUniqueOrThrow.mockResolvedValue(settled);
    await tool.execute({ invoiceNumber: invoice.invoiceNumber, status: 'SENT' });
    expect(mocks.resolveOrganizationEntitlements).toHaveBeenCalledWith('org-1', db);
    expect(mocks.emitInvoicePaid).toHaveBeenCalledOnce();
    expect(mocks.emitInvoicePaid).toHaveBeenCalledWith(db, mocks.entitlements, settled);
  });

  it('does not emit invoice.paid for an ordinary issue', async () => {
    const { tool } = setup('DRAFT');
    await tool.execute({ invoiceNumber: invoice.invoiceNumber, status: 'SENT' });
    expect(mocks.emitInvoicePaid).not.toHaveBeenCalled();
  });
});
