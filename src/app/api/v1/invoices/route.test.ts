// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({
  withApiAuth: (_scope: string, handler: unknown) => handler,
}));
vi.mock('@/server/activity', () => ({ logActivity: mocks.logActivity }));

import { POST } from './route';

describe('POST /api/v1/invoices money calculation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue({
      id: 'invoice-1',
      invoiceNumber: 'INV-2026-001',
      total: 2.03,
      client: { name: 'Acme' },
    });
  });

  it('rounds each half-cent line and the tax half up before persisting totals', async () => {
    const authCtx = {
      userId: 'user-1',
      db: {
        invoice: {
          count: vi.fn().mockResolvedValue(0),
          create: mocks.create,
        },
      },
    };
    const handler = POST as unknown as (authCtx: unknown, request: Request) => Promise<Response>;
    const response = await handler(
      authCtx,
      new Request('https://example.test/api/v1/invoices', {
        method: 'POST',
        body: JSON.stringify({
          clientId: 'client-1',
          items: [
            { description: 'First', quantity: 1, rate: 1.005, amount: 0 },
            { description: 'Second', quantity: 3, rate: 0.335, amount: 0 },
          ],
          tax: 0.005,
          dueDate: '2026-11-30T00:00:00.000Z',
        }),
      })
    );

    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          items: [
            { description: 'First', quantity: 1, rate: 1.005, amount: 1.01 },
            { description: 'Second', quantity: 3, rate: 0.335, amount: 1.01 },
          ],
          subtotal: 2.02,
          tax: 0.01,
          total: 2.03,
        }),
      })
    );
  });

  it.each([
    ['line amount', [{ description: 'Too large', quantity: 2, rate: 9_999_999_999.99 }], 0],
    [
      'subtotal',
      [
        { description: 'First', quantity: 1, rate: 5_000_000_000 },
        { description: 'Second', quantity: 1, rate: 5_000_000_000 },
      ],
      0,
    ],
    ['total', [{ description: 'At limit', quantity: 1, rate: 9_999_999_999.99 }], 0.01],
  ])('rejects a derived %s overflow before persistence', async (_kind, items, tax) => {
    const authCtx = {
      userId: 'user-1',
      db: { invoice: { count: vi.fn(), create: mocks.create } },
    };
    const handler = POST as unknown as (authCtx: unknown, request: Request) => Promise<Response>;
    const response = await handler(
      authCtx,
      new Request('https://example.test/api/v1/invoices', {
        method: 'POST',
        body: JSON.stringify({
          clientId: 'client-1',
          items,
          tax,
          dueDate: '2026-11-30T00:00:00.000Z',
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
