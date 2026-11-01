/**
 * M3-L2 router tests — capability gating, C2 shadow-copy guard (no branchId
 * accepted on canonical mutations), C4 Decimal serialization, and version
 * immutability routing. Runs the REAL router against a hand-rolled in-memory db;
 * ABAC, entitlements, and audit are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  annotateAudit: vi.fn(),
  computeRecipeCost: vi.fn(),
}));

vi.mock('@/lib/restaurant/recipe-costing', async () => {
  const actual = await vi.importActual<typeof import('@/lib/restaurant/recipe-costing')>(
    '@/lib/restaurant/recipe-costing'
  );
  return { ...actual, computeRecipeCost: mocks.computeRecipeCost };
});

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

import { restaurantCatalogRouter } from './restaurant-catalog';
import type { TRPCContext } from '../trpc';
import { Prisma } from '@/generated/prisma/client';
import { RecipeCostingError } from '@/lib/restaurant/recipe-costing';

// ── Minimal in-memory db ──────────────────────────────────────────────────────

type Delegate = Record<string, ReturnType<typeof vi.fn>>;

function model(): Delegate {
  return {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi
      .fn()
      .mockImplementation(async ({ where }: { where?: { id?: { in?: string[] } } } = {}) =>
        (where?.id?.in ?? []).map((id) => ({ id }))
      ),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'generated_id',
      ...data,
    })),
    update: vi
      .fn()
      .mockImplementation(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
          id: where.id,
          ...data,
        })
      ),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    delete: vi.fn().mockResolvedValue({}),
    upsert: vi.fn().mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
      id: 'generated_id',
      ...create,
    })),
  };
}

function makeDb() {
  const db: Record<string, Delegate | unknown> = {
    $queryRaw: vi.fn().mockResolvedValue([{ organizationId: 'org_1' }]),
    restaurantBrand: model(),
    restaurantCategory: model(),
    restaurantProduct: model(),
    restaurantProductVariant: model(),
    restaurantModifierGroup: model(),
    restaurantModifierOption: model(),
    restaurantProductModifierGroup: model(),
    restaurantComboComponentGroup: model(),
    restaurantComboComponentOption: model(),
    restaurantProductAllergen: model(),
    restaurantAllergen: model(),
    restaurantPriceList: model(),
    restaurantPriceListVersion: model(),
    restaurantPriceListEntry: model(),
    restaurantBranchMenuPublication: model(),
    restaurantMenuItem: model(),
    restaurantUnit: model(),
    restaurantUnitConversion: model(),
    restaurantIngredient: model(),
    restaurantIngredientAllergen: model(),
    restaurantRecipe: model(),
    restaurantRecipeVersion: model(),
    restaurantRecipeLine: model(),
  };
  (db as Record<string, unknown>).$transaction = vi.fn(async (fn: (tx: unknown) => unknown) =>
    fn(db)
  );
  return db;
}

let db: ReturnType<typeof makeDb>;

beforeEach(() => {
  db = makeDb();
  mocks.can.mockResolvedValue(true);
  mocks.annotateAudit.mockReset();
  mocks.computeRecipeCost.mockReset();
});

function caller(limits: Record<string, number> = { 'restaurant.brands.max': 5 }) {
  return restaurantCatalogRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_1',
      enabledModules: ['restaurant-menu'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
      limits,
    },
    session: {
      expires: 'later',
      user: {
        id: 'user_1',
        organizationId: 'org_1',
        role: 'EMPLOYEE',
        department: 'OPERATIONS',
        status: 'ACTIVE',
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('recipe picker reads', () => {
  it('lists organization recipes with only their active version summary', async () => {
    const recipes = db.restaurantRecipe as Delegate;
    recipes.findMany.mockResolvedValue([
      {
        id: 'recipe_1',
        name: 'Harvest lunch',
        versions: [{ id: 'version_2', portionCount: 24 }],
      },
    ]);

    await expect(caller().listRecipes()).resolves.toEqual([
      {
        id: 'recipe_1',
        name: 'Harvest lunch',
        activeVersionId: 'version_2',
        portionCount: 24,
      },
    ]);
    expect(recipes.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_1' },
      select: {
        id: true,
        name: true,
        versions: {
          where: { organizationId: 'org_1', status: 'ACTIVE' },
          select: { id: true, portionCount: true },
          take: 1,
        },
      },
      orderBy: { name: 'asc' },
    });
  });
});

// ── C2 shadow-copy guard — STRICT rejection of branch-scoped/shadow fields ─────
// The canonical creation schemas are `.strict()`: a branch-scoped or shadow-copy
// field is REJECTED (BAD_REQUEST at the schema edge), not silently stripped, and
// the db create is never reached. Branches cannot shadow-copy canonical records.

describe('C2 shadow-copy guard (strict canonical creation)', () => {
  it('createBrand rejects branch-scoped/shadow-copy fields (BAD_REQUEST)', async () => {
    (db.restaurantBrand as Delegate).count.mockResolvedValue(0);
    // A plain object (not a literal) carries the extra props past the compiler;
    // `.strict()` rejects them at runtime.
    const input = { name: 'Branch Shadow', branchId: 'branch_1', shadowCopyOfId: 'brand_root' };
    await expect(caller().createBrand(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect((db.restaurantBrand as Delegate).create).not.toHaveBeenCalled();
  });

  it('createProduct rejects shadow-copy fields (BAD_REQUEST)', async () => {
    const input = { name: 'Shadow Burger', sourceCanonicalId: 'product_root' };
    await expect(caller().createProduct(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect((db.restaurantProduct as Delegate).create).not.toHaveBeenCalled();
  });

  it('createProduct still writes no branchId for a clean input', async () => {
    (db.restaurantCategory as Delegate).findUnique.mockResolvedValue({ id: 'cat1' });
    await caller().createProduct({ name: 'Burger', categoryId: 'cat1' });
    const createCall = (db.restaurantProduct as Delegate).create.mock.calls[0][0];
    expect(createCall.data).not.toHaveProperty('branchId');
  });
});

describe('createBrand commercial limit resolution', () => {
  it('uses the explicit ceiling and the bootstrapped alias', async () => {
    (db.restaurantBrand as Delegate).count.mockResolvedValue(1);
    await expect(
      caller({ 'restaurant.brands.max': 1 }).createBrand({ name: 'Explicit' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      caller({ 'restaurant-core.restaurant.brands.max': 1 }).createBrand({ name: 'Alias' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('preserves explicit zero precedence over a positive alias', async () => {
    await expect(
      caller({
        'restaurant.brands.max': 0,
        'restaurant-core.restaurant.brands.max': 5,
      }).createBrand({ name: 'Disabled' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((db.restaurantBrand as Delegate).create).not.toHaveBeenCalled();
  });

  it.each<Record<string, number>>([
    {},
    { 'restaurant.brands.max': -1 },
    { 'restaurant.brands.max': 1.5 },
    { 'restaurant.brands.max': Number.NaN },
  ])('fails closed for missing or invalid limits', async (limits) => {
    await expect(caller(limits).createBrand({ name: 'Blocked' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'The restaurant brand entitlement is not configured correctly.',
    });
    expect((db.restaurantBrand as Delegate).count).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied tenant ownership', async () => {
    const input = { name: 'Foreign', organizationId: 'org_other' };
    await expect(caller().createBrand(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect((db.restaurantBrand as Delegate).create).not.toHaveBeenCalled();
  });
});

// ── Product localization round-trip through the router ────────────────────────

describe('createProduct localization round-trip', () => {
  it('persists and returns nameLocalized/descriptionLocalized', async () => {
    const nameLocalized = { 'ar-SA': 'شاي' };
    const descriptionLocalized = { 'ar-SA': 'شاي ساخن' };
    const result = await caller().createProduct({
      name: 'Tea',
      nameLocalized,
      description: 'Hot tea',
      descriptionLocalized,
    });
    expect(result).toMatchObject({ nameLocalized, descriptionLocalized });
    const createData = (db.restaurantProduct as Delegate).create.mock.calls[0][0].data;
    expect(createData.nameLocalized).toEqual(nameLocalized);
    expect(createData.descriptionLocalized).toEqual(descriptionLocalized);
  });
});

// ── Historical + list read models (GOV-2 / console read-contract) ─────────────

describe('read models', () => {
  it('registers getRecipeVersion as a procedure', () => {
    expect(Object.keys(restaurantCatalogRouter._def.procedures)).toContain('getRecipeVersion');
  });

  it('getRecipeVersion reads a SUPERSEDED version and serializes yieldQuantity (C4)', async () => {
    (db.restaurantRecipeVersion as Delegate).findUnique.mockResolvedValue({
      id: 'v1',
      recipeId: 'r1',
      status: 'SUPERSEDED',
      versionNumber: 1,
      yieldQuantity: new Prisma.Decimal('2.5'),
      notes: 'original',
    });
    const result = await caller().getRecipeVersion({ id: 'v1' });
    expect(result).toMatchObject({ id: 'v1', status: 'SUPERSEDED', notes: 'original' });
    expect(result?.yieldQuantity).toBe('2.5');
  });

  it('listRecipeVersions serializes each version yield and obeys the recipe scope', async () => {
    (db.restaurantRecipe as Delegate).findUnique.mockResolvedValue({ id: 'r1' });
    (db.restaurantRecipeVersion as Delegate).findMany.mockResolvedValue([
      {
        id: 'v2',
        recipeId: 'r1',
        status: 'ACTIVE',
        versionNumber: 2,
        yieldQuantity: new Prisma.Decimal('3'),
      },
      { id: 'v1', recipeId: 'r1', status: 'SUPERSEDED', versionNumber: 1, yieldQuantity: null },
    ]);
    const result = await caller().listRecipeVersions({ recipeId: 'r1' });
    expect(result?.map((v) => v.id)).toEqual(['v2', 'v1']);
    expect(result?.[0]?.yieldQuantity).toBe('3');
    expect(result?.[1]?.yieldQuantity).toBeNull();
  });

  it('listProducts passes filters and the console include shape', async () => {
    (db.restaurantProduct as Delegate).findMany.mockResolvedValue([]);
    await caller().listProducts({ categoryId: 'cat1' });
    const call = (db.restaurantProduct as Delegate).findMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ categoryId: 'cat1' });
    expect(call.include).toHaveProperty('variants');
    expect(call.include).toHaveProperty('modifierGroups');
    expect(call.include).toHaveProperty('category');
  });

  it('getProduct surfaces NOT_FOUND for a missing product', async () => {
    (db.restaurantProduct as Delegate).findUnique.mockResolvedValue(null);
    await expect(caller().getProduct({ id: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('listBrands returns the brand list', async () => {
    (db.restaurantBrand as Delegate).findMany.mockResolvedValue([{ id: 'b1', name: 'A' }]);
    const result = await caller().listBrands();
    expect(result).toHaveLength(1);
  });
});

describe('recipe costing reads', () => {
  const cost = (recipeId: string) => ({
    recipeId,
    recipeVersionId: `${recipeId}_v1`,
    portionCount: 4,
    yieldQuantity: new Prisma.Decimal('2'),
    yieldUnitId: 'unit_kg',
    lines: [
      {
        ingredientId: 'ingredient_1',
        ingredientName: 'Flour',
        baseUnitId: 'unit_g',
        stockItemId: 'stock_1',
        quantityInBaseUnit: new Prisma.Decimal('500'),
        unitCost: new Prisma.Decimal('0.01'),
        source: 'WEIGHTED_AVERAGE' as const,
        lineCost: new Prisma.Decimal('5'),
      },
    ],
    batchCost: new Prisma.Decimal('5'),
    costPerPortion: new Prisma.Decimal('1.25'),
    costPerYieldUnit: new Prisma.Decimal('2.5'),
    missing: [],
  });

  it('getRecipeCost is organization-scoped and serializes all Decimals', async () => {
    mocks.computeRecipeCost.mockResolvedValue(cost('r1'));
    const result = await caller().getRecipeCost({ recipeId: 'r1', versionId: 'v3' });
    expect(mocks.computeRecipeCost).toHaveBeenCalledWith({
      organizationId: 'org_1',
      recipeVersionId: 'v3',
    });
    expect(result).toMatchObject({
      batchCost: '5',
      costPerPortion: '1.25',
      costPerYieldUnit: '2.5',
      yieldQuantity: '2',
      lines: [{ quantityInBaseUnit: '500', unitCost: '0.01', lineCost: '5' }],
    });
  });

  it('computes food-cost percentages with Decimal math for each branch price', async () => {
    mocks.computeRecipeCost.mockResolvedValue(cost('r1'));
    (db.restaurantRecipe as Delegate).findUnique.mockResolvedValue({
      productId: 'product_1',
      variantId: null,
    });
    (db.restaurantPriceList as Delegate).findFirst.mockResolvedValue({ id: 'prices_1' });
    (db.restaurantBranchMenuPublication as Delegate).findMany.mockResolvedValue([
      { branchId: 'branch_1', priceListId: 'prices_1', branch: { name: 'Downtown' } },
    ]);
    (db.restaurantPriceListVersion as Delegate).findMany.mockResolvedValue([
      {
        id: 'prices_v1',
        versionNumber: 1,
        effectiveFrom: new Date('2026-01-01'),
        status: 'ACTIVE',
      },
    ]);
    (db.restaurantPriceListEntry as Delegate).findMany.mockResolvedValue([
      { id: 'entry_1', productId: 'product_1', variantId: null, price: new Prisma.Decimal('10') },
    ]);

    const result = await caller().getRecipeCost({ recipeId: 'r1' });

    expect(result?.priceComparisons).toEqual([
      {
        branchId: 'branch_1',
        branchName: 'Downtown',
        price: '10',
        foodCostPercent: '12.5',
      },
    ]);
  });

  it('listRecipeCosts limits computation to requested recipe ids', async () => {
    mocks.computeRecipeCost.mockImplementation(async ({ recipeId }: { recipeId: string }) =>
      cost(recipeId)
    );
    const result = await caller().listRecipeCosts({ recipeIds: ['r1', 'r2'] });
    expect(result?.map((item) => item.recipeId)).toEqual(['r1', 'r2']);
    expect(mocks.computeRecipeCost).toHaveBeenCalledTimes(2);
    expect((db.restaurantRecipe as Delegate).findMany).not.toHaveBeenCalled();
  });

  it.each(['INVALID', 'CYCLE'] as const)(
    'isolates a %s recipe without discarding valid costs',
    async (reason) => {
      mocks.computeRecipeCost.mockImplementation(async ({ recipeId }: { recipeId: string }) => {
        if (recipeId === 'invalid')
          throw new RecipeCostingError('Recipe cannot be costed.', reason);
        return cost(recipeId);
      });
      const result = await caller().listRecipeCosts({ recipeIds: ['r1', 'invalid', 'r2'] });
      expect(result).toEqual([
        expect.objectContaining({ recipeId: 'r1', costPerPortion: '1.25', error: null }),
        { recipeId: 'invalid', costPerPortion: null, error: 'Recipe cannot be costed.' },
        expect.objectContaining({ recipeId: 'r2', costPerPortion: '1.25', error: null }),
      ]);
    }
  );

  it.each([
    [
      'partial',
      ['ingredient_missing'],
      new Prisma.Decimal('1.25'),
      'Ingredient prices are missing.',
    ],
    ['zero', ['ingredient_missing'], new Prisma.Decimal('0'), 'Ingredient prices are missing.'],
    ['no-portions', [], null, 'Portion cost is unavailable.'],
  ] as const)(
    'marks %s costs unavailable without discarding valid neighbors',
    async (_, missing, portionCost, error) => {
      const exactCost = new Prisma.Decimal('9007199254740993.1234');
      mocks.computeRecipeCost.mockImplementation(async ({ recipeId }: { recipeId: string }) => ({
        ...cost(recipeId),
        missing: recipeId === 'unavailable' ? [...missing] : [],
        costPerPortion: recipeId === 'unavailable' ? portionCost : exactCost,
      }));
      const result = await caller().listRecipeCosts({ recipeIds: ['r1', 'unavailable', 'r2'] });
      expect(result).toEqual([
        expect.objectContaining({
          recipeId: 'r1',
          costPerPortion: exactCost.toString(),
          error: null,
        }),
        { recipeId: 'unavailable', costPerPortion: null, error },
        expect.objectContaining({
          recipeId: 'r2',
          costPerPortion: exactCost.toString(),
          error: null,
        }),
      ]);
    }
  );

  it('does not turn unexpected cost failures into unavailable recipe data', async () => {
    mocks.computeRecipeCost.mockRejectedValue(new Error('Database unavailable'));
    await expect(caller().listRecipeCosts({ recipeIds: ['r1'] })).rejects.toThrow(
      'Database unavailable'
    );
  });

  it('uses the same menu:read capability guard as recipe reads', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().getRecipeCost({ recipeId: 'r1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller().listRecipeCosts({ recipeIds: ['r1'] })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.computeRecipeCost).not.toHaveBeenCalled();
  });
});

// ── C4 Decimal serialization ──────────────────────────────────────────────────

describe('C4 Decimal serialization', () => {
  it('createModifierOption returns priceDelta as string', async () => {
    (db.restaurantModifierGroup as Delegate).findUnique.mockResolvedValue({ id: 'mg1' });
    (db.restaurantModifierOption as Delegate).create.mockResolvedValue({
      id: 'mo1',
      name: 'Extra sauce',
      priceDelta: new Prisma.Decimal('1.50'),
      sortOrder: 0,
    });
    const result = await caller().createModifierOption({
      modifierGroupId: 'mg1',
      name: 'Extra sauce',
      priceDelta: '1.50',
    });
    expect(typeof result?.priceDelta).toBe('string');
    expect(result?.priceDelta).toBe('1.5');
  });

  it('createIngredient returns referenceCost as string', async () => {
    (db.restaurantUnit as Delegate).findUnique.mockResolvedValue({ id: 'u1' });
    (db.restaurantIngredient as Delegate).create.mockResolvedValue({
      id: 'i1',
      name: 'Flour',
      baseUnitId: 'u1',
      referenceCost: new Prisma.Decimal('2.75'),
    });
    const result = await caller().createIngredient({
      name: 'Flour',
      baseUnitId: 'u1',
      referenceCost: '2.75',
    });
    expect(typeof result?.referenceCost).toBe('string');
  });

  it('upsertConversion returns factor as string', async () => {
    (db.restaurantUnit as Delegate).findUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) => ({ id: where.id })
    );
    (db.restaurantUnitConversion as Delegate).findMany.mockResolvedValue([]);
    (db.restaurantUnitConversion as Delegate).upsert.mockResolvedValue({
      id: 'c1',
      fromUnitId: 'A',
      toUnitId: 'B',
      factor: new Prisma.Decimal('1000'),
    });
    const result = await caller().upsertConversion({
      fromUnitId: 'A',
      toUnitId: 'B',
      factor: '1000',
    });
    expect(typeof result?.factor).toBe('string');
  });
});

// ── Version immutability through the router ───────────────────────────────────

describe('updateRecipeVersion — immutability guard at router boundary', () => {
  it('returns BAD_REQUEST when version is ACTIVE', async () => {
    (db.restaurantRecipeVersion as Delegate).findUnique.mockResolvedValue({
      id: 'v1',
      status: 'ACTIVE',
      recipeId: 'r1',
    });
    await expect(
      caller().updateRecipeVersion({ id: 'v1', notes: 'cannot edit' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

// ── ABAC gating ───────────────────────────────────────────────────────────────

describe('capability gating', () => {
  it('blocks mutation when ABAC denies', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller().createBrand({ name: 'X' })).rejects.toMatchObject({
      code: expect.stringMatching(/FORBIDDEN|UNAUTHORIZED/),
    });
  });
});

// ── activateRecipeVersion — supersedes prior ACTIVE ───────────────────────────

describe('activateRecipeVersion', () => {
  it('succeeds for a DRAFT version and returns ACTIVE status', async () => {
    (db.restaurantRecipe as Delegate).findUnique.mockResolvedValue({ id: 'r1' });
    (db.restaurantRecipeVersion as Delegate).findMany.mockResolvedValue([
      { id: 'v1', status: 'DRAFT', versionNumber: 1 },
    ]);
    (db.restaurantRecipeVersion as Delegate).update.mockResolvedValue({
      id: 'v1',
      status: 'ACTIVE',
      yieldQuantity: null,
    });
    const result = await caller().activateRecipeVersion({ recipeId: 'r1', versionId: 'v1' });
    expect(result?.status).toBe('ACTIVE');
  });
});

describe('catalog tenant boundaries (#142)', () => {
  it('uses trusted organization scope for getProduct and listProducts, ignoring client organizationId', async () => {
    const products = db.restaurantProduct as Delegate;
    products.findUnique.mockImplementation(async ({ where }) =>
      where.id === 'house_product' && where.organizationId === 'house'
        ? { id: 'house_product', organizationId: 'house' }
        : null
    );
    products.findMany.mockImplementation(async ({ where }) =>
      where.organizationId === 'org_1'
        ? [{ id: 'essentials_product', organizationId: 'org_1' }]
        : []
    );
    await expect(caller().getProduct({ id: 'house_product' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(products.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'house_product', organizationId: 'org_1' },
      })
    );
    await expect(caller().listProducts({ organizationId: 'house' } as never)).resolves.toEqual([
      { id: 'essentials_product', organizationId: 'org_1' },
    ]);
    expect(products.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org_1' },
      })
    );
  });

  it.each([
    ['categoryId', 'restaurantCategory', 'createProduct', { name: 'Product' }],
    ['productId', 'restaurantProduct', 'createVariant', { name: 'Variant' }],
    ['modifierGroupId', 'restaurantModifierGroup', 'createModifierOption', { name: 'Option' }],
    ['baseUnitId', 'restaurantUnit', 'createIngredient', { name: 'Ingredient' }],
  ] as const)('rejects a foreign %s before writing', async (key, model, procedure, input) => {
    const delegate = db[model] as Delegate;
    delegate.findMany.mockResolvedValue([]);
    await expect(
      (caller()[procedure] as (input: unknown) => Promise<unknown>)({ ...input, [key]: 'house_id' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(delegate.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', id: { in: ['house_id'] } },
      select: { id: true },
    });
    expect((db.restaurantProduct as Delegate).create).not.toHaveBeenCalled();
    expect((db.restaurantProductVariant as Delegate).create).not.toHaveBeenCalled();
    expect((db.restaurantModifierOption as Delegate).create).not.toHaveBeenCalled();
    expect((db.restaurantIngredient as Delegate).create).not.toHaveBeenCalled();
  });
});
