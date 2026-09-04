import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn<(subject: unknown, action: unknown) => Promise<boolean>>(async () => true),
  annotateAudit: vi.fn(),
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
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});

import type { TRPCContext } from '../trpc';
import { restaurantCateringRouter } from './restaurant-catering';

function makeDb(status = 'DRAFT') {
  const order = { id: 'order_1', organizationId: 'org_1', status };
  const db = {
    restaurantCateringOrder: {
      findFirst: vi.fn().mockResolvedValue(order),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(order),
      update: vi.fn(async ({ data }: { data: object }) => ({ ...order, ...data })),
    },
    restaurantCateringOrderLine: {
      create: vi.fn(async ({ data }: { data: object }) => ({ id: 'line_1', ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    restaurantCateringExtraCost: {
      create: vi.fn(async ({ data }: { data: object }) => ({ id: 'cost_1', ...data })),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    restaurantCateringDelivery: { upsert: vi.fn() },
    restaurantCateringEvent: {
      aggregate: vi.fn().mockResolvedValue({ _max: { sequence: 0 } }),
      create: vi.fn(),
    },
    $queryRaw: vi.fn(),
  };
  return Object.assign(db, {
    $transaction: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)),
  });
}

let db = makeDb();

function caller() {
  return restaurantCateringRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_1',
      enabledModules: ['restaurant-core'],
      activeSeats: 1,
      seatLimit: 5,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: { id: 'user_1', role: 'ADMIN', department: 'OPERATIONS', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  db = makeDb();
});

describe('restaurant catering capability and scope', () => {
  it('gates reads and writes on distinct catering capabilities', async () => {
    await caller().list({ branchId: 'branch_1' });
    await caller().addLine({
      orderId: 'order_1',
      recipeId: 'recipe_1',
      description: 'Buffet rice',
      portions: '40',
      unitPrice: '5.00',
    });
    expect(mocks.can.mock.calls.some((call) => call[1] === 'catering:read')).toBe(true);
    expect(mocks.can.mock.calls.some((call) => call[1] === 'catering:manage')).toBe(true);
  });

  it('always scopes list queries to the active organization', async () => {
    await caller().list({ branchId: 'branch_1', status: 'CONFIRMED' });
    expect(db.restaurantCateringOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org_1', branchId: 'branch_1' }),
      })
    );
  });
});

describe('restaurant catering lifecycle', () => {
  it('writes a durable event for the next forward transition', async () => {
    await caller().transition({ orderId: 'order_1', to: 'QUOTED' });
    expect(db.restaurantCateringOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'QUOTED' } })
    );
    expect(db.restaurantCateringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'STATUS_TRANSITIONED', sequence: 1 }),
      })
    );
  });

  it('rejects skipped forward transitions without changing the order', async () => {
    await expect(caller().transition({ orderId: 'order_1', to: 'READY' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(db.restaurantCateringOrder.update).not.toHaveBeenCalled();
  });

  it('allows cancellation from a non-terminal state', async () => {
    await caller().transition({ orderId: 'order_1', to: 'CANCELLED' });
    expect(db.restaurantCateringOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'CANCELLED' } })
    );
  });

  it('requires a product or recipe for every new line', async () => {
    await expect(
      caller().addLine({
        orderId: 'order_1',
        description: 'Unlinked item',
        portions: '1',
        unitPrice: '1.00',
      })
    ).rejects.toBeDefined();
  });
});
