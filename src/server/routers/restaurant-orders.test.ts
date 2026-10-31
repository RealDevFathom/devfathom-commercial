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
  assignmentsFindMany: vi.fn(),
  deviceFindFirst: vi.fn(),
  deviceFindMany: vi.fn(),
  authenticateOperator: vi.fn(),
  operatorHasCapability: vi.fn(),
  credentialLock: vi.fn(),
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
import type { TRPCContext } from '../trpc';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const db = {
  restaurantStaffProfile: { findMany: mocks.staffFindMany },
  restaurantBranchAssignment: { findMany: mocks.assignmentsFindMany },
  restaurantRegisteredDevice: { findFirst: mocks.deviceFindFirst, findMany: mocks.deviceFindMany },
  restaurantOrder: { findMany: mocks.orderFindMany, findUnique: mocks.orderFindUnique },
  restaurantKitchenTicket: { findMany: mocks.ticketFindMany },
  restaurantBranch: {
    findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
      (where.id?.in ?? []).map((id) => ({ id }))
    ),
  },
} as unknown as ScopedDb;

function caller(scopedDb: ScopedDb = db) {
  return restaurantOrdersRouter.createCaller({
    db: scopedDb,
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
  mocks.orderFindUnique.mockResolvedValue({ branchId: 'b1' });
  mocks.staffFindMany.mockResolvedValue([
    {
      id: 'staff_1',
      primaryBranchId: 'b1',
      jobRoles: [],
      directCapabilityGrants: [],
    },
  ]);
  mocks.assignmentsFindMany.mockResolvedValue([]);
  mocks.deviceFindFirst.mockResolvedValue({ id: 'dev_1' });
  mocks.deviceFindMany.mockResolvedValue([]);
  mocks.authenticateOperator.mockResolvedValue({ ok: true, staffProfileId: 'manager_1' });
  mocks.operatorHasCapability.mockResolvedValue(true);
  mocks.withTenantDb.mockImplementation(async (_org, work) =>
    work({ $queryRaw: mocks.credentialLock })
  );
  mocks.cancelOrder.mockResolvedValue({ orderId: 'o1', replayed: false });
  mocks.ticketFindMany.mockResolvedValue([]);
});

describe('cancellation authorization and device directory', () => {
  const approval = {
    approvingStaffProfileId: 'manager_1',
    approvingType: 'PIN' as const,
    approvingSecret: '482913',
  };
  const input = { orderId: 'o1', reason: 'Guest request', actor: ACTOR };

  it('denies cancellation without orders:void even with orders:manage', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'orders:manage');
    await expect(caller().cancel(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.cancelOrder).not.toHaveBeenCalled();
  });

  it('rejects a bare approver ID before command or credential work', async () => {
    await expect(
      caller().cancel({ ...input, approvingStaffProfileId: 'waiter_1' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.authenticateOperator).not.toHaveBeenCalled();
    expect(mocks.cancelOrder).not.toHaveBeenCalled();
  });

  it('rejects an approver without authority at the order branch', async () => {
    mocks.operatorHasCapability.mockResolvedValue(false);
    await expect(caller().cancel({ ...input, ...approval })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.operatorHasCapability).toHaveBeenCalledWith(
      db,
      'manager_1',
      'coauth:approve',
      expect.any(Date),
      'b1'
    );
    expect(mocks.authenticateOperator).not.toHaveBeenCalled();
    expect(mocks.cancelOrder).not.toHaveBeenCalled();
  });

  it.each([
    ['INVALID', 'FORBIDDEN'],
    ['LOCKED', 'TOO_MANY_REQUESTS'],
  ])('rejects %s approval without cancelling', async (reason, code) => {
    mocks.authenticateOperator.mockResolvedValue({ ok: false, reason });
    await expect(caller().cancel({ ...input, ...approval })).rejects.toMatchObject({ code });
    expect(mocks.withTenantDb).toHaveBeenCalledWith('org_1', expect.any(Function), {
      userId: 'user_gm',
      skipDrain: true,
    });
    expect(mocks.credentialLock).toHaveBeenCalledOnce();
    expect(mocks.cancelOrder).not.toHaveBeenCalled();
  });

  it('binds the actor to the session and verifies approval before delegation', async () => {
    await caller().cancel({
      ...input,
      ...approval,
      actor: { ...ACTOR, staffProfileId: 'spoofed_actor' },
    });
    expect(mocks.authenticateOperator).toHaveBeenCalledWith(expect.anything(), {
      staffProfileId: 'manager_1',
      type: 'PIN',
      secret: '482913',
      now: expect.any(Date),
    });
    expect(mocks.cancelOrder).toHaveBeenCalledWith(db, {
      orderId: 'o1',
      reason: 'Guest request',
      actor: ACTOR,
      approvingStaffProfileId: 'manager_1',
      wastageDisposition: undefined,
    });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(expect.anything(), { skipInput: true });
  });

  it('rejects self-approval even when a different acting identity is supplied', async () => {
    await expect(
      caller().cancel({
        ...input,
        ...approval,
        approvingStaffProfileId: 'staff_1',
        actor: { ...ACTOR, staffProfileId: 'waiter_1' },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.authenticateOperator).not.toHaveBeenCalled();
    expect(mocks.cancelOrder).not.toHaveBeenCalled();
  });

  it.each(['waiter', 'inactive', 'other-branch', 'explicit-deny'])(
    'rejects %s approval using the real branch capability resolver',
    async (scenario) => {
      const { operatorHasCapability } = await vi.importActual<
        typeof import('@/lib/restaurant/checkout-routes')
      >('@/lib/restaurant/checkout-routes');
      mocks.operatorHasCapability.mockImplementation(operatorHasCapability);
      const approvalDb = {
        ...db,
        restaurantStaffProfile: {
          ...db.restaurantStaffProfile,
          findUnique: vi.fn(async () => ({
            status: scenario === 'inactive' ? 'INACTIVE' : 'ACTIVE',
            primaryBranchId: scenario === 'other-branch' ? 'b2' : 'b1',
            jobRoles: [],
            directCapabilityGrants: [],
            user: null,
          })),
        },
        restaurantStaffJobRole: {
          findMany: vi.fn(async () =>
            scenario === 'waiter'
              ? []
              : [
                  {
                    jobRole: { capabilities: [{ capability: 'coauth:approve' }] },
                  },
                ]
          ),
        },
        restaurantStaffCapabilityGrant: {
          findMany: vi.fn(async () =>
            scenario === 'explicit-deny' ? [{ capability: 'coauth:approve', effect: 'DENY' }] : []
          ),
        },
      } as unknown as ScopedDb;
      await expect(caller(approvalDb).cancel({ ...input, ...approval })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(mocks.cancelOrder).not.toHaveBeenCalled();
    }
  );

  it.each(['PIN', 'BADGE'] as const)(
    'requires organization-wide %s approval despite the selected device credential',
    async (type) => {
      const { hash } = await import('bcryptjs');
      const { authenticateOperator } = await vi.importActual<
        typeof import('@/lib/restaurant/terminal-auth')
      >('@/lib/restaurant/terminal-auth');
      mocks.authenticateOperator.mockImplementation(authenticateOperator);
      const orgSecret = type === 'PIN' ? '482913' : 'org-manager-badge';
      const deviceSecret = type === 'PIN' ? '729184' : 'device-manager-badge';
      const deviceCredential = {
        id: 'credential_device',
        deviceId: 'dev_1',
        credentialHash: await hash(deviceSecret, 4),
        failedAttempts: 0,
        lockedUntil: null,
      };
      const orgCredential = {
        ...deviceCredential,
        id: 'credential_org',
        deviceId: null,
        credentialHash: await hash(orgSecret, 4),
      };
      const credentials: (typeof deviceCredential | typeof orgCredential)[] = [deviceCredential];
      const authDb = {
        $queryRaw: mocks.credentialLock,
        restaurantStaffProfile: {
          findUnique: vi.fn(async () => ({
            id: 'manager_1',
            status: 'ACTIVE',
            primaryBranchId: 'b1',
          })),
        },
        restaurantOperatorCredential: {
          // Return both scopes to exercise the real verifier's credential selection.
          findMany: vi.fn(async () => credentials),
          update: vi.fn(),
        },
      };
      mocks.withTenantDb.mockImplementation(async (_org, work) => work(authDb));

      await expect(
        caller().cancel({
          ...input,
          ...approval,
          approvingType: type,
          approvingSecret: deviceSecret,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.cancelOrder).not.toHaveBeenCalled();

      credentials.push(orgCredential);
      await expect(
        caller().cancel({ ...input, ...approval, approvingType: type, approvingSecret: orgSecret })
      ).resolves.toEqual({ orderId: 'o1', replayed: false });
      expect(authDb.restaurantOperatorCredential.findMany).toHaveBeenLastCalledWith({
        where: { staffProfileId: 'manager_1', type, revokedAt: null, deviceId: null },
      });
      expect(mocks.cancelOrder).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ actor: ACTOR, approvingStaffProfileId: 'manager_1' })
      );
    }
  );

  it('persists real PIN failures in the independent auth transaction and honors lockout', async () => {
    const { hash } = await import('bcryptjs');
    const { authenticateOperator } = await vi.importActual<
      typeof import('@/lib/restaurant/terminal-auth')
    >('@/lib/restaurant/terminal-auth');
    mocks.authenticateOperator.mockImplementation(authenticateOperator);
    const credential = {
      id: 'credential_1',
      deviceId: null,
      credentialHash: await hash('482913', 4),
      failedAttempts: 0,
      lockedUntil: null as Date | null,
    };
    const authDb = {
      $queryRaw: mocks.credentialLock,
      restaurantStaffProfile: {
        findUnique: vi.fn(async () => ({
          id: 'manager_1',
          status: 'ACTIVE',
          primaryBranchId: 'b1',
        })),
      },
      restaurantOperatorCredential: {
        findMany: vi.fn(async () => [credential]),
        update: vi.fn(async ({ data }: { data: Partial<typeof credential> }) =>
          Object.assign(credential, data)
        ),
      },
    };
    mocks.withTenantDb.mockImplementation(async (_org, work) => work(authDb));
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(
        caller().cancel({ ...input, ...approval, approvingSecret: '000000' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(credential.lockedUntil).toBeInstanceOf(Date);
    await expect(caller().cancel({ ...input, ...approval })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(authDb.restaurantOperatorCredential.update).toHaveBeenCalledTimes(5);
    expect(mocks.cancelOrder).not.toHaveBeenCalled();
    credential.lockedUntil = new Date(0);
    await expect(caller().cancel({ ...input, ...approval })).resolves.toEqual({
      orderId: 'o1',
      replayed: false,
    });
    expect(credential.lockedUntil).toBeNull();
    expect(mocks.cancelOrder).toHaveBeenCalledOnce();
  });

  it('rejects orders outside the acting staff branch', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'orders:void');
    mocks.orderFindUnique.mockResolvedValue({ branchId: 'other_branch' });
    await expect(caller().cancel(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.cancelOrder).not.toHaveBeenCalled();
  });

  it.each(['jobRoles', 'directCapabilityGrants'] as const)(
    'allows cancellation and device lookup at a secondary branch bound through %s',
    async (binding) => {
      mocks.can.mockImplementation(async (_subject, action) => action === 'orders:void');
      mocks.staffFindMany.mockResolvedValue([
        {
          id: 'staff_1',
          primaryBranchId: 'b1',
          jobRoles: binding === 'jobRoles' ? [{ branchId: 'b2' }] : [],
          directCapabilityGrants: binding === 'directCapabilityGrants' ? [{ branchId: 'b2' }] : [],
        },
      ]);
      mocks.orderFindUnique.mockResolvedValue({ branchId: 'b2' });

      await caller().listCancellationDevices({ branchId: 'b2' });
      await caller().cancel({
        ...input,
        actor: { ...ACTOR, staffProfileId: 'spoofed_actor' },
      });

      expect(mocks.staffFindMany).toHaveBeenCalledWith({
        where: { userId: 'user_gm', status: 'ACTIVE' },
        select: {
          id: true,
          primaryBranchId: true,
          jobRoles: { select: { branchId: true } },
          directCapabilityGrants: { select: { branchId: true } },
        },
        orderBy: { id: 'asc' },
        take: 2,
      });
      expect(mocks.deviceFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { branchId: 'b2', status: 'ACTIVE' } })
      );
      expect(mocks.deviceFindFirst).toHaveBeenCalledWith({
        where: { id: 'dev_1', branchId: 'b2', status: 'ACTIVE' },
        select: { id: true },
      });
      expect(mocks.cancelOrder).toHaveBeenCalledWith(db, expect.objectContaining({ actor: ACTOR }));

      mocks.orderFindUnique.mockResolvedValue({ branchId: 'b3' });
      await expect(caller().cancel(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(caller().listCancellationDevices({ branchId: 'b3' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(mocks.cancelOrder).toHaveBeenCalledOnce();
      expect(mocks.deviceFindMany).toHaveBeenCalledOnce();
    }
  );

  it('rejects a bound branch that is inactive or outside the session organization', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'orders:void');
    mocks.staffFindMany.mockResolvedValue([
      {
        id: 'staff_1',
        primaryBranchId: 'b1',
        jobRoles: [{ branchId: 'b2' }],
        directCapabilityGrants: [],
      },
    ]);
    mocks.orderFindUnique.mockResolvedValue({ branchId: 'b2' });
    const branchFindMany = vi.fn(async () => []);
    const scopedDb = {
      ...db,
      restaurantBranch: { findMany: branchFindMany },
    } as unknown as ScopedDb;

    await expect(caller(scopedDb).cancel(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller(scopedDb).listCancellationDevices({ branchId: 'b2' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(branchFindMany).toHaveBeenCalledWith({
      where: { id: { in: ['b2'] }, organizationId: 'org_1', active: true },
      select: { id: true },
    });
    expect(mocks.cancelOrder).not.toHaveBeenCalled();
    expect(mocks.deviceFindMany).not.toHaveBeenCalled();
  });

  it.each([0, 2])(
    'rejects cancellation and device lookup with %i active session actors',
    async (count) => {
      mocks.staffFindMany.mockResolvedValue(
        Array.from({ length: count }, (_, index) => ({
          id: `staff_${index}`,
          primaryBranchId: 'b1',
          jobRoles: [{ branchId: 'b2' }],
          directCapabilityGrants: [],
        }))
      );
      mocks.orderFindUnique.mockResolvedValue({ branchId: 'b2' });

      await expect(caller().cancel(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(caller().listCancellationDevices({ branchId: 'b2' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(mocks.cancelOrder).not.toHaveBeenCalled();
      expect(mocks.deviceFindMany).not.toHaveBeenCalled();
    }
  );

  it('rejects a revoked or out-of-branch device', async () => {
    mocks.deviceFindFirst.mockResolvedValue(null);
    await expect(caller().cancel(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.deviceFindFirst).toHaveBeenCalledWith({
      where: { id: 'dev_1', branchId: 'b1', status: 'ACTIVE' },
      select: { id: true },
    });
    expect(mocks.cancelOrder).not.toHaveBeenCalled();
  });

  it('lists only active device labels for a cancellation-authorized branch', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'orders:void');
    await caller().listCancellationDevices({ branchId: 'b1' });
    expect(mocks.deviceFindMany).toHaveBeenCalledWith({
      where: { branchId: 'b1', status: 'ACTIVE' },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, status: true, branch: { select: { id: true, name: true } } },
    });
    expect(mocks.can.mock.calls.some((call) => call[1] === 'devices:manage')).toBe(false);
  });

  it('denies device lookup for unauthorized branches', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'orders:void');
    await expect(
      caller().listCancellationDevices({ branchId: 'other_branch' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.deviceFindMany).not.toHaveBeenCalled();
  });
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
    expect(order.items.map((item) => item.remakeOfItemId)).toEqual([
      null,
      'i1',
      'i1-remake-1',
    ]);
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

  it('allows order cancellation with orders:void without requiring orders:manage', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action === 'orders:void');
    mocks.cancelOrder.mockResolvedValue({ orderId: 'o1', replayed: false });

    await caller().cancel({ orderId: 'o1', reason: 'Guest request', actor: ACTOR });

    expect(mocks.can.mock.calls.some((call) => call[1] === 'orders:void')).toBe(true);
    expect(mocks.can.mock.calls.some((call) => call[1] === 'orders:manage')).toBe(false);
    expect(mocks.cancelOrder).toHaveBeenCalledOnce();
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
