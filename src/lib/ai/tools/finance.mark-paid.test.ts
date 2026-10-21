import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/email', () => ({
  appUrl: vi.fn(() => 'https://example.test'),
  sendEmail: vi.fn(),
  templates: { invoicePaid: vi.fn(() => ({})) },
}));

import type { AssistantHelpers } from '@/lib/ai/context';
import { buildFinanceTools } from './finance';

const timestamp = new Date('2026-10-21T12:00:00.000Z');
const invoiceUpdate = vi.fn();
const paymentCreate = vi.fn();
const tx = {
  invoice: { update: invoiceUpdate },
  payment: {
    aggregate: vi.fn(async () => ({ _sum: { amount: 40 } })),
    create: paymentCreate,
  },
};
const db = {
  invoice: {
    findMany: vi.fn(async () => [
      { id: 'inv_1', invoiceNumber: 'INV-2026-001', status: 'OVERDUE' },
    ]),
  },
  user: { findMany: vi.fn(async () => []) },
  $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
};

describe('assistant invoice mark-paid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invoiceUpdate.mockResolvedValue({
      id: 'inv_1',
      invoiceNumber: 'INV-2026-001',
      total: 100,
      currency: 'USD',
      paidAt: timestamp,
      client: { name: 'Acme' },
    });
    paymentCreate.mockResolvedValue({ id: 'payment_1' });
  });

  it('records the outstanding balance in the status update transaction', async () => {
    const tools = buildFinanceTools({
      db,
      isAdmin: true,
      now: () => timestamp,
      activity: vi.fn(),
      audit: vi.fn(),
      notifyUsers: vi.fn(),
    } as unknown as AssistantHelpers);
    const update = tools.updateInvoiceStatus as unknown as {
      execute: (input: { invoiceNumber: string; status: string }) => Promise<unknown>;
    };

    await update.execute({ invoiceNumber: 'INV-2026-001', status: 'PAID' });

    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(paymentCreate).toHaveBeenCalledWith({
      data: {
        invoiceId: 'inv_1',
        amount: 60,
        currency: 'USD',
        method: 'Manual status update',
        paidAt: timestamp,
      },
    });
  });
});
