import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  attachModifierGroup,
  createBrand,
  createCategory,
  createModifierGroup,
  createModifierOption,
  createProduct,
  createVariant,
} from '@/lib/restaurant/catalog';
import { createFloor, createTable } from '@/lib/restaurant/floor';
import { createMenu, createMenuItem, createMenuSection } from '@/lib/restaurant/menus';
import {
  activatePriceListVersion,
  addPriceListEntry,
  createPriceList,
  createPriceListVersion,
} from '@/lib/restaurant/price-lists';
import {
  activateRecipeVersion,
  createIngredient,
  createRecipe,
  createRecipeLine,
  createRecipeVersion,
  createUnit,
  upsertConversion,
} from '@/lib/restaurant/recipes';
import { createRoutingRule, createStation } from '@/lib/restaurant/stations';
import { resolveEntitlementLimit, RESTAURANT_BRANDS_LIMIT } from '@/lib/entitlement-limits';
import { restaurantBranchesRouter } from '@/server/routers/restaurant-branches';
import { restaurantInventoryRouter } from '@/server/routers/restaurant-inventory';
import { restaurantMenusRouter } from '@/server/routers/restaurant-menus';
import type { TRPCContext } from '@/server/trpc';

import type { DemoRestaurantSeed } from './seed-data';

export type DemoRestaurantCatalogIds = {
  branch: Record<string, string>;
  floor: Record<string, string>;
  table: Record<string, string>;
  station: Record<string, string>;
  product: Record<string, string>;
  variant: Record<string, string>;
  menuItem: Record<string, string>;
  modifierGroup: Record<string, string>;
  modifierOption: Record<string, string>;
  unit: Record<string, string>;
  ingredient: Record<string, string>;
  recipe: Record<string, string>;
  stockLocation: Record<string, string>;
  stockItem: Record<string, string>;
};

export type SeedDemoRestaurantCatalog = (
  db: ScopedDb,
  seed: DemoRestaurantSeed,
  context: TRPCContext
) => Promise<DemoRestaurantCatalogIds>;

type DemoCategory = DemoRestaurantSeed['menu']['products'][number]['category'];

const CATEGORY_LABEL: Record<DemoCategory, string> = {
  karahi: 'Karahi',
  BBQ: 'BBQ',
  biryani: 'Biryani',
  breads: 'Breads',
  drinks: 'Drinks',
  desserts: 'Desserts',
};

const STATIONS = [
  { key: 'HOT_KITCHEN', name: 'Hot Kitchen', categories: ['karahi', 'biryani', 'desserts'] },
  { key: 'BBQ_GRILL', name: 'BBQ Grill', categories: ['BBQ'] },
  { key: 'TANDOOR', name: 'Tandoor', categories: ['breads'] },
  { key: 'BEVERAGE_BAR', name: 'Beverage Bar', categories: ['drinks'] },
] as const satisfies ReadonlyArray<{
  key: string;
  name: string;
  categories: readonly DemoCategory[];
}>;

const UNIT_NAMES = {
  kg: ['kilogram', 'kg'],
  g: ['gram', 'g'],
  litre: ['litre', 'L'],
  ml: ['millilitre', 'ml'],
  piece: ['piece', 'pc'],
  serving: ['serving', 'serving'],
} as const;

function requiredId(map: Record<string, string>, descriptorId: string, kind: string): string {
  const id = map[descriptorId];
  if (!id) throw new Error(`Missing persisted ${kind} for ${descriptorId}.`);
  return id;
}

export const seedDemoRestaurantCatalog: SeedDemoRestaurantCatalog = async (db, seed, context) => {
  if (context.db !== db) {
    throw new Error('Catalog seeding requires context.db to be the provided scoped transaction.');
  }
  if (seed.timeZone !== 'Asia/Karachi' || seed.currency !== 'PKR') {
    throw new Error('Restaurant demo catalog requires Asia/Karachi and PKR seed data.');
  }
  const earliestBusinessDate = seed.historicalBusinessDates[0];
  if (!earliestBusinessDate?.match(/^\d{4}-\d{2}-\d{2}$/)) {
    throw new Error('Restaurant demo seed requires a valid earliest historical business date.');
  }
  // Pakistan has no daylight-saving shift, so +05:00 is the stable boundary
  // for the synthetic business-date history.

  const effectiveFrom = new Date(`${earliestBusinessDate}T00:00:00+05:00`);
  if (!Number.isFinite(effectiveFrom.getTime())) {
    throw new Error('Restaurant demo seed earliest historical business date is invalid.');
  }

  const ids: DemoRestaurantCatalogIds = {
    branch: {},
    floor: {},
    table: {},
    station: {},
    product: {},
    variant: {},
    menuItem: {},
    modifierGroup: {},
    modifierOption: {},
    unit: {},
    ingredient: {},
    recipe: {},
    stockLocation: {},
    stockItem: {},
  };
  const branchCaller = restaurantBranchesRouter.createCaller(context);
  const inventoryCaller = restaurantInventoryRouter.createCaller(context);
  const menuCaller = restaurantMenusRouter.createCaller(context);

  for (const branch of seed.branches) {
    const createdBranch = await branchCaller.create({
      name: branch.name,
      code: branch.key.replaceAll('_', '-').toUpperCase(),
      timezone: seed.timeZone,
      businessDayCutoff: '05:00',
      address: branch.address,
      shiftSignInEnforced: false,
    });
    ids.branch[branch.id] = createdBranch.id;

    for (const [floorIndex, floor] of branch.floors.entries()) {
      const createdFloor = await createFloor(db, {
        branchId: createdBranch.id,
        name: floor.name,
        sortOrder: floorIndex,
      });
      ids.floor[floor.id] = createdFloor.id;
      for (const table of floor.tables) {
        const createdTable = await createTable(db, {
          floorId: createdFloor.id,
          code: table.name,
          capacity: table.capacity,
        });
        ids.table[table.id] = createdTable.id;
      }
    }

    const stockLocation = await inventoryCaller.createStockLocation({
      branchId: createdBranch.id,
      name: 'Main Store',
      code: 'MAIN',
    });
    ids.stockLocation[branch.id] = stockLocation.id;
  }

  const brandLimit = resolveEntitlementLimit(
    context.entitlements.limits as Record<string, number>,
    RESTAURANT_BRANDS_LIMIT
  );
  if (brandLimit.status === 'missing') {
    throw new Error('The restaurant brand entitlement is not configured correctly.');
  }
  const brand = await createBrand(db, { name: seed.brand.name }, brandLimit.value);

  const categoryIds = {} as Record<DemoCategory, string>;
  for (const [sortOrder, category] of (Object.keys(CATEGORY_LABEL) as DemoCategory[]).entries()) {
    const created = await createCategory(db, {
      name: CATEGORY_LABEL[category],
      sortOrder,
    });
    categoryIds[category] = created.id;
  }

  for (const group of seed.menu.modifierGroups) {
    const createdGroup = await createModifierGroup(db, {
      name: group.name,
      minSelect: group.minimumSelections,
      maxSelect: group.maximumSelections,
    });
    ids.modifierGroup[group.id] = createdGroup.id;
    for (const [sortOrder, option] of group.options.entries()) {
      const createdOption = await createModifierOption(db, {
        modifierGroupId: createdGroup.id,
        name: option.name,
        priceDelta: option.pricePkr.toFixed(2),
        sortOrder,
      });
      ids.modifierOption[option.id] = createdOption.id;
    }
  }

  for (const [sortOrder, product] of seed.menu.products.entries()) {
    const createdProduct = await createProduct(db, {
      name: product.name,
      categoryId: categoryIds[product.category],
      sortOrder,
    });
    ids.product[product.id] = createdProduct.id;
    for (const [variantOrder, variant] of product.variants.entries()) {
      const createdVariant = await createVariant(db, {
        productId: createdProduct.id,
        name: variant.name,
        sortOrder: variantOrder,
      });
      ids.variant[variant.id] = createdVariant.id;
    }
    for (const [groupOrder, groupId] of product.modifierGroupIds.entries()) {
      await attachModifierGroup(
        db,
        createdProduct.id,
        requiredId(ids.modifierGroup, groupId, 'modifier group'),
        groupOrder
      );
    }
  }

  for (const branch of seed.branches) {
    for (const [stationOrder, station] of STATIONS.entries()) {
      const createdStation = await createStation(db, {
        branchId: requiredId(ids.branch, branch.id, 'branch'),
        name: station.name,
        isDefault: stationOrder === 0,
      });
      ids.station[`${branch.id}:${station.key}`] = createdStation.id;
      for (const [priority, category] of station.categories.entries()) {
        await createRoutingRule(db, {
          stationId: createdStation.id,
          categoryId: categoryIds[category],
          priority,
        });
      }
    }
  }

  const menu = await createMenu(db, {
    brandId: brand.id,
    name: `${seed.brand.name} POS Menu`,
    description: 'Synthetic dine-in, takeaway, and delivery demonstration menu.',
  });
  const sectionIds = {} as Record<DemoCategory, string>;
  for (const [sortOrder, category] of (Object.keys(CATEGORY_LABEL) as DemoCategory[]).entries()) {
    const section = await createMenuSection(db, {
      menuId: menu.id,
      name: CATEGORY_LABEL[category],
      sortOrder,
    });
    sectionIds[category] = section.id;
  }

  const priceList = await createPriceList(db, { name: 'Standard PKR', isDefault: true });
  const priceVersion = await createPriceListVersion(db, {
    priceListId: priceList.id,
    effectiveFrom,
  });
  for (const [productOrder, product] of seed.menu.products.entries()) {
    const productId = requiredId(ids.product, product.id, 'product');
    for (const [variantOrder, variant] of product.variants.entries()) {
      const variantId = requiredId(ids.variant, variant.id, 'variant');
      const menuItem = await createMenuItem(db, {
        sectionId: sectionIds[product.category],
        productId,
        variantId,
        displayName:
          product.variants.length === 1 ? product.name : `${product.name} — ${variant.name}`,
        sortOrder: productOrder * 10 + variantOrder,
      });
      ids.menuItem[variant.id] = menuItem.id;
      await addPriceListEntry(db, {
        priceListVersionId: priceVersion.id,
        productId,
        variantId,
        price: variant.pricePkr.toFixed(2),
      });
    }
  }
  await activatePriceListVersion(db, priceVersion.id, effectiveFrom);
  for (const branch of seed.branches) {
    const publication = await menuCaller.createPublication({
      branchId: requiredId(ids.branch, branch.id, 'branch'),
      menuId: menu.id,
      priceListId: priceList.id,
      channels: ['DINE_IN', 'TAKEAWAY', 'DELIVERY'],
    });
    await menuCaller.publishPublication({ id: publication.id });
  }

  for (const key of Object.keys(UNIT_NAMES) as Array<keyof typeof UNIT_NAMES>) {
    const [name, abbreviation] = UNIT_NAMES[key];
    const unit = await createUnit(db, { name, abbreviation });
    ids.unit[key] = unit.id;
  }
  await upsertConversion(db, ids.unit.g!, ids.unit.kg!, '0.001');
  await upsertConversion(db, ids.unit.ml!, ids.unit.litre!, '0.001');

  for (const ingredient of seed.inventory.ingredients) {
    const baseUnitId = requiredId(ids.unit, ingredient.baseUnit, 'base unit');
    const createdIngredient = await createIngredient(db, {
      name: ingredient.name,
      baseUnitId,
      referenceCost: ingredient.referenceCostPkr.toFixed(4),
    });
    ids.ingredient[ingredient.id] = createdIngredient.id;
    const stockItem = await inventoryCaller.createStockItem({
      ingredientId: createdIngredient.id,
      canonicalUnitId: baseUnitId,
    });
    ids.stockItem[ingredient.id] = stockItem.id;
  }

  for (const recipe of seed.inventory.recipes) {
    const createdRecipe = await createRecipe(db, {
      productId: requiredId(ids.product, recipe.productId, 'recipe product'),
      name: recipe.name,
    });
    ids.recipe[recipe.id] = createdRecipe.id;
    const version = await createRecipeVersion(db, {
      recipeId: createdRecipe.id,
      yieldQuantity: recipe.yieldQuantity.toString(),
      yieldUnitId: requiredId(ids.unit, recipe.yieldUnit, 'yield unit'),
      portionCount: 1,
    });
    for (const [sortOrder, line] of recipe.lines.entries()) {
      await createRecipeLine(db, {
        recipeVersionId: version.id,
        ingredientId: requiredId(ids.ingredient, line.ingredientId, 'recipe ingredient'),
        quantity: line.quantity.toString(),
        unitId: requiredId(ids.unit, line.unit, 'recipe unit'),
        sortOrder,
      });
    }
    await activateRecipeVersion(db, createdRecipe.id, version.id);
  }

  return ids;
};
