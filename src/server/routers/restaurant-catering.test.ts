import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn<(subject: unknown, action: unknown) => Promise<boolean>>(async () => true),
  annotateAudit: vi.fn(),
  explodeRecipe: vi.fn(),
  computeRecipeCost: vi.fn(),
  postStockMovements: vi.fn(),
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
vi.mock('@/lib/restaurant/recipe-costing', () => ({
  explodeRecipe: mocks.explodeRecipe,
  computeRecipeCost: mocks.computeRecipeCost,
}));
vi.mock('@/lib/restaurant/inventory-ledger', () => ({
  postStockMovements: mocks.postStockMovements,
}));

import { Prisma } from '@/generated/prisma/client';
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
      findMany: vi.fn().mockResolvedValue([]),
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
    restaurantStockLocation: { findFirst: vi.fn().mockResolvedValue({ id: 'location_1' }) },
    restaurantInventoryIdempotencyKey: { findFirst: vi.fn().mockResolvedValue(null) },
    restaurantStockMovement: { findMany: vi.fn().mockResolvedValue([]) },
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
  mocks.explodeRecipe.mockResolvedValue({
    recipeId: 'recipe_1',
    recipeVersionId: 'v1',
    ingredients: [],
  });
  mocks.computeRecipeCost.mockResolvedValue({ costPerPortion: new Prisma.Decimal('2.5') });
  mocks.postStockMovements.mockResolvedValue({ movements: [], replayed: false });
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

describe('restaurant catering production and cost', () => {
  it('groups exploded requirements by ingredient in base units', async () => {
    db.restaurantCateringOrderLine.findMany.mockResolvedValue([
      { recipeId: 'recipe_1', portions: new Prisma.Decimal(10) },
      { recipeId: 'recipe_2', portions: new Prisma.Decimal(5) },
    ]);
    mocks.explodeRecipe
      .mockResolvedValueOnce({
        recipeId: 'recipe_1',
        recipeVersionId: 'v1',
        ingredients: [
          {
            ingredientId: 'rice',
            ingredientName: 'Rice',
            baseUnitId: 'gram',
            stockItemId: 'stock_rice',
            quantityInBaseUnit: new Prisma.Decimal(1000),
          },
        ],
      })
      .mockResolvedValueOnce({
        recipeId: 'recipe_2',
        recipeVersionId: 'v2',
        ingredients: [
          {
            ingredientId: 'rice',
            ingredientName: 'Rice',
            baseUnitId: 'gram',
            stockItemId: 'stock_rice',
            quantityInBaseUnit: new Prisma.Decimal(500),
          },
        ],
      });

    await expect(caller().productionRequirements({ orderId: 'order_1' })).resolves.toEqual([
      expect.objectContaining({ ingredientId: 'rice', quantityInBaseUnit: '1500' }),
    ]);
  });

  it('summarizes recipe and extra costs against the quote', async () => {
    db.restaurantCateringOrder.findFirst.mockResolvedValue({
      id: 'order_1',
      quotedTotal: new Prisma.Decimal(100),
      extraCosts: [{ amount: new Prisma.Decimal(10) }],
    });
    db.restaurantCateringOrderLine.findMany.mockResolvedValue([
      {
        id: 'line_1',
        recipeId: 'recipe_1',
        portions: new Prisma.Decimal(20),
        costPerPortionSnapshot: null,
      },
    ]);

    await expect(caller().costSummary({ orderId: 'order_1' })).resolves.toEqual({
      recipeCost: '50',
      extraCost: '10',
      totalCost: '60',
      quotedTotal: '100',
      margin: '40',
      marginPercent: '40',
    });
  });

  it('snapshots recipe cost per portion on confirmation', async () => {
    db = makeDb('QUOTED');
    db.restaurantCateringOrderLine.findMany.mockResolvedValue([
      {
        id: 'line_1',
        recipeId: 'recipe_1',
        portions: new Prisma.Decimal(4),
        costPerPortionSnapshot: null,
      },
    ]);

    await caller().transition({ orderId: 'order_1', to: 'CONFIRMED' });
    expect(db.restaurantCateringOrderLine.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { costPerPortionSnapshot: new Prisma.Decimal('2.5') } })
    );
  });

  it('posts idempotent consumption when production becomes ready', async () => {
    db = makeDb('IN_PRODUCTION');
    db.restaurantCateringOrderLine.findMany.mockResolvedValue([
      { recipeId: 'recipe_1', portions: new Prisma.Decimal(10) },
    ]);
    mocks.explodeRecipe.mockResolvedValue({
      recipeId: 'recipe_1',
      recipeVersionId: 'v1',
      ingredients: [
        {
          ingredientId: 'rice',
          ingredientName: 'Rice',
          baseUnitId: 'gram',
          stockItemId: 'stock_rice',
          quantityInBaseUnit: new Prisma.Decimal(1000),
        },
      ],
    });

    await caller().transition({ orderId: 'order_1', to: 'READY' });
    expect(mocks.postStockMovements).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        commandType: 'catering.ready',
        actor: expect.objectContaining({ idempotencyKey: 'catering:order_1:consumption' }),
        movements: [
          expect.objectContaining({
            reason: 'RECIPE_CONSUMPTION',
            quantity: new Prisma.Decimal(-1000),
          }),
        ],
      })
    );
  });

  it('serializes concurrent ready transitions and posts consumption once', async () => {
    db = makeDb('IN_PRODUCTION');
    let persistedStatus = 'IN_PRODUCTION';
    let queue = Promise.resolve();
    db.restaurantCateringOrder.findFirst.mockImplementation(async () => ({
      id: 'order_1',
      organizationId: 'org_1',
      branchId: 'branch_1',
      status: persistedStatus,
    }));
    db.restaurantCateringOrder.update.mockImplementation(async ({ data }: { data: object }) => {
      persistedStatus = (data as { status?: string }).status ?? persistedStatus;
      return { id: 'order_1', organizationId: 'org_1', status: persistedStatus };
    });
    db.$transaction.mockImplementation(async (work) => {
      const result = queue.then(() => work(db));
      queue = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    });
    db.restaurantCateringOrderLine.findMany.mockResolvedValue([
      { recipeId: 'recipe_1', portions: new Prisma.Decimal(1) },
    ]);
    mocks.explodeRecipe.mockResolvedValue({
      recipeId: 'recipe_1',
      recipeVersionId: 'v1',
      ingredients: [
        {
          ingredientId: 'rice',
          ingredientName: 'Rice',
          baseUnitId: 'gram',
          stockItemId: 'stock_rice',
          quantityInBaseUnit: new Prisma.Decimal(100),
        },
      ],
    });

    const outcomes = await Promise.allSettled([
      caller().transition({ orderId: 'order_1', to: 'READY' }),
      caller().transition({ orderId: 'order_1', to: 'READY' }),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(mocks.postStockMovements).toHaveBeenCalledOnce();
  });

  it('reverses the exact posted consumption when a ready order is cancelled', async () => {
    db = makeDb('READY');
    db.restaurantInventoryIdempotencyKey.findFirst.mockResolvedValue({ resultRef: 'movement_1' });
    db.restaurantStockMovement.findMany.mockResolvedValue([
      {
        stockItemId: 'stock_rice',
        locationId: 'location_1',
        quantity: new Prisma.Decimal(-1000),
      },
    ]);

    await caller().transition({ orderId: 'order_1', to: 'CANCELLED' });
    expect(mocks.postStockMovements).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        commandType: 'catering.cancel.reversal',
        actor: expect.objectContaining({ idempotencyKey: 'catering:order_1:reversal' }),
        movements: [
          expect.objectContaining({ reason: 'SALE_REVERSAL', quantity: new Prisma.Decimal(1000) }),
        ],
      })
    );
  });
});
