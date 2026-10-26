import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn<typeof import('@/lib/abac').can>(async () => true),
  annotateAudit: vi.fn(),
  hasModule: vi.fn(() => true),
  explodeRecipe: vi.fn(),
  computeRecipeCost: vi.fn(),
  postStockMovements: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.hasModule,
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
  explodeRecipeInDb: mocks.explodeRecipe,
  computeRecipeCost: mocks.computeRecipeCost,
}));
vi.mock('@/lib/restaurant/inventory-ledger', () => ({
  postStockMovements: mocks.postStockMovements,
}));

import { Prisma } from '@/generated/prisma/client';
import { router, type TRPCContext } from '../trpc';
import { restaurantCateringRouter } from './restaurant-catering';

function makeDb(status = 'DRAFT') {
  const order = { id: 'order_1', organizationId: 'org_1', branchId: 'branch_1', status };
  const requirement = {
    ingredientId: 'rice',
    ingredientName: 'Rice',
    baseUnitId: 'gram',
    stockItemId: 'stock_rice',
    quantityInBaseUnit: '1000',
    unitCost: '0.01',
    costSource: 'REFERENCE',
  };
  const snapshot = {
    schemaVersion: 1,
    currency: 'PKR',
    quotedTotal: '100',
    headcount: 10,
    bookingStartsAt: '2026-10-08T10:00:00Z',
    bookingEndsAt: '2026-10-08T11:00:00Z',
    fulfillmentMode: 'PICKUP',
    stockLocationId: 'location_1',
    missing: [],
    extraCosts: [],
    requirements: [requirement],
    lines: [{ id: 'line_1', portions: '4', requirements: [requirement] }],
  };
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: {
          permissions: [
            { capability: 'catering:read', effect: 'ALLOW' },
            { capability: 'catering:manage', effect: 'ALLOW' },
          ],
        },
        permissionOverrides: [],
      }),
    },
    restaurantUnit: {
      findMany: vi.fn().mockResolvedValue([{ id: 'gram', name: 'Gram', abbreviation: 'g' }]),
    },
    restaurantStaffProfile: {
      findMany: vi.fn().mockResolvedValue([{ id: 'staff_1', primaryBranchId: 'branch_1' }]),
    },
    restaurantBranch: {
      findMany: vi.fn(async ({ where }: { where?: { id?: { in?: string[] } } }) =>
        (where?.id?.in ?? []).map((id) => ({ id }))
      ),
    },
    restaurantBranchAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    restaurantStockItem: { findFirst: vi.fn().mockResolvedValue({ id: 'stock_rice' }) },
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
    restaurantStockLocation: {
      findFirst: vi.fn().mockResolvedValue({ id: 'location_1' }),
      findMany: vi.fn().mockResolvedValue([{ id: 'location_1', name: 'Kitchen' }]),
    },
    restaurantInventoryIdempotencyKey: { findFirst: vi.fn().mockResolvedValue(null) },
    restaurantStockMovement: { findMany: vi.fn().mockResolvedValue([]) },
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn(async (query: Prisma.Sql): Promise<Record<string, unknown>[]> => {
      const sql = query.strings.join('?');
      if (sql.includes('SELECT "bookingStartsAt"'))
        return [
          {
            revision: 0,
            approvedQuoteRevisionId: 'quote_1',
            confirmedQuoteRevisionId: ['IN_PRODUCTION', 'READY', 'CONFIRMED', 'DELIVERED'].includes(
              status
            )
              ? 'quote_1'
              : null,
            bookingStartsAt: new Date(snapshot.bookingStartsAt),
            bookingEndsAt: new Date(snapshot.bookingEndsAt),
            fulfillmentMode: 'PICKUP',
            stockLocationId: 'location_1',
          },
        ];
      if (sql.includes('FROM restaurant_catering_quote_revisions'))
        return [{ id: 'quote_1', revision: 0, snapshot, contentHash: 'hash' }];
      if (sql.includes('FROM restaurant_catering_quote_approvals')) return [{ id: 'approval_1' }];
      if (sql.includes('FROM restaurant_catering_branch_capacity'))
        return [{ maxConcurrentHeadcount: 100 }];
      if (sql.includes('SELECT id,"bookingStartsAt"'))
        return [
          {
            ...order,
            headcount: 10,
            bookingStartsAt: new Date(snapshot.bookingStartsAt),
            bookingEndsAt: new Date(snapshot.bookingEndsAt),
          },
        ];
      return [];
    }),
  };
  return Object.assign(db, {
    $transaction: vi.fn(async (fn: (tx: typeof db) => unknown) => fn(db)),
  });
}

let db = makeDb();

function caller(role = 'ADMIN') {
  return router({ restaurantCatering: restaurantCateringRouter }).createCaller({
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
      user: { id: 'user_1', role, department: 'OPERATIONS', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).restaurantCatering;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.hasModule.mockReturnValue(true);
  mocks.explodeRecipe.mockResolvedValue({
    recipeId: 'recipe_1',
    recipeVersionId: 'v1',
    ingredients: [],
  });
  mocks.computeRecipeCost.mockResolvedValue({
    costPerPortion: new Prisma.Decimal('2.5'),
    missing: [],
  });
  mocks.postStockMovements.mockResolvedValue({ movements: [], replayed: false });
  db = makeDb();
});

describe('restaurant catering capability and scope', () => {
  it('booking locations allow a catering-only role while denying inventory and cross-branch access', async () => {
    const { can, subjectFromSession } =
      await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
    mocks.can.mockImplementation(can);
    const client = caller('EMPLOYEE');
    await expect(client.bookingLocations({ branchId: 'branch_1' })).resolves.toEqual([
      { id: 'location_1', name: 'Kitchen' },
    ]);
    expect(db.restaurantStockLocation.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { organizationId: 'org_1', branchId: 'branch_1', isActive: true },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const subject = subjectFromSession({ id: 'user_1', role: 'EMPLOYEE', status: 'ACTIVE' });
    await expect(
      can(subject, 'inventory:read', undefined, { db: db as unknown as TRPCContext['db'] })
    ).resolves.toBe(false);
    await expect(
      can(subject, 'reports:operational', undefined, { db: db as unknown as TRPCContext['db'] })
    ).resolves.toBe(false);
    await expect(client.bookingLocations({ branchId: 'other_branch' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.restaurantStockLocation.findMany).toHaveBeenCalledTimes(1);
  });

  it('booking locations reject missing capability, module, actor and extraneous scope input', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().bookingLocations({ branchId: 'branch_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    mocks.can.mockResolvedValue(true);
    mocks.hasModule.mockReturnValue(false);
    await expect(caller().bookingLocations({ branchId: 'branch_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    mocks.hasModule.mockReturnValue(true);
    db.restaurantStaffProfile.findMany.mockResolvedValue([]);
    await expect(caller().bookingLocations({ branchId: 'branch_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    db.restaurantStaffProfile.findMany.mockResolvedValue([
      { id: 'staff_1', primaryBranchId: 'branch_1' },
    ]);
    await expect(
      caller().bookingLocations({ branchId: 'branch_1', organizationId: 'foreign' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.restaurantStockLocation.findMany).not.toHaveBeenCalled();
  });
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

  it.each([
    { portions: '1', unitPrice: '1.999' },
    { portions: '1.2345', unitPrice: '1.99' },
  ])('rejects line decimals beyond their durable database scale', async (decimals) => {
    await expect(
      caller().addLine({
        orderId: 'order_1',
        recipeId: 'recipe_1',
        description: 'Precision test',
        ...decimals,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.restaurantCateringOrderLine.create).not.toHaveBeenCalled();
  });

  it.each([{ portions: '1.2345' }, { unitPrice: '1.999' }])(
    'rejects line updates beyond their durable database scale',
    async (decimals) => {
      await expect(
        caller().updateLine({ orderId: 'order_1', lineId: 'line_1', ...decimals })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(db.restaurantCateringOrderLine.updateMany).not.toHaveBeenCalled();
    }
  );

  it('preserves values at the durable database scale', async () => {
    await caller().addLine({
      orderId: 'order_1',
      recipeId: 'recipe_1',
      description: 'Precision test',
      portions: '1.234',
      unitPrice: '1.99',
    });

    const data = db.restaurantCateringOrderLine.create.mock.calls[0]?.[0].data as {
      portions: Prisma.Decimal;
      unitPrice: Prisma.Decimal;
    };
    expect(data.portions.toString()).toBe('1.234');
    expect(data.unitPrice.toString()).toBe('1.99');
  });

  it('preserves money values at the durable database scale', async () => {
    await caller().create({
      branchId: 'branch_1',
      eventName: 'Precision test',
      eventDate: new Date('2026-10-08'),
      headcount: 1,
      quotedTotal: '12.34',
      depositAmount: '5.67',
    });
    await caller().addExtraCost({
      orderId: 'order_1',
      kind: 'OTHER',
      label: 'Precision test',
      amount: '1.23',
    });

    const order = db.restaurantCateringOrder.create.mock.calls[0]?.[0].data as {
      quotedTotal: Prisma.Decimal;
      depositAmount: Prisma.Decimal;
    };
    const extraCost = db.restaurantCateringExtraCost.create.mock.calls[0]?.[0].data as {
      amount: Prisma.Decimal;
    };
    expect(order.quotedTotal.toString()).toBe('12.34');
    expect(order.depositAmount.toString()).toBe('5.67');
    expect(extraCost.amount.toString()).toBe('1.23');
  });

  it('rejects excess money precision on every order write before persistence', async () => {
    await expect(
      caller().create({
        branchId: 'branch_1',
        eventName: 'Precision test',
        eventDate: new Date('2026-10-08'),
        headcount: 1,
        quotedTotal: '1.001',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().create({
        branchId: 'branch_1',
        eventName: 'Precision test',
        eventDate: new Date('2026-10-08'),
        headcount: 1,
        depositAmount: '1.001',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().update({ orderId: 'order_1', quotedTotal: '1.001' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().update({ orderId: 'order_1', depositAmount: '1.001' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.restaurantCateringOrder.create).not.toHaveBeenCalled();
    expect(db.restaurantCateringOrder.update).not.toHaveBeenCalled();
  });

  it('rejects excess precision for extra costs before persistence', async () => {
    await expect(
      caller().addExtraCost({
        orderId: 'order_1',
        kind: 'OTHER',
        label: 'Precision test',
        amount: '1.001',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.restaurantCateringExtraCost.create).not.toHaveBeenCalled();
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
      expect.objectContaining({
        ingredientId: 'rice',
        quantityInBaseUnit: '1500',
        baseUnit: { id: 'gram', name: 'Gram', abbreviation: 'g' },
      }),
    ]);
  });

  it('labels frozen requirements by their recorded base unit without recalculating recipes', async () => {
    db = makeDb('CONFIRMED');
    await expect(caller().productionRequirements({ orderId: 'order_1' })).resolves.toEqual([
      expect.objectContaining({
        baseUnitId: 'gram',
        quantityInBaseUnit: '1000',
        baseUnit: { id: 'gram', name: 'Gram', abbreviation: 'g' },
      }),
    ]);
    expect(db.restaurantUnit.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', id: { in: ['gram'] } },
      select: { id: true, name: true, abbreviation: true },
    });
    db.restaurantUnit.findMany.mockResolvedValue([]);
    await expect(caller().productionRequirements({ orderId: 'order_1' })).resolves.toEqual([
      expect.objectContaining({ baseUnitId: 'gram', quantityInBaseUnit: '1000', baseUnit: null }),
    ]);
    expect(mocks.explodeRecipe).not.toHaveBeenCalled();
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
      costBasis: 'ESTIMATED',
      missing: [],
      ingredientCost: '50',
      grossMargin: '40',
      actualCost: null,
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
            unitId: 'gram',
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
      return {
        id: 'order_1',
        organizationId: 'org_1',
        branchId: 'branch_1',
        status: persistedStatus,
      };
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

  it('cancellation preserves consumed stock until explicit physical disposition (October 7 policy)', async () => {
    db = makeDb('READY');
    await caller().transition({ orderId: 'order_1', to: 'CANCELLED' });
    expect(mocks.postStockMovements).not.toHaveBeenCalled();
    expect(db.restaurantCateringOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'CANCELLED' } })
    );
  });
  it('rejects a forged actor', async () => {
    await expect(
      caller().transition({ orderId: 'order_1', to: 'QUOTED', actorStaffProfileId: 'forged' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.restaurantCateringOrder.update).not.toHaveBeenCalled();
  });
  it('denies a staff member without branch assignment or global configure capability', async () => {
    db.restaurantStaffProfile.findMany.mockResolvedValue([
      { id: 'staff_1', primaryBranchId: 'other' },
    ]);
    mocks.can.mockImplementation(async (_subject, action) => action !== 'restaurant:configure');
    await expect(caller().get({ orderId: 'order_1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('fails closed for missing active stock location without advancing READY', async () => {
    db = makeDb('IN_PRODUCTION');
    db.restaurantStockLocation.findFirst.mockResolvedValue(null);
    await expect(caller().transition({ orderId: 'order_1', to: 'READY' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(mocks.postStockMovements).not.toHaveBeenCalled();
    expect(db.restaurantCateringOrder.update).not.toHaveBeenCalled();
  });
  it('rejects edits to a confirmed menu', async () => {
    db = makeDb('CONFIRMED');
    await expect(
      caller().removeLine({ orderId: 'order_1', lineId: 'line_1' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.restaurantCateringOrderLine.deleteMany).not.toHaveBeenCalled();
  });
  it('does not change status or append success audit after ledger failure', async () => {
    db = makeDb('IN_PRODUCTION');
    mocks.postStockMovements.mockRejectedValueOnce(new Error('ledger failed'));
    await expect(caller().transition({ orderId: 'order_1', to: 'READY' })).rejects.toThrow(
      'ledger failed'
    );
    expect(db.restaurantCateringOrder.update).not.toHaveBeenCalled();
    expect(db.restaurantCateringEvent.create).not.toHaveBeenCalled();
  });
});

describe('catering continuation replay and denial', () => {
  it('denies an unlicensed package before querying tenant data', async () => {
    mocks.hasModule.mockReturnValue(false);
    await expect(caller().get({ orderId: 'order_1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.restaurantCateringOrder.findFirst).not.toHaveBeenCalled();
  });
  it('returns not-found for another tenant order', async () => {
    db.restaurantCateringOrder.findFirst.mockResolvedValue(null);
    await expect(caller().get({ orderId: 'foreign' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.restaurantCateringOrder.findFirst).toHaveBeenCalledWith({
      where: { id: 'foreign', organizationId: 'org_1' },
    });
  });
  it('replays identical keyed transition and conflicts on changed target', async () => {
    let saved: { payloadHash: string; result: Record<string, unknown> } | null = null;
    const raw = db.$queryRaw.getMockImplementation()!;
    db.$queryRaw.mockImplementation(async (query) =>
      query.strings.join('?').includes('FROM restaurant_catering_commands')
        ? saved
          ? [saved]
          : []
        : raw(query)
    );
    db.$executeRaw.mockImplementation(async (query: Prisma.Sql) => {
      if (query.strings.join('?').includes('INSERT INTO restaurant_catering_commands'))
        saved = {
          payloadHash: query.values[3] as string,
          result: JSON.parse(query.values[4] as string),
        };
      return 1;
    });
    const first = await caller().transition({
      orderId: 'order_1',
      to: 'QUOTED',
      idempotencyKey: 'retry',
    });
    expect(
      await caller().transition({ orderId: 'order_1', to: 'QUOTED', idempotencyKey: 'retry' })
    ).toEqual(first);
    expect(db.restaurantCateringOrder.update).toHaveBeenCalledOnce();
    await expect(
      caller().transition({ orderId: 'order_1', to: 'CANCELLED', idempotencyKey: 'retry' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('shares a branch lock across concurrent confirmations and rejects capacity overflow', async () => {
    db = makeDb('QUOTED');
    let reservations = 0;
    let queue = Promise.resolve();
    const raw = db.$queryRaw.getMockImplementation()!;
    db.$queryRaw.mockImplementation(async (query) => {
      if (query.strings.join('?').includes('FROM restaurant_catering_branch_capacity'))
        return [{ maxConcurrentHeadcount: 10 }];
      const rows = await raw(query);
      if (query.strings.join('?').includes('SELECT id,"bookingStartsAt"') && reservations)
        return [...rows, ...rows];
      return rows;
    });
    db.restaurantCateringOrder.update.mockImplementation(async ({ data }) => {
      reservations++;
      return {
        id: 'order_1',
        organizationId: 'org_1',
        branchId: 'branch_1',
        status: 'CONFIRMED',
        ...data,
      };
    });
    db.$transaction.mockImplementation(async (work) => {
      const result = queue.then(() => work(db));
      queue = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    });
    const result = await Promise.allSettled([
      caller().transition({ orderId: 'order_1', to: 'CONFIRMED' }),
      caller().transition({ orderId: 'order_2', to: 'CONFIRMED' }),
    ]);
    expect(result.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(reservations).toBe(1);
    const locks = db.$queryRaw.mock.calls
      .filter(([q]) => q.strings.join('?').includes('pg_advisory_xact_lock'))
      .flatMap(([q]) => q.values);
    expect(locks.filter((value) => value === 'catering:branch:org_1:branch_1')).toHaveLength(2);
  });
});
