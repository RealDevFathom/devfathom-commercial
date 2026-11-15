// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transactionFindUnique: vi.fn(),
  transactionUpdate: vi.fn(),
  transactionDelete: vi.fn(),
  projectFindFirst: vi.fn(),
  clientFindFirst: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({
  withApiAuth:
    (_scope: string, handler: (...args: never[]) => unknown) =>
    (request: Request, context: unknown) =>
      handler(
        {
          organizationId: 'org-owned',
          db: {
            transaction: {
              findUnique: mocks.transactionFindUnique,
              update: mocks.transactionUpdate,
              delete: mocks.transactionDelete,
            },
            project: { findFirst: mocks.projectFindFirst },
            client: { findFirst: mocks.clientFindFirst },
          },
        } as never,
        request as never,
        context as never
      ),
}));

import { PAYMENT_LEDGER_LOCKED_MESSAGE } from '@/lib/finance/payment-ledger';
import { DELETE, PATCH } from './route';

function patch(body: Record<string, unknown>) {
  return PATCH(
    new Request('https://example.test/api/v1/transactions/transaction-owned', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'transaction-owned' }) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transactionFindUnique.mockResolvedValue({ id: 'transaction-owned' });
  mocks.transactionUpdate.mockResolvedValue({ id: 'transaction-owned' });
  mocks.transactionDelete.mockResolvedValue({ id: 'transaction-owned' });
  mocks.projectFindFirst.mockResolvedValue({ id: 'project-owned' });
  mocks.clientFindFirst.mockResolvedValue({ id: 'client-owned' });
});

describe('PATCH /api/v1/transactions/:id organization references', () => {
  it.each([
    ['projectId', mocks.projectFindFirst],
    ['clientId', mocks.clientFindFirst],
  ] as const)('rejects a foreign %s without changing the transaction', async (field, lookup) => {
    lookup.mockResolvedValueOnce(null);

    const response = await patch({ [field]: `${field}-foreign` });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: `${field} does not exist.` });
    expect(lookup).toHaveBeenCalledWith({
      where: { id: `${field}-foreign`, organizationId: 'org-owned' },
      select: { id: true },
    });
    expect(mocks.transactionUpdate).not.toHaveBeenCalled();
  });

  it('updates when both references belong to the token organization', async () => {
    const response = await patch({ projectId: 'project-owned', clientId: 'client-owned' });

    expect(response.status).toBe(200);
    expect(mocks.transactionUpdate).toHaveBeenCalledWith({
      where: { id: 'transaction-owned' },
      data: { projectId: 'project-owned', clientId: 'client-owned' },
    });
  });

  it('keeps nullable references clearable without an ownership lookup', async () => {
    const response = await patch({ projectId: null, clientId: null });

    expect(response.status).toBe(200);
    expect(mocks.projectFindFirst).not.toHaveBeenCalled();
    expect(mocks.clientFindFirst).not.toHaveBeenCalled();
    expect(mocks.transactionUpdate).toHaveBeenCalledWith({
      where: { id: 'transaction-owned' },
      data: { projectId: null, clientId: null },
    });
  });
});

describe('/api/v1/transactions/:id payment-posted income (DEV-166)', () => {
  const paidAt = new Date('2026-10-22T14:50:00.000Z');

  function remove() {
    return DELETE(
      new Request('https://example.test/api/v1/transactions/transaction-owned', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: 'transaction-owned' }) }
    );
  }

  beforeEach(() => {
    mocks.transactionFindUnique.mockResolvedValue({
      id: 'transaction-owned',
      paymentId: 'payment-6',
      type: 'INCOME',
      amount: 100,
      date: paidAt,
    });
  });

  it('refuses to delete the revenue a payment posted', async () => {
    const response = await remove();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: PAYMENT_LEDGER_LOCKED_MESSAGE });
    expect(mocks.transactionDelete).not.toHaveBeenCalled();
  });

  it.each([
    ['amount', { amount: 1 }],
    ['type', { type: 'EXPENSE' }],
    ['date', { date: '2026-10-01T00:00:00.000Z' }],
  ])('refuses to change the %s of payment-posted revenue', async (_field, change) => {
    const response = await patch(change);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: PAYMENT_LEDGER_LOCKED_MESSAGE });
    expect(mocks.transactionUpdate).not.toHaveBeenCalled();
  });

  it('still allows renaming payment-posted revenue', async () => {
    const response = await patch({ description: 'Acme retainer' });

    expect(response.status).toBe(200);
    expect(mocks.transactionUpdate).toHaveBeenCalledWith({
      where: { id: 'transaction-owned' },
      data: { description: 'Acme retainer' },
    });
  });

  it('keeps manually entered transactions deletable', async () => {
    mocks.transactionFindUnique.mockResolvedValue({ id: 'transaction-owned', paymentId: null });

    const response = await remove();

    expect(response.status).toBe(200);
    expect(mocks.transactionDelete).toHaveBeenCalledWith({ where: { id: 'transaction-owned' } });
  });
});
