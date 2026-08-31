import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  capabilities: new Set<string>(),
  ctx: {
    state: 'UNLOCKED',
    session: { activeStaffProfileId: 'staff-cashier' },
    device: { id: 'device-1', branchId: 'branch-1' },
    db: { restaurantOrder: { findFirst: vi.fn() } },
  },
}));

vi.mock('server-only', () => ({}));
vi.mock('./checkout-routes', () => ({
  operatorHasCapability: vi.fn(async (_db: unknown, _staffProfileId: string, capability: string) =>
    mocks.capabilities.has(capability)
  ),
}));
vi.mock('./terminal-auth', () => ({
  authenticateOperator: vi.fn(),
  withTerminalAuth:
    (handler: (ctx: typeof mocks.ctx, request: Request) => Promise<Response>) =>
    (request: Request) =>
      handler(mocks.ctx, request),
}));

import { terminalCommandRoute } from './terminal-orders';

const schema = z
  .object({
    channel: z.enum(['DINE_IN', 'TAKEAWAY', 'DELIVERY']),
    customerId: z.string().optional(),
  })
  .strict();

function request(channel: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY') {
  return new Request('https://tenant.test/api/restaurant/orders/open', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'open-1', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel,
      ...(channel === 'DELIVERY' ? { customerId: 'customer-1' } : {}),
    }),
  });
}

beforeEach(() => {
  mocks.capabilities.clear();
});

describe('terminal order capability boundary', () => {
  it.each(['cashier', 'server'])('allows the default authorized %s capability set', async () => {
    mocks.capabilities.add('orders:take');
    mocks.capabilities.add('customers:read');
    const run = vi.fn().mockResolvedValue({ orderId: 'order-1' });
    const route = terminalCommandRoute(schema, run, 201);

    const response = await route(request('DELIVERY'));

    expect(response.status).toBe(201);
    expect(run).toHaveBeenCalledOnce();
  });

  it('denies an active same-branch operator before the command can create durable rows', async () => {
    const run = vi.fn().mockResolvedValue({ orderId: 'should-not-exist' });
    const route = terminalCommandRoute(schema, run, 201);

    const response = await route(request('DINE_IN'));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'This operator lacks the "orders:take" capability.',
    });
    expect(run).not.toHaveBeenCalled();
    expect(mocks.ctx.db.restaurantOrder.findFirst).not.toHaveBeenCalled();
  });

  it('requires customer read in addition to order taking for delivery', async () => {
    mocks.capabilities.add('orders:take');
    const run = vi.fn().mockResolvedValue({ orderId: 'should-not-exist' });
    const route = terminalCommandRoute(schema, run, 201);

    const response = await route(request('DELIVERY'));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'This operator lacks the "customers:read" capability.',
    });
    expect(run).not.toHaveBeenCalled();
  });
});
