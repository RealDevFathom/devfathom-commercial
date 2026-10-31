/**
 * M4-L2 router — capability gating/wiring, strict inputs, the C10 read model
 * (order list / order detail / kitchen tickets) and money-as-string serialization.
 * Runs the REAL router against a hand-rolled in-memory db; the ABAC decision,
 * entitlement check and audit writer are mocked (platform middleware), and the
 * command layer is stubbed so mutation tests assert the router's wiring, not the
 * transactional command internals (those are covered by the command-layer tests).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

const D = (v: string) => new Prisma.Decimal(v);

const mocks = vi.hoisted(() => ({
  can: vi.fn<typeof import('@/lib/abac').can>(() => Promise.resolve(true)),
  userFindUnique: vi.fn(),
  annotateAudit: vi.fn(),
  orderFindMany: vi.fn(),
  orderFindUnique: vi.fn(),
  ticketFindMany: vi.fn(),
  openOrder: vi.fn(),
  closeOrder: vi.fn(),
  sendOrder: vi.fn(),
  voidItem: vi.fn(),
  cancelOrder: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: mocks.annotateAudit,
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/lib/restaurant/orders', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/restaurant/orders')>('@/lib/restaurant/orders');
  return {
    ...actual,
    openOrder: mocks.openOrder,
    closeOrder: mocks.closeOrder,
    sendOrder: mocks.sendOrder,
    voidItem: mocks.voidItem,
    cancelOrder: mocks.cancelOrder,
  };
});

import { restaurantOrdersRouter } from './restaurant-orders';
import { OrderCommandError } from '@/lib/restaurant/orders';
import type { TRPCContext } from '../trpc';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { roleTemplatesForVertical } from '@/lib/vertical-catalog';

const db = {
  user: { findUnique: mocks.userFindUnique },
  restaurantOrder: { findMany: mocks.orderFindMany, findUnique: mocks.orderFindUnique },
  restaurantKitchenTicket: { findMany: mocks.ticketFindMany },
  restaurantBranch: {
    findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
      (where.id?.in ?? []).map((id) => ({ id }))
    ),
  },
} as unknown as ScopedDb;

function caller() {
  return restaurantOrdersRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_1',
      enabledModules: ['restaurant-pos'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
    },
    session: {
      expires: 'later',
      user: { id: 'user_gm', role: 'EMPLOYEE', department: 'OPERATIONS', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

const ACTOR = { staffProfileId: 'staff_1', deviceId: 'dev_1', idempotencyKey: 'key_1' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.orderFindMany.mockResolvedValue([]);
  mocks.ticketFindMany.mockResolvedValue([]);
});

describe('read model (C10)', () => {
  it('keeps historical DELIVERY orders readable through the channel filter', async () => {
    mocks.orderFindMany.mockResolvedValue([]);

    await caller().listOrders({ branchId: 'b1', channel: 'DELIVERY' });

    expect(mocks.orderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ channel: 'DELIVERY' }) })
    );
  });

  it('lists orders with a derived, string-serialized subtotal and pagination cursor', async () => {
    mocks.orderFindMany.mockResolvedValue([
      {
        id: 'o1',
        orderNumber: 1,
        businessDate: new Date('2026-08-19T00:00:00.000Z'),
        status: 'OPEN',
        channel: 'DINE_IN',
        coverCount: 2,
        sectionId: null,
        serverStaffProfileId: null,
        createdAt: new Date(),
        items: [
          { unitPrice: D('10.00'), quantity: 2, modifiers: [{ priceDelta: D('1.50') }] },
          { unitPrice: D('4.00'), quantity: 1, modifiers: [] },
        ],
        orderTables: [{ tableId: 't1', table: { code: 'T1' } }],
      },
    ]);
    const result = await caller().listOrders({ branchId: 'b1' });
    // (10 + 1.5) * 2 + 4 * 1 = 27
    expect(result.orders[0].subtotal).toBe('27');
    expect(typeof result.orders[0].subtotal).toBe('string');
    expect(result.orders[0].activeTableIds).toEqual(['t1']);
    expect(result.orders[0].activeTables).toEqual([{ id: 't1', code: 'T1' }]);
    expect(mocks.orderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          orderTables: {
            where: { active: true },
            select: { tableId: true, table: { select: { code: true } } },
          },
        }),
      })
    );
    expect(result.orders[0].itemCount).toBe(2);
    expect(result.nextCursor).toBeNull();
  });

  it('returns a nextCursor when a full page + 1 is fetched', async () => {
    const row = (id: string) => ({
      id,
      orderNumber: 1,
      businessDate: new Date('2026-08-19T00:00:00.000Z'),
      status: 'OPEN',
      channel: 'DINE_IN',
      coverCount: null,
      sectionId: null,
      serverStaffProfileId: null,
      createdAt: new Date(),
      items: [],
      orderTables: [],
    });
    mocks.orderFindMany.mockResolvedValue([row('a'), row('b'), row('c')]);
    const result = await caller().listOrders({ branchId: 'b1', limit: 2 });
    expect(result.orders).toHaveLength(2);
    expect(result.nextCursor).toBe('b');
  });

  it('serializes every monetary field of an order as a string and derives totals', async () => {
    mocks.orderFindUnique.mockResolvedValue({
      id: 'o1',
      branchId: 'b1',
      orderNumber: 7,
      businessDate: new Date('2026-08-19T00:00:00.000Z'),
      status: 'SENT',
      channel: 'DINE_IN',
      coverCount: null,
      sectionId: null,
      serverStaffProfileId: null,
      staffProfileId: 'staff_1',
      deviceId: 'dev_1',
      publicationId: 'pub_1',
      priceListVersionId: 'plv_1',
      openedAt: new Date(),
      closedAt: null,
      cancelledAt: null,
      items: [
        {
          id: 'i1',
          course: 1,
          seatNumber: null,
          productId: 'p1',
          variantId: null,
          name: 'Burger',
          unitPrice: D('10.00'),
          quantity: 1,
          taxAmount: D('0'),
          serviceChargeAmount: D('0'),
          status: 'QUEUED',
          remakeOfItemId: null,
          voidedPostPrep: false,
          wastageDisposition: null,
          voidReason: null,
          modifiers: [
            { id: 'm1', modifierOptionId: 'opt1', name: 'Cheese', priceDelta: D('1.50') },
          ],
        },
      ],
      orderTables: [],
      events: [],
      kitchenTickets: [],
    });
    const order = await caller().getOrder({ orderId: 'o1' });
    expect(order.items[0].unitPrice).toBe('10');
    expect(order.items[0].modifiers[0].priceDelta).toBe('1.5');
    expect(order.totals.subtotal).toBe('11.5');
    expect(order.totals.tax).toBe('0');
  });

  it('throws NOT_FOUND for a missing order', async () => {
    mocks.orderFindUnique.mockResolvedValue(null);
    await expect(caller().getOrder({ orderId: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('shapes kitchen tickets with their linked item state', async () => {
    mocks.ticketFindMany.mockResolvedValue([
      {
        id: 'tk1',
        orderId: 'o1',
        stationId: 'grill',
        businessDate: new Date('2026-08-19T00:00:00.000Z'),
        ticketNumber: 1,
        createdAt: new Date(),
        order: { orderNumber: 7 },
        items: [
          {
            orderItemId: 'i1',
            quantity: 2,
            orderItem: { name: 'Burger', status: 'FIRING', course: 1, seatNumber: 3 },
          },
        ],
      },
    ]);
    const result = await caller().listKitchenTickets({ branchId: 'b1' });
    expect(result.tickets[0].items[0]).toMatchObject({
      name: 'Burger',
      status: 'FIRING',
      quantity: 2,
    });
  });
});

describe('capability gating + strict inputs', () => {
  it('gates reads on orders:read', async () => {
    await caller().listOrders({ branchId: 'b1' });
    expect(mocks.can.mock.calls.some((c) => c[1] === 'orders:read')).toBe(true);
  });

  it('gates mutations on orders:manage', async () => {
    mocks.closeOrder.mockResolvedValue({ orderId: 'o1', replayed: false });
    await caller().close({ orderId: 'o1', actor: ACTOR });
    expect(mocks.can.mock.calls.some((c) => c[1] === 'orders:manage')).toBe(true);
  });

  it('allows order cancellation with orders:void rather than orders:manage', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'orders:void');
    mocks.cancelOrder.mockResolvedValue({ orderId: 'o1', replayed: false });

    await expect(
      caller().cancel({ orderId: 'o1', reason: 'Guest request', actor: ACTOR })
    ).resolves.toMatchObject({ orderId: 'o1' });
    expect(mocks.can.mock.calls.some((call) => call[1] === 'orders:void')).toBe(true);
    expect(mocks.can.mock.calls.some((call) => call[1] === 'orders:manage')).toBe(false);
  });

  it('does not allow orders:manage to substitute for orders:void when cancelling', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'orders:manage');

    await expect(
      caller().cancel({ orderId: 'o1', reason: 'Guest request', actor: ACTOR })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.can.mock.calls.some((call) => call[1] === 'orders:void')).toBe(true);
    expect(mocks.cancelOrder).not.toHaveBeenCalled();
  });

  it('rejects unknown input fields (strict)', async () => {
    await expect(
      // @ts-expect-error — surplus field must be rejected, never stripped
      caller().getOrder({ orderId: 'o1', surplus: true })
    ).rejects.toBeDefined();
  });
});

describe('cancellation through real ABAC middleware', () => {
  const permissionsFor = (key: string) =>
    roleTemplatesForVertical('RESTAURANT')
      .find((role) => role.key === key)!
      .capabilities.map((capability) => ({ capability, effect: 'ALLOW' as const }));

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
    mocks.can.mockImplementation(actual.can);
    mocks.cancelOrder.mockResolvedValue({ orderId: 'o1', replayed: false });
  });

  it.each(['owner', 'general-manager', 'branch-manager'])(
    'allows the %s template through the tenant-scoped permission lookup',
    async (role) => {
      mocks.userFindUnique.mockResolvedValue({
        organizationRole: { permissions: permissionsFor(role) },
        permissionOverrides: [],
      });

      await expect(
        caller().cancel({ orderId: 'o1', reason: 'Guest request', actor: ACTOR })
      ).resolves.toMatchObject({ orderId: 'o1' });
      expect(mocks.can).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user_gm' }),
        'orders:void',
        undefined,
        expect.objectContaining({ db })
      );
      expect(mocks.userFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'user_gm' } })
      );
      expect(mocks.cancelOrder).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ orderId: 'o1', reason: 'Guest request' })
      );
    }
  );

  it.each(['owner', 'general-manager', 'branch-manager'])(
    'honors an explicit orders:void deny for the %s template',
    async (role) => {
      mocks.userFindUnique.mockResolvedValue({
        organizationRole: { permissions: permissionsFor(role) },
        permissionOverrides: [{ capability: 'orders:void', effect: 'DENY' }],
      });

      await expect(
        caller().cancel({ orderId: 'o1', reason: 'Guest request', actor: ACTOR })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.cancelOrder).not.toHaveBeenCalled();
    }
  );

  it.each([
    { permissions: [] },
    { permissions: [{ capability: 'orders:manage', effect: 'ALLOW' }] },
  ])('denies cancellation without an orders:void grant ($permissions)', async ({ permissions }) => {
    mocks.userFindUnique.mockResolvedValue({
      organizationRole: { permissions },
      permissionOverrides: [],
    });

    await expect(
      caller().cancel({ orderId: 'o1', reason: 'Guest request', actor: ACTOR })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.cancelOrder).not.toHaveBeenCalled();
  });
});

describe('mutation wiring', () => {
  it('delegates open and maps the business date to YYYY-MM-DD', async () => {
    mocks.openOrder.mockResolvedValue({
      orderId: 'o9',
      orderNumber: 3,
      businessDate: new Date('2026-08-19T00:00:00.000Z'),
      replayed: false,
    });
    const result = await caller().open({ branchId: 'b1', channel: 'DINE_IN', actor: ACTOR });
    expect(mocks.openOrder).toHaveBeenCalledOnce();
    expect(result.orderId).toBe('o9');
    expect(result.businessDate).toBe('2026-08-19');
    expect(mocks.annotateAudit).toHaveBeenCalled();
  });

  it('refuses to open an order on a branch outside the session organization', async () => {
    vi.mocked(db.restaurantBranch.findMany).mockResolvedValueOnce([]);
    await expect(
      caller().open({ branchId: 'other_org_branch', channel: 'DINE_IN', actor: ACTOR })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That record is not in this workspace.',
    });
    expect(mocks.openOrder).not.toHaveBeenCalled();
  });

  it('rejects delivery at the tRPC schema before command or audit work', async () => {
    await expect(
      // @ts-expect-error — deliberate bypass attempt against the operational schema
      caller().open({ branchId: 'b1', channel: 'DELIVERY', actor: ACTOR })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.openOrder).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });

  it('serializes fired-ticket results', async () => {
    mocks.sendOrder.mockResolvedValue({
      orderId: 'o1',
      itemIds: ['i1'],
      tickets: [{ ticketId: 'tk1', stationId: 'grill', ticketNumber: 1, matchedBy: 'default' }],
      replayed: false,
    });
    const result = await caller().send({ orderId: 'o1', actor: ACTOR });
    expect(result.tickets[0]).toMatchObject({ ticketNumber: 1, matchedBy: 'default' });
  });

  it('maps a domain error to the right tRPC status', async () => {
    mocks.voidItem.mockRejectedValue(
      new OrderCommandError('post-prep needs co-auth', 'CO_AUTH_REQUIRED')
    );
    await expect(
      caller().voidItem({ orderId: 'o1', itemId: 'i1', reason: 'bad', actor: ACTOR })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('maps a terminal-state conflict to CONFLICT', async () => {
    mocks.closeOrder.mockRejectedValue(new OrderCommandError('already closed', 'ORDER_TERMINAL'));
    await expect(caller().close({ orderId: 'o1', actor: ACTOR })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('maps a post-cut item void to CONFLICT', async () => {
    mocks.voidItem.mockRejectedValue(
      new OrderCommandError('void and recut the bill first', 'BILL_ALREADY_CUT')
    );
    await expect(
      caller().voidItem({ orderId: 'o1', itemId: 'i1', reason: 'changed mind', actor: ACTOR })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
