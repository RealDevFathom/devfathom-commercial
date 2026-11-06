import { spawnSync } from 'node:child_process';

import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import pg from 'pg';

import {
  establishDeliveryPosFixture,
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
    headers: { authorization: `Bearer ${fixture.delivery.pos.secret}` },
  });
  const { sessionToken } = (await established.json()) as { sessionToken: string };
  const headers = {
    authorization: `Bearer ${fixture.delivery.pos.secret}`,
    'x-terminal-session': sessionToken,
  };
  const unlocked = await request.post('/api/restaurant/terminal/unlock', {
    headers,
    data: { staffProfileId: staff.staffProfileId, type: 'PIN', secret: staff.pin },
  });
  expect(unlocked.status()).toBe(200);
  const { composerProof } = (await unlocked.json()) as { composerProof: string };
  expect(typeof composerProof).toBe('string');
  return {
    deviceId: fixture.delivery.pos.deviceId,
    deviceSecret: fixture.delivery.pos.secret,
    sessionToken,
    headers: { ...headers, 'x-pos-composer-proof': composerProof },
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
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
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
  await installSeededTerminalCookie(page.context(), fixture.delivery.pos, origin);
  await page.goto(new URL('/pos', origin).href);
  await page
    .getByLabel('Operator', { exact: true })
    .selectOption(fixture.deliveryOperator.staffProfileId);
  await page.getByLabel('Operator PIN', { exact: true }).fill(fixture.deliveryOperator.pin);
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
  await page.getByLabel(new RegExp(fixture.modifier.name)).check();
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
    businessDate: string;
  };
  await expect(
    page.getByText(`Delivery order ${opened.orderNumber} opened and fulfillment attached.`)
  ).toBeVisible();
  await page.getByRole('button', { name: 'Send whole order' }).click();
  await expect(page.getByText('Order sent to kitchen.')).toBeVisible();
  return opened;
}

async function readyVisible(browser: Browser, contexts: BrowserContext[], orderNumber: number) {
  const origin = terminalBrowserBaseUrl();
  const context = await browser.newContext({ baseURL: origin });
  contexts.push(context);
  await installSeededTerminalCookie(context, fixture.delivery.kds, origin);
  const page = await context.newPage();
  await page.goto(new URL('/kds', origin).href);
  await page.getByLabel('Acting operator').selectOption(fixture.deliveryOperator.staffProfileId);
  await page.getByLabel('Operator PIN', { exact: true }).fill(fixture.deliveryOperator.pin);
  await page.getByRole('button', { name: 'Verify PIN and unlock' }).click();
  await page
    .getByRole('button', {
      name: new RegExp(`Start ${fixture.menuItem.name} for order ${orderNumber}`),
    })
    .click();
  const readyResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/restaurant/kds/bump') && response.request().method() === 'POST'
  );
  await page
    .getByRole('button', {
      name: new RegExp(`Mark ready ${fixture.menuItem.name} for order ${orderNumber}`),
    })
    .click();
  expect((await readyResponse).status()).toBe(200);
  await expect(page.getByText('Item marked ready.')).toBeVisible();
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

async function refreshDeliveryBoard(
  kds: Awaited<ReturnType<typeof readyVisible>>,
  orderNumber: number,
  expectedMode: 'COD' | 'PREPAID'
) {
  const responsePromise = kds.page.waitForResponse(
    async (response) => {
      if (
        !response.url().endsWith('/api/restaurant/kds/delivery/queue') ||
        response.request().method() !== 'GET' ||
        response.status() !== 200
      ) {
        return false;
      }
      const queue = (await response.json()) as {
        deliveries: Array<{
          orderNumber: number;
          status: string;
          paymentMode: string | null;
          dispatchable: boolean;
          rejection: string | null;
        }>;
      };
      return queue.deliveries.some(
        (delivery) =>
          delivery.orderNumber === orderNumber &&
          delivery.status === 'PENDING' &&
          delivery.paymentMode === expectedMode &&
          delivery.dispatchable === true &&
          delivery.rejection === null
      );
    },
    { timeout: 15_000 }
  );
  await kds.page.evaluate(() => window.dispatchEvent(new Event('online')));
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const delivery = kds.page.getByRole('article').filter({ hasText: `Order #${orderNumber}` });
  await expect(delivery.getByText(expectedMode, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(
    delivery.getByRole('button', { name: `Dispatch order ${orderNumber}` })
  ).toBeEnabled();
}

async function settleVisible(
  page: Page,
  orderNumber: number,
  tender: 'CASH' | 'CARD',
  amount: string
) {
  await unlockPos(page);
  await page.getByRole('button', { name: new RegExp(`^#${orderNumber} ·`) }).click();
  await page.getByRole('button', { name: 'Collect payment' }).click();
  await expect(page.getByRole('dialog', { name: 'Collect payment' })).toBeVisible();
  await page.getByLabel('Amount').fill(amount);
  if (tender === 'CASH') await page.getByLabel('Cash received').fill(amount);
  if (tender === 'CARD') await page.getByLabel('Tender type').selectOption('CARD');
  await page.getByRole('button', { name: 'Apply tender' }).click();
  await expect(
    page
      .getByRole('dialog', { name: 'Collect payment' })
      .getByRole('region', { name: /^Receipt \d+$/ })
  ).toBeVisible();
}

function drainRestaurantJobs(workerId: string) {
  const conditions = [process.env.NODE_OPTIONS, '--conditions=react-server']
    .filter(Boolean)
    .join(' ');
  const result = spawnSync(
    'bunx',
    [
      'tsx',
      'scripts/run-restaurant-jobs.ts',
      '--once',
      `--worker-id=${workerId}`,
      '--max-jobs-per-org=100',
      '--max-outbox-per-org=100',
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: conditions },
      encoding: 'utf8',
      timeout: 60_000,
    }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

test('direct delivery authorization, COD/PREPAID handoff and fee reporting remain integrated', async ({
  request,
  page,
  browser,
}) => {
  test.slow();
  const key = e2eIdempotencyKey('delivery-auth', Date.now());
  const databaseUrl = process.env.DATABASE_URL;
  expect(databaseUrl, 'integrated lane requires DATABASE_URL').toBeTruthy();
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const transientContexts: BrowserContext[] = [];
  try {
    await tenantMutation(
      pool,
      `UPDATE restaurant_delivery_zones SET "fixedFee" = 3.50 WHERE id = $1`,
      [fixture.delivery.zoneId]
    );
    const before = await tenantQuery<{ orders: string; keys: string; events: string }>(
      pool,
      `SELECT
       (SELECT count(*)::text FROM restaurant_orders WHERE "deviceId" = $1 AND channel = 'DELIVERY') orders,
       (SELECT count(*)::text FROM restaurant_order_idempotency_keys WHERE "deviceId" = $1 AND key = $2) keys,
       (SELECT count(*)::text FROM restaurant_order_events WHERE "actorDeviceId" = $1) events`,
      [fixture.delivery.pos.deviceId, key]
    );
    expect(before.rows[0]!.keys).toBe('0');

    const denied = await unlockAs(request, fixture.deliveryDeniedOperator);
    const rejected = await request.post('/api/restaurant/orders/open', {
      headers: { ...denied.headers, 'Idempotency-Key': key },
      data: { channel: 'DELIVERY', customerId: fixture.customer.id },
    });
    expect(rejected.status()).toBe(403);
    // A valid composer proof is presented, so the 403 must come from the capability gate.
    expect(((await rejected.json()) as { error: string }).error).toMatch(
      /^This operator lacks the "[a-z-]+:[a-z-]+" capability\.$/
    );

    const afterDenied = await tenantQuery<{ orders: string; keys: string; events: string }>(
      pool,
      `SELECT
       (SELECT count(*)::text FROM restaurant_orders WHERE "deviceId" = $1 AND channel = 'DELIVERY') orders,
       (SELECT count(*)::text FROM restaurant_order_idempotency_keys WHERE "deviceId" = $1 AND key = $2) keys,
       (SELECT count(*)::text FROM restaurant_order_events WHERE "actorDeviceId" = $1) events`,
      [fixture.delivery.pos.deviceId, key]
    );
    expect(afterDenied.rows[0]).toEqual(before.rows[0]);

    const pos = await establishDeliveryPosFixture(request);
    const reused = await post(
      request,
      pos,
      '/api/restaurant/orders/open',
      { channel: 'DELIVERY', customerId: fixture.customer.id },
      key
    );
    expect(reused.status()).toBe(201);
    const reusedOrder = (await reused.json()) as { orderId: string; orderNumber: number };
    const afterReuse = await tenantQuery<{ orders: string; keys: string; events: string }>(
      pool,
      `SELECT
       (SELECT count(*)::text FROM restaurant_orders WHERE "deviceId" = $1 AND channel = 'DELIVERY') orders,
       (SELECT count(*)::text FROM restaurant_order_idempotency_keys WHERE "deviceId" = $1 AND key = $2) keys,
       (SELECT count(*)::text FROM restaurant_order_events WHERE "actorDeviceId" = $1) events`,
      [fixture.delivery.pos.deviceId, key]
    );
    expect(Number(afterReuse.rows[0]!.orders)).toBe(Number(before.rows[0]!.orders) + 1);
    expect(afterReuse.rows[0]!.keys).toBe('1');
    expect(Number(afterReuse.rows[0]!.events)).toBe(Number(before.rows[0]!.events) + 1);
    await post(
      request,
      pos,
      '/api/restaurant/orders/cancel',
      { orderId: reusedOrder.orderId, reason: 'Authorization same-key reuse proof complete' },
      e2eIdempotencyKey('delivery-auth-probe-cancel', reusedOrder.orderNumber)
    );

    const drawer = await post(
      request,
      pos,
      '/api/restaurant/cash/drawer/open',
      { openingFloat: '100.00' },
      e2eIdempotencyKey('delivery-drawer-open', key)
    );
    const drawerState = (await drawer.json()) as {
      drawerSessionId: string;
      businessDate: string;
    };

    await unlockPos(page);
    const cod = await openVisibleDelivery(page);
    expect(cod.businessDate).toBe(drawerState.businessDate);
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
    expect(summary.accountedTotal).toBe(summary.derivedOrderTotal);

    const codKds = await readyVisible(browser, transientContexts, cod.orderNumber);
    await refreshDeliveryBoard(codKds, cod.orderNumber, 'COD');
    await handoffVisible(codKds, cod.orderNumber, 'COD');
    await settleVisible(page, cod.orderNumber, 'CASH', summary.accountedTotal);
    const receiptResponse = await request.get(`/api/restaurant/checkout/receipt?billId=${billId}`, {
      headers: pos.headers,
    });
    const receipt = await receiptResponse.json();
    expect(receipt.totals.deliveryFeeTotal).toBe(fixture.delivery.fee);
    expect(JSON.stringify(receipt)).not.toContain('+923001234567');
    expect(JSON.stringify(receipt)).not.toContain('12 Delivery Street');

    const snapshot = await tenantQuery<{
      fee: string;
      phone: string;
      address: string;
      mode: string;
    }>(
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
    const prepaidKds = await readyVisible(browser, transientContexts, prepaid.orderNumber);
    await settleVisible(page, prepaid.orderNumber, 'CARD', prepaidSummary.accountedTotal);
    await refreshDeliveryBoard(prepaidKds, prepaid.orderNumber, 'PREPAID');
    await handoffVisible(prepaidKds, prepaid.orderNumber, 'PREPAID');

    const businessDate = cod.businessDate;
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
        drawerSessionId: drawerState.drawerSessionId,
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
    drainRestaurantJobs(`restaurant-delivery-e2e-${key}`);
    const rollup = await tenantQuery<{ sales: string; refunds: string }>(
      pool,
      `SELECT "deliveryFeeSales"::text sales, "deliveryFeeRefunds"::text refunds
       FROM restaurant_insight_daily_rollups
      WHERE "branchId" = $1 AND "businessDate" = $2::date`,
      [fixture.delivery.branchId, businessDate]
    );
    expect(rollup.rows[0]).toEqual({ sales: '13.25', refunds: '0.00' });

    await page.goto(new URL('/pos', terminalBrowserBaseUrl()).href);
    await expect(page.locator('body')).not.toContainText(snapshot.rows[0]!.phone);
    await expect(page.locator('body')).not.toContainText(snapshot.rows[0]!.address);

    const admin = await browser.newPage();
    const adminOrigin = await signInAs(admin, 'restaurantAdmin');
    await admin.goto(
      new URL(
        `/restaurant/reports?branch=${fixture.delivery.branchId}&from=${businessDate}&to=${businessDate}`,
        adminOrigin
      ).href
    );
    const deliveryFeeSalesStat = admin
      .locator('[data-slot="stat"]')
      .filter({ has: admin.getByText('Delivery fee sales', { exact: true }) });
    const deliveryFeeRefundsStat = admin
      .locator('[data-slot="stat"]')
      .filter({ has: admin.getByText('Delivery fee refunds', { exact: true }) });
    await expect(deliveryFeeSalesStat.locator('.stat-figure')).toHaveText('13.25');
    await expect(deliveryFeeRefundsStat.locator('.stat-figure')).toHaveText('0');
    await admin.goto(new URL('/restaurant/insights', adminOrigin).href);
    await admin.getByLabel('Branch').selectOption(fixture.delivery.branchId);
    await admin.getByLabel('From date').fill(businessDate);
    await admin.getByLabel('To date').fill(businessDate);
    const financialReportsTable = admin.getByRole('region', {
      name: 'financial reports table',
    });
    const financialHeaders = financialReportsTable.getByRole('columnheader');
    await expect(financialHeaders.nth(7)).toHaveText('Delivery fees');
    await expect(financialHeaders.nth(8)).toHaveText('Delivery fee refunds');
    const financialRow = financialReportsTable.getByRole('row').filter({ hasText: businessDate });
    const financialCells = financialRow.getByRole('cell');
    await expect(financialCells.nth(7)).toHaveText('13.25');
    await expect(financialCells.nth(8)).toHaveText('0');
    await expect(admin.locator('body')).not.toContainText(snapshot.rows[0]!.phone);
    await expect(admin.locator('body')).not.toContainText(snapshot.rows[0]!.address);
    await admin.close();
  } finally {
    await Promise.allSettled(transientContexts.map((context) => context.close()));
    await tenantMutation(
      pool,
      `UPDATE restaurant_delivery_zones SET "fixedFee" = 3.50 WHERE id = $1`,
      [fixture.delivery.zoneId]
    ).catch(() => undefined);
    await pool.end();
  }
});
