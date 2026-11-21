import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  capabilities: new Set<string>(),
  ctx: {
    state: 'UNLOCKED',
    organizationId: 'org-1',
    session: { id: 'session-1', activeStaffProfileId: 'staff-cashier' },
    device: { id: 'device-1', branchId: 'branch-1', kind: 'POS' },
    db: { restaurantOrder: { findFirst: vi.fn() }, restaurantTerminalSession: { update: vi.fn() } },
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
import { mintPosComposerProof } from './pos-composer-proof';

const schema = z
  .object({
    channel: z.enum(['DINE_IN', 'TAKEAWAY', 'DELIVERY']),
    customerId: z.string().optional(),
  })
  .strict();

function request(
  channel: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY',
  proof = mintPosComposerProof({
    organizationId: 'org-1',
    branchId: 'branch-1',
    deviceId: 'device-1',
    sessionId: 'session-1',
    staffProfileId: 'staff-cashier',
  })
) {
  return new Request('https://tenant.test/api/restaurant/orders/open', {
    method: 'POST',
    headers: {
      'Idempotency-Key': 'open-1',
      'Content-Type': 'application/json',
      ...(proof ? { 'X-POS-Composer-Proof': proof } : {}),
    },
    body: JSON.stringify({
      channel,
      ...(channel === 'DELIVERY' ? { customerId: 'customer-1' } : {}),
    }),
  });
}

beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', 'terminal-order-test-secret');
  mocks.capabilities.clear();
  mocks.ctx.db.restaurantTerminalSession.update.mockClear();
  mocks.ctx.device.kind = 'POS';
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
    expect(mocks.ctx.db.restaurantTerminalSession.update).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      data: { activeStaffProfileId: null },
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
    expect(mocks.ctx.db.restaurantTerminalSession.update).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      data: { activeStaffProfileId: null },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', ''],
    ['invalid', 'not-a-signed-proof'],
    [
      'wrong operator',
      () =>
        mintPosComposerProof({
          organizationId: 'org-1',
          branchId: 'branch-1',
          deviceId: 'device-1',
          sessionId: 'session-1',
          staffProfileId: 'staff-manager',
        }),
    ],
  ])('rejects a %s composer proof before capability checks', async (_label, proofValue) => {
    mocks.capabilities.add('orders:take');
    const run = vi.fn();
    const route = terminalCommandRoute(schema, run, 201);
    const proof = typeof proofValue === 'function' ? proofValue() : proofValue;

    const response = await route(request('DINE_IN', proof));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Missing or invalid POS composer proof.',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('allows an attributed online KDS command without a POS offline-composer proof', async () => {
    mocks.ctx.device.kind = 'KDS';
    mocks.capabilities.add('orders:take');
    const run = vi.fn().mockResolvedValue({ ticketId: 'ticket-1' });
    const route = terminalCommandRoute(schema, run, 200, { composerProof: 'POS_ONLY' });

    const response = await route(request('DINE_IN', ''));

    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ staffProfileId: 'staff-cashier' }),
      })
    );
  });
});
