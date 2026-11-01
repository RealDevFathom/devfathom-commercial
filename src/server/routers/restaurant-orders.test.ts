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
  can: vi.fn<(subject: unknown, action: unknown) => Promise<boolean>>(() => Promise.resolve(true)),
  annotateAudit: vi.fn(),
  orderFindMany: vi.fn(),
  orderFindUnique: vi.fn(),
  ticketFindMany: vi.fn(),
  openOrder: vi.fn(),
  closeOrder: vi.fn(),
  sendOrder: vi.fn(),
  voidItem: vi.fn(),
  cancelOrder: vi.fn(),
  staffFindMany: vi.fn(),
  queryRawUnsafe: vi.fn(),
  authenticateOperator: vi.fn(),
  operatorHasCapability: vi.fn(),
  withTenantDb: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(() => ({})),
  withTenantDb: mocks.withTenantDb,
}));
vi.mock('@/lib/restaurant/terminal-auth', () => ({
  authenticateOperator: mocks.authenticateOperator,
}));
vi.mock('@/lib/restaurant/checkout-routes', () => ({
  operatorHasCapability: mocks.operatorHasCapability,
}));
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
import { buildCoAuthorizationRecord } from '@/lib/restaurant/co-authorization';
import type { TRPCContext } from '../trpc';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const db = {
  restaurantOrder: { findMany: mocks.orderFindMany, findUnique: mocks.orderFindUnique },
  restaurantKitchenTicket: { findMany: mocks.ticketFindMany },
  restaurantStaffProfile: { findMany: mocks.staffFindMany },
  $queryRawUnsafe: mocks.queryRawUnsafe,
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
  // The session user (`user_gm`) has exactly one ACTIVE staff profile.
  mocks.staffFindMany.mockResolvedValue([{ id: 'staff_1' }]);
  mocks.queryRawUnsafe.mockResolvedValue([]);
  mocks.withTenantDb.mockImplementation(
    async (_organizationId: string, work: (tx: unknown) => unknown) => work(db)
  );
  mocks.authenticateOperator.mockResolvedValue({ ok: true, staffProfileId: 'mgr_1' });
  mocks.operatorHasCapability.mockResolvedValue(true);
  mocks.orderFindUnique.mockResolvedValue({ branchId: 'branch_1' });
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
    expect(result.orders[0].itemCount).toBe(3);
    expect(result.nextCursor).toBeNull();
    expect(mocks.orderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          items: expect.objectContaining({
            where: { status: { not: 'VOIDED' }, remakeOfItemId: null },
          }),
        }),
      })
    );
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
        {
          id: 'i1-remake-1',
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
          remakeOfItemId: 'i1',
          voidedPostPrep: false,
          wastageDisposition: null,
          voidReason: null,
          modifiers: [],
        },
        {
          id: 'i1-remake-2',
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
          remakeOfItemId: 'i1-remake-1',
          voidedPostPrep: false,
          wastageDisposition: null,
          voidReason: null,
          modifiers: [],
        },
      ],
      orderTables: [],
      events: [],
      kitchenTickets: [],
    });
    const order = await caller().getOrder({ orderId: 'o1' });
    expect(order.items[0].unitPrice).toBe('10');
    expect(order.items[0].modifiers[0].priceDelta).toBe('1.5');
    expect(order.items.map((item) => item.remakeOfItemId)).toEqual([null, 'i1', 'i1-remake-1']);
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

  it('rejects unknown input fields (strict)', async () => {
    await expect(
      // @ts-expect-error — surplus field must be rejected, never stripped
      caller().getOrder({ orderId: 'o1', surplus: true })
    ).rejects.toBeDefined();
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

  it('maps opening an order on a closed day to CONFLICT', async () => {
    mocks.openOrder.mockRejectedValueOnce(
      new OrderCommandError('This business day is closed; no order can be opened.', 'DAY_CLOSED')
    );
    await expect(
      caller().open({ branchId: 'b1', channel: 'DINE_IN', actor: ACTOR })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'This business day is closed; no order can be opened.',
    });
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

// ── H5: back-office void/cancel maker-checker ─────────────────────────────────

describe('void/cancel approver authentication (H5)', () => {
  const POST_PREP_VOID = {
    orderId: 'o1',
    itemId: 'i1',
    reason: 'Burnt',
    wastageDisposition: 'WASTE' as const,
    actor: ACTOR,
  };
  const PIN = { type: 'PIN' as const, secret: '4821' };

  beforeEach(() => {
    mocks.voidItem.mockResolvedValue({ itemId: 'i1', replayed: false });
    mocks.cancelOrder.mockResolvedValue({ orderId: 'o1', replayed: false });
  });

  it('refuses a caller-supplied approver id with no credential', async () => {
    await expect(
      caller().voidItem({ ...POST_PREP_VOID, approvingStaffProfileId: 'mgr_1' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().cancel({
        orderId: 'o1',
        reason: 'Walkout',
        approvingStaffProfileId: 'mgr_1',
        actor: ACTOR,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.authenticateOperator).not.toHaveBeenCalled();
    expect(mocks.voidItem).not.toHaveBeenCalled();
    expect(mocks.cancelOrder).not.toHaveBeenCalled();
  });

  it.each(['INVALID', 'LOCKED', 'REVOKED'])(
    'refuses a %s approver credential with one uniform answer',
    async (reason) => {
      mocks.authenticateOperator.mockResolvedValue({ ok: false, reason });
      await expect(
        caller().voidItem({
          ...POST_PREP_VOID,
          approvingStaffProfileId: 'mgr_1',
          approvingCredential: { type: 'PIN', secret: '0000' },
        })
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Approving credential is invalid or locked.',
      });
      expect(mocks.voidItem).not.toHaveBeenCalled();
    }
  );

  it('refuses an approver without coauth:approve at the order branch, with the same answer', async () => {
    mocks.operatorHasCapability.mockResolvedValue(false);
    await expect(
      caller().cancel({
        orderId: 'o1',
        reason: 'Walkout',
        approvingStaffProfileId: 'mgr_1',
        approvingCredential: PIN,
        actor: ACTOR,
      })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Approving credential is invalid or locked.',
    });
    expect(mocks.operatorHasCapability).toHaveBeenCalledWith(
      db,
      'mgr_1',
      'coauth:approve',
      expect.any(Date),
      'branch_1'
    );
    expect(mocks.cancelOrder).not.toHaveBeenCalled();
  });

  it('verifies the approver credential in an independent, row-locked tenant transaction', async () => {
    await caller().voidItem({
      ...POST_PREP_VOID,
      approvingStaffProfileId: 'mgr_1',
      approvingCredential: PIN,
    });
    expect(mocks.withTenantDb).toHaveBeenCalledWith('org_1', expect.any(Function));
    expect(mocks.queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('FOR UPDATE'),
      'mgr_1',
      'PIN'
    );
    expect(mocks.authenticateOperator).toHaveBeenCalledWith(db, {
      staffProfileId: 'mgr_1',
      type: 'PIN',
      secret: '4821',
      now: expect.any(Date),
    });
  });

  it('records the session actor and the credential-verified approver, ignoring a forged actor', async () => {
    await caller().voidItem({
      ...POST_PREP_VOID,
      approvingStaffProfileId: 'mgr_1',
      approvingCredential: PIN,
      actor: { ...ACTOR, staffProfileId: 'victim' },
    });
    expect(mocks.voidItem).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        approvingStaffProfileId: 'mgr_1',
        actor: { staffProfileId: 'staff_1', deviceId: 'dev_1', idempotencyKey: 'key_1' },
      })
    );
    expect(mocks.annotateAudit).toHaveBeenCalledWith(expect.anything(), { skipInput: true });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({ approvalMode: 'SECOND_OPERATOR' }),
      })
    );
  });

  it('cancels with a credential-verified approver attributed to the session actor', async () => {
    await caller().cancel({
      orderId: 'o1',
      reason: 'Walkout',
      approvingStaffProfileId: 'mgr_1',
      approvingCredential: { type: 'BADGE', secret: 'badge-1' },
      actor: { ...ACTOR, staffProfileId: 'victim' },
    });
    expect(mocks.cancelOrder).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        approvingStaffProfileId: 'mgr_1',
        actor: expect.objectContaining({ staffProfileId: 'staff_1' }),
      })
    );
  });

  it('attributes an unapproved (pre-prep) void to the session actor', async () => {
    await caller().voidItem({
      orderId: 'o1',
      itemId: 'i1',
      reason: 'Changed mind',
      actor: { ...ACTOR, staffProfileId: 'victim' },
    });
    expect(mocks.voidItem).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        approvingStaffProfileId: null,
        actor: expect.objectContaining({ staffProfileId: 'staff_1' }),
      })
    );
    expect(mocks.authenticateOperator).not.toHaveBeenCalled();
  });

  it.each([{ profiles: [] }, { profiles: [{ id: 'a' }, { id: 'b' }] }])(
    'fails closed without a unique active session staff profile',
    async ({ profiles }) => {
      mocks.staffFindMany.mockResolvedValue(profiles);
      await expect(
        caller().voidItem({
          ...POST_PREP_VOID,
          approvingStaffProfileId: 'mgr_1',
          approvingCredential: PIN,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.voidItem).not.toHaveBeenCalled();
    }
  );

  it('returns NOT_FOUND for an order outside the tenant before checking credentials', async () => {
    mocks.orderFindUnique.mockResolvedValue(null);
    await expect(
      caller().voidItem({
        ...POST_PREP_VOID,
        approvingStaffProfileId: 'mgr_1',
        approvingCredential: PIN,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.authenticateOperator).not.toHaveBeenCalled();
  });

  describe('sole-owner self-approval', () => {
    const owner = { id: 'staff_1', user: { organizationRole: { key: 'owner' } }, jobRoles: [] };
    function staffRoster(roster: unknown[]) {
      mocks.staffFindMany.mockImplementation(async (args: { select?: { user?: unknown } }) =>
        // `isSoloOwner` selects the user's role; the session lookup selects only ids.
        args?.select?.user ? roster : [{ id: 'staff_1' }]
      );
    }
    let recorded: ReturnType<typeof buildCoAuthorizationRecord> | null;

    beforeEach(() => {
      recorded = null;
      mocks.authenticateOperator.mockResolvedValue({ ok: true, staffProfileId: 'staff_1' });
      // Run the real co-authorization primitive the command layer would call, so
      // the test proves the solo proof reaches the persisted record.
      mocks.voidItem.mockImplementation(
        async (
          _db: unknown,
          input: {
            approvingStaffProfileId: string;
            reason: string;
            itemId: string;
            actor: { staffProfileId: string; deviceId: string };
          }
        ) => {
          recorded = buildCoAuthorizationRecord({
            actingStaffProfileId: input.actor.staffProfileId,
            approvingStaffProfileId: input.approvingStaffProfileId,
            capability: 'orders:void',
            reason: input.reason,
            targetType: 'RestaurantOrderItem',
            targetId: input.itemId,
            deviceId: input.actor.deviceId,
          });
          return { itemId: input.itemId, replayed: false };
        }
      );
    });

    it('lets the only active staff member, an owner, approve after a fresh PIN', async () => {
      staffRoster([owner]);
      await caller().voidItem({
        ...POST_PREP_VOID,
        approvingStaffProfileId: 'staff_1',
        approvingCredential: PIN,
      });
      expect(recorded).toMatchObject({
        actingStaffProfileId: 'staff_1',
        approvingStaffProfileId: 'staff_1',
        reason: 'Burnt [Owner PIN reauthentication]',
        terminalSessionId: null,
      });
      expect(mocks.annotateAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          metadata: expect.objectContaining({ approvalMode: 'OWNER_PIN_REAUTHENTICATION' }),
        })
      );
    });

    it('refuses a solo owner whose PIN is wrong', async () => {
      staffRoster([owner]);
      mocks.authenticateOperator.mockResolvedValue({ ok: false, reason: 'INVALID' });
      await expect(
        caller().voidItem({
          ...POST_PREP_VOID,
          approvingStaffProfileId: 'staff_1',
          approvingCredential: { type: 'PIN', secret: '0000' },
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.voidItem).not.toHaveBeenCalled();
    });

    it('refuses self-approval once a second active staff member exists', async () => {
      staffRoster([owner, { id: 'staff_2', user: null, jobRoles: [] }]);
      await expect(
        caller().cancel({
          orderId: 'o1',
          reason: 'Walkout',
          approvingStaffProfileId: 'staff_1',
          approvingCredential: PIN,
          actor: ACTOR,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.cancelOrder).not.toHaveBeenCalled();
    });

    it('refuses self-approval by badge (a PIN re-entry is required)', async () => {
      staffRoster([owner]);
      await expect(
        caller().voidItem({
          ...POST_PREP_VOID,
          approvingStaffProfileId: 'staff_1',
          approvingCredential: { type: 'BADGE', secret: 'badge-1' },
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.authenticateOperator).not.toHaveBeenCalled();
      expect(mocks.voidItem).not.toHaveBeenCalled();
    });

    it('refuses self-approval by a sole staff member who is not an owner', async () => {
      staffRoster([{ ...owner, user: { organizationRole: { key: 'cashier' } } }]);
      await expect(
        caller().voidItem({
          ...POST_PREP_VOID,
          approvingStaffProfileId: 'staff_1',
          approvingCredential: PIN,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.voidItem).not.toHaveBeenCalled();
    });
  });
});
