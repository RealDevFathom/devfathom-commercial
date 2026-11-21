import { chooseSelectField } from './fixtures/select-field';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import { signInAs } from './fixtures/restaurant-actor-accessibility';
import { restaurantE2eCredentials as fixture } from './restaurant-fixture';
import {
  assertAcceptanceBrowser,
  assertAcceptanceDatabase,
  readAcceptanceReceipt,
} from '../../scripts/restaurant-acceptance-target';
import { captureRestaurantStudio } from './fixtures/restaurant-studio';

test.describe.configure({ mode: 'serial' });

if (process.env.RESTAURANT_INTEGRATED_E2E !== '1') {
  throw new Error('RESTAURANT_INTEGRATED_E2E=1 is required.');
}

const cateringFixture = {
  gramUnitId: 'unit_restaurant_e2e_catering_g',
  product: { id: 'product_restaurant_e2e_catering_tray', name: 'Catering celebration tray' },
  recipe: { id: 'recipe_restaurant_e2e_catering_tray', name: 'Catering celebration tray BOM' },
  recipeVersionId: 'recipe_version_restaurant_e2e_catering_tray_v1',
  stockLocationId: 'stock_location_acceptance_catering_selected',
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
    // The finite run uses registers 0/1; reserve commercial capacity for real UI enrollment.
    const unused = [
      ...fixture.caseRegisters.slice(2).map((device) => device.deviceId),
      'device_restaurant_e2e_ascii_receipt_pos',
    ];
    const retired = await client.query(
      `UPDATE restaurant_registered_devices SET status='REVOKED', "revokedAt"=now(), "updatedAt"=now()
       WHERE "organizationId"=$1 AND id=ANY($2::text[]) RETURNING id`,
      [fixture.organizationId, unused]
    );
    expect(retired.rows.map((row) => row.id).sort()).toEqual([...unused].sort());
    // Legacy seed role permissions do not grant the separate terminal staff capabilities.
    for (const capability of ['catering:manage', 'payments:refund', 'cash:adjust']) {
      await client.query(
        `INSERT INTO restaurant_staff_capability_grants
         (id,"organizationId","staffProfileId","branchId",capability,effect)
         VALUES ($1,$2,$3,$4,$5,'ALLOW') ON CONFLICT ("staffProfileId","branchId",capability) DO NOTHING`,
        [
          `acceptance_catering_manager_${capability}`,
          fixture.organizationId,
          fixture.manager.staffProfileId,
          fixture.branchId,
          capability,
        ]
      );
    }
    const capabilities = await client.query(
      `SELECT capability,effect FROM restaurant_staff_capability_grants
       WHERE "organizationId"=$1 AND "staffProfileId"=$2 AND "branchId"=$3 ORDER BY capability`,
      [fixture.organizationId, fixture.manager.staffProfileId, fixture.branchId]
    );
    expect(capabilities.rows).toEqual(
      ['cash:adjust', 'catering:manage', 'payments:refund'].map((capability) => ({
        capability,
        effect: 'ALLOW',
      }))
    );

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
  await chooseSelectField(
    dialog.getByRole('combobox', { name: 'Order branch', exact: true }),
    fixture.branchId
  );
  await dialog.getByLabel('Customer').selectOption(fixture.customer.id);
  await dialog.getByLabel('Event name').fill(input.eventName);
  await dialog.getByLabel('Event date').fill(input.eventDate);
  await dialog.getByLabel('Service time').fill('18:30');
  await dialog.getByLabel('Headcount').fill(input.headcount);
  await dialog.getByLabel('Venue address').fill('12 Catering Lane, Lahore');
  await dialog.getByLabel('Quoted total').fill(input.quotedTotal);
  await dialog.getByLabel('Planned deposit').fill('50.00');
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
  await page.getByLabel('Recipe', { exact: true }).selectOption(source);
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

async function approveBooking(page: Page, date: string) {
  await page.getByLabel('Booking start with UTC offset').fill(`${date}T18:00:00+05:00`);
  await page.getByLabel('Booking end with UTC offset').fill(`${date}T20:00:00+05:00`);
  await page.getByLabel('Fulfillment').selectOption('PICKUP');
  await page.getByLabel('Stock location').selectOption(cateringFixture.stockLocationId);
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
  await expect(page.getByRole('status').filter({ hasText: 'capacity' }).first()).toBeVisible();
}

async function cancelOrder(page: Page) {
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm status change' });
  await expect(dialog).toContainText('Cancel this order? Prepared inventory remains consumed.');
  await waitForMutation(page, 'restaurantCatering.transition', () =>
    dialog.getByRole('button', { name: 'Confirm change' }).click()
  );
  await expect(dialog).toBeHidden();
}

async function expectOrderStatus(page: Page, eventName: string, status: 'CLOSED' | 'CANCELLED') {
  await page.getByLabel('Filter by status').selectOption(status);
  await expect(
    page.getByRole('button', { name: new RegExp(`^Select event ${eventName}`) })
  ).toBeVisible();
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
  const receipt = readAcceptanceReceipt();
  const databaseUrl = assertAcceptanceDatabase(process.env.DATABASE_URL, receipt);
  pool = new pg.Pool({ connectionString: databaseUrl });
  const identity = (
    await pool.query(
      'SELECT current_database() AS database, current_user AS role, inet_server_port() AS port, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user'
    )
  ).rows[0];
  expect(identity).toEqual({
    database: receipt.database,
    role: receipt.runtimeRole,
    port: 55683,
    rolsuper: false,
    rolbypassrls: false,
  });
  await seedCateringFixture();
});

test.beforeEach(async ({ baseURL }) => {
  assertAcceptanceBrowser(baseURL, readAcceptanceReceipt());
  expect(process.env.PLAYWRIGHT_BASE_URL).toBe(baseURL);
});

test.afterAll(async () => {
  await pool?.end();
});

test('creates, costs, produces, delivers, and closes a catering order', async ({ page }) => {
  test.slow();
  const unpriced = cateringFixture.ingredients[1];
  await tenantQuery(
    'UPDATE restaurant_ingredients SET "referenceCost"=NULL WHERE "organizationId"=$1 AND id=$2',
    [fixture.organizationId, unpriced.id]
  );
  await openCatering(page);
  const eventName = 'E2E catering close lifecycle';
  const orderId = await createOrder(page, {
    eventName,
    eventDate: '2026-09-20',
    headcount: '10',
    quotedTotal: '200.00',
  });

  try {
    const recipeOption = page.getByRole('option', {
      name: `${cateringFixture.recipe.name} · Cost unavailable: Ingredient prices are missing.`,
    });
    await expect(recipeOption).toHaveJSProperty('disabled', true);
    await expect(recipeOption).not.toContainText('/portion');
    const picker = page.getByLabel('Recipe', { exact: true });
    // Catering now requires a recipe on every line; product-only choices are absent.
    await expect(
      picker.locator(`option[value="product:${cateringFixture.product.id}"]`)
    ).toHaveCount(0);
    await expect(picker).toHaveValue('');
    const lines = await tenantQuery(
      `SELECT id FROM restaurant_catering_order_lines
       WHERE "organizationId"=$1 AND "orderId"=$2`,
      [fixture.organizationId, orderId]
    );
    expect(lines.rows).toEqual([]);
  } finally {
    await tenantQuery(
      'UPDATE restaurant_ingredients SET "referenceCost"=$3 WHERE "organizationId"=$1 AND id=$2',
      [fixture.organizationId, unpriced.id, unpriced.referenceCost]
    );
  }
  await page.reload();
  await page.getByRole('button', { name: new RegExp(`^Select event ${eventName}`) }).click();
  await expect(
    page.getByRole('option', { name: new RegExp(`^${cateringFixture.recipe.name} · .*2/portion$`) })
  ).toHaveJSProperty('disabled', false);

  // Keep the add/remove-line coverage using the current recipe-backed contract.
  await addLine(page, cateringFixture.recipe.id, 'Four packaged add-ons', '4', '5.00');
  const recipeLine = await tenantQuery(
    `SELECT "recipeId", "productId", portions::text, "unitPrice"::text
     FROM restaurant_catering_order_lines
     WHERE "organizationId"=$1 AND "orderId"=$2`,
    [fixture.organizationId, orderId]
  );
  expect(recipeLine.rows).toEqual([
    { recipeId: cateringFixture.recipe.id, productId: null, portions: '4.000', unitPrice: '5.00' },
  ]);

  await addLine(page, cateringFixture.recipe.id, 'Ten celebration trays', '10', '15.00');
  await page.getByLabel('Cost type').selectOption('TRANSPORT');
  await page.getByLabel('Label').fill('Delivery van');
  await page.getByLabel('Amount', { exact: true }).fill('20.00');
  await waitForMutation(page, 'restaurantCatering.addExtraCost', () =>
    page.getByRole('button', { name: 'Add cost' }).click()
  );

  await tenantQuery(
    'UPDATE restaurant_ingredients SET "referenceCost"=NULL WHERE "organizationId"=$1 AND id=$2',
    [fixture.organizationId, unpriced.id]
  );
  await approveBooking(page, '2026-09-20');
  await moveTo(page, 'quoted');
  await expect(page.getByRole('button', { name: 'Move to confirmed' })).toBeVisible();
  // An uncosted catalog line must not be silently frozen as zero cost.
  await page.getByRole('button', { name: 'Move to confirmed' }).click();
  const rejectedConfirmation = page.getByRole('dialog', { name: 'Confirm status change' });
  const deniedConfirmation = page.waitForResponse(
    (response) =>
      response.url().includes('/api/trpc/restaurantCatering.transition') &&
      response.request().method() === 'POST'
  );
  await rejectedConfirmation.getByRole('button', { name: 'Confirm change' }).click();
  const deniedResponse = await deniedConfirmation;
  expect(deniedResponse.status()).toBe(409);
  expect(await deniedResponse.text()).toContain('cost information is incomplete');
  expect((await movementRows(orderId, 'consumption')).rows).toEqual([]);
  await rejectedConfirmation.getByRole('button', { name: 'Keep current status' }).click();
  await tenantQuery(
    'UPDATE restaurant_ingredients SET "referenceCost"=$3 WHERE "organizationId"=$1 AND id=$2',
    [fixture.organizationId, unpriced.id, unpriced.referenceCost]
  );
  await waitForMutation(page, 'restaurantCatering.removeLine', () =>
    page.getByRole('button', { name: /^Remove Four packaged add-ons from/ }).click()
  );
  await approveBooking(page, '2026-09-20');
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
    { recipe_id: cateringFixture.recipe.id, product_id: null, snapshot: '2.0000' },
  ]);

  await expect(page.getByText(/^PKR 160(?:\.0+)?$/).first()).toBeVisible();
  await expect(page.getByText(/^80(?:\.0+)?%$/)).toBeVisible();
  for (const ingredient of cateringFixture.ingredients) {
    const row = page.getByRole('row').filter({ hasText: ingredient.name });
    await expect(row).toContainText('Gram');
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
  await page.getByLabel('Delivered', { exact: true }).fill('2026-09-20T16:45');
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

async function enrollBrowser(page: Page, branch: string = fixture.branchId) {
  const origin = new URL(process.env.PLAYWRIGHT_BASE_URL!).origin;
  await page.goto(new URL('/restaurant/devices', origin).href);
  if (new URL(page.url()).pathname === '/login') {
    await signInAs(page, 'restaurantAdmin');
    await page.goto(new URL('/restaurant/devices', origin).href);
  }
  await page.getByRole('button', { name: 'Enroll device', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Enroll this browser' });
  await dialog.getByLabel('Device name').fill('Acceptance catering browser');
  await chooseSelectField(dialog.getByRole('combobox', { name: 'Branch', exact: true }), branch);
  await dialog.getByLabel('Device kind').selectOption('POS');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Enroll this browser' }).click();
  await expect(page).toHaveURL(/\/pos$/);
  // Enrollment's normal sign-out is part of the contract. No cookie/session injection.
  return origin;
}

async function unlockCatering(
  page: Page,
  staff: { staffProfileId: string; pin: string } = fixture.manager
) {
  await page.getByLabel('Terminal operator').selectOption(staff.staffProfileId);
  await page.getByLabel('Operator PIN', { exact: true }).fill(staff.pin);
  await page.getByRole('button', { name: 'Unlock terminal', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Lock terminal', exact: true })).toBeEnabled();
}

async function selectEvent(page: Page, name: string) {
  await page.getByRole('button', { name: new RegExp(`^Select event ${name}`) }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

async function moneyOrder(page: Page, name: string) {
  await openCatering(page);
  const id = await createOrder(page, {
    eventName: name,
    eventDate: '2026-10-20',
    headcount: '2',
    quotedTotal: '100.00',
  });
  await addLine(page, cateringFixture.recipe.id, 'Two money trays', '2', '50.00');
  await approveBooking(page, '2026-10-20');
  return id;
}

async function moneyRows(order: string) {
  return (
    await tenantQuery<{
      id: string;
      kind: string;
      amount: string;
      quote: string;
      original: string | null;
      source: string;
      actor: string;
      device: string;
      drawer: string | null;
      audited: boolean;
    }>(
      `SELECT e.id,e.kind,e.amount::text,e."quoteRevisionId" quote,e."originalEvidenceId" original,
      e.source,e."actorStaffProfileId" actor,e."deviceId" device,e."drawerMovementId" drawer,
      EXISTS(SELECT 1 FROM audit_logs a WHERE a."organizationId"=e."organizationId" AND a."targetId"=e.id AND a.action='catering.recordMoneyEvidence') audited
      FROM restaurant_catering_money_evidence e WHERE e."organizationId"=$1 AND e."cateringOrderId"=$2 ORDER BY e."createdAt",e.id`,
      [fixture.organizationId, order]
    )
  ).rows;
}

async function fillMoney(page: Page, amount: string) {
  const form = page.getByRole('form', { name: 'Record catering money' });
  await form.getByLabel('Payment amount').fill(amount);
  await form.getByLabel('Evidence source').fill('Synthetic counter attestation');
  await form.getByLabel('Evidence reference').fill('acceptance-' + amount);
  return form;
}

test('ordinary staff plus enrolled terminal: lost committed receipt, exact retry, double click and actor recovery', async ({
  page,
}) => {
  const name = 'Acceptance money recovery';
  await enrollBrowser(page);
  const order = await moneyOrder(page, name);
  await expect(page.getByRole('button', { name: 'Record receipt evidence' })).toBeDisabled();
  await page.getByRole('button', { name: 'Connect enrolled terminal' }).click();
  await unlockCatering(page);
  const form = await fillMoney(page, '30.00');
  const commands: Array<{ key: string; body: string }> = [];
  let committedId = '';
  await page.route('**/api/restaurant/catering/money', async (route) => {
    commands.push({
      key: route.request().headers()['idempotency-key'] ?? '',
      body: route.request().postData() ?? '',
    });
    if (commands.length === 1) {
      // The real server commits before only its response is lost. No mocked success.
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(200);
      committedId = (await response.json()).evidenceId;
      expect(committedId).toBeTruthy();
      await route.abort('connectionfailed');
    } else await route.continue();
  });
  await form
    .getByRole('button', { name: 'Record receipt evidence' })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await expect(form.getByRole('alert')).toContainText('Outcome unknown');
  expect(commands).toHaveLength(1);
  expect((await moneyRows(order)).map((row) => row.id)).toEqual([committedId]);
  await expect(form.getByLabel('Payment amount')).toBeDisabled();
  // Inject only a transient list denial; the preceding receipt commit and subsequent replay use the real server.
  let denyList = true;
  await page.route('**/api/trpc/**', async (route) => {
    const paths = new URL(route.request().url()).pathname.split('/api/trpc/')[1]!.split(',');
    if (!denyList || !paths.includes('restaurantCatering.list')) return route.continue();
    const response = await route.fetch();
    const data = await response.json();
    const denied = {
      error: {
        json: {
          message: 'Synthetic transient permission denial',
          code: -32003,
          data: { code: 'FORBIDDEN', httpStatus: 403, path: 'restaurantCatering.list' },
        },
      },
    };
    await route.fulfill({
      response,
      json: Array.isArray(data)
        ? data.map((entry, index) => (paths[index] === 'restaurantCatering.list' ? denied : entry))
        : denied,
    });
  });
  await page.getByLabel('Filter by status').selectOption('DRAFT');
  await expect(page.getByText('You do not have permission to view catering orders.')).toBeVisible();
  await expect(form).toBeHidden();
  expect(commands).toHaveLength(1);
  denyList = false;
  await page.getByRole('button', { name: 'Retry catering access' }).click();
  await expect(form.getByRole('button', { name: 'Retry same payment command' })).toBeEnabled();
  await page.unroute('**/api/trpc/**');
  await page.getByRole('button', { name: 'Lock terminal', exact: true }).click();
  await unlockCatering(page, fixture.operator);
  await expect(form.getByRole('alert').filter({ hasText: 'original staff account' })).toBeVisible();
  await expect(form.getByRole('button', { name: 'Retry same payment command' })).toBeDisabled();
  await page.getByRole('button', { name: 'Lock terminal', exact: true }).click();
  await unlockCatering(page);
  await page.context().setOffline(true);
  await expect(form.getByRole('button', { name: 'Retry same payment command' })).toBeDisabled();
  await page.context().setOffline(false);
  await form.getByRole('button', { name: 'Retry same payment command' }).click();
  await expect(form.getByRole('status')).toContainText('Previously recorded evidence confirmed');
  expect(commands).toHaveLength(2);
  expect(commands[0]!.key).toBeTruthy();
  expect(commands[1]).toEqual(commands[0]);
  expect(await moneyRows(order)).toEqual([
    expect.objectContaining({
      id: committedId,
      amount: '30.00',
      actor: fixture.manager.staffProfileId,
      source: 'OPERATOR_ATTESTED',
      drawer: null,
      audited: true,
    }),
  ]);
  await page.unroute('**/api/restaurant/catering/money');

  await fillMoney(page, '70.00');
  await form.getByLabel('Receipt kind').selectOption('BALANCE');
  await form.getByRole('button', { name: 'Record receipt evidence' }).click();
  await expect(form.getByRole('status')).toContainText('Payment evidence recorded');
  expect((await moneyRows(order)).map(({ amount, kind }) => ({ amount, kind }))).toEqual([
    { amount: '30.00', kind: 'DEPOSIT' },
    { amount: '70.00', kind: 'BALANCE' },
  ]);

  // A revised/cancelled order still refunds the original receipt and original quote.
  const original = (await moneyRows(order))[0]!;
  const stock = await tenantQuery<{ count: number }>(
    'SELECT count(*)::int count FROM restaurant_stock_movements WHERE "organizationId"=$1',
    [fixture.organizationId]
  );
  await page.getByRole('button', { name: 'Edit order', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit catering order' });
  await editor.getByLabel('Quoted total').fill('120.00');
  await waitForMutation(page, 'restaurantCatering.update', () =>
    editor.getByRole('button', { name: 'Save order' }).click()
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await cancelOrder(page);
  const receipt = page
    .getByRole('listitem')
    .filter({ hasText: `Receipt reference: ${original.id}` });
  await receipt.getByRole('button', { name: 'Refund this receipt' }).click();
  await fillMoney(page, '30.01');
  const rejected = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/restaurant/catering/money') &&
      response.request().method() === 'POST'
  );
  await form.getByRole('button', { name: 'Record refund evidence' }).click();
  expect((await rejected).status()).toBe(409); // Per-original cap, despite aggregate balance of 100.
  expect(await moneyRows(order)).toHaveLength(2);
  await form.getByLabel('Payment amount').fill('20.00');
  await form.getByRole('button', { name: 'Record refund evidence' }).click();
  await expect(form.getByRole('status')).toContainText('Payment evidence recorded');
  expect((await moneyRows(order))[2]).toMatchObject({
    kind: 'REFUND',
    amount: '20.00',
    original: original.id,
    quote: original.quote,
    audited: true,
  });
  expect(
    (
      await tenantQuery(
        'SELECT count(*)::int count FROM restaurant_stock_movements WHERE "organizationId"=$1',
        [fixture.organizationId]
      )
    ).rows
  ).toEqual(stock.rows);
});

test('staff-only, terminal-only and mismatched-branch money UI remain denied', async ({
  page,
  browser,
}) => {
  const name = 'Acceptance dual identity denials';
  const order = await moneyOrder(page, name);
  await withTenantClient(async (client) => {
    await client.query(
      "SELECT set_config('app.current_organization_id','acceptance_foreign_org',true)"
    );
    await client.query(`INSERT INTO organizations (id,slug,"legalName","displayName",vertical,"updatedAt") VALUES ('acceptance_foreign_org','acceptance_foreign_org','Synthetic foreign tenant','Synthetic foreign tenant','RESTAURANT',now());
      INSERT INTO restaurant_branches(id,"organizationId",name,"updatedAt") VALUES ('acceptance_foreign_branch','acceptance_foreign_org','Foreign branch',now());
      INSERT INTO restaurant_catering_orders(id,"organizationId","branchId","eventName","eventDate",headcount,"updatedAt") VALUES ('acceptance_foreign_order','acceptance_foreign_org','acceptance_foreign_branch','Foreign event must remain private',current_date,1,now())`);
  });
  const readOrder = (orderId: string) =>
    page.evaluate(async (id) => {
      const input = encodeURIComponent(JSON.stringify({ json: { orderId: id } }));
      const response = await fetch(`/api/trpc/restaurantCatering.get?input=${input}`);
      return { status: response.status, text: await response.text() };
    }, orderId);
  expect((await readOrder(order)).status).toBe(200);
  const foreign = await readOrder('acceptance_foreign_order');
  expect(foreign.status).toBe(404);
  expect(foreign.text).toContain('NOT_FOUND');
  expect(foreign.text).not.toContain('Foreign event must remain private');
  const deniedContext = await browser.newContext();
  try {
    const deniedPage = await deniedContext.newPage();
    const origin = await signInAs(deniedPage, 'restaurantOperator');
    await deniedPage.goto(new URL('/restaurant/catering', origin).href);
    await expect(
      deniedPage.getByText(/access denied|do not have permission/i).first()
    ).toBeVisible();
    // The UI batches queries; verify this procedure's HTTP status independently.
    const deniedList = await deniedPage.evaluate(async () => {
      const input = encodeURIComponent(JSON.stringify({ json: {} }));
      return (await fetch(`/api/trpc/restaurantCatering.list?input=${input}`)).status;
    });
    expect(deniedList).toBe(403);
    await expect(deniedPage.getByRole('button', { name: 'New order', exact: true })).toHaveCount(0);
  } finally {
    await deniedContext.close();
  }
  const submit = page.getByRole('button', { name: 'Record receipt evidence' });
  await expect(submit).toBeDisabled(); // ordinary staff, no terminal
  await enrollBrowser(page, fixture.branchA2Id);
  await page.goto('/restaurant/catering');
  await expect(page).toHaveURL(/\/login/); // enrolled terminal, no staff
  await openCatering(page);
  await selectEvent(page, name);
  await page.getByRole('button', { name: 'Connect enrolled terminal' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'another organization or branch' })
  ).toBeVisible();
  await expect(submit).toBeDisabled();
  expect(await moneyRows(order)).toEqual([]);
});

test('cash receipt and refund reconcile the actual drawer without stock or sales rows', async ({
  page,
}) => {
  await enrollBrowser(page);
  await page.getByLabel('Operator', { exact: true }).selectOption(fixture.manager.staffProfileId);
  await page.getByLabel('Operator PIN', { exact: true }).fill(fixture.manager.pin);
  await page.getByRole('button', { name: 'Unlock terminal', exact: true }).click();
  const currentDrawer = page.waitForResponse(
    (response) => response.url().endsWith('/api/restaurant/cash/drawer/current'),
    { timeout: 15_000 }
  );
  await page.getByRole('button', { name: 'Cash drawer', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Cash drawer', exact: true });
  const drawerRead = await currentDrawer.catch(async (error: unknown) => {
    throw new Error(`${String(error)}; drawer state: ${await drawer.innerText()}`);
  });
  expect(drawerRead.status(), await drawerRead.text()).toBe(200);

  await drawer.getByLabel('Opening float').fill('0.00');
  const opening = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/restaurant/cash/drawer/open') &&
      response.request().method() === 'POST'
  );
  await drawer.getByRole('button', { name: 'Open drawer', exact: true }).click();
  const opened = await opening;
  expect(opened.status()).toBe(200);
  const drawerId = (await opened.json()).drawerSessionId as string;
  const order = await moneyOrder(page, 'Acceptance cash lineage');
  await page.getByRole('button', { name: 'Connect enrolled terminal' }).click();
  // Establishment is asynchronous and creates a locked session; await the normal PIN flow.
  await unlockCatering(page);
  const form = page.getByRole('form', { name: 'Record catering money' });
  const counts = () =>
    tenantQuery(
      'SELECT (SELECT count(*)::int FROM restaurant_stock_movements) stock,(SELECT count(*)::int FROM restaurant_bills) bills,(SELECT count(*)::int FROM restaurant_payments) payments,(SELECT count(*)::int FROM restaurant_tenders) tenders'
    );
  const before = (await counts()).rows;
  await form.getByLabel('Payment amount').fill('28.00');
  await form.getByLabel('Evidence type').selectOption('CASH');
  await form.getByLabel('Open drawer session reference').fill(drawerId);
  await form.getByRole('button', { name: 'Record receipt evidence' }).click();
  await expect(form.getByRole('status')).toContainText('Payment evidence recorded');
  const original = (await moneyRows(order))[0]!;
  await page
    .getByRole('listitem')
    .filter({ hasText: `Receipt reference: ${original.id}` })
    .getByRole('button', { name: 'Refund this receipt' })
    .click();
  await form.getByLabel('Payment amount').fill('8.00');
  await form.getByLabel('Evidence type').selectOption('CASH');
  await form.getByLabel('Open drawer session reference').fill(drawerId);
  await form.getByRole('button', { name: 'Record refund evidence' }).click();
  await expect(form.getByRole('status')).toContainText('Payment evidence recorded');
  const rows = await moneyRows(order);
  expect(rows).toHaveLength(2);
  expect(
    rows.every((row) => row.drawer && row.audited && row.actor === fixture.manager.staffProfileId)
  ).toBe(true);
  const ledger = await tenantQuery(
    `SELECT m.kind::text,m.amount::text,m."drawerSessionId" drawer,m."staffProfileId" actor,m."deviceId" device
    FROM restaurant_drawer_movements m JOIN restaurant_catering_money_evidence e ON e."drawerMovementId"=m.id AND e."organizationId"=m."organizationId"
    WHERE e."cateringOrderId"=$1 ORDER BY e."createdAt",e.id`,
    [order]
  );
  expect(ledger.rows).toEqual([
    {
      kind: 'PAID_IN',
      amount: '28.00',
      drawer: drawerId,
      actor: fixture.manager.staffProfileId,
      device: rows[0]!.device,
    },
    {
      kind: 'PAID_OUT',
      amount: '8.00',
      drawer: drawerId,
      actor: fixture.manager.staffProfileId,
      device: rows[0]!.device,
    },
  ]);
  expect((await counts()).rows).toEqual(before);
  await page.goto('/pos');
  await page.getByLabel('Operator', { exact: true }).selectOption(fixture.manager.staffProfileId);
  await page.getByLabel('Operator PIN', { exact: true }).fill(fixture.manager.pin);
  await page.getByRole('button', { name: 'Unlock terminal', exact: true }).click();
  await page.getByRole('button', { name: 'Cash drawer', exact: true }).click();
  const closingDrawer = page.getByRole('dialog', { name: 'Cash drawer', exact: true });
  await closingDrawer.getByLabel('Counted cash').fill('20.00');
  const closing = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/restaurant/cash/drawer/close') &&
      response.request().method() === 'POST'
  );
  await closingDrawer.getByRole('button', { name: 'Close drawer', exact: true }).click();
  const closed = await closing;
  expect(closed.status(), await closed.text()).toBe(200);
  expect(await closed.json()).toMatchObject({ expectedCash: '20.00', variance: '0.00' });
});

test('disabled Core refuses money UI without ledger writes', async ({ page }) => {
  const order = await moneyOrder(page, 'Acceptance disabled module');
  const coreModuleId = await withTenantClient(async (client) => {
    await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    const modules = await client.query<{ id: string }>(
      "SELECT id FROM platform_modules WHERE key='restaurant-core'"
    );
    expect(modules.rows).toHaveLength(1);
    return modules.rows[0].id;
  });
  const previous = await tenantQuery<{ id: string; status: string }>(
    `SELECT id,status::text FROM organization_modules WHERE "organizationId"=$1 AND "moduleId"=$2`,
    [fixture.organizationId, coreModuleId]
  );
  try {
    const disabled = await tenantQuery(
      `INSERT INTO organization_modules (id,"organizationId","moduleId",status,"createdAt","updatedAt")
      VALUES ('acceptance_disabled_core',$1,$2,'DISABLED',now(),now())
      ON CONFLICT ("organizationId","moduleId") DO UPDATE SET status='DISABLED',"updatedAt"=now() RETURNING status::text`,
      [fixture.organizationId, coreModuleId]
    );
    expect(disabled.rows).toEqual([{ status: 'DISABLED' }]);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Record receipt evidence' })).toHaveCount(0);
    await expect(
      page.getByText(/not enabled|access denied|module.*disabled|not available/i).first()
    ).toBeVisible();
    expect(await moneyRows(order)).toEqual([]);
  } finally {
    if (previous.rows[0])
      await tenantQuery(
        'UPDATE organization_modules SET status=$2::"OrganizationModuleStatus", "updatedAt"=now() WHERE id=$1',
        [previous.rows[0].id, previous.rows[0].status]
      );
    else
      await tenantQuery(
        'DELETE FROM organization_modules WHERE id=\'acceptance_disabled_core\' AND "organizationId"=$1',
        [fixture.organizationId]
      );
  }
});

test('Studio catering and normal enrolled POS cover sizes, themes, motion and keyboard', async ({
  page,
}, info) => {
  await enrollBrowser(page);
  const errors: string[] = [];
  const failedResponses: Promise<string>[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400)
      failedResponses.push(
        response.text().then((body) => `${response.status()} ${response.url()}: ${body}`)
      );
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${message.text()} ${message.location().url}`);
  });
  await page.getByLabel('Operator', { exact: true }).selectOption(fixture.manager.staffProfileId);
  await page.getByLabel('Operator PIN', { exact: true }).fill(fixture.manager.pin);
  await page.getByRole('button', { name: 'Unlock terminal', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Order pad' })).toBeVisible();
  await captureRestaurantStudio(page, info, 'pos');
  await moneyOrder(page, 'Acceptance Studio catering');
  await page.getByRole('button', { name: 'Connect enrolled terminal' }).click();
  await unlockCatering(page);
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 10_000 });
  await captureRestaurantStudio(page, info, 'catering');
  const button = page.getByRole('button', { name: 'New order', exact: true });
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Create catering order' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Create catering order' })).toBeHidden();
  await expect(button).toBeFocused();
  expect(errors, (await Promise.all(failedResponses)).join('\n')).toEqual([]);
});

test('cancellation retains consumption; only explicit unused return restores selected-location stock', async ({
  page,
}) => {
  test.slow();
  await openCatering(page);
  const eventName = 'E2E catering cancellation lifecycle';
  const orderId = await createOrder(page, {
    eventName,
    eventDate: '2026-09-21',
    headcount: '2',
    quotedTotal: '40.00',
  });
  await addLine(page, cateringFixture.recipe.id, 'Two cancellation trays', '2', '20.00');
  await approveBooking(page, '2026-09-21');
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

  expect((await movementRows(orderId, 'reversal')).rows).toEqual([]);
  const original = await tenantQuery<{ id: string; stock_item_id: string; location_id: string }>(
    `SELECT movement.id,movement."stockItemId" stock_item_id,movement."locationId" location_id
     FROM restaurant_inventory_idempotency_keys key
     CROSS JOIN LATERAL unnest(string_to_array(key."resultRef", ',')) movement_id
     JOIN restaurant_stock_movements movement ON movement.id = movement_id
     WHERE key."organizationId" = $1 AND key.key=$2
     ORDER BY movement."stockItemId"`,
    [fixture.organizationId, `catering:${orderId}:consumption`]
  );
  expect(original.rows).toHaveLength(2);
  expect(original.rows.every((row) => row.location_id === cateringFixture.stockLocationId)).toBe(
    true
  );
  const form = page.getByRole('form', { name: 'Record physical disposition' });
  for (const [kind, amount] of [
    ['UNUSED_RETURN', '25'],
    ['WASTE', '25'],
    ['NO_RETURN', '50'],
  ]) {
    await form.getByLabel('Original consumption').selectOption(original.rows[0]!.id);
    await form.getByRole('combobox', { name: /^Disposition/ }).selectOption(kind!);
    await form.getByLabel('Canonical quantity').fill(amount!);
    await form.getByLabel('Disposition reason').fill('Synthetic explicit physical allocation');
    await waitForMutation(page, 'restaurantCatering.recordDisposition', () =>
      form.getByRole('button', { name: 'Record disposition', exact: true }).click()
    );
  }
  const dispositions = await tenantQuery<{
    kind: string;
    quantity: string;
    returned: string | null;
    location: string | null;
  }>(
    `SELECT d.kind,d.quantity::text,m.quantity::text returned,m."locationId" location
     FROM restaurant_catering_dispositions d LEFT JOIN restaurant_stock_movements m ON m.id=d."resultMovementId" AND m."organizationId"=d."organizationId"
     WHERE d."organizationId"=$1 AND d."orderId"=$2 ORDER BY d.kind`,
    [fixture.organizationId, orderId]
  );
  expect(dispositions.rows).toEqual([
    { kind: 'NO_RETURN', quantity: '50.000000', returned: null, location: null },
    {
      kind: 'UNUSED_RETURN',
      quantity: '25.000000',
      returned: '25.000000',
      location: cateringFixture.stockLocationId,
    },
    { kind: 'WASTE', quantity: '25.000000', returned: null, location: null },
  ]);
});
