import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  establishDeliveryPosFixture,
  establishKdsFixture,
  establishPosFixture,
  e2eIdempotencyKey,
  assertTerminalSecretIsBrowserIsolated,
  installSeededTerminalCookie,
  restaurantE2eCredentials as fixture,
  terminalBrowserBaseUrl,
  type RestaurantTerminalFixture,
} from './restaurant-fixture';
import { signInAs } from './fixtures/restaurant-actor-accessibility';

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
  await expect(page.getByRole('heading', { name: 'Terminal locked' })).toBeVisible();
  await page.getByLabel('Operator', { exact: true }).selectOption(fixture.operator.staffProfileId);
  await page.getByLabel('Operator PIN', { exact: true }).fill(fixture.operator.pin);
  const unlockedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/restaurant/terminal/unlock') &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Unlock terminal' }).click();
  expect((await unlockedResponse).status()).toBe(200);
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
    const actorOrigin = await signInAs(page, 'restaurantAdmin');
    await page.goto(new URL('/dashboard', actorOrigin).href);
    await expect(page).toHaveURL(new URL('/dashboard', actorOrigin).href);
    await expect(page.getByRole('heading', { name: 'Restaurant dashboard' })).toBeVisible();
    await expect(page.getByTestId('first-run-checklist')).toHaveCount(0);
    await installSeededTerminalCookie(page.context(), fixture.pos, actorOrigin);
    const establishedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/restaurant/terminal/establish') &&
        response.request().method() === 'POST'
    );
    await page
      .locator('[data-slot="app-canvas"]')
      .getByRole('link', { name: 'Point of sale' })
      .click();
    expect((await establishedResponse).status()).toBe(201);

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
    await expect(page.getByRole('option', { name: 'Delivery' })).toBeEnabled();
    await expect(page.getByLabel('Channel')).toHaveValue('DINE_IN');
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
      page.getByText(`Order ${opened.orderNumber} opened.`, { exact: true })
    ).toBeVisible();

    const deliveryPos = await establishDeliveryPosFixture(request);
    const crossBranchDetail = await request.get(
      `/api/restaurant/orders/detail?orderId=${encodeURIComponent(opened.orderId)}`,
      { headers: deliveryPos.headers }
    );
    expect(crossBranchDetail.status()).toBe(404);
    const crossBranchCancel = await request.post('/api/restaurant/orders/cancel', {
      headers: {
        ...deliveryPos.headers,
        'Idempotency-Key': e2eIdempotencyKey(
          'cross-branch-order-cancel',
          `${opened.orderNumber}-${opened.orderId}`
        ),
      },
      data: {
        orderId: opened.orderId,
        reason: 'Cross-branch cancellation must fail closed',
      },
    });
    expect(crossBranchCancel.status()).toBe(404);
    const branchADetail = await request.get(
      `/api/restaurant/orders/detail?orderId=${encodeURIComponent(opened.orderId)}`,
      { headers: pos.headers }
    );
    expect(branchADetail.status()).toBe(200);
    expect(await branchADetail.json()).toMatchObject({ id: opened.orderId });

    await page.getByRole('button', { name: new RegExp(fixture.menuItem.name) }).click();
    await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).fill('2');
    await page.getByLabel('Seat').fill('1');
    await page.getByLabel(new RegExp(fixture.modifier.name)).check();
    await page.getByRole('button', { name: 'Add to order' }).click();
    await expect(page.getByText(`2 × ${fixture.menuItem.name}`)).toBeVisible();
    await expect(
      page
        .getByRole('listitem')
        .filter({ hasText: `2 × ${fixture.menuItem.name}` })
        .getByText(fixture.modifier.name, { exact: true })
    ).toBeVisible();
    await page.getByRole('button', { name: 'Send whole order' }).click();
    await expect(page.getByText('Order sent to kitchen.')).toBeVisible();

    const orderButton = page.getByRole('button', { name: /#\d+ · 2 items/ });
    const orderNumber = String(opened.orderNumber);

    const terminalBaseUrl = terminalBrowserBaseUrl(baseURL);
    const kdsContext = await browser.newContext({ baseURL: terminalBaseUrl });
    await installSeededTerminalCookie(kdsContext, fixture.kds, terminalBaseUrl);
    const kdsPage = await kdsContext.newPage();
    const kdsEstablishedResponse = kdsPage.waitForResponse(
      (response) =>
        response.url().endsWith('/api/restaurant/terminal/establish') &&
        response.request().method() === 'POST'
    );
    await kdsPage.goto(new URL('/kds', terminalBaseUrl).href);
    expect((await kdsEstablishedResponse).status()).toBe(201);
    await kdsPage.getByLabel('Acting operator').selectOption(fixture.operator.staffProfileId);
    await kdsPage.getByLabel('Operator PIN', { exact: true }).fill(fixture.operator.pin);
    const unlockedResponse = kdsPage.waitForResponse(
      (response) =>
        response.url().endsWith('/api/restaurant/terminal/unlock') &&
        response.request().method() === 'POST'
    );
    await kdsPage.getByRole('button', { name: 'Verify PIN and unlock' }).click();
    expect((await unlockedResponse).status()).toBe(200);
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

    const splitAmount = (Number(fixture.expected.twoItemTotal) / 2).toFixed(2);
    const receipts = page
      .getByRole('dialog', { name: 'Collect payment' })
      .getByRole('region', { name: /^Receipt \d+$/ });
    for (let settled = 1; settled <= 2; settled += 1) {
      await page.getByLabel('Amount').first().fill(splitAmount);
      await page.getByLabel('Cash received').first().fill(splitAmount);
      await page.getByRole('button', { name: 'Apply tender' }).first().click();
      await expect(receipts).toHaveCount(settled);
    }
    await page.getByRole('button', { name: 'Close checkout' }).click();
    await expect(page.getByRole('dialog', { name: 'Collect payment' })).toHaveCount(0);

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

    const currentDayResponse = await request.get('/api/restaurant/cash/day/current', {
      headers: pos.headers,
    });
    expect(currentDayResponse.status()).toBe(200);
    const { businessDate } = (await currentDayResponse.json()) as { businessDate: string };
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

    await page.getByRole('button', { name: 'Switch operator' }).click();
    await page.getByLabel('Operator', { exact: true }).selectOption(fixture.manager.staffProfileId);
    await page.getByLabel('Operator PIN', { exact: true }).fill(fixture.manager.pin);
    const switchResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/restaurant/terminal/switch') &&
        response.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Confirm switch' }).click();
    expect((await switchResponse).status()).toBe(200);
    await expect(
      page.getByText('Operator switched. New actions use the incoming identity.')
    ).toBeVisible();

    const refundableTendersResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/restaurant/checkout/refund') &&
        response.request().method() === 'GET'
    );
    await page.getByRole('button', { name: 'Refund' }).click();
    const refundableTenders = (await (await refundableTendersResponse).json()) as {
      tenders: Array<{
        tenderId: string;
        orderNumber: number;
        paidAmount: string;
        refundedAmount: string;
        remainingAmount: string;
      }>;
    };
    const refundableTender = refundableTenders.tenders.find(
      (tender) => tender.orderNumber === opened.orderNumber
    );
    expect(refundableTender).toBeDefined();
    await expect(page.getByRole('dialog', { name: 'Refund settled payment' })).toBeVisible();
    await page.getByLabel('Settled receipt').selectOption(refundableTender!.tenderId);
    await page.getByLabel('Refund amount').fill('1.00');
    await page
      .getByRole('dialog', { name: 'Refund settled payment' })
      .getByLabel('Reason', { exact: true })
      .fill('Guest item quality adjustment');
    await page
      .getByLabel('Approving manager')
      .selectOption({ label: 'Alex Carter — Restaurant E2E Manager' });
    await page.getByLabel('Manager PIN').fill(fixture.manager.pin);
    await page.getByRole('button', { name: 'Review refund' }).click();
    await expect(page.getByText('Confirm destructive refund')).toBeVisible();
    const refundResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/restaurant/checkout/refund') &&
        response.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Confirm refund' }).click();
    const recordedRefundResponse = await refundResponse;
    expect(recordedRefundResponse.status()).toBe(200);
    expect((await recordedRefundResponse.json()).amount).toBe('1.00');
    await expect(page.getByText('refund recorded', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Refund settled payment' })).toHaveCount(0);

    const managerSwitch = await request.post('/api/restaurant/terminal/switch', {
      headers: pos.headers,
      data: {
        staffProfileId: fixture.manager.staffProfileId,
        type: 'PIN',
        secret: fixture.manager.pin,
      },
    });
    expect(managerSwitch.status()).toBe(200);

    const readOpenedOrderTenders = async () => {
      const response = await request.get('/api/restaurant/checkout/refund', {
        headers: pos.headers,
      });
      expect(response.status()).toBe(200);
      const body = (await response.json()) as typeof refundableTenders;
      return body.tenders.filter((tender) => tender.orderNumber === opened.orderNumber);
    };
    const openedOrderTenders = await readOpenedOrderTenders();
    expect(openedOrderTenders).toHaveLength(2);
    expect(
      openedOrderTenders.find((tender) => tender.tenderId === refundableTender!.tenderId)
    ).toMatchObject({
      paidAmount: Number(splitAmount).toFixed(2),
      refundedAmount: '1.00',
      remainingAmount: (Number(splitAmount) - 1).toFixed(2),
    });
    expect(
      openedOrderTenders.find((tender) => tender.tenderId !== refundableTender!.tenderId)
    ).toMatchObject({
      paidAmount: Number(splitAmount).toFixed(2),
      refundedAmount: '0.00',
      remainingAmount: Number(splitAmount).toFixed(2),
    });

    const overRefund = await request.post('/api/restaurant/checkout/refund', {
      headers: {
        ...pos.headers,
        'Idempotency-Key': e2eIdempotencyKey('over-refund', opened.orderNumber),
      },
      data: {
        originalTenderId: refundableTender!.tenderId,
        amount: splitAmount,
        reason: 'Over-refund boundary must fail closed',
        approving: {
          staffProfileId: fixture.manager.staffProfileId,
          type: 'PIN',
          secret: fixture.manager.pin,
        },
      },
    });
    expect(overRefund.status()).toBe(409);
    expect(await overRefund.json()).toMatchObject({
      error: expect.stringMatching(/exceeds the tender balance/i),
    });
    expect(await readOpenedOrderTenders()).toEqual(openedOrderTenders);

    const postRefundPreviewResponse = await request.get(
      `/api/restaurant/cash/day/preview?businessDate=${businessDate}`,
      { headers: pos.headers }
    );
    expect(postRefundPreviewResponse.status()).toBe(200);
    const postRefundPreview = await postRefundPreviewResponse.json();
    const postRefundCashExpected = (Number(preview.totals.cashExpected) - 1).toFixed(2);
    expect(postRefundPreview.totals.refundTotal).toBe('1.00');
    expect(postRefundPreview.totals.cashExpected).toBe(postRefundCashExpected);

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
    // Only this drawer remains open; already-counted drawers belong to the branch total.
    expect(postRefundPreview.readiness.openDrawerCount).toBe(1);
    const drawerClose = await post(
      request,
      pos,
      '/api/restaurant/cash/drawer/close',
      {
        drawerSessionId: 'drawer_restaurant_e2e',
        countedCash: (
          Number(postRefundPreview.totals.cashExpected) -
          Number(postRefundPreview.totals.cashCounted) +
          5
        ).toFixed(2),
      },
      e2eIdempotencyKey('drawer-close', opened.orderNumber)
    );
    expect((await drawerClose.json()).variance).toBe('0.00');
    const closeResponse = await post(
      request,
      pos,
      '/api/restaurant/cash/day/close',
      { businessDate },
      e2eIdempotencyKey('daily-close', opened.orderNumber)
    );
    const close = await closeResponse.json();
    expect(close.totals.refundTotal).toBe('1.00');
    expect(close.totals.cashVariance).toBe('0.00');
    expect(close.totals.grossSales).toBe(fixture.expected.twoItemTotal);
    expect(close.tenderTotals).toEqual([
      expect.objectContaining({
        tenderType: 'CASH',
        amount: fixture.expected.twoItemTotal,
        count: 2,
      }),
    ]);
    expect(close.replayed).toBe(false);

    const kds = await establishKdsFixture(request);
    expect(kds.deviceId).toBe(fixture.kds.deviceId);
  });
});
