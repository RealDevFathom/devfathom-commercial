import { expect, test, type APIRequestContext } from '@playwright/test';
import pg from 'pg';

import {
  establishKdsFixture,
  establishPosFixture,
  e2eIdempotencyKey,
  restaurantE2eCredentials as fixture,
  type RestaurantTerminalFixture,
} from './restaurant-fixture';

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

test('direct delivery authorization, COD/PREPAID handoff and fee reporting remain integrated', async ({
  request,
  page,
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
  const before = await pool.query<{ orders: string; keys: string; events: string }>(
    `SELECT
       (SELECT count(*)::text FROM restaurant_orders WHERE "deviceId" = $1 AND channel = 'DELIVERY') orders,
       (SELECT count(*)::text FROM restaurant_order_idempotency_keys WHERE "deviceId" = $1 AND key = $2) keys,
       (SELECT count(*)::text FROM restaurant_order_events WHERE metadata->>'idempotencyKey' = $2) events`,
    [fixture.pos.deviceId, key]
  );
  expect(before.rows[0]).toMatchObject({ keys: '0', events: '0' });

  const pos = await establishPosFixture(request);
  const opened = await post(
    request,
    pos,
    '/api/restaurant/orders/open',
    { channel: 'DELIVERY', customerId: fixture.customer.id },
    key
  );
  expect(opened.status()).toBe(201);
  const openedBody = (await opened.json()) as { orderId: string; orderNumber: number };
  const added = await post(
    request,
    pos,
    '/api/restaurant/orders/add-item',
    { orderId: openedBody.orderId, menuItemId: 'menu_item_restaurant_e2e_burger', quantity: 1 },
    e2eIdempotencyKey('delivery-line', openedBody.orderNumber)
  );
  const { itemId } = (await added.json()) as { itemId: string };
  const attached = await post(
    request,
    pos,
    '/api/restaurant/orders/delivery/attach',
    {
      orderId: openedBody.orderId,
      customerId: fixture.customer.id,
      addressId: fixture.delivery.addressId,
      zoneId: fixture.delivery.zoneId,
    },
    e2eIdempotencyKey('delivery-attach', openedBody.orderNumber)
  );
  const fulfillment = (await attached.json()) as { fulfillmentId: string; deliveryFee: string };
  expect(fulfillment.deliveryFee).toBe(fixture.delivery.fee);
  await post(
    request,
    pos,
    '/api/restaurant/orders/fire',
    { orderId: openedBody.orderId },
    e2eIdempotencyKey('delivery-fire', openedBody.orderNumber)
  );

  const kds = await establishKdsFixture(request);
  await post(
    request,
    kds,
    '/api/restaurant/kds/ack',
    { orderItemId: itemId, operatorStaffProfileId: fixture.operator.staffProfileId },
    e2eIdempotencyKey('delivery-ack', openedBody.orderNumber)
  );
  await post(
    request,
    kds,
    '/api/restaurant/kds/bump',
    { orderItemId: itemId, operatorStaffProfileId: fixture.operator.staffProfileId },
    e2eIdempotencyKey('delivery-ready', openedBody.orderNumber)
  );
  const bill = await post(
    request,
    pos,
    '/api/restaurant/checkout/bill',
    { orderId: openedBody.orderId, split: { kind: 'NONE' } },
    e2eIdempotencyKey('delivery-bill', openedBody.orderNumber)
  );
  const billId = ((await bill.json()) as { billIds: string[] }).billIds[0]!;
  const summaryResponse = await request.get(
    `/api/restaurant/checkout/summary?orderId=${openedBody.orderId}`,
    { headers: pos.headers }
  );
  const summary = await summaryResponse.json();
  expect(summary.deliveryFeeTotal).toBe(fixture.delivery.fee);
  expect(Number(summary.accountedTotal)).toBe(
    Number(summary.derivedOrderTotal) + Number(fixture.delivery.fee)
  );

  await post(
    request,
    kds,
    '/api/restaurant/kds/delivery/transition',
    {
      fulfillmentId: fulfillment.fulfillmentId,
      status: 'DISPATCHED',
      operatorStaffProfileId: fixture.operator.staffProfileId,
    },
    e2eIdempotencyKey('delivery-dispatch', openedBody.orderNumber)
  );
  await post(
    request,
    kds,
    '/api/restaurant/kds/delivery/transition',
    {
      fulfillmentId: fulfillment.fulfillmentId,
      status: 'DELIVERED',
      operatorStaffProfileId: fixture.operator.staffProfileId,
    },
    e2eIdempotencyKey('delivery-delivered', openedBody.orderNumber)
  );
  const tender = await post(
    request,
    pos,
    '/api/restaurant/checkout/tender',
    {
      billId,
      tender: {
        type: 'CASH',
        amount: summary.accountedTotal,
        cashReceived: summary.accountedTotal,
      },
    },
    e2eIdempotencyKey('delivery-cod', openedBody.orderNumber)
  );
  expect((await tender.json()).settled).toBe(true);
  const receiptResponse = await request.get(`/api/restaurant/checkout/receipt?billId=${billId}`, {
    headers: pos.headers,
  });
  const receipt = await receiptResponse.json();
  expect(receipt.totals.deliveryFeeTotal).toBe(fixture.delivery.fee);
  expect(JSON.stringify(receipt)).not.toContain('+923001234567');
  expect(JSON.stringify(receipt)).not.toContain('12 Delivery Street');

  const snapshot = await pool.query<{ fee: string; phone: string; address: string; mode: string }>(
    `SELECT "deliveryFeeSnapshot"::text fee, "normalizedPhoneSnapshot" phone,
            "addressLine1Snapshot" address, "paymentMode"::text mode
       FROM restaurant_delivery_fulfillments WHERE id = $1`,
    [fulfillment.fulfillmentId]
  );
  expect(snapshot.rows[0]).toMatchObject({ fee: '3.50', mode: 'COD' });

  await page.goto('/pos');
  await expect(page.locator('body')).not.toContainText(snapshot.rows[0]!.phone);
  await expect(page.locator('body')).not.toContainText(snapshot.rows[0]!.address);
  await pool.end();
});
