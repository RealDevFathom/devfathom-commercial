import { expect, test, type Locator, type Page, type Response } from '@playwright/test';
import pg from 'pg';

import { signInAs } from './fixtures/restaurant-actor-accessibility';
import { restaurantE2eCredentials as fixture } from './restaurant-fixture';

test.describe.configure({ mode: 'serial' });

if (process.env.RESTAURANT_INTEGRATED_E2E !== '1') {
  throw new Error('RESTAURANT_INTEGRATED_E2E=1 is required.');
}

/**
 * WHA-1565 — real-browser acceptance for Restaurant recipe costing arithmetic
 * and the dish-profitability report, including the cost-coverage surfaces that
 * make an uncosted dish visible instead of silently zero-costed.
 *
 * Everything asserted here is what the running application rendered or
 * returned. The expected figures are an INDEPENDENT hand calculation over the
 * small fixture described in `FIXTURE_CONTRACT` below: each one is derived in a
 * comment from the fixture inputs and the documented domain rules, never by
 * importing, re-running or transcribing `src/lib/restaurant/recipe-costing.ts`
 * or `src/lib/restaurant/reports.ts`. No tRPC response, report payload or
 * network route is mocked or stubbed, and this spec performs no mutation: it
 * reads the fixture back over a read-only SQL connection, then drives real UI.
 *
 * Deliberately out of scope, because each is already owned elsewhere and must
 * not be restated as a second, weaker copy:
 *   · catering order costing, production and delivery lifecycle — covered by
 *     `restaurant-catering.spec.ts` ("creates, costs, produces, delivers, and
 *     closes a catering order", which already asserts the
 *     `costPerPortionSnapshot` a catering line takes from a recipe);
 *   · the financial-comparison CSV export and its coverage panels — covered by
 *     `restaurant-financial-comparison-export.spec.ts`;
 *   · the Insights contribution scenario and its break-even arithmetic —
 *     covered by `restaurant-insights-completion.spec.ts`;
 *   · unit-level explosion/costing branches — covered by
 *     `src/lib/restaurant/recipe-costing.test.ts` and
 *     `src/lib/restaurant/reports.test.ts`. This file exists for the browser
 *     acceptance those unit suites cannot give: that the numbers actually reach
 *     the operator's screen, and that an incomplete recipe is visibly excluded
 *     rather than quietly counted as free.
 *
 * RUNTIME STATUS — AUTHORED (7 cases), EXECUTED 0. Two prerequisites are
 * outstanding, and neither is satisfied by this file:
 *
 *   1. REGISTRATION — pending shared CI/config work, not owned here.
 *      `playwright.restaurant-integrated.config.ts` matches an EXACT per-file
 *      `testMatch` list, and `.github/workflows/qa.yml` hands
 *      `scripts/run-restaurant-e2e.ts` an explicit file list. This filename is
 *      in neither, so in the only lane that sets `RESTAURANT_INTEGRATED_E2E=1`
 *      together with `DATABASE_URL` this file registers ZERO cases today.
 *      Nothing in this file should be read as a promise that an unregistered
 *      spec executes: until root adds the filename to both lists, "authored" is
 *      the honest status and no case here has run.
 *   2. FIXTURE — see `FIXTURE_CONTRACT` below; it does not exist in
 *      `scripts/seed-restaurant-e2e.ts` yet. This spec deliberately does not
 *      seed it. Manufacturing settled bills, stock movements and recipe versions
 *      by hand inside a test file would fabricate exactly the money and costing
 *      facts the spec exists to verify.
 *
 * What the file does guarantee once both prerequisites are met: every case fails
 * loudly, with the full prerequisite text, the moment the fixture is absent or
 * differs — it never skips and never reports a pass it did not earn.
 */

/** Fixed historical business date; isolates this fixture's bills from the lane's same-day traffic. */
const BUSINESS_DATE = '2026-02-17';

/**
 * Factor semantics, as the schema and the costing reader use them: a conversion
 * row `from -> to` with factor F means `quantity_in_to = quantity_in_from * F`.
 */
const rpa = {
  units: {
    gram: 'unit_rpa_gram',
    kilogram: 'unit_rpa_kilogram',
    millilitre: 'unit_rpa_millilitre',
    litre: 'unit_rpa_litre',
    portion: 'unit_rpa_portion',
  },
  conversions: [
    { fromUnitId: 'unit_rpa_kilogram', toUnitId: 'unit_rpa_gram', factor: '1000' },
    { fromUnitId: 'unit_rpa_litre', toUnitId: 'unit_rpa_millilitre', factor: '1000' },
    { fromUnitId: 'unit_rpa_gram', toUnitId: 'unit_rpa_kilogram', factor: '0.001' },
  ],
  ingredients: {
    /** Weighted-average wins: the reference cost is deliberately a DIFFERENT number. */
    chicken: {
      id: 'ingredient_rpa_chicken',
      name: 'RPA chicken',
      baseUnitId: 'unit_rpa_gram',
      referenceCost: '0.9',
      stockItemId: 'stock_item_rpa_chicken',
      canonicalUnitId: 'unit_rpa_kilogram',
      /** Σqty = 50 kg, Σ(qty×unitCost) = 38000 ⇒ 760 per kg. */
      movementQuantity: '50',
      movementValue: '38000',
    },
    /** No stock item at all ⇒ the reference cost is the only available source. */
    yoghurt: {
      id: 'ingredient_rpa_yoghurt',
      name: 'RPA yoghurt',
      baseUnitId: 'unit_rpa_millilitre',
      referenceCost: '0.25',
      stockItemId: null,
      canonicalUnitId: null,
      movementQuantity: null,
      movementValue: null,
    },
    /** Stocked but fully consumed: Σqty = 0, so weighted average is unusable and reference applies. */
    flour: {
      id: 'ingredient_rpa_flour',
      name: 'RPA flour',
      baseUnitId: 'unit_rpa_gram',
      referenceCost: '0.1',
      stockItemId: 'stock_item_rpa_flour',
      canonicalUnitId: 'unit_rpa_kilogram',
      movementQuantity: '0',
      movementValue: '0',
    },
    /** Neither source ⇒ MISSING: costed at zero and named in `missing`. */
    saffron: {
      id: 'ingredient_rpa_saffron',
      name: 'RPA saffron',
      baseUnitId: 'unit_rpa_gram',
      referenceCost: null,
      stockItemId: null,
      canonicalUnitId: null,
      movementQuantity: null,
      movementValue: null,
    },
  },
  recipes: {
    spiceMix: {
      id: 'recipe_rpa_spice_mix',
      versionId: 'recipe_version_rpa_spice_mix_v1',
      name: 'RPA spice mix BOM',
      productId: 'product_rpa_spice_mix',
      productName: 'RPA Spice Mix',
      portionCount: null,
      yieldQuantity: '6',
      yieldUnitId: 'unit_rpa_gram',
    },
    platter: {
      id: 'recipe_rpa_platter',
      versionId: 'recipe_version_rpa_platter_v1',
      name: 'RPA Tikka Platter BOM',
      productId: 'product_rpa_platter',
      productName: 'RPA Tikka Platter',
      portionCount: 5,
      yieldQuantity: '2',
      yieldUnitId: 'unit_rpa_portion',
    },
    cooler: {
      id: 'recipe_rpa_cooler',
      versionId: 'recipe_version_rpa_cooler_v1',
      name: 'RPA Chai Cooler BOM',
      productId: 'product_rpa_cooler',
      productName: 'RPA Chai Cooler',
      portionCount: 2,
      yieldQuantity: null,
      yieldUnitId: null,
    },
    rice: {
      id: 'recipe_rpa_rice',
      versionId: 'recipe_version_rpa_rice_v1',
      name: 'RPA Saffron Rice BOM',
      productId: 'product_rpa_rice',
      productName: 'RPA Saffron Rice',
      portionCount: 2,
      yieldQuantity: null,
      yieldUnitId: null,
    },
    cycleA: {
      id: 'recipe_rpa_cycle_a',
      versionId: 'recipe_version_rpa_cycle_a_v1',
      name: 'RPA Cycle Bowl BOM',
      productId: 'product_rpa_cycle_bowl',
      productName: 'RPA Cycle Bowl',
      portionCount: 1,
      yieldQuantity: null,
      yieldUnitId: null,
    },
    cycleB: {
      id: 'recipe_rpa_cycle_b',
      versionId: 'recipe_version_rpa_cycle_b_v1',
      name: 'RPA Cycle Base BOM',
      productId: 'product_rpa_cycle_base',
      productName: 'RPA Cycle Base',
      portionCount: 1,
      yieldQuantity: null,
      yieldUnitId: null,
    },
  },
  /** The product with no recipe row at all. */
  snack: { productId: 'product_rpa_snack', productName: 'RPA Unlinked Snack' },
} as const;

/**
 * Every recipe line, in `sortOrder` order. `unitId` on a SUB-RECIPE line is not
 * a conversion input — the reader divides the line quantity by the sub-recipe's
 * `yieldQuantity` and never converts it — so it is recorded here only because
 * the column is NOT NULL.
 */
const RECIPE_LINES = [
  {
    versionId: rpa.recipes.spiceMix.versionId,
    sortOrder: 0,
    ingredientId: rpa.ingredients.flour.id,
    subRecipeId: null,
    quantity: '10',
    unitId: rpa.units.gram,
  },
  {
    versionId: rpa.recipes.spiceMix.versionId,
    sortOrder: 1,
    ingredientId: rpa.ingredients.chicken.id,
    subRecipeId: null,
    quantity: '0.02',
    unitId: rpa.units.kilogram,
  },
  {
    versionId: rpa.recipes.platter.versionId,
    sortOrder: 0,
    ingredientId: rpa.ingredients.chicken.id,
    subRecipeId: null,
    quantity: '1.5',
    unitId: rpa.units.kilogram,
  },
  {
    versionId: rpa.recipes.platter.versionId,
    sortOrder: 1,
    ingredientId: rpa.ingredients.yoghurt.id,
    subRecipeId: null,
    quantity: '0.4',
    unitId: rpa.units.litre,
  },
  {
    versionId: rpa.recipes.platter.versionId,
    sortOrder: 2,
    ingredientId: null,
    subRecipeId: rpa.recipes.spiceMix.id,
    quantity: '3',
    unitId: rpa.units.gram,
  },
  {
    versionId: rpa.recipes.cooler.versionId,
    sortOrder: 0,
    ingredientId: rpa.ingredients.yoghurt.id,
    subRecipeId: null,
    quantity: '200',
    unitId: rpa.units.millilitre,
  },
  {
    versionId: rpa.recipes.rice.versionId,
    sortOrder: 0,
    ingredientId: rpa.ingredients.saffron.id,
    subRecipeId: null,
    quantity: '2',
    unitId: rpa.units.gram,
  },
  {
    versionId: rpa.recipes.rice.versionId,
    sortOrder: 1,
    ingredientId: rpa.ingredients.flour.id,
    subRecipeId: null,
    quantity: '200',
    unitId: rpa.units.gram,
  },
  {
    versionId: rpa.recipes.cycleA.versionId,
    sortOrder: 0,
    ingredientId: null,
    subRecipeId: rpa.recipes.cycleB.id,
    quantity: '1',
    unitId: rpa.units.gram,
  },
  {
    versionId: rpa.recipes.cycleB.versionId,
    sortOrder: 0,
    ingredientId: null,
    subRecipeId: rpa.recipes.cycleA.id,
    quantity: '1',
    unitId: rpa.units.gram,
  },
] as const;

/**
 * Settled sales for `BUSINESS_DATE` at the seeded branch, all with a zero bill
 * discount and zero comp, so net sales for a product is simply its summed
 * `lineSubtotal`. Products absent from this list (the spice-mix base and the
 * cycle base) must have NO settled bill lines in the window at all.
 */
const SALES = [
  {
    productId: rpa.recipes.platter.productId,
    productName: rpa.recipes.platter.productName,
    quantity: '3',
    netSales: '1500',
  },
  {
    productId: rpa.recipes.cooler.productId,
    productName: rpa.recipes.cooler.productName,
    quantity: '10',
    netSales: '400',
  },
  {
    productId: rpa.recipes.rice.productId,
    productName: rpa.recipes.rice.productName,
    quantity: '4',
    netSales: '600',
  },
  {
    productId: rpa.recipes.cycleA.productId,
    productName: rpa.recipes.cycleA.productName,
    quantity: '2',
    netSales: '300',
  },
  {
    productId: rpa.snack.productId,
    productName: rpa.snack.productName,
    quantity: '5',
    netSales: '100',
  },
] as const;

/**
 * ── THE HAND-CALCULATED ORACLE ───────────────────────────────────────────────
 *
 * Derived here, once, from the fixture above and the documented rules. Nothing
 * below re-reads production code to obtain a number.
 *
 * Per-unit ingredient costs, expressed in each ingredient's BASE unit:
 *   chicken  weighted average = 38000 / 50 = 760 per kg.
 *            Base unit is gram, stock canonical unit is kilogram, and the
 *            conversion applied is base -> canonical (g -> kg, 0.001):
 *            760 × 0.001 = 0.76 per gram. Reference cost 0.9 is NOT used.
 *   yoghurt  no stock item      ⇒ reference 0.25 per ml.
 *   flour    Σ movement qty = 0 ⇒ weighted average unusable ⇒ reference 0.1 per g.
 *   saffron  no stock, no reference ⇒ MISSING ⇒ 0 per g, and named in `missing`.
 *
 * RPA Tikka Platter BOM (one batch):
 *   chicken  1.5 kg × 1000            = 1500 g
 *   yoghurt  0.4 L  × 1000            =  400 ml
 *   sub-recipe spice mix: 3 ÷ yield 6 = 0.5 batches, so
 *       flour    10   × 0.5           =    5 g
 *       chicken  0.02 × 0.5 × 1000    =   10 g
 *   Leaves are summed PER INGREDIENT, so chicken = 1500 + 10 = 1510 g.
 *   batch cost = 1510×0.76 + 400×0.25 + 5×0.1
 *              = 1147.6   + 100      + 0.5      = 1248.1
 *   cost per portion    = 1248.1 ÷ 5 portions   =  249.62
 *   cost per yield unit = 1248.1 ÷ 2 yield      =  624.05
 *   missing = [] (nothing uncosted)
 *
 * RPA Chai Cooler BOM: 200 ml × 0.25 = 50; ÷ 2 portions = 25.
 *   No yield quantity ⇒ cost per yield unit is unavailable.
 *
 * RPA Saffron Rice BOM: saffron 2 g × 0 = 0; flour 200 g × 0.1 = 20.
 *   batch cost 20; ÷ 2 portions = 10; missing = [saffron].
 *
 * RPA Cycle Bowl BOM: A → B → A. The cycle is refused, so the recipe has no
 *   usable cost at all.
 *
 * Food-cost report over the window (report money is rounded to 2 decimals):
 *   platter  3 × 249.62 = 748.86 cost; margin 1500 − 748.86 = 751.14;
 *            margin/item 751.14 ÷ 3 = 250.38; food cost 748.86÷1500 = 49.92%
 *   cooler  10 × 25     = 250    cost; margin  400 − 250    = 150;
 *            margin/item 150 ÷ 10 = 15;      food cost 250÷400   = 62.5%
 *   rice, cycle bowl and snack are EXCLUDED, so their sales never reach the
 *   cost or margin totals — but they do reach total net sales:
 *     net sales        1500 + 400 + 600 + 300 + 100 = 2900
 *     costed net sales 1500 + 400                   = 1900
 *     uncosted         2900 − 1900                  = 1000
 *     theoretical cost 748.86 + 250                 =  998.86
 *     gross margin     1900 − 998.86                =  901.14
 *     food cost %      998.86 ÷ 1900                =   52.57%
 *
 * Dish profitability (medians over the two costed products):
 *   median volume = (3 + 10) ÷ 2 = 6.5
 *   median margin = (15 + 250.38) ÷ 2 = 132.69
 *   platter: volume 3 < 6.5 (low), margin 250.38 ≥ 132.69 (high) ⇒ PUZZLE
 *   cooler: volume 10 ≥ 6.5 (high), margin 15 < 132.69 (low)     ⇒ PLOWHORSE
 *   ⇒ stars 0, plowhorses 1, puzzles 1, dogs 0
 *   ranked by margin/item: platter, cooler.  ranked by volume: cooler, platter.
 *   Both contributions are positive, so there is no negative-contribution list.
 */
const oracle = {
  platter: { batchCost: '1248.1', costPerPortion: '249.62', costPerYieldUnit: '624.05' },
  cooler: { batchCost: '50', costPerPortion: '25', costPerYieldUnit: null },
  rice: { batchCost: '20', costPerPortion: '10', missing: [rpa.ingredients.saffron.id] },
  totals: {
    // Total net sales (2,900) is deliberately absent: the food-cost tab renders
    // only the four figures below, and the excluded 1,000 is published as its
    // own sentence rather than as a stat.
    costedNetSales: '1,900',
    uncostedNetSales: '1,000',
    theoreticalCost: '998.86',
    grossMargin: '901.14',
    foodCostPercent: '52.57',
  },
  thresholds: { medianVolume: '6.5', medianMargin: '132.69' },
  quadrantCounts: { stars: '0', plowhorses: '1', puzzles: '1', dogs: '0' },
  byMargin: [
    {
      rank: '1',
      product: rpa.recipes.platter.productName,
      quadrant: 'PUZZLE',
      volume: '3',
      marginPerItem: '250.38',
    },
    {
      rank: '2',
      product: rpa.recipes.cooler.productName,
      quadrant: 'PLOWHORSE',
      volume: '10',
      marginPerItem: '15',
    },
  ],
  byVolume: [
    {
      rank: '1',
      product: rpa.recipes.cooler.productName,
      quadrant: 'PLOWHORSE',
      volume: '10',
      marginPerItem: '15',
    },
    {
      rank: '2',
      product: rpa.recipes.platter.productName,
      quadrant: 'PUZZLE',
      volume: '3',
      marginPerItem: '250.38',
    },
  ],
  /** Costing exceptions are ordered by product name ascending. */
  exceptions: [
    {
      product: rpa.recipes.cycleA.productName,
      reason: 'Recipe has no usable active version',
      quantity: '2',
      netSales: '300',
    },
    {
      product: rpa.recipes.rice.productName,
      reason: 'Ingredient costs are incomplete (1 missing)',
      quantity: '4',
      netSales: '600',
    },
    { product: rpa.snack.productName, reason: 'No linked recipe', quantity: '5', netSales: '100' },
  ],
  /** Coverage gaps are ordered by uncosted net sales descending. */
  coverageGaps: [
    {
      product: rpa.recipes.rice.productName,
      remedy: 'Complete ingredient costs',
      quantity: '4',
      netSales: '600.00',
    },
    {
      product: rpa.recipes.cycleA.productName,
      remedy: 'Review the active recipe version',
      quantity: '2',
      netSales: '300.00',
    },
    { product: rpa.snack.productName, remedy: 'Link a recipe', quantity: '5', netSales: '100.00' },
  ],
  coverageSummary:
    '2 products with costed sales; 3 with excluded sales; 5 distinct products returned.',
} as const;

const FIXTURE_CONTRACT = [
  `Missing fixture: the WHA-1565 recipe-costing and dish-profitability fixture is not present in ${fixture.organizationId}.`,
  '',
  'This spec asserts hand-calculated figures against real application output, so it cannot run',
  'against an approximate fixture and deliberately refuses to seed one itself: manufacturing',
  'settled bills and stock movements inside the test would fabricate the very money and costing',
  'facts it exists to verify. Seed the following through the ordinary domain write paths — with the',
  'ONE documented exception called out under CYCLE PAIR below — then re-run.',
  '',
  `ISOLATION — all sales below are at branch ${fixture.branchId} on business date ${BUSINESS_DATE},`,
  "  a deliberately historical day so the lane's same-day POS traffic cannot enter the window.",
  '  No OTHER settled bill line may exist for that branch and date, and no other stock movement',
  '  may exist for stock items stock_item_rpa_chicken / stock_item_rpa_flour: the weighted-average',
  '  reader sums every movement for a stock item with no date or branch bound, so one stray row',
  '  silently changes every figure below.',
  '',
  'UNITS — unit_rpa_gram (g), unit_rpa_kilogram (kg), unit_rpa_millilitre (ml), unit_rpa_litre (L),',
  '  unit_rpa_portion (portion), plus restaurant_unit_conversions rows',
  '  kg->g factor 1000, L->ml factor 1000, and g->kg factor 0.001 (the base->canonical direction',
  '  the weighted-average path needs; without it costing raises NO_UNIT_CONVERSION).',
  '',
  'INGREDIENTS',
  '  · ingredient_rpa_chicken  base g, referenceCost 0.9000, stock item stock_item_rpa_chicken',
  '    canonical unit kg, holding movements that sum to quantity 50 and value 38000 with a',
  '    non-null unitCost (e.g. +20 @ 700 and +30 @ 800). The reference cost must stay DIFFERENT',
  '    from 0.76 so the weighted-average precedence is actually proven.',
  '  · ingredient_rpa_yoghurt  base ml, referenceCost 0.2500, NO stock item.',
  '  · ingredient_rpa_flour    base g, referenceCost 0.1000, stock item stock_item_rpa_flour',
  '    canonical unit kg, whose movements sum to quantity 0 (e.g. +10 @ 50 and -10 @ 50, BOTH',
  '    carrying unitCost — a null unitCost on the issue leaves the receipt unbalanced and the',
  '    weighted average non-zero, which breaks the reference-fallback case).',
  '  · ingredient_rpa_saffron  base g, referenceCost NULL, NO stock item.',
  '',
  'RECIPES — every recipe below carries EXACTLY ONE version, versionNumber 1, status ACTIVE.',
  '  The catalog console costs versions[0] of a recipe ordered by versionNumber DESC, so a',
  '  second version would move the console off the active one and make these figures ambiguous.',
  '  restaurant_recipes.productId is NOT NULL, so each sub-recipe needs its own product; those',
  '  products must record no sales.',
  '  Every restaurant_recipes.variantId below must be NULL. The food-cost reader resolves a',
  "  product's recipe as find(candidate.variantId === row.variantId) ?? find(candidate.variantId",
  '  === null), so a recipe bound to a product VARIANT is invisible to the variant-less sales row:',
  '  its product is excluded as NO_RECIPE outright and every total, median and quadrant below',
  '  collapses.',
  ...Object.values(rpa.recipes).map(
    (recipe) =>
      `  · ${recipe.id} (${recipe.name}) on product ${recipe.productId} "${recipe.productName}", ` +
      `version ${recipe.versionId}: portionCount ${recipe.portionCount ?? 'NULL'}, ` +
      `yieldQuantity ${recipe.yieldQuantity ?? 'NULL'}, yieldUnitId ${recipe.yieldUnitId ?? 'NULL'}`
  ),
  '  Lines (recipeVersionId, sortOrder, ingredient|sub-recipe, quantity, unit):',
  ...RECIPE_LINES.map(
    (line) =>
      `  · ${line.versionId} #${line.sortOrder} ${line.ingredientId ?? `sub:${line.subRecipeId}`} ` +
      `${line.quantity} ${line.unitId}`
  ),
  `  · ${rpa.snack.productId} "${rpa.snack.productName}" is a product with NO recipe row at all.`,
  '',
  'CYCLE PAIR — recipe_rpa_cycle_a and recipe_rpa_cycle_b close an A -> B -> A loop, and they are',
  '  the ONE part of this fixture the ordinary write path cannot produce. createRecipeLine',
  '  (src/lib/restaurant/recipes.ts) calls assertNoRecipeCycle for every sub-recipe line, and that',
  '  guard walks the sub-recipe graph across EVERY version regardless of status: the first edge is',
  '  accepted and the second is always refused, in either order, by symmetry. updateRecipeLine',
  '  cannot re-target an existing line at a different sub-recipe either, so no sequence of write-path',
  '  calls reaches the loop.',
  '  · Seed the two cycle LINES with a direct, seeder-local INSERT into restaurant_recipe_lines,',
  '    scoped to exactly these two recipe versions. That insert is fixture-only and isolated:',
  '    nothing else in this fixture may bypass a domain guard, and no runtime, API or product code',
  '    path may be given the ability to write a cyclic recipe.',
  '  · DO NOT weaken, skip, flag-gate or make assertNoRecipeCycle conditional to make this seedable.',
  "    The refusal IS the product behaviour under test elsewhere. computeRecipeCost's cycle branch",
  '    is a DEFENSIVE path for legacy or externally-introduced data that the current write layer',
  '    forbids, and this fixture exists to prove that defence still holds — which is only meaningful',
  '    while the guard stays intact.',
  '  · DO NOT substitute a different unusable recipe (a DRAFT-only version, a version with no',
  '    lines) because the loop is awkward to seed. Such a substitute still reports RECIPE_UNAVAILABLE',
  '    in the report, so the two report-level cases would keep passing while the console case',
  '    asserting "Recipe cycle detected." fails for an entirely unrelated reason.',
  '',
  `SALES — settled bills at ${fixture.branchId} on ${BUSINESS_DATE}, each with discountTotal 0 and`,
  "  compAmount 0, so a product's net sales equals its summed lineSubtotal:",
  ...SALES.map(
    (row) =>
      `  · ${row.productName} (${row.productId}) quantity ${row.quantity}, net sales ${row.netSales}`
  ),
  '  Every one of those settled order items must carry variantId NULL. The sales reader groups by',
  '  (branchId, branchName, productId, productName, variantId, categoryId, categoryName), so one',
  '  product split across two variants arrives as TWO report rows. For a product whose recipe has',
  '  already failed, the second row takes the recipeFailures early-out: its reason is never set and',
  '  it degrades to NO_PORTION_COST, adding a fourth "Costing exceptions" row and a second remedy on',
  '  the cycle bowl. A per-productId total cannot see that dimension, so it is pinned here and',
  '  verified directly in verifyFixtureSales.',
  '',
  'ACTOR — the restaurantAdmin actor (RESTAURANT_ACTOR_ADMIN_EMAIL / _PASSWORD) must reach',
  `  ${fixture.branchId} in Restaurant reports, and the organization must keep its restaurant-pos,`,
  '  menu and inventory entitlements: dish profitability renders a "Source module not enabled"',
  '  notice without all three, and "Permission required" without reports:financial.',
  '  The four catalog cases additionally require the menu:read capability on the restaurant-menu',
  '  module: restaurantCatalog.getRecipeCost is a menu:read read procedure, and the console only',
  '  issues it once its own menu:read check has passed. Without that permission the catalog renders',
  '  "You do not have permission to view the restaurant catalog.", the Version N cost panel is never',
  '  mounted, and those cases fail as a bare locator timeout with no other explanation.',
].join('\n');

/**
 * Attaches the contract to whatever actually failed, so the prerequisite reaches
 * the reader on the path that needs it instead of surfacing as a bare locator
 * timeout. The original failure is preserved verbatim and re-raised.
 */
async function withContract<T>(step: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    const original = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
    throw new Error(`${step} failed.\n\n${FIXTURE_CONTRACT}\n\n${original}`, { cause });
  }
}

// ── Read-only fixture verification ───────────────────────────────────────────

let pool: pg.Pool;

/**
 * A read-only tenant-scoped query. The transaction is always rolled back: this
 * spec inspects the fixture and never writes to it.
 */
async function tenantQuery<T extends pg.QueryResultRow>(text: string, values: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(
      `SELECT set_config('app.current_organization_id', $1, true),
              set_config('app.is_platform_admin', 'false', true)`,
      [fixture.organizationId]
    );
    const result = await client.query<T>(text, values);
    return result.rows;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** Numeric equality that ignores harmless scale differences ("0.76" vs "0.7600"). */
function sameNumber(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return Number(left) === Number(right);
}

function expectSameNumber(actual: string | null, expected: string | null, what: string) {
  expect(
    sameNumber(actual, expected),
    `${what}: expected ${expected ?? 'NULL'}, fixture holds ${actual ?? 'NULL'}\n\n${FIXTURE_CONTRACT}`
  ).toBe(true);
}

/**
 * Proves the fixture the hand calculation assumes is the fixture the database
 * actually holds. Without this, every figure below would merely assert that the
 * application agrees with itself about unknown inputs.
 */
async function verifyFixtureInputs() {
  const conversions = await tenantQuery<{ fromUnitId: string; toUnitId: string; factor: string }>(
    `SELECT "fromUnitId", "toUnitId", factor::text FROM restaurant_unit_conversions
      WHERE "fromUnitId" = ANY($1) AND "toUnitId" = ANY($1)`,
    [[...new Set(Object.values(rpa.units))]]
  );
  for (const expected of rpa.conversions) {
    const found = conversions.find(
      (row) => row.fromUnitId === expected.fromUnitId && row.toUnitId === expected.toUnitId
    );
    expect(
      found,
      `missing unit conversion ${expected.fromUnitId} -> ${expected.toUnitId}\n\n${FIXTURE_CONTRACT}`
    ).toBeTruthy();
    expectSameNumber(
      found!.factor,
      expected.factor,
      `conversion ${expected.fromUnitId}->${expected.toUnitId}`
    );
  }

  const ingredients = await tenantQuery<{
    id: string;
    baseUnitId: string;
    referenceCost: string | null;
    stockItemId: string | null;
    canonicalUnitId: string | null;
  }>(
    `SELECT i.id, i."baseUnitId", i."referenceCost"::text AS "referenceCost",
            s.id AS "stockItemId", s."canonicalUnitId"
       FROM restaurant_ingredients i
       LEFT JOIN restaurant_stock_items s ON s."ingredientId" = i.id
      WHERE i.id = ANY($1)`,
    [Object.values(rpa.ingredients).map((ingredient) => ingredient.id)]
  );
  for (const expected of Object.values(rpa.ingredients)) {
    const found = ingredients.find((row) => row.id === expected.id);
    expect(found, `missing ingredient ${expected.id}\n\n${FIXTURE_CONTRACT}`).toBeTruthy();
    expect(found!.baseUnitId, `${expected.id} base unit\n\n${FIXTURE_CONTRACT}`).toBe(
      expected.baseUnitId
    );
    expectSameNumber(found!.referenceCost, expected.referenceCost, `${expected.id} reference cost`);
    expect(found!.stockItemId, `${expected.id} stock item\n\n${FIXTURE_CONTRACT}`).toBe(
      expected.stockItemId
    );
    expect(found!.canonicalUnitId, `${expected.id} canonical unit\n\n${FIXTURE_CONTRACT}`).toBe(
      expected.canonicalUnitId
    );
  }

  // Only the two aggregates the weighted average is built from, so this reads
  // the ledger rather than restating how a weighted average is computed.
  const movements = await tenantQuery<{ stockItemId: string; quantity: string; value: string }>(
    `SELECT "stockItemId",
            COALESCE(SUM(quantity), 0)::text AS quantity,
            COALESCE(SUM(quantity * "unitCost"), 0)::text AS value
       FROM restaurant_stock_movements
      WHERE "stockItemId" = ANY($1) AND "unitCost" IS NOT NULL
      GROUP BY "stockItemId"`,
    [[rpa.ingredients.chicken.stockItemId, rpa.ingredients.flour.stockItemId]]
  );
  for (const expected of [rpa.ingredients.chicken, rpa.ingredients.flour]) {
    const found = movements.find((row) => row.stockItemId === expected.stockItemId);
    const quantity = found?.quantity ?? '0';
    const value = found?.value ?? '0';
    expectSameNumber(
      quantity,
      expected.movementQuantity,
      `${expected.stockItemId} costed movement quantity`
    );
    expectSameNumber(
      value,
      expected.movementValue,
      `${expected.stockItemId} costed movement value`
    );
  }

  const versions = await tenantQuery<{
    recipeId: string;
    id: string;
    versionCount: string;
    status: string;
    portionCount: number | null;
    yieldQuantity: string | null;
    yieldUnitId: string | null;
    recipeVariantId: string | null;
  }>(
    `SELECT v."recipeId", v.id, v.status, v."portionCount",
            v."yieldQuantity"::text AS "yieldQuantity", v."yieldUnitId",
            r."variantId" AS "recipeVariantId",
            COUNT(*) OVER (PARTITION BY v."recipeId")::text AS "versionCount"
       FROM restaurant_recipe_versions v
       JOIN restaurant_recipes r ON r.id = v."recipeId"
      WHERE v."recipeId" = ANY($1)`,
    [Object.values(rpa.recipes).map((recipe) => recipe.id)]
  );
  for (const expected of Object.values(rpa.recipes)) {
    const found = versions.find((row) => row.recipeId === expected.id);
    expect(found, `missing recipe version for ${expected.id}\n\n${FIXTURE_CONTRACT}`).toBeTruthy();
    expect(
      found!.versionCount,
      `${expected.id} must hold exactly one version\n\n${FIXTURE_CONTRACT}`
    ).toBe('1');
    expect(found!.id, `${expected.id} version id\n\n${FIXTURE_CONTRACT}`).toBe(expected.versionId);
    expect(found!.status, `${expected.id} version status\n\n${FIXTURE_CONTRACT}`).toBe('ACTIVE');
    // The report resolves a recipe by variant first and only then falls back to a
    // variant-less one, so a variant-bound recipe would leave its product
    // excluded as NO_RECIPE — silently voiding every total in the oracle.
    expect(
      found!.recipeVariantId,
      `${expected.id} must not be bound to a product variant\n\n${FIXTURE_CONTRACT}`
    ).toBeNull();
    expect(found!.portionCount, `${expected.id} portion count\n\n${FIXTURE_CONTRACT}`).toBe(
      expected.portionCount
    );
    expectSameNumber(found!.yieldQuantity, expected.yieldQuantity, `${expected.id} yield quantity`);
    expect(found!.yieldUnitId, `${expected.id} yield unit\n\n${FIXTURE_CONTRACT}`).toBe(
      expected.yieldUnitId
    );
  }

  const lines = await tenantQuery<{
    recipeVersionId: string;
    sortOrder: number;
    ingredientId: string | null;
    subRecipeId: string | null;
    quantity: string;
    unitId: string;
  }>(
    `SELECT "recipeVersionId", "sortOrder", "ingredientId", "subRecipeId",
            quantity::text, "unitId"
       FROM restaurant_recipe_lines WHERE "recipeVersionId" = ANY($1)`,
    [Object.values(rpa.recipes).map((recipe) => recipe.versionId)]
  );
  expect(
    lines.length,
    `the fixture recipes must hold exactly ${RECIPE_LINES.length} lines\n\n${FIXTURE_CONTRACT}`
  ).toBe(RECIPE_LINES.length);
  for (const expected of RECIPE_LINES) {
    const found = lines.find(
      (row) => row.recipeVersionId === expected.versionId && row.sortOrder === expected.sortOrder
    );
    const label = `${expected.versionId} line #${expected.sortOrder}`;
    expect(found, `missing ${label}\n\n${FIXTURE_CONTRACT}`).toBeTruthy();
    expect(found!.ingredientId, `${label} ingredient\n\n${FIXTURE_CONTRACT}`).toBe(
      expected.ingredientId
    );
    expect(found!.subRecipeId, `${label} sub-recipe\n\n${FIXTURE_CONTRACT}`).toBe(
      expected.subRecipeId
    );
    expect(found!.unitId, `${label} unit\n\n${FIXTURE_CONTRACT}`).toBe(expected.unitId);
    expectSameNumber(found!.quantity, expected.quantity, `${label} quantity`);
  }
}

/**
 * Raw settled-sales facts for the window. This reads bill lines directly and
 * checks the discount and comp are zero, so the hand oracle can treat net sales
 * as the summed line subtotal WITHOUT copying the reader's allocation SQL.
 *
 * Zero is asserted per row with `bool_and(... = 0)` rather than as a SUM: a sum
 * cannot distinguish "every discount is zero" from two discounts of +5 and -5
 * that happen to cancel, and only the former licenses the oracle's net-sales
 * shortcut.
 *
 * The grouping deliberately carries `variantId`, which is the dimension the
 * report's sales reader groups by and a per-product total cannot see. Pinning it
 * NULL here is what stops a contract-conforming fixture from splitting one
 * product into two report rows — and, for an already-failed recipe, degrading the
 * second row's exclusion reason to NO_PORTION_COST.
 *
 * It also proves the window holds nothing else: a stray bill would change the
 * medians and quadrants without changing any single assertion's shape.
 */
async function verifyFixtureSales() {
  const rows = await tenantQuery<{
    productId: string;
    variantId: string | null;
    quantity: string;
    lineSubtotal: string;
    zeroComp: boolean;
    zeroDiscount: boolean;
  }>(
    `SELECT item."productId",
            item."variantId",
            SUM(line.quantity)::text AS quantity,
            SUM(line."lineSubtotal")::text AS "lineSubtotal",
            bool_and(line."compAmount" = 0) AS "zeroComp",
            bool_and(bill."discountTotal" = 0) AS "zeroDiscount"
       FROM restaurant_bills bill
       JOIN restaurant_bill_lines line ON line."billId" = bill.id
       JOIN restaurant_order_items item ON item.id = line."orderItemId"
      WHERE bill.status = 'SETTLED'
        AND bill."branchId" = $1
        AND bill."businessDate" = $2::date
      GROUP BY item."productId", item."variantId"`,
    [fixture.branchId, BUSINESS_DATE]
  );
  expect(
    rows.filter((row) => row.variantId !== null).map((row) => `${row.productId}/${row.variantId}`),
    `every settled fixture order item must carry variantId NULL, or the report splits the product ` +
      `into rows this oracle does not describe\n\n${FIXTURE_CONTRACT}`
  ).toEqual([]);
  expect(
    rows.map((row) => row.productId).sort(),
    `the ${BUSINESS_DATE} window at ${fixture.branchId} must hold exactly the fixture's five ` +
      `products, one row each, and nothing else\n\n${FIXTURE_CONTRACT}`
  ).toEqual(SALES.map((row) => row.productId).sort());
  for (const expected of SALES) {
    const found = rows.find((row) => row.productId === expected.productId)!;
    expectSameNumber(found.quantity, expected.quantity, `${expected.productName} settled quantity`);
    expectSameNumber(
      found.lineSubtotal,
      expected.netSales,
      `${expected.productName} settled line subtotal`
    );
    expect(
      found.zeroComp,
      `every ${expected.productName} bill line must carry compAmount exactly 0\n\n${FIXTURE_CONTRACT}`
    ).toBe(true);
    expect(
      found.zeroDiscount,
      `every bill carrying ${expected.productName} must carry discountTotal exactly 0 — offsetting ` +
        `discounts that merely sum to zero do not qualify\n\n${FIXTURE_CONTRACT}`
    ).toBe(true);
  }
}

// ── Rendering helpers ────────────────────────────────────────────────────────

function normalize(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * The report formats figures with `toLocaleString`, so a non-English runner
 * would render "1.500" or "1 500" and every money expectation here would be
 * wrong for a reason that has nothing to do with costing. Make the assumption
 * explicit and self-checking instead of silent.
 */
async function requireEnglishNumberFormatting(page: Page) {
  const locale = await page.evaluate(() => Intl.NumberFormat().resolvedOptions().locale);
  expect(
    locale.startsWith('en'),
    `this spec's rendered figures assume English grouping; the browser resolved "${locale}". ` +
      'Run the lane with an en-* locale, or re-derive the expected strings for that locale.'
  ).toBe(true);
}

function profitabilityCard(page: Page): Locator {
  return page.locator('[data-slot="section-card"]', {
    has: page.getByRole('heading', { name: 'Profitability', exact: true, level: 2 }),
  });
}

function statValue(scope: Locator, label: string): Locator {
  return scope
    .locator('[data-slot="stat"]')
    .filter({ has: scope.page().getByText(label, { exact: true }) })
    .locator('.stat-figure');
}

/** Every cell of a region's table body rows, in document order. */
async function regionRows(scope: Locator, label: string): Promise<string[][]> {
  const rows = scope.getByRole('region', { name: label, exact: true }).locator('tbody tr');
  const rendered: string[][] = [];
  for (let index = 0; index < (await rows.count()); index += 1) {
    const cells = await rows.nth(index).locator('th, td').allInnerTexts();
    rendered.push(cells.map(normalize));
  }
  return rendered;
}

/** Notices the profitability card renders INSTEAD of a result. */
const PROFITABILITY_NOTICE =
  /^(Permission required|Source module not enabled|Section could not load|No matching data)/u;

async function requireRenderedProfitability(card: Locator) {
  const notices = (await card.getByText(PROFITABILITY_NOTICE).allInnerTexts()).map(normalize);
  expect(
    notices,
    `the authorized profitability card must render results, not a notice\n\n${FIXTURE_CONTRACT}`
  ).toEqual([]);
}

/**
 * Loads the reports page and scopes it to the fixture window through the real
 * filter form, then waits for the server to answer with those exact filters.
 */
async function applyFixtureWindow(page: Page, origin: string) {
  await page.goto(new URL('/restaurant/reports', origin).href);
  await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
  const filters = page.locator('[data-slot="section-card"]', {
    has: page.getByRole('heading', { name: 'Report filters', exact: true, level: 2 }),
  });
  // The branch filter is a `<select>` WRAPPED by its `<label>` with no `htmlFor`
  // (`restaurant/reports/page.tsx`). Playwright folds the whole label subtree —
  // every `<option>` included — into the computed accessible name, so that name
  // is `"BranchAll active branchesGulberg Café…"` and `getByLabel('Branch',
  // { exact: true })` matches NOTHING; it does not fail fast, it waits out the
  // test timeout. It is addressed by the field name the page's own GET form
  // reads, and the visible caption is asserted separately so that half of the
  // label contract keeps its coverage. The two date controls are bare `<input>`s,
  // which contribute no text, so their exact label locators stand.
  const branchFilter = filters.locator('select[name="branch"]');
  await expect(
    filters.locator('label:has(select[name="branch"])'),
    'the branch filter must stay labelled "Branch"'
  ).toContainText('Branch');
  await branchFilter.selectOption(fixture.branchId);
  await filters.getByLabel('From date', { exact: true }).fill(BUSINESS_DATE);
  await filters.getByLabel('To date', { exact: true }).fill(BUSINESS_DATE);
  await filters.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await page.waitForURL((url) => {
    const applied = url.searchParams;
    return (
      url.pathname === '/restaurant/reports' &&
      applied.get('branch') === fixture.branchId &&
      applied.get('from') === BUSINESS_DATE &&
      applied.get('to') === BUSINESS_DATE
    );
  });
  await requireEnglishNumberFormatting(page);
}

// ── Catalog console helpers ──────────────────────────────────────────────────

type BatchEnvelope = {
  result?: { data?: unknown };
  error?: { json?: { message?: string; data?: { code?: string; httpStatus?: number } } };
};

/**
 * The client batches procedures into one request, so the response body is an
 * array positionally aligned with the comma-separated procedure list in the
 * path. A verdict must therefore be read for THIS procedure's slot: judging the
 * request as a whole would let a sibling procedure's success or failure stand in
 * for the recipe-cost answer.
 */
function batchEntry(response: Response, procedure: string, body: unknown): BatchEnvelope {
  const path = decodeURIComponent(new URL(response.url()).pathname);
  const procedures = (path.split('/api/trpc/')[1] ?? '').split(',');
  const index = procedures.indexOf(procedure);
  expect(index, `${procedure} is not part of the batch path ${path}`).toBeGreaterThanOrEqual(0);
  expect(Array.isArray(body), `a batched tRPC response must be an array; got ${typeof body}`).toBe(
    true
  );
  const entry = (body as BatchEnvelope[])[index];
  expect(entry, `the batch response has no entry at slot ${index} for ${procedure}`).toBeTruthy();
  return entry!;
}

async function openRecipe(page: Page, origin: string, recipe: { name: string }) {
  await page.goto(new URL('/restaurant/catalog', origin).href);
  await withContract(`Opening the catalog Recipes tab for ${recipe.name}`, async () => {
    await page.getByRole('tab', { name: /^Recipes \(\d+\)$/u }).click();
    await expect(page.getByRole('cell', { name: recipe.name, exact: true })).toBeVisible();
  });
  const row = page.getByRole('row').filter({
    has: page.getByRole('cell', { name: recipe.name, exact: true }),
  });
  const costResponse = page.waitForResponse(
    (response) => response.url().includes('restaurantCatalog.getRecipeCost'),
    { timeout: 30_000 }
  );
  await row.getByRole('button', { name: 'Manage versions', exact: true }).click();
  return await costResponse;
}

/**
 * The per-procedure verdict for `getRecipeCost`, with the only claim the
 * TRANSPORT can honestly carry: a batch's HTTP status is the shared status of
 * its entries or 207 when they differ, so it cannot stand in for one
 * procedure's outcome. Anything at or above 500 is a server fault on any
 * reading, and that IS worth refusing here.
 */
async function recipeCostVerdict(response: Response): Promise<BatchEnvelope> {
  expect(response.status(), 'a recipe cost answer must never be a server fault').toBeLessThan(500);
  return batchEntry(response, 'restaurantCatalog.getRecipeCost', await response.json());
}

/** The `Version N cost` panel's definition list, keyed by its own labels. */
function costFigure(page: Page, label: string): Locator {
  return page
    .locator('div')
    .filter({ has: page.getByText(label, { exact: true }) })
    .last()
    .locator('dd')
    .first();
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

test.beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  expect(databaseUrl, 'the integrated lane requires DATABASE_URL').toBeTruthy();
  pool = new pg.Pool({ connectionString: databaseUrl });
  // Fails the whole file, loudly and once, when the fixture is absent — rather
  // than letting each case die on an unrelated locator timeout.
  await verifyFixtureInputs();
  await verifyFixtureSales();
});

test.afterAll(async () => {
  await pool?.end();
});

test.describe('Restaurant recipe costing arithmetic', () => {
  test('a mixed-unit recipe with a sub-recipe costs to its hand-calculated batch, portion and yield figures', async ({
    page,
  }) => {
    const origin = await signInAs(page, 'restaurantAdmin');

    // The API answer first, so a wrong figure is attributable to costing rather
    // than to rendering.
    const entry = await recipeCostVerdict(await openRecipe(page, origin, rpa.recipes.platter));
    expect(entry.error, `getRecipeCost failed: ${JSON.stringify(entry.error)}`).toBeUndefined();

    // Then the operator-visible figures, which is what this file exists to prove.
    await withContract('Reading the platter recipe cost panel', async () => {
      await expect(costFigure(page, 'Batch cost')).toHaveText(oracle.platter.batchCost);
    });
    await expect(costFigure(page, 'Cost per portion')).toHaveText(oracle.platter.costPerPortion);
    await expect(costFigure(page, 'Cost per yield unit')).toHaveText(
      oracle.platter.costPerYieldUnit
    );
    // 1510 g of chicken is 1500 g direct plus 10 g through the sub-recipe: the
    // weighted average (0.76/g), not the 0.9/g reference, produced 1147.6 of the
    // 1248.1 batch. A reference-priced chicken would have shown 1359 + 100 + 0.5
    // = 1459.5 here, so this single figure pins both the sub-recipe explosion and
    // the weighted-average precedence.
    await expect(
      page.getByText('Missing cost', { exact: true }),
      'a fully costed recipe must not raise a missing-cost warning'
    ).toHaveCount(0);
  });

  test('a recipe with no yield quantity reports no cost per yield unit', async ({ page }) => {
    const origin = await signInAs(page, 'restaurantAdmin');
    const entry = await recipeCostVerdict(await openRecipe(page, origin, rpa.recipes.cooler));
    expect(entry.error, `getRecipeCost failed: ${JSON.stringify(entry.error)}`).toBeUndefined();

    await withContract('Reading the cooler recipe cost panel', async () => {
      await expect(costFigure(page, 'Batch cost')).toHaveText(oracle.cooler.batchCost);
    });
    await expect(costFigure(page, 'Cost per portion')).toHaveText(oracle.cooler.costPerPortion);
    // Division by an absent yield is reported as unavailable, never as zero.
    await expect(costFigure(page, 'Cost per yield unit')).toHaveText('Not available');
  });

  test('an ingredient with neither a stocked nor a reference cost is named, not silently zeroed', async ({
    page,
  }) => {
    const origin = await signInAs(page, 'restaurantAdmin');
    const entry = await recipeCostVerdict(await openRecipe(page, origin, rpa.recipes.rice));
    expect(entry.error, `getRecipeCost failed: ${JSON.stringify(entry.error)}`).toBeUndefined();

    // 20 is the flour line alone (200 g × 0.1). The saffron line contributed 0
    // because it has no cost at all — and the panel says so rather than letting
    // the operator read 20 as a complete cost.
    await withContract('Reading the rice recipe cost panel', async () => {
      await expect(costFigure(page, 'Batch cost')).toHaveText(oracle.rice.batchCost);
    });
    await expect(costFigure(page, 'Cost per portion')).toHaveText(oracle.rice.costPerPortion);
    await expect(page.getByText('Missing cost', { exact: true })).toBeVisible();
    await expect(page.getByText(oracle.rice.missing.join(', '), { exact: true })).toBeVisible();
  });

  test('a recipe that references itself through a sub-recipe is refused as a client error', async ({
    page,
  }) => {
    const origin = await signInAs(page, 'restaurantAdmin');
    const entry = await recipeCostVerdict(await openRecipe(page, origin, rpa.recipes.cycleA));
    // A cycle is a data problem, not a server fault: it must come back as a 400
    // BAD_REQUEST with the domain message, never a 500 and never a silent zero.
    expect(entry.result, 'a cycle must not yield a cost payload').toBeUndefined();
    expect(entry.error?.json?.data?.code).toBe('BAD_REQUEST');
    expect(entry.error?.json?.data?.httpStatus).toBe(400);
    expect(entry.error?.json?.message).toBe('Recipe cycle detected.');

    // The console retries a non-authorization failure three times with backoff
    // before it surrenders, so the visible error legitimately lands seconds after
    // the first response; this is a bounded wait on a real state, not a sleep.
    const alert = page.getByRole('alert').filter({ hasText: 'Recipe cycle detected.' });
    await expect(alert).toBeVisible({ timeout: 30_000 });
    const recalculate = alert.getByRole('button', { name: 'Recalculate', exact: true });
    await expect(recalculate).toBeVisible();
    const recalculated = page.waitForResponse((response) =>
      response.url().includes('restaurantCatalog.getRecipeCost')
    );
    await recalculate.click();
    const retry = await recipeCostVerdict(await recalculated);
    expect(retry.result).toBeUndefined();
    expect(retry.error?.json?.data?.code).toBe('BAD_REQUEST');
    expect(retry.error?.json?.data?.httpStatus).toBe(400);
    expect(retry.error?.json?.message).toBe('Recipe cycle detected.');
    await expect(alert).toBeVisible();
    await expect(
      page.getByText('Missing cost', { exact: true }),
      'a refused cost is not a missing-ingredient warning'
    ).toHaveCount(0);
  });
});

test.describe('Restaurant dish profitability report', () => {
  test('the dish profitability tab ranks and classifies exactly the fully costed dishes', async ({
    page,
  }) => {
    const origin = await signInAs(page, 'restaurantAdmin');
    await applyFixtureWindow(page, origin);
    const card = profitabilityCard(page);
    await withContract('Opening the dish profitability tab', async () => {
      await card.getByRole('tab', { name: 'Dish profitability', exact: true }).click();
      await expect(card.getByRole('heading', { name: 'Ranked by margin per item' })).toBeVisible();
    });
    await requireRenderedProfitability(card);

    // Medians are taken over the two costed dishes only; the three excluded ones
    // never enter the thresholds, which is what makes 6.5 and 132.69 correct.
    await expect(statValue(card, 'Median volume')).toHaveText(oracle.thresholds.medianVolume);
    await expect(statValue(card, 'Median margin / item')).toHaveText(
      oracle.thresholds.medianMargin
    );
    await expect(statValue(card, 'Stars')).toHaveText(oracle.quadrantCounts.stars);
    await expect(statValue(card, 'Plowhorses')).toHaveText(oracle.quadrantCounts.plowhorses);
    await expect(statValue(card, 'Puzzles')).toHaveText(oracle.quadrantCounts.puzzles);
    await expect(statValue(card, 'Dogs')).toHaveText(oracle.quadrantCounts.dogs);

    // Rank, quadrant and both figures per row, in the order the page rendered
    // them: a ranking that agrees on values but not on order is still wrong.
    expect(await regionRows(card, 'Ranked by margin per item')).toEqual(
      oracle.byMargin.map((row) => [
        row.rank,
        row.product,
        row.quadrant,
        row.volume,
        row.marginPerItem,
      ])
    );
    expect(await regionRows(card, 'Ranked by volume')).toEqual(
      oracle.byVolume.map((row) => [
        row.rank,
        row.product,
        row.quadrant,
        row.volume,
        row.marginPerItem,
      ])
    );
  });

  test('uncosted dishes are excluded from margin totals and published as costing exceptions', async ({
    page,
  }) => {
    const origin = await signInAs(page, 'restaurantAdmin');
    await applyFixtureWindow(page, origin);
    const card = profitabilityCard(page);
    await withContract('Opening the food cost tab', async () => {
      await card.getByRole('tab', { name: 'Food cost', exact: true }).click();
      await expect(card.getByRole('heading', { name: 'Costing exceptions' })).toBeVisible();
    });
    await requireRenderedProfitability(card);

    // The excluded 1,000 stays inside total net sales and outside every cost and
    // margin figure. This is the whole point of the coverage contract: unknown
    // cost is never treated as zero cost.
    await expect(statValue(card, 'Costed net sales')).toHaveText(oracle.totals.costedNetSales);
    await expect(statValue(card, 'Theoretical food cost')).toHaveText(
      oracle.totals.theoreticalCost
    );
    await expect(statValue(card, 'Food cost')).toHaveText(`${oracle.totals.foodCostPercent}%`);
    await expect(statValue(card, 'Gross margin')).toHaveText(oracle.totals.grossMargin);
    await expect(
      card.getByText(
        `${oracle.totals.uncostedNetSales} in net sales is excluded from margin totals until these recipes are complete.`,
        { exact: true }
      )
    ).toBeVisible();

    // One row per excluded product, each naming the specific remedy: a missing
    // recipe, an unusable one (the cycle), and incomplete ingredient costs with
    // the count of ingredients still uncosted.
    const rows = await regionRows(card, 'Products excluded from food-cost totals');
    expect(rows.map((cells) => [cells[0], cells[2], cells[3], cells[4]])).toEqual(
      oracle.exceptions.map((row) => [row.product, row.reason, row.quantity, row.netSales])
    );
  });

  test('the recipe review panel ranks cost-coverage gaps by the sales they exclude', async ({
    page,
  }) => {
    const origin = await signInAs(page, 'restaurantAdmin');
    await applyFixtureWindow(page, origin);
    const card = profitabilityCard(page);
    await withContract('Opening the dish profitability tab', async () => {
      await card.getByRole('tab', { name: 'Dish profitability', exact: true }).click();
      await expect(card.getByRole('heading', { name: 'Recipe review priorities' })).toBeVisible();
    });
    const panel = card.locator('[data-slot="section-card"]', {
      has: page.getByRole('heading', { name: 'Recipe review priorities', exact: true }),
    });

    await expect(panel.getByText(oracle.coverageSummary, { exact: false })).toBeVisible();
    await expect(
      panel.getByText(
        `Top ${oracle.coverageGaps.length} of ${oracle.coverageGaps.length} products with excluded sales.`,
        {
          exact: false,
        }
      )
    ).toBeVisible();

    // Both costed dishes contribute positively (751.14 and 150), so the panel has
    // no negative ranking to show — and says so instead of rendering an empty
    // table that could read as "nothing is wrong".
    await expect(
      panel.getByText('No known negative contributions in returned costed sales.', { exact: false })
    ).toBeVisible();

    // Gaps are ranked by excluded sales, not by product name, so the rice dish
    // (600) outranks the cycle bowl (300) and the unlinked snack (100). The
    // amounts carry the page's own currency prefix, read from the panel rather
    // than assumed.
    const currency = await withContract('Reading the panel currency', async () => {
      const header = normalize(
        await panel
          .getByText(/· Business dates$/u)
          .first()
          .innerText()
      );
      const match = /·\s([^·]+)\s·\sBusiness dates$/u.exec(header);
      expect(match, `unreadable coverage header: ${header}`).toBeTruthy();
      return match![1]!.trim();
    });
    const rows = await regionRows(panel, 'Cost coverage priorities');
    expect(rows.map((cells) => [normalize(cells[0]!), cells[1], cells[2]])).toEqual(
      oracle.coverageGaps.map((row) => [
        `${row.product} ${row.remedy}`,
        row.quantity,
        `${currency} ${row.netSales}`,
      ])
    );
  });
});
