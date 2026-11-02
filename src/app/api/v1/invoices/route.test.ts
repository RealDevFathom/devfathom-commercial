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
          discount: 0,
          tax: 0.01,
          total: 2.03,
        }),
      })
    );
  });

  async function post(body: Record<string, unknown>) {
    const authCtx = {
      userId: 'user-1',
      db: { invoice: { count: vi.fn().mockResolvedValue(0), create: mocks.create } },
    };
    const handler = POST as unknown as (authCtx: unknown, request: Request) => Promise<Response>;
    const response = await handler(
      authCtx,
      new Request('https://example.test/api/v1/invoices', {
        method: 'POST',
        body: JSON.stringify({
          clientId: 'client-1',
          dueDate: '2026-11-30T00:00:00.000Z',
          ...body,
        }),
      })
    );
    return { response, body: await response.json() };
  }

  it('persists tax and discount amounts with total = subtotal − discount + tax (#448)', async () => {
    const { response } = await post({
      items: [
        { description: 'Pack', quantity: 3, rate: 0.335 },
        { description: 'Third', quantity: 3, rate: 1 / 3 },
      ],
      discount: 0.5,
      tax: 0.125,
    });

    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          items: [
            { description: 'Pack', quantity: 3, rate: 0.335, amount: 1.01 },
            { description: 'Third', quantity: 3, rate: 1 / 3, amount: 1 },
          ],
          subtotal: 2.01,
          discount: 0.5,
          tax: 0.13,
          total: 1.64,
        }),
      })
    );
  });

  it('refuses a discount above the subtotal with a field error (#448)', async () => {
    const { response, body } = await post({
      items: [{ description: 'Work', quantity: 1, rate: 100 }],
      discount: 100.01,
    });

    expect(response.status).toBe(400);
    expect(body.details).toEqual([
      { path: ['discount'], message: 'Discount cannot be more than the subtotal.' },
    ]);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([{ discount: -1 }, { tax: -0.01 }])(
    'refuses a negative amount %j (#448)',
    async (money) => {
      const { response } = await post({
        items: [{ description: 'Work', quantity: 1, rate: 100 }],
        ...money,
      });

      expect(response.status).toBe(400);
      expect(mocks.create).not.toHaveBeenCalled();
    }
  );

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
