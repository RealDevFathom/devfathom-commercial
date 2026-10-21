import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '@/server/trpc';

const mocks = vi.hoisted(() => ({
  rows: {
    createBrand: vi.fn(),
    createCategory: vi.fn(),
    createModifierGroup: vi.fn(),
    createModifierOption: vi.fn(),
    createProduct: vi.fn(),
    createVariant: vi.fn(),
    createFloor: vi.fn(),
    createTable: vi.fn(),
    createMenu: vi.fn(),
    createMenuSection: vi.fn(),
    createMenuItem: vi.fn(),
    createPriceList: vi.fn(),
    createPriceListVersion: vi.fn(),
    createUnit: vi.fn(),
    createIngredient: vi.fn(),
    createRecipe: vi.fn(),
    createRecipeVersion: vi.fn(),
    createStation: vi.fn(),
    branchCreate: vi.fn(),
    stockLocationCreate: vi.fn(),
    stockItemCreate: vi.fn(),
    publicationCreate: vi.fn(),
  },
  attachModifierGroup: vi.fn(),
  createRoutingRule: vi.fn(),
  addPriceListEntry: vi.fn(),
  activatePriceListVersion: vi.fn(),
  upsertConversion: vi.fn(),
  createRecipeLine: vi.fn(),
  activateRecipeVersion: vi.fn(),
  publishPublication: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/restaurant/catalog', () => ({
  attachModifierGroup: mocks.attachModifierGroup,
  createBrand: mocks.rows.createBrand,
  createCategory: mocks.rows.createCategory,
  createModifierGroup: mocks.rows.createModifierGroup,
  createModifierOption: mocks.rows.createModifierOption,
  createProduct: mocks.rows.createProduct,
  createVariant: mocks.rows.createVariant,
}));
vi.mock('@/lib/restaurant/floor', () => ({
  createFloor: mocks.rows.createFloor,
  createTable: mocks.rows.createTable,
}));
vi.mock('@/lib/restaurant/menus', () => ({
  createMenu: mocks.rows.createMenu,
  createMenuItem: mocks.rows.createMenuItem,
  createMenuSection: mocks.rows.createMenuSection,
}));
vi.mock('@/lib/restaurant/price-lists', () => ({
  activatePriceListVersion: mocks.activatePriceListVersion,
  addPriceListEntry: mocks.addPriceListEntry,
  createPriceList: mocks.rows.createPriceList,
  createPriceListVersion: mocks.rows.createPriceListVersion,
}));
vi.mock('@/lib/restaurant/recipes', () => ({
  activateRecipeVersion: mocks.activateRecipeVersion,
  createIngredient: mocks.rows.createIngredient,
  createRecipe: mocks.rows.createRecipe,
  createRecipeLine: mocks.createRecipeLine,
  createRecipeVersion: mocks.rows.createRecipeVersion,
  createUnit: mocks.rows.createUnit,
  upsertConversion: mocks.upsertConversion,
}));
vi.mock('@/lib/restaurant/stations', () => ({
  createRoutingRule: mocks.createRoutingRule,
  createStation: mocks.rows.createStation,
}));
vi.mock('@/server/routers/restaurant-branches', () => ({
  restaurantBranchesRouter: {
    createCaller: () => ({ create: mocks.rows.branchCreate }),
  },
}));
vi.mock('@/server/routers/restaurant-inventory', () => ({
  restaurantInventoryRouter: {
    createCaller: () => ({
      createStockLocation: mocks.rows.stockLocationCreate,
      createStockItem: mocks.rows.stockItemCreate,
    }),
  },
}));
vi.mock('@/server/routers/restaurant-menus', () => ({
  restaurantMenusRouter: {
    createCaller: () => ({
      createPublication: mocks.rows.publicationCreate,
      publishPublication: mocks.publishPublication,
    }),
  },
}));

import { buildDemoRestaurantSeed } from './seed-data';
import { seedDemoRestaurantCatalog } from './seed-catalog';

const db = {} as ScopedDb;
const context = {
  db,
  entitlements: { limits: { 'restaurant.brands.max': 1 } },
} as unknown as TRPCContext;

beforeEach(() => {
  vi.clearAllMocks();
  let nextId = 0;
  for (const mock of Object.values(mocks.rows)) {
    mock.mockImplementation(async () => ({ id: `db_${++nextId}` }));
  }
});

describe('seedDemoRestaurantCatalog', () => {
  it('persists every catalog descriptor through services and returns usable ID maps', async () => {
    const seed = buildDemoRestaurantSeed(new Date('2026-09-04T07:00:00.000Z'), 1);
    const ids = await seedDemoRestaurantCatalog(db, seed, context);
    const variantCount = seed.menu.products.reduce(
      (total, product) => total + product.variants.length,
      0
    );
    const modifierOptionCount = seed.menu.modifierGroups.reduce(
      (total, group) => total + group.options.length,
      0
    );
    const recipeLineCount = seed.inventory.recipes.reduce(
      (total, recipe) => total + recipe.lines.length,
      0
    );

    expect(Object.keys(ids.branch)).toHaveLength(seed.branches.length);
    expect(Object.keys(ids.floor)).toHaveLength(
      seed.branches.reduce((total, branch) => total + branch.floors.length, 0)
    );
    expect(Object.keys(ids.table)).toHaveLength(
      seed.branches.reduce(
        (total, branch) =>
          total + branch.floors.reduce((sum, floor) => sum + floor.tables.length, 0),
        0
      )
    );
    expect(Object.keys(ids.station)).toHaveLength(seed.branches.length * 4);
    expect(ids.station[`${seed.branches[0]!.id}:HOT_KITCHEN`]).toBeDefined();
    expect(Object.keys(ids.product)).toHaveLength(seed.menu.products.length);
    expect(Object.keys(ids.variant)).toHaveLength(variantCount);
    expect(Object.keys(ids.menuItem)).toHaveLength(variantCount);
    expect(ids.menuItem[seed.menu.products[0]!.variants[0]!.id]).toBeDefined();
    expect(Object.keys(ids.modifierGroup)).toHaveLength(seed.menu.modifierGroups.length);
    expect(Object.keys(ids.modifierOption)).toHaveLength(modifierOptionCount);
    expect(Object.keys(ids.ingredient)).toHaveLength(seed.inventory.ingredients.length);
    expect(Object.keys(ids.stockItem)).toHaveLength(seed.inventory.ingredients.length);
    expect(Object.keys(ids.recipe)).toHaveLength(seed.inventory.recipes.length);

    expect(mocks.createRecipeLine).toHaveBeenCalledTimes(recipeLineCount);
    const recipeUnitIds = new Set(
      mocks.createRecipeLine.mock.calls.map(([, input]) => input.unitId as string)
    );
    expect(recipeUnitIds).toEqual(
      expect.objectContaining(new Set([ids.unit.g, ids.unit.ml, ids.unit.piece]))
    );
    const priceEffectiveFrom = mocks.rows.createPriceListVersion.mock.calls[0]![1]
      .effectiveFrom as Date;
    expect(priceEffectiveFrom).toEqual(
      new Date(`${seed.historicalBusinessDates[0]}T00:00:00+05:00`)
    );
    expect(priceEffectiveFrom.getTime()).toBeLessThanOrEqual(
      Math.min(...seed.sales.historicalOrders.map((order) => new Date(order.placedAt).getTime()))
    );
    expect(mocks.upsertConversion).toHaveBeenCalledTimes(2);
    expect(mocks.upsertConversion).toHaveBeenNthCalledWith(1, db, ids.unit.g, ids.unit.kg, '0.001');
    expect(mocks.upsertConversion).toHaveBeenNthCalledWith(
      2,
      db,
      ids.unit.ml,
      ids.unit.litre,
      '0.001'
    );
    expect(mocks.rows.stockItemCreate).toHaveBeenCalledTimes(seed.inventory.ingredients.length);
    expect(mocks.rows.publicationCreate).toHaveBeenCalledTimes(seed.branches.length);
    expect(mocks.publishPublication).toHaveBeenCalledTimes(seed.branches.length);
  });
});
