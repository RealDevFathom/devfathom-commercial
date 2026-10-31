// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logActivity: vi.fn(),
  emitInvoicePaid: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({
  withApiAuth: (_scope: string, handler: unknown) => handler,
}));
vi.mock('@/server/activity', () => ({ logActivity: mocks.logActivity }));
vi.mock('@/lib/finance/invoice-paid-event', () => ({ emitInvoicePaid: mocks.emitInvoicePaid }));

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
        findUnique: vi.fn().mockResolvedValue({ id: invoice.id, status, total: 100 }),
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
      where: { id: invoice.id, status: 'DRAFT', total: 100 },
      data: { status: 'SENT', sentAt: expect.any(Date) },
    });
    expect(mocks.logActivity).toHaveBeenCalledOnce();
  });

  it.each(['OVERDUE', 'CANCELLED'])('preserves sentAt for SENT to %s', async (status) => {
    const { authCtx, response } = await patch(status, 'SENT');

    expect(response.status).toBe(200);
    expect(authCtx.db.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: invoice.id, status: 'SENT', total: 100 },
      data: { status },
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
    expect(mocks.emitInvoicePaid).not.toHaveBeenCalled();
  });

  it('issues and settles a fully discounted draft atomically', async () => {
    const authCtx = context('DRAFT');
    authCtx.db.invoice.findUnique.mockResolvedValue({ id: invoice.id, status: 'DRAFT', total: 0 });
    const settled = { ...invoice, total: 0, status: 'PAID' };
    authCtx.db.invoice.findUniqueOrThrow.mockResolvedValue(settled);
    const handler = PATCH as unknown as (
      ctx: unknown,
      request: Request,
      route: { params: Promise<{ id: string }> }
    ) => Promise<Response>;
    const response = await handler(
      authCtx,
      new Request('https://example.test/api/v1/invoices/invoice-1', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'SENT' }),
      }),
      { params: Promise.resolve({ id: invoice.id }) }
    );
    expect(response.status).toBe(200);
    expect(authCtx.db.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: invoice.id, status: 'DRAFT', total: 0 },
      data: { status: 'PAID', sentAt: expect.any(Date), paidAt: expect.any(Date) },
    });
    expect(mocks.emitInvoicePaid).toHaveBeenCalledOnce();
    expect(mocks.emitInvoicePaid).toHaveBeenCalledWith(authCtx.db, undefined, settled);
  });

  it('does not emit invoice.paid for an ordinary issue', async () => {
    await patch('SENT', 'DRAFT');
    expect(mocks.emitInvoicePaid).not.toHaveBeenCalled();
  });
});
