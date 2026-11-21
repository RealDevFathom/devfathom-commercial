import { chooseSelectField } from './fixtures/select-field';
import { expect, test, type Locator, type Page } from '@playwright/test';
import pg from 'pg';

import { actorFixture, signInAs } from './fixtures/restaurant-actor-accessibility';
import { restaurantE2eCredentials as fixture } from './restaurant-fixture';

/**
 * WHA-1319 — acceptance coverage for the catering behaviours that
 * `restaurant-catering.spec.ts` does NOT reach. That file already proves the
 * happy quote → confirm → production → ready → delivered → close journey, the
 * confirm-time `costPerPortionSnapshot` values, the ready-time
 * RECIPE_CONSUMPTION postings and the READY → CANCELLED reversal. Nothing here
 * repeats those assertions. What is uncovered, and what this file proves:
 *
 *   1. "Frozen" costing actually freezes. The confirm-time snapshot is only
 *      meaningful if a LATER ingredient reference-cost change cannot move the
 *      confirmed order's cost summary. Proved against a same-recipe control
 *      order left unconfirmed, which MUST reprice on the same change — without
 *      that control the freeze assertion would pass even if the cost change
 *      never landed.
 *   2. Cancelling BEFORE production posts no stock movements at all (the
 *      consumption seam is `IN_PRODUCTION → READY` only), and a cancelled order
 *      exposes no further lifecycle affordance.
 *   3. `DELIVERED → CANCELLED` reverses consumption. The covered reversal path
 *      is `READY → CANCELLED`; `DELIVERED` is a distinct branch in
 *      `restaurantCatering.transition`. Reconciliation is asserted against the
 *      FULL append-only ledger balance for these stock items, not only against
 *      the two idempotency-keyed batches.
 *
 * Fixture contract (all IDs are exclusive to this file so that mutating an
 * ingredient's `referenceCost` in test 1 cannot disturb the neighbouring
 * catering spec's shared fixture):
 *   - `DATABASE_URL` must point at the integrated Restaurant E2E database and
 *     the application under test must be served from that same database.
 *   - `RESTAURANT_INTEGRATED_E2E=1`.
 *   - `RESTAURANT_ACTOR_ADMIN_EMAIL` / `RESTAURANT_ACTOR_ADMIN_PASSWORD` for the
 *     `chai-chowk.localhost` administrator with `catering:read` + `catering:manage`.
 *   - The seeded organization/branch/customer from `restaurantE2eCredentials`.
 * A missing prerequisite throws at load or fails the run; nothing here skips.
 */

test.describe.configure({ mode: 'serial' });

if (process.env.RESTAURANT_INTEGRATED_E2E !== '1') {
  throw new Error(
    'RESTAURANT_INTEGRATED_E2E=1 is required for restaurant-catering-lifecycle-acceptance.spec.ts.'
  );
}
if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL (the integrated Restaurant E2E database) is required for restaurant-catering-lifecycle-acceptance.spec.ts.'
  );
}
if (!actorFixture.restaurantAdmin.email || !actorFixture.restaurantAdmin.password) {
  throw new Error(
    'RESTAURANT_ACTOR_ADMIN_EMAIL and RESTAURANT_ACTOR_ADMIN_PASSWORD are required for restaurant-catering-lifecycle-acceptance.spec.ts.'
  );
}

/**
 * One gram-denominated recipe whose active version yields ONE portion, so
 * `costPerPortion` is exactly the sum of the reference-costed lines:
 * 40 g × 0.0300 + 200 g × 0.0050 = 1.2000 + 1.0000 = 2.2000 per portion.
 * Raising the chicken reference cost to 0.0900 moves that to
 * 40 × 0.0900 + 1.0000 = 4.6000 per portion for anything not yet frozen.
 */
const acceptance = {
  gramUnitId: 'unit_restaurant_e2e_catering_acceptance_g',
  product: {
    id: 'product_restaurant_e2e_catering_acceptance_tray',
    name: 'Acceptance catering tray',
  },
  recipe: {
    id: 'recipe_restaurant_e2e_catering_acceptance_tray',
    name: 'Acceptance catering tray BOM',
  },
  recipeVersionId: 'recipe_version_restaurant_e2e_catering_acceptance_tray_v1',
  fallbackStockLocationId: 'stock_location_restaurant_e2e_catering_acceptance',
  costPerPortionSnapshot: '2.2000',
  ingredients: [
    {
      id: 'ingredient_restaurant_e2e_catering_acceptance_chicken',
      stockItemId: 'stock_item_restaurant_e2e_catering_acceptance_chicken',
      recipeLineId: 'recipe_line_restaurant_e2e_catering_acceptance_chicken',
      name: 'Acceptance catering chicken',
      referenceCost: '0.0300',
      raisedReferenceCost: '0.0900',
      quantityPerPortion: '40.0000',
    },
    {
      id: 'ingredient_restaurant_e2e_catering_acceptance_rice',
      stockItemId: 'stock_item_restaurant_e2e_catering_acceptance_rice',
      recipeLineId: 'recipe_line_restaurant_e2e_catering_acceptance_rice',
      name: 'Acceptance catering rice',
      referenceCost: '0.0050',
      quantityPerPortion: '200.0000',
    },
  ],
} as const;

/** `calculateRequirements` sorts by ingredient name; the readbacks below sort by
 * stock-item id. Both orders put chicken first — assert that, so a fixture
 * rename can never silently re-order an expected-row array. */
const [chicken, rice] = acceptance.ingredients;
expect(chicken.name.localeCompare(rice.name)).toBeLessThan(0);
expect(chicken.stockItemId.localeCompare(rice.stockItemId)).toBeLessThan(0);

const stockItemIds = [chicken.stockItemId, rice.stockItemId];

let pool: pg.Pool;
/** The `organizations.currency` the console renders every money figure with. */
let currencyLabel: string;
/** The location `postCateringConsumption` resolves for the fixture branch. */
let stockLocationId: string;

async function withTenantClient<T>(action: (client: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_organization_id', $1, true),
              set_config('app.is_platform_admin', 'false', true)`,
      [fixture.organizationId]
    );
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function tenantQuery<T extends pg.QueryResultRow>(text: string, values: unknown[] = []) {
  return withTenantClient((client) => client.query<T>(text, values));
}

async function seedAcceptanceFixture() {
  await withTenantClient(async (client) => {
    await client.query(
      `INSERT INTO restaurant_units
         (id, "organizationId", name, abbreviation, "createdAt", "updatedAt")
       VALUES ($1, $2, 'Gram', 'g', now(), now())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, abbreviation = EXCLUDED.abbreviation,
         "updatedAt" = now()`,
      [acceptance.gramUnitId, fixture.organizationId]
    );
    await client.query(
      `INSERT INTO restaurant_products
         (id, "organizationId", type, status, name, "createdAt", "updatedAt")
       VALUES ($1, $2, 'ITEM', 'ACTIVE', $3, now(), now())
       ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE', name = EXCLUDED.name, "updatedAt" = now()`,
      [acceptance.product.id, fixture.organizationId, acceptance.product.name]
    );
    for (const ingredient of acceptance.ingredients) {
      await client.query(
        `INSERT INTO restaurant_ingredients
           (id, "organizationId", name, "baseUnitId", "referenceCost", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, now(), now())
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name,
           "baseUnitId" = EXCLUDED."baseUnitId", "referenceCost" = EXCLUDED."referenceCost",
           "updatedAt" = now()`,
        [
          ingredient.id,
          fixture.organizationId,
          ingredient.name,
          acceptance.gramUnitId,
          ingredient.referenceCost,
        ]
      );
      await client.query(
        `INSERT INTO restaurant_stock_items
           (id, "organizationId", "ingredientId", "canonicalUnitId", "isActive", "trackBatches", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, true, false, now(), now())
         ON CONFLICT (id) DO UPDATE SET "canonicalUnitId" = EXCLUDED."canonicalUnitId",
           "isActive" = true, "updatedAt" = now()`,
        [ingredient.stockItemId, fixture.organizationId, ingredient.id, acceptance.gramUnitId]
      );
    }
    await client.query(
      `INSERT INTO restaurant_recipes
         (id, "organizationId", "productId", name, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, now(), now())
       ON CONFLICT (id) DO UPDATE SET "productId" = EXCLUDED."productId", name = EXCLUDED.name,
         "updatedAt" = now()`,
      [acceptance.recipe.id, fixture.organizationId, acceptance.product.id, acceptance.recipe.name]
    );
    await client.query(
      `INSERT INTO restaurant_recipe_versions
         (id, "organizationId", "recipeId", "versionNumber", status, "portionCount", "activatedAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 1, 'ACTIVE', 1, now(), now(), now())
       ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE', "portionCount" = 1,
         "activatedAt" = EXCLUDED."activatedAt", "supersededAt" = NULL, "updatedAt" = now()`,
      [acceptance.recipeVersionId, fixture.organizationId, acceptance.recipe.id]
    );
    for (const [sortOrder, ingredient] of acceptance.ingredients.entries()) {
      await client.query(
        `INSERT INTO restaurant_recipe_lines
           (id, "organizationId", "recipeVersionId", "ingredientId", quantity, "unitId", "sortOrder", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
         ON CONFLICT (id) DO UPDATE SET "ingredientId" = EXCLUDED."ingredientId",
           quantity = EXCLUDED.quantity, "unitId" = EXCLUDED."unitId",
           "sortOrder" = EXCLUDED."sortOrder", "updatedAt" = now()`,
        [
          ingredient.recipeLineId,
          fixture.organizationId,
          acceptance.recipeVersionId,
          ingredient.id,
          ingredient.quantityPerPortion,
          acceptance.gramUnitId,
          sortOrder,
        ]
      );
    }
  });
}

/**
 * `postCateringConsumption` posts to the OLDEST active location of the order's
 * branch. Resolve it by that same rule rather than assuming an ID, and only
 * create one when the branch has none, so an existing seeded location always
 * keeps winning the `createdAt asc` tie-break for every other lane.
 */
async function resolveBranchStockLocation() {
  const existing = await tenantQuery<{ id: string }>(
    `SELECT id FROM restaurant_stock_locations
     WHERE "organizationId" = $1 AND "branchId" = $2 AND "isActive" = true
     ORDER BY "createdAt" ASC LIMIT 1`,
    [fixture.organizationId, fixture.branchId]
  );
  if (existing.rows.length) return existing.rows[0]!.id;
  await tenantQuery(
    `INSERT INTO restaurant_stock_locations
       (id, "organizationId", "branchId", name, code, "isActive", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'Acceptance catering prep store', 'CATERING-ACCEPTANCE', true, now(), now())
     ON CONFLICT (id) DO UPDATE SET "branchId" = EXCLUDED."branchId", "isActive" = true,
       "updatedAt" = now()`,
    [acceptance.fallbackStockLocationId, fixture.organizationId, fixture.branchId]
  );
  return acceptance.fallbackStockLocationId;
}

/** The append-only ledger IS the stock truth, so on-hand is a fold of every
 * movement for the item — not only the catering-keyed ones. Fixed scale keeps
 * "no movements at all" and "movements that net to zero" comparable. */
async function derivedOnHand() {
  const result = await tenantQuery<{ stock_item_id: string; quantity: string }>(
    `SELECT item.id stock_item_id,
            COALESCE(sum(movement.quantity), 0)::numeric(18,6)::text quantity
     FROM unnest($2::text[]) item(id)
     LEFT JOIN restaurant_stock_movements movement
       ON movement."stockItemId" = item.id AND movement."organizationId" = $1
     GROUP BY item.id
     ORDER BY item.id`,
    [fixture.organizationId, stockItemIds]
  );
  expect(result.rows.map((row) => row.stock_item_id)).toEqual(stockItemIds);
  return result.rows.map((row) => row.quantity);
}

async function keyedMovements(orderId: string, suffix: 'consumption' | 'reversal') {
  const result = await tenantQuery<{
    stock_item_id: string;
    location_id: string;
    reason: string;
    quantity: string;
  }>(
    `SELECT movement."stockItemId" stock_item_id, movement."locationId" location_id,
            movement.reason::text, movement.quantity::text
     FROM restaurant_inventory_idempotency_keys key
     CROSS JOIN LATERAL unnest(string_to_array(key."resultRef", ',')) movement_id
     JOIN restaurant_stock_movements movement ON movement.id = movement_id
     WHERE key."organizationId" = $1 AND key.key = $2
     ORDER BY movement."stockItemId"`,
    [fixture.organizationId, `catering:${orderId}:${suffix}`]
  );
  return result.rows;
}

async function inventoryIdempotencyKeys(orderId: string) {
  const result = await tenantQuery<{ key: string }>(
    `SELECT key FROM restaurant_inventory_idempotency_keys
     WHERE "organizationId" = $1 AND key = ANY($2::text[])
     ORDER BY key`,
    [fixture.organizationId, [`catering:${orderId}:consumption`, `catering:${orderId}:reversal`]]
  );
  return result.rows.map((row) => row.key);
}

async function lineSnapshots(orderId: string) {
  const result = await tenantQuery<{ description: string; snapshot: string | null }>(
    `SELECT description, "costPerPortionSnapshot"::text snapshot
     FROM restaurant_catering_order_lines
     WHERE "organizationId" = $1 AND "orderId" = $2
     ORDER BY description`,
    [fixture.organizationId, orderId]
  );
  return result.rows;
}

async function orderStatus(orderId: string) {
  const result = await tenantQuery<{ status: string }>(
    `SELECT status::text FROM restaurant_catering_orders
     WHERE "organizationId" = $1 AND id = $2`,
    [fixture.organizationId, orderId]
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!.status;
}

async function setChickenReferenceCost(value: string) {
  const result = await tenantQuery(
    `UPDATE restaurant_ingredients SET "referenceCost" = $3, "updatedAt" = now()
     WHERE "organizationId" = $1 AND id = $2`,
    [fixture.organizationId, chicken.id, value]
  );
  // A no-op UPDATE would make the freeze assertion vacuous.
  expect(result.rowCount, `reference cost update for ${chicken.id}`).toBe(1);
}

/** Mirrors the console's `money()`: the raw Decimal string after the org currency. */
function money(amount: string) {
  return `${currencyLabel} ${amount}`;
}

async function waitForMutation(page: Page, procedure: string, action: () => Promise<void>) {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/api/trpc/') || response.request().method() !== 'POST') {
      return false;
    }
    // tRPC batches procedures into the pathname; judge it per procedure so a
    // co-batched unrelated mutation can never satisfy this wait.
    return url.pathname.slice('/api/trpc/'.length).split(',').includes(procedure);
  });
  await action();
  const response = await responsePromise;
  expect(response.status(), `${procedure}: ${await response.text()}`).toBe(200);
}

async function openCatering(page: Page) {
  const origin = await signInAs(page, 'restaurantAdmin');
  await page.goto(new URL('/restaurant/catering', origin).href);
  await expect(page.getByRole('heading', { name: 'Catering', exact: true })).toBeVisible();
  return origin;
}

/** The detail card for the selected order. Asserted to exist before anything is
 * asserted absent inside it, so an absence check cannot pass on a missing card. */
function orderCard(page: Page, eventName: string) {
  return page
    .locator('[data-slot="section-card"]')
    .filter({ has: page.getByRole('heading', { name: eventName, exact: true }) });
}

function stat(scope: Locator, label: string) {
  return scope.locator('[data-slot="stat"]').filter({ hasText: label }).locator('.stat-figure');
}

function costSummary(page: Page) {
  return page
    .locator('[data-slot="section-card"]')
    .filter({ has: page.getByRole('heading', { name: 'Cost summary', exact: true }) });
}

/**
 * Re-runs of this file append same-named orders. The list is ordered
 * `[eventDate asc, createdAt asc]`, so the row this run created is the LAST one
 * carrying the name — the same row `createOrder` read back.
 */
async function selectEvent(page: Page, eventName: string) {
  await page
    .getByRole('button', { name: new RegExp(`^Select event ${eventName} · `) })
    .last()
    .click();
  await expect(page.getByRole('heading', { name: eventName, exact: true })).toBeVisible();
}

async function createOrder(
  page: Page,
  input: { eventName: string; eventDate: string; headcount: string; quotedTotal: string }
) {
  await page.getByRole('button', { name: 'New order' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create catering order' });
  await chooseSelectField(
    dialog.getByRole('combobox', { name: 'Order branch', exact: true }),
    fixture.branchId
  );
  await dialog.getByLabel('Customer').selectOption(fixture.customer.id);
  await dialog.getByLabel('Event name').fill(input.eventName);
  await dialog.getByLabel('Event date').fill(input.eventDate);
  await dialog.getByLabel('Headcount').fill(input.headcount);
  await dialog.getByLabel('Venue address').fill('9 Acceptance Avenue, Lahore');
  await dialog.getByLabel('Quoted total').fill(input.quotedTotal);
  await waitForMutation(page, 'restaurantCatering.create', () =>
    dialog.getByRole('button', { name: 'Save order' }).click()
  );
  await expect(page.getByRole('heading', { name: input.eventName, exact: true })).toBeVisible();

  const order = await tenantQuery<{ id: string; status: string }>(
    `SELECT id, status::text FROM restaurant_catering_orders
     WHERE "organizationId" = $1 AND "eventName" = $2
     ORDER BY "createdAt" DESC LIMIT 1`,
    [fixture.organizationId, input.eventName]
  );
  expect(order.rows).toHaveLength(1);
  expect(order.rows[0]!.status).toBe('DRAFT');
  return order.rows[0]!.id;
}

async function addRecipeLine(page: Page, description: string, portions: string, unitPrice: string) {
  await page.getByLabel('Recipe', { exact: true }).selectOption(acceptance.recipe.id);
  await page.getByLabel('Description').fill(description);
  await page.getByLabel('Portions').fill(portions);
  await page.getByLabel('Unit price').fill(unitPrice);
  await waitForMutation(page, 'restaurantCatering.addLine', () =>
    page.getByRole('button', { name: 'Add line' }).click()
  );
  await expect(page.getByText(`${description} · ${portions} portions`)).toBeVisible();
}

async function moveTo(page: Page, eventName: string, status: string) {
  if (status === 'confirmed') {
    const dates = await tenantQuery<{ date: string }>(
      `SELECT to_char("eventDate", 'YYYY-MM-DD') AS date FROM restaurant_catering_orders
       WHERE "organizationId"=$1 AND "eventName"=$2 ORDER BY "createdAt" DESC LIMIT 1`,
      [fixture.organizationId, eventName]
    );
    expect(dates.rows).toHaveLength(1);
    const date = dates.rows[0]!.date;
    await page.getByLabel('Booking start with UTC offset').fill(`${date}T12:00:00+00:00`);
    await page.getByLabel('Booking end with UTC offset').fill(`${date}T14:00:00+00:00`);
    await page.getByLabel('Fulfillment').selectOption('PICKUP');
    await page.getByLabel('Stock location').selectOption(stockLocationId);
    await waitForMutation(page, 'restaurantCatering.setBooking', () =>
      page.getByRole('button', { name: 'Save booking', exact: true }).click()
    );
    await page.getByLabel('Maximum concurrent guests').fill('100');
    await waitForMutation(page, 'restaurantCatering.setBranchCapacity', () =>
      page.getByRole('button', { name: 'Save branch capacity' }).click()
    );
    await waitForMutation(page, 'restaurantCatering.publishQuote', () =>
      page.getByRole('button', { name: 'Publish quote revision' }).click()
    );
    await waitForMutation(page, 'restaurantCatering.approveQuote', () =>
      page
        .getByRole('button', { name: 'Approve quote revision', exact: true })
        .and(page.locator(':enabled'))
        .click()
    );
    await expect(
      orderCard(page, eventName).getByRole('button', { name: 'Move to confirmed' })
    ).toBeEnabled();
  }

  await orderCard(page, eventName)
    .getByRole('button', { name: `Move to ${status}` })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Confirm status change' });
  await waitForMutation(page, 'restaurantCatering.transition', () =>
    dialog.getByRole('button', { name: 'Confirm change' }).click()
  );
  await expect(dialog).toBeHidden();
}

async function cancelOrder(page: Page, eventName: string) {
  await orderCard(page, eventName).getByRole('button', { name: 'Cancel', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm status change' });
  await waitForMutation(page, 'restaurantCatering.transition', () =>
    dialog.getByRole('button', { name: 'Confirm change' }).click()
  );
  await expect(dialog).toBeHidden();
}

/**
 * The catering console cannot render at all while this tenant holds a cyclic
 * recipe, and that is a PRODUCT defect, not a fixture detail. Recorded here
 * because this file is where it bites:
 *
 *   - `restaurantCatalog.listRecipeCosts` (src/server/routers/restaurant-catalog.ts)
 *     called with no `recipeIds` — which is exactly how `catering-console.tsx`
 *     calls it — enumerates EVERY recipe in the organization and costs each one.
 *     One cyclic recipe makes `computeRecipeCost` throw, `mapCatalogError` turns
 *     that into a 400 `Recipe cycle detected.`, and the whole org-wide call fails.
 *   - `/api/trpc` runs each batch in ONE transaction (WHA-1550), so that single
 *     400 rolls the batch back and every co-batched read returns "Rolled back:
 *     another operation in this request failed". In the 2026-09-17 10:21 run the
 *     console lost `listBranches`, `restaurantCatering.list`, `listProducts`,
 *     `listRecipes`, `listCustomers` and `listDirectory` in one response, and the
 *     Customer picker was left with only its "No linked customer" option.
 *
 * `computeRecipeCost`'s cycle branch is documented in
 * `scripts/seed-restaurant-acceptance-fixtures.ts` as a DEFENSIVE path for legacy
 * or externally-introduced data — data the product therefore expects to exist. So
 * one legacy cyclic recipe takes a real tenant's catering console down entirely.
 * A per-recipe failure in the list payload, rather than an org-wide throw, is the
 * fix; it is outside this lease's ownership and is reported, not made here.
 *
 * WHA-1565 seeds that cycle deliberately, to prove the defensive path still
 * holds, and its own case reads ONE recipe by id, so it is unaffected by the edge
 * being absent while this file runs. This file therefore lifts the closing edge
 * for its own duration and puts it back, leaving the seeded fixture as it found
 * it. Nothing product-side is relaxed and no assertion here weakens.
 */
const CYCLE_CLOSING_LINE_ID = 'recipe_line_rpa_cycle_b';
let cycleClosingLine: {
  recipeVersionId: string;
  subRecipeId: string;
  quantity: string;
  unitId: string;
  sortOrder: number;
} | null = null;

async function liftSeededRecipeCycle() {
  const held = await tenantQuery<{
    recipeVersionId: string;
    subRecipeId: string;
    quantity: string;
    unitId: string;
    sortOrder: number;
  }>(
    `DELETE FROM restaurant_recipe_lines
     WHERE "organizationId" = $1 AND id = $2
     RETURNING "recipeVersionId", "subRecipeId", quantity::text, "unitId", "sortOrder"`,
    [fixture.organizationId, CYCLE_CLOSING_LINE_ID]
  );
  expect(
    held.rows,
    `${CYCLE_CLOSING_LINE_ID} must be seeded: without it this file proves nothing about the cycle it lifts`
  ).toHaveLength(1);
  cycleClosingLine = held.rows[0]!;
}

async function restoreSeededRecipeCycle() {
  if (!cycleClosingLine) return;
  const line = cycleClosingLine;
  cycleClosingLine = null;
  await tenantQuery(
    `INSERT INTO restaurant_recipe_lines
       ("organizationId", id, "recipeVersionId", "subRecipeId", quantity, "unitId", "sortOrder",
        "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [
      fixture.organizationId,
      CYCLE_CLOSING_LINE_ID,
      line.recipeVersionId,
      line.subRecipeId,
      line.quantity,
      line.unitId,
      line.sortOrder,
    ]
  );
}

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const organization = await tenantQuery<{ currency: string }>(
    'SELECT currency FROM organizations WHERE id = $1',
    [fixture.organizationId]
  );
  expect(organization.rows, `organization ${fixture.organizationId} must be seeded`).toHaveLength(
    1
  );
  currencyLabel = organization.rows[0]!.currency.trim() || 'Currency unavailable';
  await seedAcceptanceFixture();
  stockLocationId = await resolveBranchStockLocation();
  await liftSeededRecipeCycle();
});

test.afterAll(async () => {
  // Restore BEFORE the pool closes, and unconditionally: a failed case above must
  // still hand the seeded cycle fixture back to WHA-1565 intact.
  try {
    await restoreSeededRecipeCycle();
  } finally {
    await pool?.end();
  }
});

test('freezes a confirmed order against a later ingredient reference-cost change', async ({
  page,
}) => {
  test.slow();
  await openCatering(page);

  const controlEvent = 'Acceptance catering unconfirmed control';
  const frozenEvent = 'Acceptance catering frozen quote';
  const eventDate = '2026-10-05';

  const controlOrderId = await createOrder(page, {
    eventName: controlEvent,
    eventDate,
    headcount: '5',
    quotedTotal: '100.00',
  });
  await addRecipeLine(page, 'Control five trays', '5', '20.00');

  const frozenOrderId = await createOrder(page, {
    eventName: frozenEvent,
    eventDate,
    headcount: '5',
    quotedTotal: '100.00',
  });
  await addRecipeLine(page, 'Frozen five trays', '5', '20.00');

  await moveTo(page, frozenEvent, 'quoted');
  await moveTo(page, frozenEvent, 'confirmed');
  expect(await orderStatus(frozenOrderId)).toBe('CONFIRMED');

  // Confirmation freezes the per-portion cost onto the line; the unconfirmed
  // control carries no snapshot and therefore still costs live.
  expect(await lineSnapshots(frozenOrderId)).toEqual([
    { description: 'Frozen five trays', snapshot: acceptance.costPerPortionSnapshot },
  ]);
  expect(await lineSnapshots(controlOrderId)).toEqual([
    { description: 'Control five trays', snapshot: null },
  ]);

  // 5 portions × 2.2000 = 11; quoted 100 leaves a margin of 89 (89.0%).
  await expect(stat(costSummary(page), 'Ingredient cost')).toHaveText(money('11'));
  await expect(stat(costSummary(page), 'Margin')).toHaveText(money('89'));
  await expect(costSummary(page)).toContainText('89.0%');

  await selectEvent(page, controlEvent);
  await expect(stat(costSummary(page), 'Ingredient cost')).toHaveText(money('11'));
  await expect(stat(costSummary(page), 'Margin')).toHaveText(money('89'));

  try {
    await setChickenReferenceCost(chicken.raisedReferenceCost);
    // The console caches the cost summary per order; reload so both orders are
    // re-read from the application against the changed ingredient cost.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Catering', exact: true })).toBeVisible();

    await selectEvent(page, frozenEvent);
    await expect(stat(costSummary(page), 'Ingredient cost')).toHaveText(money('11'));
    await expect(stat(costSummary(page), 'Margin')).toHaveText(money('89'));
    await expect(costSummary(page)).toContainText('89.0%');
    expect(await lineSnapshots(frozenOrderId)).toEqual([
      { description: 'Frozen five trays', snapshot: acceptance.costPerPortionSnapshot },
    ]);

    // Non-vacuity: the SAME change repriced the unconfirmed control to
    // 5 × (40 × 0.0900 + 200 × 0.0050) = 23, margin 77 (77.0%).
    await selectEvent(page, controlEvent);
    await expect(stat(costSummary(page), 'Ingredient cost')).toHaveText(money('23'));
    await expect(stat(costSummary(page), 'Margin')).toHaveText(money('77'));
    await expect(costSummary(page)).toContainText('77.0%');
  } finally {
    await setChickenReferenceCost(chicken.referenceCost);
  }
});

test('cancelling before production posts no catering stock movements', async ({ page }) => {
  test.slow();
  await openCatering(page);

  const eventName = 'Acceptance catering pre-production cancellation';
  const before = await derivedOnHand();
  const orderId = await createOrder(page, {
    eventName,
    eventDate: '2026-10-06',
    headcount: '3',
    quotedTotal: '60.00',
  });
  await addRecipeLine(page, 'Three unproduced trays', '3', '20.00');

  await moveTo(page, eventName, 'quoted');
  await moveTo(page, eventName, 'confirmed');
  expect(await orderStatus(orderId)).toBe('CONFIRMED');

  await cancelOrder(page, eventName);
  expect(await orderStatus(orderId)).toBe('CANCELLED');

  // Consumption is posted only on IN_PRODUCTION → READY, so a cancellation that
  // never reached READY must create neither the consumption nor the reversal
  // idempotency domain, and must leave derived on-hand untouched.
  expect(await inventoryIdempotencyKeys(orderId)).toEqual([]);
  expect(await keyedMovements(orderId, 'consumption')).toEqual([]);
  expect(await keyedMovements(orderId, 'reversal')).toEqual([]);
  expect(await derivedOnHand()).toEqual(before);

  const card = orderCard(page, eventName);
  await expect(card).toHaveCount(1);
  await expect(stat(card, 'Status')).toHaveText('CANCELLED');
  await expect(card.getByRole('button', { name: /^Move to / })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  // The card itself is still live — only the lifecycle affordances are gone.
  await expect(card.getByRole('button', { name: 'Edit order' })).toBeVisible();
});

test('cancelling a delivered order retains consumption until explicit unused returns restore stock', async ({
  page,
}) => {
  test.slow();
  await openCatering(page);

  const eventName = 'Acceptance catering delivered cancellation';
  const opening = await derivedOnHand();
  const orderId = await createOrder(page, {
    eventName,
    eventDate: '2026-10-07',
    headcount: '4',
    quotedTotal: '80.00',
  });
  await addRecipeLine(page, 'Four delivered trays', '4', '20.00');

  await moveTo(page, eventName, 'quoted');
  await moveTo(page, eventName, 'confirmed');
  await moveTo(page, eventName, 'in production');
  await moveTo(page, eventName, 'ready');

  // 4 portions × 40 g and × 200 g, posted to the branch's oldest active location.
  expect(await keyedMovements(orderId, 'consumption')).toEqual([
    {
      stock_item_id: chicken.stockItemId,
      location_id: stockLocationId,
      reason: 'RECIPE_CONSUMPTION',
      quantity: '-160.000000',
    },
    {
      stock_item_id: rice.stockItemId,
      location_id: stockLocationId,
      reason: 'RECIPE_CONSUMPTION',
      quantity: '-800.000000',
    },
  ]);
  const consumed = await derivedOnHand();
  expect(consumed).toEqual([
    addQuantity(opening[0]!, '-160.000000'),
    addQuantity(opening[1]!, '-800.000000'),
  ]);

  await moveTo(page, eventName, 'delivered');
  expect(await orderStatus(orderId)).toBe('DELIVERED');

  // Cancellation alone must not put prepared stock back on the shelf.
  await cancelOrder(page, eventName);
  expect(await orderStatus(orderId)).toBe('CANCELLED');

  expect(await keyedMovements(orderId, 'reversal')).toEqual([]);
  expect(await derivedOnHand()).toEqual(consumed);
  const originals = await tenantQuery<{ id: string; quantity: string }>(
    `SELECT movement.id, (-movement.quantity)::text quantity
     FROM restaurant_inventory_idempotency_keys key
     CROSS JOIN LATERAL unnest(string_to_array(key."resultRef", ',')) movement_id
     JOIN restaurant_stock_movements movement ON movement.id=movement_id
     WHERE key."organizationId"=$1 AND key.key=$2 ORDER BY movement."stockItemId"`,
    [fixture.organizationId, `catering:${orderId}:consumption`]
  );
  expect(originals.rows).toHaveLength(2);
  const disposition = page.getByRole('form', { name: 'Record physical disposition' });
  for (const movement of originals.rows) {
    await disposition.getByLabel('Original consumption').selectOption(movement.id);
    await disposition.getByRole('combobox', { name: /^Disposition/ }).selectOption('UNUSED_RETURN');
    await disposition.getByLabel('Canonical quantity').fill(movement.quantity);
    await disposition
      .getByLabel('Disposition reason')
      .fill('Verified unused stock physically returned to its original store');
    await waitForMutation(page, 'restaurantCatering.recordDisposition', () =>
      disposition.getByRole('button', { name: 'Record disposition', exact: true }).click()
    );
  }
  const returned = await tenantQuery<{
    stock_item_id: string;
    location_id: string;
    reason: string;
    quantity: string;
  }>(
    `SELECT movement."stockItemId" stock_item_id, movement."locationId" location_id,
            movement.reason::text, movement.quantity::text
     FROM restaurant_catering_dispositions disposition
     JOIN restaurant_stock_movements movement ON movement.id=disposition."resultMovementId"
       AND movement."organizationId"=disposition."organizationId"
     WHERE disposition."organizationId"=$1 AND disposition."orderId"=$2
       AND disposition.kind='UNUSED_RETURN' ORDER BY movement."stockItemId"`,
    [fixture.organizationId, orderId]
  );
  expect(returned.rows).toEqual([
    {
      stock_item_id: chicken.stockItemId,
      location_id: stockLocationId,
      reason: 'SALE_REVERSAL',
      quantity: '160.000000',
    },
    {
      stock_item_id: rice.stockItemId,
      location_id: stockLocationId,
      reason: 'SALE_REVERSAL',
      quantity: '800.000000',
    },
  ]);
  // Reconciliation over the WHOLE ledger, not only the two keyed batches: the
  // explicit returns are new movements and the fold returns to the opening balance.
  expect(await derivedOnHand()).toEqual(opening);

  const card = orderCard(page, eventName);
  await expect(card).toHaveCount(1);
  await expect(stat(card, 'Status')).toHaveText('CANCELLED');
  await expect(card.getByRole('button', { name: /^Move to / })).toHaveCount(0);
});

/**
 * Fixed-scale decimal addition over the `numeric(18,6)::text` balances above,
 * without pulling a Decimal runtime into the test process. The scaled operands
 * are exact integers, and the guard rejects anything that would leave the safe
 * integer range rather than silently comparing rounded figures.
 */
function addQuantity(base: string, delta: string) {
  const scale = (value: string) => {
    const parsed = /^(-?)(\d+)\.(\d{6})$/.exec(value);
    if (!parsed) throw new Error(`Expected a numeric(18,6) balance, received "${value}".`);
    const scaled = Number(`${parsed[1]}${parsed[2]}${parsed[3]}`);
    if (!Number.isSafeInteger(scaled)) throw new Error(`Balance "${value}" is not exact.`);
    return scaled;
  };
  const total = scale(base) + scale(delta);
  const digits = Math.abs(total).toString().padStart(7, '0');
  return `${total < 0 ? '-' : ''}${digits.slice(0, -6)}.${digits.slice(-6)}`;
}
