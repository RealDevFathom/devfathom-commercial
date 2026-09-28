import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import { signInAs } from './fixtures/restaurant-actor-accessibility';
import { restaurantE2eCredentials as fixture } from './restaurant-fixture';

test.describe.configure({ mode: 'serial' });

if (process.env.RESTAURANT_INTEGRATED_E2E !== '1') {
  throw new Error('RESTAURANT_INTEGRATED_E2E=1 is required.');
}

const cateringFixture = {
  gramUnitId: 'unit_restaurant_e2e_catering_g',
  product: { id: 'product_restaurant_e2e_catering_tray', name: 'Catering celebration tray' },
  recipe: { id: 'recipe_restaurant_e2e_catering_tray', name: 'Catering celebration tray BOM' },
  recipeVersionId: 'recipe_version_restaurant_e2e_catering_tray_v1',
  stockLocationId: 'demo_stockloc_main',
  ingredients: [
    {
      id: 'ingredient_restaurant_e2e_catering_chicken',
      stockItemId: 'stock_item_restaurant_e2e_catering_chicken',
      recipeLineId: 'recipe_line_restaurant_e2e_catering_chicken',
      name: 'Catering spiced chicken',
      referenceCost: '0.0200',
      quantityPerPortion: '50.0000',
      tenPortions: '500.000000',
    },
    {
      id: 'ingredient_restaurant_e2e_catering_rice',
      stockItemId: 'stock_item_restaurant_e2e_catering_rice',
      recipeLineId: 'recipe_line_restaurant_e2e_catering_rice',
      name: 'Catering basmati rice',
      referenceCost: '0.0100',
      quantityPerPortion: '100.0000',
      tenPortions: '1000.000000',
    },
  ],
} as const;

let pool: pg.Pool;

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

async function seedCateringFixture() {
  await withTenantClient(async (client) => {
    await client.query(
      `INSERT INTO restaurant_units
         (id, "organizationId", name, abbreviation, "createdAt", "updatedAt")
       VALUES ($1, $2, 'Gram', 'g', now(), now())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, abbreviation = EXCLUDED.abbreviation,
         "updatedAt" = now()`,
      [cateringFixture.gramUnitId, fixture.organizationId]
    );
    await client.query(
      `INSERT INTO restaurant_products
         (id, "organizationId", type, status, name, "createdAt", "updatedAt")
       VALUES ($1, $2, 'ITEM', 'ACTIVE', $3, now(), now())
       ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE', name = EXCLUDED.name, "updatedAt" = now()`,
      [cateringFixture.product.id, fixture.organizationId, cateringFixture.product.name]
    );
    await client.query(
      `INSERT INTO restaurant_stock_locations
         (id, "organizationId", "branchId", name, code, "isActive", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 'Catering prep store', 'CATERING-E2E', true, now(), now())
       ON CONFLICT (id) DO UPDATE SET "branchId" = EXCLUDED."branchId", "isActive" = true,
         "updatedAt" = now()`,
      [cateringFixture.stockLocationId, fixture.organizationId, fixture.branchId]
    );
    for (const ingredient of cateringFixture.ingredients) {
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
          cateringFixture.gramUnitId,
          ingredient.referenceCost,
        ]
      );
      await client.query(
        `INSERT INTO restaurant_stock_items
           (id, "organizationId", "ingredientId", "canonicalUnitId", "isActive", "trackBatches", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, true, false, now(), now())
         ON CONFLICT (id) DO UPDATE SET "canonicalUnitId" = EXCLUDED."canonicalUnitId",
           "isActive" = true, "updatedAt" = now()`,
        [ingredient.stockItemId, fixture.organizationId, ingredient.id, cateringFixture.gramUnitId]
      );
    }
    await client.query(
      `INSERT INTO restaurant_recipes
         (id, "organizationId", "productId", name, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, now(), now())
       ON CONFLICT (id) DO UPDATE SET "productId" = EXCLUDED."productId", name = EXCLUDED.name,
         "updatedAt" = now()`,
      [
        cateringFixture.recipe.id,
        fixture.organizationId,
        cateringFixture.product.id,
        cateringFixture.recipe.name,
      ]
    );
    await client.query(
      `INSERT INTO restaurant_recipe_versions
         (id, "organizationId", "recipeId", "versionNumber", status, "portionCount", "activatedAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 1, 'ACTIVE', 1, now(), now(), now())
       ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE', "portionCount" = 1,
         "activatedAt" = EXCLUDED."activatedAt", "supersededAt" = NULL, "updatedAt" = now()`,
      [cateringFixture.recipeVersionId, fixture.organizationId, cateringFixture.recipe.id]
    );
    for (const [sortOrder, ingredient] of cateringFixture.ingredients.entries()) {
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
          cateringFixture.recipeVersionId,
          ingredient.id,
          ingredient.quantityPerPortion,
          cateringFixture.gramUnitId,
          sortOrder,
        ]
      );
    }
  });
}

async function waitForMutation(page: Page, procedure: string, action: () => Promise<void>) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/trpc/${procedure}`) && response.request().method() === 'POST'
  );
  await action();
  const response = await responsePromise;
  expect(response.status(), `${procedure}: ${await response.text()}`).toBe(200);
}

async function openCatering(page: Page) {
  const origin = await signInAs(page, 'restaurantAdmin');
  await page.goto(new URL('/restaurant/catering', origin).href);
  await expect(page.getByRole('heading', { name: 'Catering', exact: true })).toBeVisible();
}

async function createOrder(
  page: Page,
  input: { eventName: string; eventDate: string; headcount: string; quotedTotal: string }
) {
  await page.getByRole('button', { name: 'New order' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create catering order' });
  await dialog.getByLabel('Order branch').selectOption(fixture.branchId);
  await dialog.getByLabel('Customer').selectOption(fixture.customer.id);
  await dialog.getByLabel('Event name').fill(input.eventName);
  await dialog.getByLabel('Event date').fill(input.eventDate);
  await dialog.getByLabel('Service time').fill('18:30');
  await dialog.getByLabel('Headcount').fill(input.headcount);
  await dialog.getByLabel('Venue address').fill('12 Catering Lane, Lahore');
  await dialog.getByLabel('Quoted total').fill(input.quotedTotal);
  await dialog.getByLabel('Deposit').fill('50.00');
  await dialog.getByLabel('Notes').fill('Deterministic catering browser fixture');
  await waitForMutation(page, 'restaurantCatering.create', () =>
    dialog.getByRole('button', { name: 'Save order' }).click()
  );
  await expect(page.getByRole('heading', { name: input.eventName, exact: true })).toBeVisible();

  const order = await tenantQuery<{ id: string }>(
    `SELECT id FROM restaurant_catering_orders
     WHERE "organizationId" = $1 AND "eventName" = $2
     ORDER BY "createdAt" DESC LIMIT 1`,
    [fixture.organizationId, input.eventName]
  );
  expect(order.rows).toHaveLength(1);
  return order.rows[0]!.id;
}

async function addLine(
  page: Page,
  source: string,
  description: string,
  portions: string,
  unitPrice: string
) {
  await page.getByLabel('Product or recipe').selectOption(source);
  await page.getByLabel('Description').fill(description);
  await page.getByLabel('Portions').fill(portions);
  await page.getByLabel('Unit price').fill(unitPrice);
  await waitForMutation(page, 'restaurantCatering.addLine', () =>
    page.getByRole('button', { name: 'Add line' }).click()
  );
}

async function moveTo(page: Page, status: string) {
  await page.getByRole('button', { name: `Move to ${status}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm status change' });
  await waitForMutation(page, 'restaurantCatering.transition', () =>
    dialog.getByRole('button', { name: 'Confirm change' }).click()
  );
  await expect(dialog).toBeHidden();
}

async function cancelOrder(page: Page) {
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm status change' });
  await expect(dialog).toContainText(
    'Cancel this order? Ready-order ingredient consumption will be reversed.'
  );
  await waitForMutation(page, 'restaurantCatering.transition', () =>
    dialog.getByRole('button', { name: 'Confirm change' }).click()
  );
  await expect(dialog).toBeHidden();
}

async function expectOrderStatus(page: Page, eventName: string, status: 'CLOSED' | 'CANCELLED') {
  await page.getByLabel('Filter by status').selectOption(status);
  const orderRow = page.getByRole('row').filter({ hasText: eventName }).filter({ hasText: status });
  await expect(orderRow.first()).toBeVisible();
}

async function movementRows(orderId: string, suffix: 'consumption' | 'reversal') {
  return tenantQuery<{ stock_item_id: string; reason: string; quantity: string }>(
    `SELECT movement."stockItemId" stock_item_id, movement.reason::text, movement.quantity::text
     FROM restaurant_inventory_idempotency_keys key
     CROSS JOIN LATERAL unnest(string_to_array(key."resultRef", ',')) movement_id
     JOIN restaurant_stock_movements movement ON movement.id = movement_id
     WHERE key."organizationId" = $1 AND key.key = $2
     ORDER BY movement."stockItemId"`,
    [fixture.organizationId, `catering:${orderId}:${suffix}`]
  );
}

test.beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  expect(databaseUrl, 'integrated lane requires DATABASE_URL').toBeTruthy();
  pool = new pg.Pool({ connectionString: databaseUrl });
  await seedCateringFixture();
});

test.afterAll(async () => {
  await pool.end();
});

test('creates, costs, produces, delivers, and closes a catering order', async ({ page }) => {
  test.slow();
  await openCatering(page);
  const eventName = 'E2E catering close lifecycle';
  const orderId = await createOrder(page, {
    eventName,
    eventDate: '2026-09-20',
    headcount: '10',
    quotedTotal: '200.00',
  });

  await addLine(
    page,
    `recipe:${cateringFixture.recipe.id}`,
    'Ten celebration trays',
    '10',
    '15.00'
  );
  await addLine(
    page,
    `product:${cateringFixture.product.id}`,
    'Four packaged add-ons',
    '4',
    '5.00'
  );
  await page.getByLabel('Cost type').selectOption('TRANSPORT');
  await page.getByLabel('Label').fill('Delivery van');
  await page.getByLabel('Amount').fill('20.00');
  await waitForMutation(page, 'restaurantCatering.addExtraCost', () =>
    page.getByRole('button', { name: 'Add cost' }).click()
  );

  await moveTo(page, 'quoted');
  await expect(page.getByRole('button', { name: 'Move to confirmed' })).toBeVisible();
  await moveTo(page, 'confirmed');
  await expect(page.getByRole('button', { name: 'Move to in production' })).toBeVisible();

  const snapshots = await tenantQuery<{
    recipe_id: string | null;
    product_id: string | null;
    snapshot: string;
  }>(
    `SELECT "recipeId" recipe_id, "productId" product_id,
            "costPerPortionSnapshot"::text snapshot
     FROM restaurant_catering_order_lines
     WHERE "organizationId" = $1 AND "orderId" = $2
     ORDER BY description`,
    [fixture.organizationId, orderId]
  );
  expect(snapshots.rows).toEqual([
    { recipe_id: null, product_id: cateringFixture.product.id, snapshot: '0.0000' },
    { recipe_id: cateringFixture.recipe.id, product_id: null, snapshot: '2.0000' },
  ]);

  await expect(page.getByText('PKR 160', { exact: true })).toBeVisible();
  await expect(page.getByText('80.0%', { exact: true })).toBeVisible();
  for (const ingredient of cateringFixture.ingredients) {
    const row = page.getByRole('row').filter({ hasText: ingredient.name });
    await expect(row).toContainText(cateringFixture.gramUnitId);
    await expect(row).toContainText(ingredient.tenPortions.replace(/\.0+$/, ''));
  }

  await moveTo(page, 'in production');
  await expect(page.getByRole('button', { name: 'Move to ready' })).toBeVisible();
  await moveTo(page, 'ready');
  await expect(page.getByRole('button', { name: 'Move to delivered' })).toBeVisible();

  const consumption = await movementRows(orderId, 'consumption');
  expect(consumption.rows).toEqual([
    {
      stock_item_id: cateringFixture.ingredients[0].stockItemId,
      reason: 'RECIPE_CONSUMPTION',
      quantity: '-500.000000',
    },
    {
      stock_item_id: cateringFixture.ingredients[1].stockItemId,
      reason: 'RECIPE_CONSUMPTION',
      quantity: '-1000.000000',
    },
  ]);

  await page.getByLabel('Scheduled').fill('2026-09-20T16:00');
  await page.getByLabel('Driver').selectOption(fixture.manager.staffProfileId);
  await page.getByLabel('Dispatched').fill('2026-09-20T16:15');
  await page.getByLabel('Delivered').fill('2026-09-20T16:45');
  await page.getByLabel('Vehicle').fill('Catering Van 1');
  await page.getByLabel('Delivery notes').fill('Delivered to event coordinator');
  await waitForMutation(page, 'restaurantCatering.setDelivery', () =>
    page.getByRole('button', { name: 'Save delivery' }).click()
  );

  const delivery = await tenantQuery<{
    scheduled: boolean;
    dispatched: boolean;
    delivered: boolean;
    chronological: boolean;
  }>(
    `SELECT "scheduledAt" IS NOT NULL scheduled,
            "dispatchedAt" IS NOT NULL dispatched,
            "deliveredAt" IS NOT NULL delivered,
            "scheduledAt" < "dispatchedAt" AND "dispatchedAt" < "deliveredAt" chronological
     FROM restaurant_catering_deliveries
     WHERE "organizationId" = $1 AND "orderId" = $2`,
    [fixture.organizationId, orderId]
  );
  expect(delivery.rows).toEqual([
    { scheduled: true, dispatched: true, delivered: true, chronological: true },
  ]);

  await moveTo(page, 'delivered');
  await expect(page.getByRole('button', { name: 'Move to closed' })).toBeVisible();
  await moveTo(page, 'closed');
  await expectOrderStatus(page, eventName, 'CLOSED');
  const closed = await tenantQuery<{ status: string }>(
    `SELECT status::text FROM restaurant_catering_orders
     WHERE "organizationId" = $1 AND id = $2`,
    [fixture.organizationId, orderId]
  );
  expect(closed.rows).toEqual([{ status: 'CLOSED' }]);
});

test('cancelling after ready reverses catering recipe consumption', async ({ page }) => {
  test.slow();
  await openCatering(page);
  const eventName = 'E2E catering cancellation lifecycle';
  const orderId = await createOrder(page, {
    eventName,
    eventDate: '2026-09-21',
    headcount: '2',
    quotedTotal: '40.00',
  });
  await addLine(
    page,
    `recipe:${cateringFixture.recipe.id}`,
    'Two cancellation trays',
    '2',
    '20.00'
  );
  await moveTo(page, 'quoted');
  await expect(page.getByRole('button', { name: 'Move to confirmed' })).toBeVisible();
  await moveTo(page, 'confirmed');
  await expect(page.getByRole('button', { name: 'Move to in production' })).toBeVisible();
  await moveTo(page, 'in production');
  await expect(page.getByRole('button', { name: 'Move to ready' })).toBeVisible();
  await moveTo(page, 'ready');
  await expect(page.getByRole('button', { name: 'Move to delivered' })).toBeVisible();

  const consumption = await movementRows(orderId, 'consumption');
  expect(consumption.rows.map((row) => row.reason)).toEqual([
    'RECIPE_CONSUMPTION',
    'RECIPE_CONSUMPTION',
  ]);
  await cancelOrder(page);
  await expectOrderStatus(page, eventName, 'CANCELLED');

  const reversal = await movementRows(orderId, 'reversal');
  expect(reversal.rows).toEqual([
    {
      stock_item_id: cateringFixture.ingredients[0].stockItemId,
      reason: 'SALE_REVERSAL',
      quantity: '100.000000',
    },
    {
      stock_item_id: cateringFixture.ingredients[1].stockItemId,
      reason: 'SALE_REVERSAL',
      quantity: '200.000000',
    },
  ]);
  const net = await tenantQuery<{ stock_item_id: string; quantity: string }>(
    `SELECT movement."stockItemId" stock_item_id, sum(movement.quantity)::text quantity
     FROM restaurant_inventory_idempotency_keys key
     CROSS JOIN LATERAL unnest(string_to_array(key."resultRef", ',')) movement_id
     JOIN restaurant_stock_movements movement ON movement.id = movement_id
     WHERE key."organizationId" = $1
       AND key.key IN ($2, $3)
     GROUP BY movement."stockItemId"
     ORDER BY movement."stockItemId"`,
    [fixture.organizationId, `catering:${orderId}:consumption`, `catering:${orderId}:reversal`]
  );
  expect(net.rows).toEqual([
    { stock_item_id: cateringFixture.ingredients[0].stockItemId, quantity: '0.000000' },
    { stock_item_id: cateringFixture.ingredients[1].stockItemId, quantity: '0.000000' },
  ]);
});
