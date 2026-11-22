import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  grants: new Set<string>(),
  operatorHasCapability: vi.fn(),
  attachCustomerToOrder: vi.fn(),
  orderFindFirst: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/restaurant/checkout-routes', () => ({
  operatorHasCapability: mocks.operatorHasCapability,
}));
vi.mock('@/lib/restaurant/customers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/restaurant/customers')>(
    '@/lib/restaurant/customers'
  );
  return { ...actual, attachCustomerToOrder: mocks.attachCustomerToOrder };
});
vi.mock('@/lib/restaurant/terminal-auth', () => ({
  withTerminalAuth:
    (handler: (ctx: unknown, request: Request) => Promise<Response>) => (request: Request) =>
      handler(
        {
          db: {
            restaurantOrder: { findFirst: mocks.orderFindFirst },
            restaurantTerminalSession: { update: mocks.updateSession },
          },
          session: { id: 'session_1' },
          device: { branchId: 'branch_1' },
        },
        request
      ),
}));
vi.mock('@/lib/restaurant/terminal-orders', () => ({
  idempotencyKeyFromRequest: () => null,
  invalidBody: () => new Response(null, { status: 400 }),
  requireActingOperator: () => ({ ok: true, staffProfileId: 'staff_1' }),
}));

import { POST } from './route';

function request() {
  return new Request('https://tenant.test/api/restaurant/orders/customer/attach', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId: 'order_1', customerId: 'customer_1' }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.grants.clear();
  mocks.operatorHasCapability.mockImplementation(async (_db, _staffProfileId, capability) =>
    mocks.grants.has(capability)
  );
  mocks.orderFindFirst.mockResolvedValue({ id: 'order_1' });
  mocks.attachCustomerToOrder.mockResolvedValue({
    id: 'order_1',
    branchId: 'branch_1',
    customerId: 'customer_1',
    status: 'OPEN',
  });
});

describe('POST customer attach capability', () => {
  it('denies a read-only operator before attaching', async () => {
    mocks.grants.add('customers:read');

    const response = await POST(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'This operator lacks the "customers:manage" capability.',
    });
    expect(mocks.operatorHasCapability).toHaveBeenCalledWith(
      expect.anything(),
      'staff_1',
      'customers:manage',
      expect.any(Date),
      'branch_1'
    );
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(mocks.orderFindFirst).not.toHaveBeenCalled();
    expect(mocks.attachCustomerToOrder).not.toHaveBeenCalled();
  });

  it('allows a manager and derives branch scope from the device', async () => {
    mocks.grants.add('customers:manage');

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      orderId: 'order_1',
      branchId: 'branch_1',
      customerId: 'customer_1',
      status: 'OPEN',
    });
    expect(mocks.orderFindFirst).toHaveBeenCalledWith({
      where: { id: 'order_1', branchId: 'branch_1' },
      select: { id: true },
    });
    expect(mocks.attachCustomerToOrder).toHaveBeenCalledWith(expect.anything(), {
      orderId: 'order_1',
      customerId: 'customer_1',
    });
  });
});
