// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logActivity: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({
  withApiAuth: (_scope: string, handler: unknown) => handler,
}));
vi.mock('@/server/activity', () => ({ logActivity: mocks.logActivity }));

import { PATCH } from './route';

const invoice = {
  id: 'invoice-1',
  invoiceNumber: 'INV-2026-001',
  total: 100,
  client: { name: 'Acme' },
};

function context(status: string) {
  return {
    userId: 'user-1',
    db: {
      invoice: {
        findUnique: vi.fn().mockResolvedValue({ id: invoice.id, status }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(invoice),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    },
  };
}

async function patch(status: string, currentStatus: string) {
  const authCtx = context(currentStatus);
  const patchHandler = PATCH as unknown as (
    authCtx: unknown,
    request: Request,
    context: { params: Promise<{ id: string }> }
  ) => Promise<Response>;
  const response = await patchHandler(
    authCtx as never,
    new Request('https://example.test/api/v1/invoices/invoice-1', {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
    { params: Promise.resolve({ id: invoice.id }) }
  );
  return { authCtx, response, body: await response.json() };
}

beforeEach(() => vi.clearAllMocks());

describe('PATCH /api/v1/invoices/:id invoice status', () => {
  it.each(['DRAFT', 'SENT', 'OVERDUE', 'CANCELLED', 'PAID'])(
    'rejects PAID from %s so payment recording remains the only paid path',
    async (currentStatus) => {
      const { authCtx, response, body } = await patch('PAID', currentStatus);

      expect(response.status).toBe(400);
      expect(body).toEqual({ error: 'Record a payment to mark an invoice as paid.' });
      expect(authCtx.db.invoice.updateMany).not.toHaveBeenCalled();
      expect(mocks.logActivity).not.toHaveBeenCalled();
    }
  );

  it('rejects other transitions outside the invoice state machine', async () => {
    const { authCtx, response, body } = await patch('OVERDUE', 'DRAFT');

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'Cannot change an invoice from DRAFT to OVERDUE.' });
    expect(authCtx.db.invoice.updateMany).not.toHaveBeenCalled();
  });

  it('allows DRAFT to SENT and stamps the sent date', async () => {
    const { authCtx, response } = await patch('SENT', 'DRAFT');

    expect(response.status).toBe(200);
    expect(authCtx.db.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: invoice.id, status: 'DRAFT' },
      data: { status: 'SENT', sentAt: expect.any(Date) },
    });
    expect(mocks.logActivity).toHaveBeenCalledOnce();
  });

  it.each(['OVERDUE', 'CANCELLED'])('clears sentAt for SENT to %s', async (status) => {
    const { authCtx, response } = await patch(status, 'SENT');

    expect(response.status).toBe(200);
    expect(authCtx.db.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: invoice.id, status: 'SENT' },
      data: { status, sentAt: null },
    });
  });

  it('suppresses side effects when another request wins the transition', async () => {
    const authCtx = context('DRAFT');
    authCtx.db.invoice.updateMany.mockResolvedValue({ count: 0 });
    const patchHandler = PATCH as unknown as (
      authCtx: unknown,
      request: Request,
      context: { params: Promise<{ id: string }> }
    ) => Promise<Response>;
    const response = await patchHandler(
      authCtx as never,
      new Request('https://example.test/api/v1/invoices/invoice-1', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'SENT' }),
      }),
      { params: Promise.resolve({ id: invoice.id }) }
    );

    expect(response.status).toBe(409);
    expect(authCtx.db.invoice.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });
});
