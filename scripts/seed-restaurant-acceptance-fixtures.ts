import { Prisma } from '../src/generated/prisma/client.js';

/**
 * WHA-1542 — the two Chai Chowk fixtures the already-authored Restaurant
 * acceptance specs need but `scripts/seed-restaurant-e2e.ts` never wrote.
 *
 * Both live in the SAME tenant as the rest of the integrated lane, so they are
 * written inside that seed's tenant-scoped transaction rather than in an
 * organization of their own. They are additive: nothing here reads, rewrites or
 * deactivates a pre-existing lane row.
 *
 *   · `seedBackOfficeStockFixture` (WHA-1238) — the ONE active stock location,
 *     canonical-unit stock item and opening movement the back-office acceptance
 *     spec needs before `/restaurant/purchasing` can build a purchase-order line
 *     or `/restaurant/inventory` can take a count line. Without them both forms
 *     render with an empty `<select>` and their submit controls stay disabled.
 *
 *   · `seedRecipeProfitabilityFixture` (WHA-1565) — the units, conversions,
 *     ingredients, stock movements, recipes and settled sales the recipe-costing
 *     and dish-profitability oracle is hand-calculated against. Every figure that
 *     spec asserts is derived from these inputs, so the numbers below are the
 *     contract and must not drift.
 *
 * ISOLATION RULES THIS FILE KEEPS, because breaking either silently changes
 * someone else's asserted number:
 *
 *   1. The weighted-average cost reader (`src/lib/restaurant/recipe-costing.ts`)
 *      sums EVERY movement for a stock item, with no branch or date bound. The
 *      WHA-1565 stock items are therefore seeded `isActive: false`: the purchasing
 *      and stock-count consoles list only active items
 *      (`where: { isActive: true }`), so no browser flow in the lane can post a
 *      stray movement into them, while costing — which does not filter on
 *      `isActive` — still reads them exactly as the oracle expects.
 *   2. The WHA-1565 sales window is a deliberately historical business date at
 *      branch A1, so the lane's same-day POS traffic can never enter it. The
 *      back-office fixture's opening movement carries no bill at all.
 */

const FIXED_AT = new Date('2026-08-27T00:00:00.000Z');

/** Fixed historical business date; must match `BUSINESS_DATE` in the WHA-1565 spec. */
const RPA_BUSINESS_DATE = new Date('2026-02-17T00:00:00.000Z');

/**
 * Order numbers for the settled fixture sales. `restaurant_orders` is unique on
 * (branchId, businessDate, orderNumber) and the historical date carries no other
 * traffic, so a fixed block keeps the seed idempotent across re-runs.
 */
const RPA_FIRST_ORDER_NUMBER = 9101;

type TransactionClient = Prisma.TransactionClient;

// ── WHA-1238: back-office stock fixture ──────────────────────────────────────

export const BACK_OFFICE_STOCK = {
  unitId: 'unit_restaurant_e2e_backoffice_kg',
  locationId: 'stock_location_restaurant_e2e_main',
  ingredientId: 'ingredient_restaurant_e2e_backoffice_flour',
  stockItemId: 'stock_item_restaurant_e2e_backoffice_flour',
  openingMovementId: 'stock_movement_restaurant_e2e_backoffice_opening',
  /**
   * The opening position the acceptance spec receives against. It is a plain
   * whole number at a scale no run-unique amount the spec generates can collide
   * with (those carry six fractional digits), so "exactly one movement carries
   * my amount" stays a sound identification.
   */
  openingQuantity: '40',
  openingUnitCost: '250',
} as const;

export const BACK_OFFICE_STOCK_OWNED_FIXTURES = [
  ['restaurant_units', [BACK_OFFICE_STOCK.unitId]],
  ['restaurant_stock_locations', [BACK_OFFICE_STOCK.locationId]],
  ['restaurant_ingredients', [BACK_OFFICE_STOCK.ingredientId]],
  ['restaurant_stock_items', [BACK_OFFICE_STOCK.stockItemId]],
  ['restaurant_stock_movements', [BACK_OFFICE_STOCK.openingMovementId]],
] as const;

/**
 * Seeded on branch A1, which is where the back-office consoles default. The
 * location is the OLDEST active one for that branch, so it also keeps winning the
 * `createdAt asc` tie-break `postCateringConsumption` resolves by — the catering
 * acceptance spec creates its own only when the branch has none, and with this row
 * present it no longer needs to.
 */
export async function seedBackOfficeStockFixture(tx: TransactionClient, branchId: string) {
  await tx.restaurantUnit.upsert({
    where: { id: BACK_OFFICE_STOCK.unitId },
    update: { name: 'Kilogram', abbreviation: 'kg' },
    create: {
      id: BACK_OFFICE_STOCK.unitId,
      name: 'Kilogram',
      abbreviation: 'kg',
      createdAt: FIXED_AT,
      updatedAt: FIXED_AT,
    },
  });
  await tx.restaurantStockLocation.upsert({
    where: { id: BACK_OFFICE_STOCK.locationId },
    update: { branchId, name: 'Main store', code: 'MAIN', isActive: true },
    create: {
      id: BACK_OFFICE_STOCK.locationId,
      branchId,
      name: 'Main store',
      code: 'MAIN',
      isActive: true,
      createdAt: FIXED_AT,
      updatedAt: FIXED_AT,
    },
  });
  await tx.restaurantIngredient.upsert({
    where: { id: BACK_OFFICE_STOCK.ingredientId },
    update: {
      name: 'E2E Flour',
      baseUnitId: BACK_OFFICE_STOCK.unitId,
      referenceCost: new Prisma.Decimal('250'),
    },
    create: {
      id: BACK_OFFICE_STOCK.ingredientId,
      name: 'E2E Flour',
      baseUnitId: BACK_OFFICE_STOCK.unitId,
      referenceCost: new Prisma.Decimal('250'),
      createdAt: FIXED_AT,
      updatedAt: FIXED_AT,
    },
  });
  await tx.restaurantStockItem.upsert({
    where: { id: BACK_OFFICE_STOCK.stockItemId },
    update: {
      ingredientId: BACK_OFFICE_STOCK.ingredientId,
      canonicalUnitId: BACK_OFFICE_STOCK.unitId,
      isActive: true,
      trackBatches: false,
    },
    create: {
      id: BACK_OFFICE_STOCK.stockItemId,
      ingredientId: BACK_OFFICE_STOCK.ingredientId,
      canonicalUnitId: BACK_OFFICE_STOCK.unitId,
      isActive: true,
      trackBatches: false,
      createdAt: FIXED_AT,
      updatedAt: FIXED_AT,
    },
  });
  // The opening position.
  await appendStockMovement(tx, {
    id: BACK_OFFICE_STOCK.openingMovementId,
    stockItemId: BACK_OFFICE_STOCK.stockItemId,
    locationId: BACK_OFFICE_STOCK.locationId,
    reason: 'PURCHASE_RECEIPT',
    quantity: new Prisma.Decimal(BACK_OFFICE_STOCK.openingQuantity),
    unitCost: new Prisma.Decimal(BACK_OFFICE_STOCK.openingUnitCost),
    occurredAt: FIXED_AT,
  });
}

/**
 * Create-if-absent, NEVER update. `restaurant_stock_movements` carries a SELECT
 * policy, an INSERT policy and a narrow demo-reset DELETE policy — and no UPDATE
 * policy at all, because the stock ledger is append-only by design. An
 * `upsert` therefore succeeds on a fresh database and is refused with SQLSTATE
 * 42501 the moment the row already exists, which is exactly what the lane's
 * seed-twice runner does.
 *
 * Reading the row first and skipping it keeps the seed idempotent WITHOUT
 * rewriting a committed ledger entry. Nothing here relaxes the policy: the
 * refusal is correct product behaviour and the seed is what had to change.
 */
async function appendStockMovement(
  tx: TransactionClient,
  movement: {
    id: string;
    stockItemId: string;
    locationId: string;
    reason: 'PURCHASE_RECEIPT' | 'RECIPE_CONSUMPTION';
    quantity: Prisma.Decimal;
    unitCost: Prisma.Decimal;
    occurredAt: Date;
  }
) {
  const existing = await tx.restaurantStockMovement.findUnique({
    where: { id: movement.id },
    select: { id: true },
  });
  if (existing) return;
  await tx.restaurantStockMovement.create({
    data: { ...movement, recordedAt: movement.occurredAt },
  });
}

// ── WHA-1565: recipe costing and dish profitability fixture ──────────────────

const RPA_UNITS = [
  { id: 'unit_rpa_gram', name: 'RPA gram', abbreviation: 'g' },
  { id: 'unit_rpa_kilogram', name: 'RPA kilogram', abbreviation: 'kg' },
  { id: 'unit_rpa_millilitre', name: 'RPA millilitre', abbreviation: 'ml' },
  { id: 'unit_rpa_litre', name: 'RPA litre', abbreviation: 'L' },
  { id: 'unit_rpa_portion', name: 'RPA portion', abbreviation: 'portion' },
] as const;

/**
 * `from -> to` with factor F means `quantity_in_to = quantity_in_from * F`.
 * The g -> kg row is the base -> canonical direction the weighted-average path
 * needs; without it costing raises NO_UNIT_CONVERSION instead of a number.
 */
const RPA_CONVERSIONS = [
  {
    id: 'unit_conversion_rpa_kg_g',
    fromUnitId: 'unit_rpa_kilogram',
    toUnitId: 'unit_rpa_gram',
    factor: '1000',
  },
  {
    id: 'unit_conversion_rpa_l_ml',
    fromUnitId: 'unit_rpa_litre',
    toUnitId: 'unit_rpa_millilitre',
    factor: '1000',
  },
  {
    id: 'unit_conversion_rpa_g_kg',
    fromUnitId: 'unit_rpa_gram',
    toUnitId: 'unit_rpa_kilogram',
    factor: '0.001',
  },
] as const;

const RPA_INGREDIENTS = [
  {
    id: 'ingredient_rpa_chicken',
    name: 'RPA chicken',
    baseUnitId: 'unit_rpa_gram',
    /** Deliberately NOT 0.76, so weighted-average precedence is actually proven. */
    referenceCost: '0.9',
    stockItemId: 'stock_item_rpa_chicken',
    canonicalUnitId: 'unit_rpa_kilogram',
    /** Σqty 50, Σ(qty × unitCost) 38000 ⇒ 760 per kg ⇒ 0.76 per gram. */
    movements: [
      { id: 'stock_movement_rpa_chicken_1', quantity: '20', unitCost: '700' },
      { id: 'stock_movement_rpa_chicken_2', quantity: '30', unitCost: '800' },
    ],
  },
  {
    id: 'ingredient_rpa_yoghurt',
    name: 'RPA yoghurt',
    baseUnitId: 'unit_rpa_millilitre',
    referenceCost: '0.25',
    stockItemId: null,
    canonicalUnitId: null,
    movements: [],
  },
  {
    id: 'ingredient_rpa_flour',
    name: 'RPA flour',
    baseUnitId: 'unit_rpa_gram',
    referenceCost: '0.1',
    stockItemId: 'stock_item_rpa_flour',
    canonicalUnitId: 'unit_rpa_kilogram',
    /**
     * Σqty 0, so the weighted average is unusable and the reference cost applies.
     * BOTH rows carry a unitCost: a null on the issue would leave the receipt
     * unbalanced and the summed value non-zero, breaking the fallback case.
     */
    movements: [
      { id: 'stock_movement_rpa_flour_1', quantity: '10', unitCost: '50' },
      { id: 'stock_movement_rpa_flour_2', quantity: '-10', unitCost: '50' },
    ],
  },
  {
    id: 'ingredient_rpa_saffron',
    name: 'RPA saffron',
    baseUnitId: 'unit_rpa_gram',
    /** Neither source ⇒ MISSING: costed at zero and named in `missing`. */
    referenceCost: null,
    stockItemId: null,
    canonicalUnitId: null,
    movements: [],
  },
] as const;

/**
 * Every recipe carries EXACTLY ONE version, versionNumber 1, status ACTIVE, and
 * `variantId` NULL. A second version would move the catalog console off the
 * active one; a variant-bound recipe would be invisible to the variant-less sales
 * row and collapse every total in the oracle.
 */
const RPA_RECIPES = [
  {
    id: 'recipe_rpa_spice_mix',
    versionId: 'recipe_version_rpa_spice_mix_v1',
    name: 'RPA spice mix BOM',
    productId: 'product_rpa_spice_mix',
    productName: 'RPA Spice Mix',
    portionCount: null,
    yieldQuantity: '6',
    yieldUnitId: 'unit_rpa_gram',
  },
  {
    id: 'recipe_rpa_platter',
    versionId: 'recipe_version_rpa_platter_v1',
    name: 'RPA Tikka Platter BOM',
    productId: 'product_rpa_platter',
    productName: 'RPA Tikka Platter',
    portionCount: 5,
    yieldQuantity: '2',
    yieldUnitId: 'unit_rpa_portion',
  },
  {
    id: 'recipe_rpa_cooler',
    versionId: 'recipe_version_rpa_cooler_v1',
    name: 'RPA Chai Cooler BOM',
    productId: 'product_rpa_cooler',
    productName: 'RPA Chai Cooler',
    portionCount: 2,
    yieldQuantity: null,
    yieldUnitId: null,
  },
  {
    id: 'recipe_rpa_rice',
    versionId: 'recipe_version_rpa_rice_v1',
    name: 'RPA Saffron Rice BOM',
    productId: 'product_rpa_rice',
    productName: 'RPA Saffron Rice',
    portionCount: 2,
    yieldQuantity: null,
    yieldUnitId: null,
  },
  {
    id: 'recipe_rpa_cycle_a',
    versionId: 'recipe_version_rpa_cycle_a_v1',
    name: 'RPA Cycle Bowl BOM',
    productId: 'product_rpa_cycle_bowl',
    productName: 'RPA Cycle Bowl',
    portionCount: 1,
    yieldQuantity: null,
    yieldUnitId: null,
  },
  {
    id: 'recipe_rpa_cycle_b',
    versionId: 'recipe_version_rpa_cycle_b_v1',
    name: 'RPA Cycle Base BOM',
    productId: 'product_rpa_cycle_base',
    productName: 'RPA Cycle Base',
    portionCount: 1,
    yieldQuantity: null,
    yieldUnitId: null,
  },
] as const;

/** The product with no recipe row at all. */
const RPA_SNACK = { productId: 'product_rpa_snack', productName: 'RPA Unlinked Snack' } as const;

/**
 * Exactly ten lines across the six versions above — the WHA-1565 spec asserts that
 * count, so an eleventh line anywhere in this fixture is a failure, not a detail.
 *
 * The two `recipe_rpa_cycle_*` lines close an A -> B -> A loop and are the ONE
 * part of this fixture the ordinary write path cannot produce: `createRecipeLine`
 * calls `assertNoRecipeCycle` for every sub-recipe line and that guard walks the
 * sub-recipe graph across every version regardless of status, so the first edge is
 * accepted and the second is always refused, in either order, by symmetry. They
 * are therefore written directly here, scoped to exactly these two versions.
 *
 * That guard is NOT weakened, skipped or flag-gated to make this seedable: the
 * refusal is the product behaviour under test elsewhere, and `computeRecipeCost`'s
 * cycle branch is a DEFENSIVE path for legacy or externally-introduced data, which
 * this fixture exists to prove still holds. No runtime, API or product code path
 * gains the ability to write a cyclic recipe from anything in this file.
 */
const RPA_RECIPE_LINES = [
  {
    id: 'recipe_line_rpa_spice_mix_flour',
    versionId: 'recipe_version_rpa_spice_mix_v1',
    sortOrder: 0,
    ingredientId: 'ingredient_rpa_flour',
    subRecipeId: null,
    quantity: '10',
    unitId: 'unit_rpa_gram',
  },
  {
    id: 'recipe_line_rpa_spice_mix_chicken',
    versionId: 'recipe_version_rpa_spice_mix_v1',
    sortOrder: 1,
    ingredientId: 'ingredient_rpa_chicken',
    subRecipeId: null,
    quantity: '0.02',
    unitId: 'unit_rpa_kilogram',
  },
  {
    id: 'recipe_line_rpa_platter_chicken',
    versionId: 'recipe_version_rpa_platter_v1',
    sortOrder: 0,
    ingredientId: 'ingredient_rpa_chicken',
    subRecipeId: null,
    quantity: '1.5',
    unitId: 'unit_rpa_kilogram',
  },
  {
    id: 'recipe_line_rpa_platter_yoghurt',
    versionId: 'recipe_version_rpa_platter_v1',
    sortOrder: 1,
    ingredientId: 'ingredient_rpa_yoghurt',
    subRecipeId: null,
    quantity: '0.4',
    unitId: 'unit_rpa_litre',
  },
  {
    id: 'recipe_line_rpa_platter_spice_mix',
    versionId: 'recipe_version_rpa_platter_v1',
    sortOrder: 2,
    ingredientId: null,
    subRecipeId: 'recipe_rpa_spice_mix',
    quantity: '3',
    unitId: 'unit_rpa_gram',
  },
  {
    id: 'recipe_line_rpa_cooler_yoghurt',
    versionId: 'recipe_version_rpa_cooler_v1',
    sortOrder: 0,
    ingredientId: 'ingredient_rpa_yoghurt',
    subRecipeId: null,
    quantity: '200',
    unitId: 'unit_rpa_millilitre',
  },
  {
    id: 'recipe_line_rpa_rice_saffron',
    versionId: 'recipe_version_rpa_rice_v1',
    sortOrder: 0,
    ingredientId: 'ingredient_rpa_saffron',
    subRecipeId: null,
    quantity: '2',
    unitId: 'unit_rpa_gram',
  },
  {
    id: 'recipe_line_rpa_rice_flour',
    versionId: 'recipe_version_rpa_rice_v1',
    sortOrder: 1,
    ingredientId: 'ingredient_rpa_flour',
    subRecipeId: null,
    quantity: '200',
    unitId: 'unit_rpa_gram',
  },
  {
    id: 'recipe_line_rpa_cycle_a',
    versionId: 'recipe_version_rpa_cycle_a_v1',
    sortOrder: 0,
    ingredientId: null,
    subRecipeId: 'recipe_rpa_cycle_b',
    quantity: '1',
    unitId: 'unit_rpa_gram',
  },
  {
    id: 'recipe_line_rpa_cycle_b',
    versionId: 'recipe_version_rpa_cycle_b_v1',
    sortOrder: 0,
    ingredientId: null,
    subRecipeId: 'recipe_rpa_cycle_a',
    quantity: '1',
    unitId: 'unit_rpa_gram',
  },
] as const;

/**
 * Settled sales for the historical window. Every bill carries `discountTotal` 0
 * and every line `compAmount` 0, so a product's net sales is simply its summed
 * `lineSubtotal`. Each order item carries `variantId` NULL: the sales reader
 * groups by variant, so one product split across two variants would arrive as two
 * report rows and change the medians the oracle pins.
 *
 * The spice-mix base and the cycle base record NO sales, exactly as the oracle
 * requires.
 */
const RPA_SALES = [
  {
    key: 'platter',
    productId: 'product_rpa_platter',
    name: 'RPA Tikka Platter',
    quantity: 3,
    lineSubtotal: '1500',
  },
  {
    key: 'cooler',
    productId: 'product_rpa_cooler',
    name: 'RPA Chai Cooler',
    quantity: 10,
    lineSubtotal: '400',
  },
  {
    key: 'rice',
    productId: 'product_rpa_rice',
    name: 'RPA Saffron Rice',
    quantity: 4,
    lineSubtotal: '600',
  },
  {
    key: 'cycle',
    productId: 'product_rpa_cycle_bowl',
    name: 'RPA Cycle Bowl',
    quantity: 2,
    lineSubtotal: '300',
  },
  {
    key: 'snack',
    productId: 'product_rpa_snack',
    name: 'RPA Unlinked Snack',
    quantity: 5,
    lineSubtotal: '100',
  },
] as const;

const rpaProducts = [
  ...RPA_RECIPES.map((recipe) => ({ id: recipe.productId, name: recipe.productName })),
  { id: RPA_SNACK.productId, name: RPA_SNACK.productName },
] as const;

export const RECIPE_PROFITABILITY_OWNED_FIXTURES = [
  ['restaurant_units', RPA_UNITS.map((unit) => unit.id)],
  ['restaurant_unit_conversions', RPA_CONVERSIONS.map((conversion) => conversion.id)],
  ['restaurant_products', rpaProducts.map((product) => product.id)],
  ['restaurant_ingredients', RPA_INGREDIENTS.map((ingredient) => ingredient.id)],
  [
    'restaurant_stock_items',
    RPA_INGREDIENTS.flatMap((ingredient) =>
      ingredient.stockItemId ? [ingredient.stockItemId] : []
    ),
  ],
  [
    'restaurant_stock_movements',
    RPA_INGREDIENTS.flatMap((ingredient) => ingredient.movements.map((movement) => movement.id)),
  ],
  ['restaurant_recipes', RPA_RECIPES.map((recipe) => recipe.id)],
  ['restaurant_recipe_versions', RPA_RECIPES.map((recipe) => recipe.versionId)],
  ['restaurant_recipe_lines', RPA_RECIPE_LINES.map((line) => line.id)],
  ['restaurant_orders', RPA_SALES.map((sale) => `order_rpa_${sale.key}`)],
  ['restaurant_order_items', RPA_SALES.map((sale) => `order_item_rpa_${sale.key}`)],
  ['restaurant_bills', RPA_SALES.map((sale) => `bill_rpa_${sale.key}`)],
  ['restaurant_bill_lines', RPA_SALES.map((sale) => `bill_line_rpa_${sale.key}`)],
] as const;

export async function seedRecipeProfitabilityFixture(
  tx: TransactionClient,
  lane: {
    branchId: string;
    /** The seeded stock location the fixture movements are booked against. */
    locationId: string;
    staffProfileId: string;
    deviceId: string;
  }
) {
  for (const unit of RPA_UNITS) {
    await tx.restaurantUnit.upsert({
      where: { id: unit.id },
      update: { name: unit.name, abbreviation: unit.abbreviation },
      create: { ...unit, createdAt: FIXED_AT, updatedAt: FIXED_AT },
    });
  }
  for (const conversion of RPA_CONVERSIONS) {
    await tx.restaurantUnitConversion.upsert({
      where: {
        fromUnitId_toUnitId: { fromUnitId: conversion.fromUnitId, toUnitId: conversion.toUnitId },
      },
      update: { factor: new Prisma.Decimal(conversion.factor) },
      create: {
        id: conversion.id,
        fromUnitId: conversion.fromUnitId,
        toUnitId: conversion.toUnitId,
        factor: new Prisma.Decimal(conversion.factor),
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
  }
  for (const product of rpaProducts) {
    await tx.restaurantProduct.upsert({
      where: { id: product.id },
      update: { name: product.name, type: 'ITEM', status: 'ACTIVE', categoryId: null },
      create: {
        id: product.id,
        name: product.name,
        type: 'ITEM',
        status: 'ACTIVE',
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
  }
  for (const ingredient of RPA_INGREDIENTS) {
    const referenceCost = ingredient.referenceCost
      ? new Prisma.Decimal(ingredient.referenceCost)
      : null;
    await tx.restaurantIngredient.upsert({
      where: { id: ingredient.id },
      update: { name: ingredient.name, baseUnitId: ingredient.baseUnitId, referenceCost },
      create: {
        id: ingredient.id,
        name: ingredient.name,
        baseUnitId: ingredient.baseUnitId,
        referenceCost,
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
    if (!ingredient.stockItemId || !ingredient.canonicalUnitId) continue;
    // isActive false: see the isolation rules in this file's header.
    await tx.restaurantStockItem.upsert({
      where: { id: ingredient.stockItemId },
      update: {
        ingredientId: ingredient.id,
        canonicalUnitId: ingredient.canonicalUnitId,
        isActive: false,
        trackBatches: false,
      },
      create: {
        id: ingredient.stockItemId,
        ingredientId: ingredient.id,
        canonicalUnitId: ingredient.canonicalUnitId,
        isActive: false,
        trackBatches: false,
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
    for (const movement of ingredient.movements) {
      const quantity = new Prisma.Decimal(movement.quantity);
      const unitCost = new Prisma.Decimal(movement.unitCost);
      await appendStockMovement(tx, {
        id: movement.id,
        stockItemId: ingredient.stockItemId,
        locationId: lane.locationId,
        reason: quantity.isNegative() ? 'RECIPE_CONSUMPTION' : 'PURCHASE_RECEIPT',
        quantity,
        unitCost,
        occurredAt: RPA_BUSINESS_DATE,
      });
    }
  }
  for (const recipe of RPA_RECIPES) {
    await tx.restaurantRecipe.upsert({
      where: { id: recipe.id },
      update: { productId: recipe.productId, variantId: null, name: recipe.name },
      create: {
        id: recipe.id,
        productId: recipe.productId,
        name: recipe.name,
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
    await tx.restaurantRecipeVersion.upsert({
      where: { id: recipe.versionId },
      // `status` defaults to DRAFT, and the WHA-1565 oracle needs the ACTIVE
      // version: the catalog console costs versions[0] ordered by versionNumber
      // DESC and the food-cost reader resolves the active version, so a DRAFT row
      // makes every figure in that spec unreachable. Set on BOTH branches.
      update: {
        recipeId: recipe.id,
        versionNumber: 1,
        status: 'ACTIVE',
        portionCount: recipe.portionCount,
        yieldQuantity: recipe.yieldQuantity ? new Prisma.Decimal(recipe.yieldQuantity) : null,
        yieldUnitId: recipe.yieldUnitId,
        activatedAt: FIXED_AT,
        supersededAt: null,
      },
      create: {
        id: recipe.versionId,
        recipeId: recipe.id,
        versionNumber: 1,
        status: 'ACTIVE',
        portionCount: recipe.portionCount,
        yieldQuantity: recipe.yieldQuantity ? new Prisma.Decimal(recipe.yieldQuantity) : null,
        yieldUnitId: recipe.yieldUnitId,
        activatedAt: FIXED_AT,
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
  }
  for (const line of RPA_RECIPE_LINES) {
    await tx.restaurantRecipeLine.upsert({
      where: { id: line.id },
      update: {
        recipeVersionId: line.versionId,
        ingredientId: line.ingredientId,
        subRecipeId: line.subRecipeId,
        quantity: new Prisma.Decimal(line.quantity),
        unitId: line.unitId,
        sortOrder: line.sortOrder,
      },
      create: {
        id: line.id,
        recipeVersionId: line.versionId,
        ingredientId: line.ingredientId,
        subRecipeId: line.subRecipeId,
        quantity: new Prisma.Decimal(line.quantity),
        unitId: line.unitId,
        sortOrder: line.sortOrder,
        createdAt: FIXED_AT,
        updatedAt: FIXED_AT,
      },
    });
  }
  for (const [index, sale] of RPA_SALES.entries()) {
    const orderId = `order_rpa_${sale.key}`;
    const orderItemId = `order_item_rpa_${sale.key}`;
    const billId = `bill_rpa_${sale.key}`;
    const billLineId = `bill_line_rpa_${sale.key}`;
    const lineSubtotal = new Prisma.Decimal(sale.lineSubtotal);
    const unitPrice = lineSubtotal.dividedBy(sale.quantity);

    await tx.restaurantOrder.upsert({
      where: { id: orderId },
      update: {
        branchId: lane.branchId,
        orderNumber: RPA_FIRST_ORDER_NUMBER + index,
        businessDate: RPA_BUSINESS_DATE,
        status: 'CLOSED',
        channel: 'DINE_IN',
        staffProfileId: lane.staffProfileId,
        deviceId: lane.deviceId,
        openedAt: RPA_BUSINESS_DATE,
        closedAt: RPA_BUSINESS_DATE,
        cancelledAt: null,
      },
      create: {
        id: orderId,
        branchId: lane.branchId,
        orderNumber: RPA_FIRST_ORDER_NUMBER + index,
        businessDate: RPA_BUSINESS_DATE,
        status: 'CLOSED',
        channel: 'DINE_IN',
        staffProfileId: lane.staffProfileId,
        deviceId: lane.deviceId,
        openedAt: RPA_BUSINESS_DATE,
        closedAt: RPA_BUSINESS_DATE,
        createdAt: RPA_BUSINESS_DATE,
        updatedAt: RPA_BUSINESS_DATE,
      },
    });
    await tx.restaurantOrderItem.upsert({
      where: { id: orderItemId },
      update: {
        orderId,
        productId: sale.productId,
        variantId: null,
        name: sale.name,
        unitPrice,
        quantity: sale.quantity,
        taxAmount: new Prisma.Decimal(0),
        serviceChargeAmount: new Prisma.Decimal(0),
        status: 'SERVED',
      },
      create: {
        id: orderItemId,
        orderId,
        productId: sale.productId,
        name: sale.name,
        unitPrice,
        quantity: sale.quantity,
        status: 'SERVED',
        createdAt: RPA_BUSINESS_DATE,
        updatedAt: RPA_BUSINESS_DATE,
      },
    });
    await tx.restaurantBill.upsert({
      where: { id: billId },
      update: {
        orderId,
        branchId: lane.branchId,
        businessDate: RPA_BUSINESS_DATE,
        status: 'SETTLED',
        subtotal: lineSubtotal,
        taxTotal: new Prisma.Decimal(0),
        serviceChargeTotal: new Prisma.Decimal(0),
        deliveryFeeTotal: new Prisma.Decimal(0),
        compTotal: new Prisma.Decimal(0),
        discountTotal: new Prisma.Decimal(0),
        roundingAdjustment: new Prisma.Decimal(0),
        grandTotal: lineSubtotal,
        settledAt: RPA_BUSINESS_DATE,
        openerStaffProfileId: lane.staffProfileId,
        deviceId: lane.deviceId,
      },
      create: {
        id: billId,
        orderId,
        branchId: lane.branchId,
        businessDate: RPA_BUSINESS_DATE,
        status: 'SETTLED',
        subtotal: lineSubtotal,
        grandTotal: lineSubtotal,
        settledAt: RPA_BUSINESS_DATE,
        openerStaffProfileId: lane.staffProfileId,
        deviceId: lane.deviceId,
        createdAt: RPA_BUSINESS_DATE,
        updatedAt: RPA_BUSINESS_DATE,
      },
    });
    await tx.restaurantBillLine.upsert({
      where: { id: billLineId },
      update: {
        billId,
        orderItemId,
        name: sale.name,
        quantity: sale.quantity,
        unitPrice,
        lineSubtotal,
        taxAmount: new Prisma.Decimal(0),
        serviceChargeAmount: new Prisma.Decimal(0),
        compAmount: new Prisma.Decimal(0),
        lineTotal: lineSubtotal,
      },
      create: {
        id: billLineId,
        billId,
        orderItemId,
        name: sale.name,
        quantity: sale.quantity,
        unitPrice,
        lineSubtotal,
        lineTotal: lineSubtotal,
        createdAt: RPA_BUSINESS_DATE,
        updatedAt: RPA_BUSINESS_DATE,
      },
    });
  }

  return {
    units: RPA_UNITS.length,
    conversions: RPA_CONVERSIONS.length,
    ingredients: RPA_INGREDIENTS.length,
    recipes: RPA_RECIPES.length,
    recipeLines: RPA_RECIPE_LINES.length,
    settledSales: RPA_SALES.length,
  };
}
