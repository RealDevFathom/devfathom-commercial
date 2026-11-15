import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  transactionFindUnique: vi.fn(),
  transactionUpdate: vi.fn(),
  transactionDelete: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({ hasModule: vi.fn(() => true) }));
vi.mock('../activity', () => ({ logActivity: vi.fn() }));
vi.mock('@/lib/webhooks', () => ({ emitEvent: vi.fn() }));
vi.mock('../audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { PAYMENT_LEDGER_LOCKED_MESSAGE } from '@/lib/finance/payment-ledger';
import type { TRPCContext } from '../trpc';
import { financeRouter } from './finance';

const paidAt = new Date('2026-10-22T14:50:00.000Z');

function caller() {
  return financeRouter.createCaller({
    db: {
      transaction: {
        findUnique: mocks.transactionFindUnique,
        update: mocks.transactionUpdate,
        delete: mocks.transactionDelete,
      },
      client: { findMany: vi.fn().mockResolvedValue([]) },
      project: { findMany: vi.fn().mockResolvedValue([]) },
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

describe('finance transaction mutations on payment-posted income (DEV-166)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.transactionFindUnique.mockResolvedValue({
      paymentId: 'payment-6',
      type: 'INCOME',
      amount: 100,
      date: paidAt,
    });
    mocks.transactionUpdate.mockResolvedValue({ id: 'transaction-6' });
    mocks.transactionDelete.mockResolvedValue({ id: 'transaction-6' });
  });

  it('refuses to delete the revenue a payment posted', async () => {
    await expect(caller().deleteTransaction({ id: 'transaction-6' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: PAYMENT_LEDGER_LOCKED_MESSAGE,
    });
    expect(mocks.transactionDelete).not.toHaveBeenCalled();
  });

  it.each([
    ['amount', { amount: 0.01 }],
    ['type', { type: 'EXPENSE' as const }],
    ['date', { date: new Date('2026-10-01T00:00:00.000Z') }],
  ])('refuses to change the %s of payment-posted revenue', async (_field, change) => {
    await expect(
      caller().updateTransaction({ id: 'transaction-6', ...change })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: PAYMENT_LEDGER_LOCKED_MESSAGE });
    expect(mocks.transactionUpdate).not.toHaveBeenCalled();
  });

  it('still allows renaming payment-posted revenue', async () => {
    await caller().updateTransaction({ id: 'transaction-6', description: 'Acme retainer' });

    expect(mocks.transactionUpdate).toHaveBeenCalledWith({
      where: { id: 'transaction-6' },
      data: { description: 'Acme retainer' },
    });
  });

  it('keeps manually entered transactions editable and deletable', async () => {
    mocks.transactionFindUnique.mockResolvedValue({
      paymentId: null,
      type: 'INCOME',
      amount: 100,
      date: paidAt,
    });

    await caller().updateTransaction({ id: 'transaction-1', amount: 75 });
    await caller().deleteTransaction({ id: 'transaction-1' });

    expect(mocks.transactionUpdate).toHaveBeenCalledWith({
      where: { id: 'transaction-1' },
      data: { amount: 75 },
    });
    expect(mocks.transactionDelete).toHaveBeenCalledWith({ where: { id: 'transaction-1' } });
  });

  it('reports a missing transaction as not found', async () => {
    mocks.transactionFindUnique.mockResolvedValue(null);

    await expect(caller().deleteTransaction({ id: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(caller().updateTransaction({ id: 'missing', amount: 1 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
