import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  establishKdsFixture,
  establishPosFixture,
  e2eIdempotencyKey,
  assertTerminalSecretIsBrowserIsolated,
  installSeededTerminalCookie,
  restaurantE2eCredentials as fixture,
  type RestaurantTerminalFixture,
} from './restaurant-fixture';

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

async function unlockPos(page: Page) {
  await installSeededTerminalCookie(page.context(), fixture.pos);
  await page.goto('/pos');
  await expect(page.getByRole('heading', { name: 'Terminal locked' })).toBeVisible();
  await page.getByLabel('Operator', { exact: true }).selectOption(fixture.operator.staffProfileId);
  await page.getByLabel('Operator PIN', { exact: true }).fill(fixture.operator.pin);
  await page.getByRole('button', { name: 'Unlock terminal' }).click();
  await expect(page.getByRole('heading', { name: 'Order pad' })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(fixture.menuItem.name) })).toBeVisible();
  await assertTerminalSecretIsBrowserIsolated(page, fixture.pos.secret);
}

test.describe('restaurant POS and KDS core flow', () => {
  test('shift, order, KOT, KDS, split tender, drawer and close ledgers reconcile', async ({
    page,
    browser,
    baseURL,
    request,
  }) => {
    test.slow();
    const pos = await establishPosFixture(request);

    const switched = await request.post('/api/restaurant/terminal/switch', {
      headers: pos.headers,
      data: {
        staffProfileId: fixture.manager.staffProfileId,
        type: 'PIN',
        secret: fixture.manager.pin,
      },
    });
    expect(switched.status()).toBe(200);
    expect((await switched.json()).session.activeStaffProfileId).toBe(
      fixture.manager.staffProfileId
    );

    const switchedBack = await request.post('/api/restaurant/terminal/switch', {
      headers: pos.headers,
      data: {
        staffProfileId: fixture.operator.staffProfileId,
        type: 'PIN',
        secret: fixture.operator.pin,
      },
    });
    expect(switchedBack.status()).toBe(200);

    const approval = await request.post('/api/restaurant/terminal/co-authorize', {
      headers: pos.headers,
      data: {
        approvingStaffProfileId: fixture.manager.staffProfileId,
        type: 'PIN',
        secret: fixture.manager.pin,
        capability: 'orders:void-post-prep',
        reason: 'E2E manager co-authorization evidence',
        targetType: 'ORDER',
        targetId: 'pending-e2e-order',
      },
    });
    expect(approval.status()).toBe(201);
    expect((await approval.json()).coAuthorization).toMatchObject({
      actingStaffProfileId: fixture.operator.staffProfileId,
      approvingStaffProfileId: fixture.manager.staffProfileId,
    });

    await unlockPos(page);
    await expect(page.getByLabel(/table id/i)).toHaveCount(0);
    await expect(page.getByLabel(/modifier option id/i)).toHaveCount(0);
    await page.getByRole('checkbox').first().check();
    await page.getByLabel('Covers').fill('2');
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
      page.getByText(`Order ${opened.orderNumber} active.`, { exact: true })
    ).toBeVisible();

    await page.getByRole('button', { name: new RegExp(fixture.menuItem.name) }).click();
    await page.getByLabel('Quantity').fill('2');
    await page.getByLabel('Seat').fill('1');
    await page.getByLabel(new RegExp(fixture.modifier.name)).check();
    await page.getByRole('button', { name: 'Add to order' }).click();
    await expect(page.getByText(`2 × ${fixture.menuItem.name}`)).toBeVisible();
    await expect(page.getByText(fixture.modifier.name, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Send whole order' }).click();
    await expect(page.getByText('Order sent to kitchen.')).toBeVisible();

    const orderButton = page.getByRole('button', { name: /#\d+ · 2 items/ });
    const orderNumber = String(opened.orderNumber);

    const kdsContext = await browser.newContext({ baseURL });
    await installSeededTerminalCookie(kdsContext, fixture.kds);
    const kdsPage = await kdsContext.newPage();
    await kdsPage.goto('/kds');
    await kdsPage.getByLabel('Acting operator').selectOption(fixture.operator.staffProfileId);
    await kdsPage.getByLabel('Operator PIN', { exact: true }).fill(fixture.operator.pin);
    await kdsPage.getByRole('button', { name: 'Verify PIN and unlock' }).click();
    await expect(kdsPage.getByRole('heading', { name: 'Kitchen floor' })).toBeVisible();
    await assertTerminalSecretIsBrowserIsolated(kdsPage, fixture.kds.secret);
    await expect(kdsPage.getByText(`Order #${orderNumber}`)).toBeVisible();
    await kdsPage
      .getByRole('button', {
        name: new RegExp(`Start ${fixture.menuItem.name} for order ${orderNumber}`),
      })
      .click();
    await expect(kdsPage.getByText('Item started.')).toBeVisible();
    await kdsPage
      .getByRole('button', {
        name: new RegExp(`Mark ready ${fixture.menuItem.name} for order ${orderNumber}`),
      })
      .click();
    await expect(kdsPage.getByText('Item marked ready.')).toBeVisible();
    await kdsContext.close();

    await page.bringToFront();
    await orderButton.click();
    await expect(page.getByText('PREPARED')).toBeVisible();
    await page.getByRole('button', { name: 'Mark served' }).click();
    await page.getByRole('button', { name: 'Close order' }).click();
    await expect(page.getByRole('dialog', { name: 'Collect payment' })).toBeVisible();
    await page.getByRole('button', { name: 'Split bill' }).click();
    await page.getByLabel('Split method').selectOption('FRACTIONAL');
    await page.getByLabel('Fractional weights').fill('1,1');
    await page.getByRole('button', { name: 'Create split bills' }).click();
    await expect(page.getByText('FRACTIONAL')).toHaveCount(2);

    const amounts = page.getByLabel('Amount');
    for (let index = 0; index < 2; index += 1) {
      const amount = await amounts.nth(index).inputValue();
      await page.getByLabel('Cash received').nth(index).fill(amount);
      await page.getByRole('button', { name: 'Apply tender' }).nth(index).click();
    }
    await expect(page.getByText('Bill settled')).toHaveCount(2);

    const summaryResponse = await request.get(
      `/api/restaurant/checkout/summary?orderId=${encodeURIComponent(opened.orderId)}`,
      { headers: pos.headers }
    );
    expect(summaryResponse.status()).toBe(200);
    const summary = await summaryResponse.json();
    expect(summary).toMatchObject({
      settled: true,
      blocker: null,
      derivedOrderTotal: fixture.expected.twoItemTotal,
      accountedTotal: fixture.expected.twoItemTotal,
    });

    const businessDate = new Date().toISOString().slice(0, 10);
    const previewResponse = await request.get(
      `/api/restaurant/cash/day/preview?businessDate=${businessDate}`,
      { headers: pos.headers }
    );
    expect(previewResponse.status()).toBe(200);
    const preview = await previewResponse.json();
    expect(preview.totals).toMatchObject({
      grossSales: fixture.expected.twoItemTotal,
      netSales: fixture.expected.twoItemTotal,
    });
    expect(preview.tenderTotals).toEqual([
      expect.objectContaining({
        tenderType: 'CASH',
        amount: fixture.expected.twoItemTotal,
        count: 2,
      }),
    ]);

    await post(
      request,
      pos,
      '/api/restaurant/cash/drawer/movement',
      {
        drawerSessionId: 'drawer_restaurant_e2e',
        kind: 'PAID_IN',
        amount: '5.00',
        reason: 'E2E exact reconciliation',
      },
      e2eIdempotencyKey('drawer-paid-in', opened.orderNumber)
    );
    await post(
      request,
      pos,
      '/api/restaurant/cash/drawer/close',
      {
        drawerSessionId: 'drawer_restaurant_e2e',
        countedCash: String(Number(preview.totals.cashExpected) + 5)
          .concat('.00')
          .replace('.00.00', '.00'),
      },
      e2eIdempotencyKey('drawer-close', opened.orderNumber)
    );
    const closeResponse = await post(
      request,
      pos,
      '/api/restaurant/cash/day/close',
      { businessDate },
      e2eIdempotencyKey('daily-close', opened.orderNumber)
    );
    const close = await closeResponse.json();
    expect(close.totals.cashVariance).toBe('0.00');
    expect(close.totals.grossSales).toBe(fixture.expected.twoItemTotal);
    expect(close.replayed).toBe(false);

    const kds = await establishKdsFixture(request);
    expect(kds.deviceId).toBe(fixture.kds.deviceId);
  });
});
