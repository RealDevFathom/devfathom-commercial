import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import pg from 'pg';

import {
  establishPosFixture,
  e2eIdempotencyKey,
  installSeededTerminalCookie,
  restaurantE2eCredentials as fixture,
  terminalBrowserBaseUrl,
  type RestaurantTerminalFixture,
} from './restaurant-fixture';
import { signInAs } from './fixtures/restaurant-actor-accessibility';

test.describe.configure({ mode: 'serial' });

async function post(
  request: APIRequestContext,
  terminal: RestaurantTerminalFixture,
  path: string,
  data: Record<string, unknown>,
  key: string
) {
  const response = await request.post(path, {
    headers: { ...terminal.headers, 'Idempotency-Key': key },
    data,
  });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return response;
}

async function unlockAs(
  request: APIRequestContext,
  staff: { staffProfileId: string; pin: string }
) {
  const established = await request.post('/api/restaurant/terminal/establish', {
    headers: { authorization: `Bearer ${fixture.pos.secret}` },
  });
  const { sessionToken } = (await established.json()) as { sessionToken: string };
  const headers = {
    authorization: `Bearer ${fixture.pos.secret}`,
    'x-terminal-session': sessionToken,
  };
  const unlocked = await request.post('/api/restaurant/terminal/unlock', {
    headers,
    data: { staffProfileId: staff.staffProfileId, type: 'PIN', secret: staff.pin },
  });
  expect(unlocked.status()).toBe(200);
  return {
    deviceId: fixture.pos.deviceId,
    deviceSecret: fixture.pos.secret,
    sessionToken,
    headers,
  };
}

async function tenantQuery<T extends pg.QueryResultRow>(
  pool: pg.Pool,
  text: string,
  values: unknown[] = []
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_organization_id', $1, true),
              set_config('app.is_platform_admin', 'false', true)`,
      [fixture.organizationId]
    );
    const result = await client.query<T>(text, values);
    await client.query('ROLLBACK');
    return result;
  } finally {
    client.release();
  }
}

async function tenantMutation(pool: pg.Pool, text: string, values: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_organization_id', $1, true),
              set_config('app.is_platform_admin', 'false', true)`,
      [fixture.organizationId]
    );
    const result = await client.query(text, values);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function unlockPos(page: Page) {
  const origin = terminalBrowserBaseUrl();
  await installSeededTerminalCookie(page.context(), fixture.pos, origin);
  await page.goto(new URL('/pos', origin).href);
  await page.getByLabel('Operator', { exact: true }).selectOption(fixture.operator.staffProfileId);
  await page.getByLabel('Operator PIN', { exact: true }).fill(fixture.operator.pin);
  await page.getByRole('button', { name: 'Unlock terminal' }).click();
  await expect(page.getByRole('heading', { name: 'Order pad' })).toBeVisible();
}

async function openVisibleDelivery(page: Page) {
  await page.getByLabel('Channel').selectOption('DELIVERY');
  await page.getByLabel('Customer name').fill(fixture.customer.name);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(fixture.customer.name) }).click();
  await expect(page.getByLabel('Saved address')).toHaveValue(fixture.delivery.addressId);
  await expect(page.getByLabel('Delivery zone')).toHaveValue(fixture.delivery.zoneId);
  await page.getByRole('button', { name: new RegExp(fixture.menuItem.name) }).click();
  await page.getByRole('button', { name: 'Add to order' }).click();
  const openedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/restaurant/orders/open') &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Open order' }).click();
  const opened = (await (await openedResponse).json()) as {
    orderId: string;
    orderNumber: number;
  };
  await expect(
    page.getByText(`Delivery order ${opened.orderNumber} opened and fulfillment attached.`)
  ).toBeVisible();
  await page.getByRole('button', { name: 'Send whole order' }).click();
  await expect(page.getByText('Order sent to kitchen.')).toBeVisible();
  return opened;
}

async function readyVisible(browser: Browser, orderNumber: number) {
  const origin = terminalBrowserBaseUrl();
  const context = await browser.newContext({ baseURL: origin });
  await installSeededTerminalCookie(context, fixture.kds, origin);
  const page = await context.newPage();
  await page.goto(new URL('/kds', origin).href);
  await page.getByLabel('Acting operator').selectOption(fixture.operator.staffProfileId);
  await page.getByLabel('Operator PIN', { exact: true }).fill(fixture.operator.pin);
  await page.getByRole('button', { name: 'Verify PIN and unlock' }).click();
  await page
    .getByRole('button', {
      name: new RegExp(`Start ${fixture.menuItem.name} for order ${orderNumber}`),
    })
    .click();
  await page
    .getByRole('button', {
      name: new RegExp(`Mark ready ${fixture.menuItem.name} for order ${orderNumber}`),
    })
    .click();
  return { context, page };
}

async function handoffVisible(
  kds: Awaited<ReturnType<typeof readyVisible>>,
  orderNumber: number,
  expectedMode: 'COD' | 'PREPAID'
) {
  const delivery = kds.page.getByRole('article').filter({ hasText: `Order #${orderNumber}` });
  await expect(delivery.getByText(expectedMode, { exact: true })).toBeVisible();
  await delivery.getByRole('button', { name: `Dispatch order ${orderNumber}` }).click();
  await kds.page.getByRole('button', { name: 'Confirm transition' }).click();
  await expect(kds.page.getByText('Delivery dispatched.')).toBeVisible();
  await delivery.getByRole('button', { name: `Mark delivered order ${orderNumber}` }).click();
  await kds.page.getByRole('button', { name: 'Confirm transition' }).click();
  await expect(kds.page.getByText('Delivery completed.')).toBeVisible();
  await kds.context.close();
}

async function settleVisible(page: Page, orderNumber: number, tender: 'CASH' | 'CARD') {
  await unlockPos(page);
  await page.getByRole('button', { name: new RegExp(`^#${orderNumber} ·`) }).click();
  await page.getByRole('button', { name: 'Close order' }).click();
  await expect(page.getByRole('dialog', { name: 'Collect payment' })).toBeVisible();
  if (tender === 'CARD') await page.getByLabel('Tender type').selectOption('CARD');
  await page.getByRole('button', { name: 'Apply tender' }).click();
  await expect(page.getByText('Bill settled')).toBeVisible();
}

test('direct delivery authorization, COD/PREPAID handoff and fee reporting remain integrated', async ({
  request,
  page,
  browser,
}) => {
  test.slow();
  const key = e2eIdempotencyKey('delivery-auth', Date.now());
  const denied = await unlockAs(request, fixture.deniedOperator);
  const rejected = await request.post('/api/restaurant/orders/open', {
    headers: { ...denied.headers, 'Idempotency-Key': key },
    data: { channel: 'DELIVERY', customerId: fixture.customer.id },
  });
  expect(rejected.status()).toBe(403);

  const databaseUrl = process.env.DATABASE_URL;
  expect(databaseUrl, 'integrated lane requires DATABASE_URL').toBeTruthy();
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const before = await tenantQuery<{ orders: string; keys: string; events: string }>(
    pool,
    `SELECT
       (SELECT count(*)::text FROM restaurant_orders WHERE "deviceId" = $1 AND channel = 'DELIVERY') orders,
       (SELECT count(*)::text FROM restaurant_order_idempotency_keys WHERE "deviceId" = $1 AND key = $2) keys,
       (SELECT count(*)::text FROM restaurant_order_events WHERE metadata->>'idempotencyKey' = $2) events`,
    [fixture.pos.deviceId, key]
  );
  expect(before.rows[0]).toEqual({ orders: '0', keys: '0', events: '0' });

  const pos = await establishPosFixture(request);
  const reused = await post(
    request,
    pos,
    '/api/restaurant/orders/open',
    { channel: 'DELIVERY', customerId: fixture.customer.id },
    key
  );
  expect(reused.status()).toBe(201);
  const reusedOrder = (await reused.json()) as { orderId: string; orderNumber: number };
  await post(
    request,
    pos,
    '/api/restaurant/orders/cancel',
    { orderId: reusedOrder.orderId, reason: 'Authorization same-key reuse proof complete' },
    e2eIdempotencyKey('delivery-auth-probe-cancel', reusedOrder.orderNumber)
  );

  await unlockPos(page);
  const cod = await openVisibleDelivery(page);
  const fulfillmentResult = await tenantQuery<{ id: string; fee: string }>(
    pool,
    `SELECT id, "deliveryFeeSnapshot"::text fee
       FROM restaurant_delivery_fulfillments WHERE "orderId" = $1`,
    [cod.orderId]
  );
  const fulfillment = fulfillmentResult.rows[0]!;
  expect(fulfillment.fee).toBe(fixture.delivery.fee);
  await tenantMutation(
    pool,
    `UPDATE restaurant_delivery_zones SET "fixedFee" = 9.75 WHERE id = $1`,
    [fixture.delivery.zoneId]
  );
  const frozen = await tenantQuery<{ fee: string }>(
    pool,
    `SELECT "deliveryFeeSnapshot"::text fee
       FROM restaurant_delivery_fulfillments WHERE id = $1`,
    [fulfillment.id]
  );
  expect(frozen.rows[0]!.fee).toBe(fixture.delivery.fee);

  const bill = await post(
    request,
    pos,
    '/api/restaurant/checkout/bill',
    { orderId: cod.orderId, split: { kind: 'NONE' } },
    e2eIdempotencyKey('delivery-bill', cod.orderNumber)
  );
  const billId = ((await bill.json()) as { billIds: string[] }).billIds[0]!;
  const summaryResponse = await request.get(
    `/api/restaurant/checkout/summary?orderId=${cod.orderId}`,
    { headers: pos.headers }
  );
  const summary = await summaryResponse.json();
  expect(summary.deliveryFeeTotal).toBe(fixture.delivery.fee);
  expect(Number(summary.accountedTotal)).toBe(
    Number(summary.derivedOrderTotal) + Number(fixture.delivery.fee)
  );

  const codKds = await readyVisible(browser, cod.orderNumber);
  await handoffVisible(codKds, cod.orderNumber, 'COD');
  await settleVisible(page, cod.orderNumber, 'CASH');
  const receiptResponse = await request.get(`/api/restaurant/checkout/receipt?billId=${billId}`, {
    headers: pos.headers,
  });
  const receipt = await receiptResponse.json();
  expect(receipt.totals.deliveryFeeTotal).toBe(fixture.delivery.fee);
  expect(JSON.stringify(receipt)).not.toContain('+923001234567');
  expect(JSON.stringify(receipt)).not.toContain('12 Delivery Street');

  const snapshot = await tenantQuery<{ fee: string; phone: string; address: string; mode: string }>(
    pool,
    `SELECT "deliveryFeeSnapshot"::text fee, "normalizedPhoneSnapshot" phone,
            "addressLine1Snapshot" address, "paymentMode"::text mode
       FROM restaurant_delivery_fulfillments WHERE id = $1`,
    [fulfillment.id]
  );
  expect(snapshot.rows[0]).toMatchObject({ fee: '3.50', mode: 'COD' });

  await unlockPos(page);
  const prepaid = await openVisibleDelivery(page);
  const prepaidFulfillment = await tenantQuery<{ fee: string }>(
    pool,
    `SELECT "deliveryFeeSnapshot"::text fee
       FROM restaurant_delivery_fulfillments WHERE "orderId" = $1`,
    [prepaid.orderId]
  );
  expect(prepaidFulfillment.rows[0]!.fee).toBe('9.75');
  const prepaidBill = await post(
    request,
    pos,
    '/api/restaurant/checkout/bill',
    { orderId: prepaid.orderId, split: { kind: 'NONE' } },
    e2eIdempotencyKey('delivery-prepaid-bill', prepaid.orderNumber)
  );
  expect(((await prepaidBill.json()) as { billIds: string[] }).billIds).toHaveLength(1);
  const prepaidSummaryResponse = await request.get(
    `/api/restaurant/checkout/summary?orderId=${prepaid.orderId}`,
    { headers: pos.headers }
  );
  const prepaidSummary = await prepaidSummaryResponse.json();
  expect(prepaidSummary.deliveryFeeTotal).toBe('9.75');
  const prepaidKds = await readyVisible(browser, prepaid.orderNumber);
  await settleVisible(page, prepaid.orderNumber, 'CARD');
  await handoffVisible(prepaidKds, prepaid.orderNumber, 'PREPAID');

  const businessDate = new Date().toISOString().slice(0, 10);
  const preview = await request.get(
    `/api/restaurant/cash/day/preview?businessDate=${businessDate}`,
    { headers: pos.headers }
  );
  expect(preview.status()).toBe(200);
  const previewBody = await preview.json();
  expect(previewBody.totals).toMatchObject({
    deliveryFeeSales: '13.25',
    deliveryFeeRefunds: '0.00',
  });
  await post(
    request,
    pos,
    '/api/restaurant/cash/drawer/close',
    {
      drawerSessionId: 'drawer_restaurant_e2e',
      countedCash: previewBody.totals.cashExpected,
    },
    e2eIdempotencyKey('delivery-drawer-close', cod.orderNumber)
  );
  const closed = await post(
    request,
    pos,
    '/api/restaurant/cash/day/close',
    { businessDate },
    e2eIdempotencyKey('delivery-day-close', cod.orderNumber)
  );
  expect((await closed.json()).totals).toMatchObject({
    deliveryFeeSales: '13.25',
    deliveryFeeRefunds: '0.00',
  });

  await page.goto(new URL('/pos', terminalBrowserBaseUrl()).href);
  await expect(page.locator('body')).not.toContainText(snapshot.rows[0]!.phone);
  await expect(page.locator('body')).not.toContainText(snapshot.rows[0]!.address);

  const admin = await browser.newPage();
  const adminOrigin = await signInAs(admin, 'restaurantAdmin');
  await admin.goto(
    new URL(`/restaurant/reports?from=${businessDate}&to=${businessDate}`, adminOrigin).href
  );
  await expect(admin.getByText('Delivery fee sales').locator('..')).toContainText('13.25');
  await expect(admin.getByText('Delivery fee refunds').locator('..')).toContainText('0.00');
  await admin.goto(
    new URL(`/restaurant/insights?from=${businessDate}&to=${businessDate}`, adminOrigin).href
  );
  const financialRow = admin.getByRole('row').filter({ hasText: businessDate });
  await expect(financialRow).toContainText('13.25');
  await expect(financialRow).toContainText('0.00');
  await expect(admin.locator('body')).not.toContainText(snapshot.rows[0]!.phone);
  await expect(admin.locator('body')).not.toContainText(snapshot.rows[0]!.address);
  await admin.close();
  await pool.end();
});
