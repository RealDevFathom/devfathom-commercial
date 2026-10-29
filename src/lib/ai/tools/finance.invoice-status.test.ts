import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantHelpers } from '@/lib/ai/context';

vi.mock('server-only', () => ({}));

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
  const tx = {
    invoice: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: invoice.id, invoiceNumber: invoice.invoiceNumber, status: prior },
        ]),
      updateMany: vi.fn().mockResolvedValue({ count: changed }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ ...invoice, status: prior }),
      findUnique: vi.fn().mockResolvedValue(invoice),
    },
    payment: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { amount: 40 } }),
      create: vi.fn().mockResolvedValue({}),
    },
  };
  const db = { ...tx, $transaction: vi.fn(async (callback) => callback(tx)) };
  const helpers = {
    db,
    isAdmin: true,
    ctx: { userId: 'admin-1' },
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
  beforeEach(() => vi.clearAllMocks());

  it.each(['SENT', 'OVERDUE'])(
    'records a balancing payment when marking %s paid',
    async (prior) => {
      const { db, helpers, tool } = setup(prior);

      const result = await tool.execute({ invoiceNumber: invoice.invoiceNumber, status: 'PAID' });

      expect(result.error).toBeUndefined();
      expect(db.payment.create).toHaveBeenCalledWith({
        data: {
          invoiceId: invoice.id,
          amount: 60,
          currency: 'USD',
          method: 'Manual status update',
        },
      });
      expect(db.invoice.updateMany).toHaveBeenCalledWith({
        where: { id: invoice.id, status: prior },
        data: {
          status: 'PAID',
          paidAt: new Date('2026-10-21T00:00:00Z'),
          ...(prior === 'SENT' && { sentAt: null }),
        },
      });
      expect(helpers.activity).not.toHaveBeenCalled();
      expect(helpers.audit).toHaveBeenCalledOnce();
      expect(helpers.notifyUsers).not.toHaveBeenCalled();
    }
  );

  it('clears sentAt with a compare-and-set when SENT becomes OVERDUE', async () => {
    const { db, tool } = setup('SENT');

    await tool.execute({ invoiceNumber: invoice.invoiceNumber, status: 'OVERDUE' });

    expect(db.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: invoice.id, status: 'SENT' },
      data: { status: 'OVERDUE', sentAt: null },
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
});
