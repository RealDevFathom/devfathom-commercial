import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantHelpers } from '@/lib/ai/context';
import { PAYMENT_LEDGER_LOCKED_MESSAGE } from '@/lib/finance/payment-ledger';

vi.mock('server-only', () => ({}));

import { buildFinanceTools } from './finance';

const paidAt = new Date('2026-10-22T14:50:00.000Z');

type ToolResult = { error?: string; id?: string };
type Exec = { execute(input: Record<string, unknown>): Promise<ToolResult> };

function setup(paymentId: string | null) {
  const db = {
    transaction: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'transaction-6',
        description: 'Payment for INV-2026-006',
        paymentId,
        type: 'INCOME',
        amount: 100,
        currency: 'USD',
        date: paidAt,
      }),
      update: vi.fn().mockResolvedValue({
        id: 'transaction-6',
        type: 'INCOME',
        amount: 100,
        currency: 'USD',
        category: null,
        description: 'Renamed',
        date: paidAt,
        project: null,
        client: null,
      }),
      delete: vi.fn().mockResolvedValue({ id: 'transaction-6' }),
    },
  };
  const helpers = {
    db,
    isAdmin: true,
    ctx: { userId: 'admin-1' },
    now: () => new Date('2026-10-23T00:00:00Z'),
    activity: vi.fn(),
    audit: vi.fn(),
    notifyUsers: vi.fn(),
  } as unknown as AssistantHelpers;
  const tools = buildFinanceTools(helpers);
  return {
    db,
    helpers,
    update: tools.updateTransaction as unknown as Exec,
    remove: tools.deleteTransaction as unknown as Exec,
  };
}

describe('assistant transaction tools on payment-posted income (DEV-166)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses to delete the revenue a payment posted', async () => {
    const { db, helpers, remove } = setup('payment-6');

    const result = await remove.execute({ id: 'transaction-6' });

    expect(result.error).toBe(PAYMENT_LEDGER_LOCKED_MESSAGE);
    expect(db.transaction.delete).not.toHaveBeenCalled();
    expect(helpers.audit).not.toHaveBeenCalled();
  });

  it.each([
    ['amount', { amount: 1 }],
    ['type', { type: 'EXPENSE' }],
    ['date', { date: '2026-10-01' }],
  ])('refuses to change the %s of payment-posted revenue', async (_field, change) => {
    const { db, helpers, update } = setup('payment-6');

    const result = await update.execute({ id: 'transaction-6', ...change });

    expect(result.error).toBe(PAYMENT_LEDGER_LOCKED_MESSAGE);
    expect(db.transaction.update).not.toHaveBeenCalled();
    expect(helpers.audit).not.toHaveBeenCalled();
  });

  it('still allows renaming payment-posted revenue', async () => {
    const { db, update } = setup('payment-6');

    const result = await update.execute({ id: 'transaction-6', description: 'Renamed' });

    expect(result.error).toBeUndefined();
    expect(db.transaction.update).toHaveBeenCalledOnce();
  });

  it('keeps manually entered transactions deletable', async () => {
    const { db, remove } = setup(null);

    const result = await remove.execute({ id: 'transaction-6' });

    expect(result.error).toBeUndefined();
    expect(db.transaction.delete).toHaveBeenCalledWith({ where: { id: 'transaction-6' } });
  });
});
