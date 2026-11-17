import { expect, test, type Page, type Request } from '@playwright/test';

import {
  assertTerminalSecretIsBrowserIsolated,
  establishTerminalFixture,
  installSeededTerminalCookie,
  restaurantE2eCredentials as fixture,
  terminalBrowserBaseUrl,
} from './restaurant-fixture';
import { signInAs } from './fixtures/restaurant-actor-accessibility';

test.describe.configure({ mode: 'serial' });

if (process.env.RESTAURANT_INTEGRATED_E2E !== '1') {
  throw new Error('RESTAURANT_INTEGRATED_E2E=1 is required.');
}

function isAbortedSuccessfulRscFetch({
  errorText,
  resourceType,
  responseStatus,
  url,
}: {
  errorText: string | undefined;
  resourceType: string;
  responseStatus: number | undefined;
  url: string;
}) {
  return (
    responseStatus === 200 &&
    resourceType === 'fetch' &&
    new URL(url).searchParams.has('_rsc') &&
    errorText === 'net::ERR_ABORTED'
  );
}

function observeRuntimeFailures(page: Page) {
  const failures: string[] = [];
  const responseStatuses = new WeakMap<Request, number>();
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon/i.test(message.text()))
      failures.push(message.text());
  });
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('response', (response) => {
    responseStatuses.set(response.request(), response.status());
  });
  page.on('requestfailed', (request) => {
    if (
      !isAbortedSuccessfulRscFetch({
        errorText: request.failure()?.errorText,
        resourceType: request.resourceType(),
        responseStatus: responseStatuses.get(request),
        url: request.url(),
      })
    )
      failures.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  return failures;
}

test('runtime observer ignores only aborted successful RSC fetches', () => {
  const expected = {
    errorText: 'net::ERR_ABORTED',
    resourceType: 'fetch',
    responseStatus: 200,
    url: 'http://localhost/dashboard?_rsc=abc',
  };

  expect(isAbortedSuccessfulRscFetch(expected)).toBe(true);
  expect(isAbortedSuccessfulRscFetch({ ...expected, errorText: 'net::ERR_FAILED' })).toBe(false);
  expect(isAbortedSuccessfulRscFetch({ ...expected, resourceType: 'document' })).toBe(false);
  expect(isAbortedSuccessfulRscFetch({ ...expected, responseStatus: 204 })).toBe(false);
  expect(isAbortedSuccessfulRscFetch({ ...expected, url: 'http://localhost/dashboard' })).toBe(
    false
  );
});

test('WHA-1600: POS earns, redeems on the next sale, and reverses earned points on refund', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(180_000);
  const network: Array<{ method: string; path: string; status: number }> = [];
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api/restaurant/')) {
      network.push({ method: response.request().method(), path, status: response.status() });
    }
  });
  const origin = terminalBrowserBaseUrl();
  const manager = await establishTerminalFixture(request, fixture.pos, fixture.manager);
  const device = { ...fixture.caseRegisters[11], clientIp: '198.51.100.160' };
  await installSeededTerminalCookie(page.context(), device, origin);
  await page.goto(new URL('/pos', origin).href);
  await page.getByLabel('Operator', { exact: true }).selectOption(fixture.manager.staffProfileId);
  await page.getByLabel('Operator PIN', { exact: true }).fill(fixture.manager.pin);
  await page.getByRole('button', { name: 'Unlock terminal', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Order pad', exact: true })).toBeVisible();

  const kitchen = await browser.newContext({ baseURL: origin });
  try {
    await installSeededTerminalCookie(kitchen, fixture.kds, origin);
    const kds = await kitchen.newPage();
    await kds.goto('/kds');
    await kds.getByLabel('Acting operator').selectOption(fixture.operator.staffProfileId);
    await kds.getByLabel('Operator PIN', { exact: true }).fill(fixture.operator.pin);
    await kds.getByRole('button', { name: 'Verify PIN and unlock' }).click();
    await expect(kds.getByRole('heading', { name: 'Kitchen floor' })).toBeVisible();

    const responseFor = (path: string, method = 'POST') =>
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/restaurant/${path}` &&
          response.request().method() === method
      );
    const snapshot = async (billId: string) => {
      const response = await request.get(`/api/restaurant/checkout/loyalty?billId=${billId}`, {
        headers: manager.headers,
      });
      expect(response.status(), await response.text()).toBe(200);
      return (await response.json()) as { balance: number; redeemedValue: string };
    };
    let openingBalance = 0;
    let secondBillId = '';
    let secondTenderId = '';
    for (const sale of [0, 1]) {
      await page.getByLabel('Channel', { exact: true }).selectOption('TAKEAWAY');
      const opening = responseFor('orders/open');
      await page.getByRole('button', { name: 'Open order', exact: true }).click();
      const openedResponse = await opening;
      expect(openedResponse.status(), await openedResponse.text()).toBe(201);
      const opened = (await openedResponse.json()) as { orderId: string; orderNumber: number };
      // The checkout guest picker appears only after PAYMENT_PENDING, but the
      // transport accepts attachment only while OPEN. Keep that product seam
      // explicit; attach through its authorized endpoint before sending food.
      const guest = await request.post('/api/restaurant/orders/customer/attach', {
        headers: { ...manager.headers, 'Idempotency-Key': `wha1600-guest-${opened.orderId}` },
        data: { orderId: opened.orderId, customerId: fixture.customer.id },
      });
      expect(guest.status(), await guest.text()).toBe(200);
      await page.getByRole('button', { name: new RegExp(fixture.menuItem.name) }).click();
      await page.getByLabel(new RegExp(fixture.modifier.name)).check();
      await page.getByRole('button', { name: 'Add to order', exact: true }).click();
      await expect(page.getByText(`1 × ${fixture.menuItem.name}`)).toBeVisible();
      await page.getByRole('button', { name: 'Send whole order' }).click();
      await expect(page.getByText('Order sent to kitchen.')).toBeVisible();
      await kds
        .getByRole('button', {
          name: `Start ${fixture.menuItem.name} for order ${opened.orderNumber}`,
        })
        .click();
      const kitchenReady = kds.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/restaurant/kds/bump' &&
          response.request().method() === 'POST'
      );
      await kds
        .getByRole('button', {
          name: `Mark ready ${fixture.menuItem.name} for order ${opened.orderNumber}`,
        })
        .click();
      const readyResponse = await kitchenReady;
      expect(readyResponse.status(), await readyResponse.text()).toBe(200);
      await page.getByRole('button', { name: new RegExp(`#${opened.orderNumber} ·`) }).click();
      await page.getByRole('button', { name: 'Mark served', exact: true }).click();
      await page.getByRole('button', { name: 'Close order', exact: true }).click();
      const checkout = page.getByRole('dialog', { name: 'Collect payment' });
      await expect(checkout).toBeVisible();
      const loyalty = responseFor('checkout/loyalty', 'GET');
      await checkout.getByRole('button', { name: 'Cut single bill', exact: true }).click();
      const loyaltyResponse = await loyalty;
      expect(loyaltyResponse.status(), await loyaltyResponse.text()).toBe(200);
      const attached = (await loyaltyResponse.json()) as {
        billId: string;
        customerId: string;
        balance: number;
        outstanding: string;
      };
      expect(attached.customerId).toBe(fixture.customer.id);
      expect(Number(attached.outstanding)).toBe(14);
      if (sale === 0) openingBalance = attached.balance;
      else {
        expect(attached.balance).toBe(openingBalance + 14);
        await checkout.getByLabel(/Points to redeem/).fill('10');
        const redemption = responseFor('checkout/loyalty');
        await checkout.getByRole('button', { name: 'Redeem', exact: true }).click();
        const redeemedResponse = await redemption;
        expect(redeemedResponse.status(), await redeemedResponse.text()).toBe(200);
        expect(await redeemedResponse.json()).toMatchObject({
          value: '0.1',
          balance: openingBalance + 4,
        });
        await expect(checkout.getByLabel('Amount', { exact: true })).toHaveValue('13.90');
      }
      await checkout.getByLabel('Tender type').selectOption('CARD');
      // Synthetic slip facts exercise the current manual-confirmation guard.
      await checkout.getByLabel('Approval code').fill('E2E739');
      await checkout.getByLabel('Last 4 digits or reference').fill('4242');
      const payment = responseFor('checkout/tender');
      await checkout.getByRole('button', { name: 'Apply tender', exact: true }).click();
      const paidResponse = await payment;
      expect(paidResponse.status(), await paidResponse.text()).toBe(200);
      const paid = (await paidResponse.json()) as {
        tenderId: string;
        amount: string;
        settled: boolean;
      };
      expect(paid).toMatchObject({ settled: true, amount: sale === 0 ? '14.00' : '13.90' });
      await expect(checkout.getByRole('region', { name: /^Receipt \d+$/ })).toHaveCount(1);
      await checkout.getByRole('button', { name: 'Close checkout', exact: true }).click();

      const settledBalance = (await snapshot(attached.billId)).balance;
      expect(settledBalance).toBe(openingBalance + (sale === 0 ? 14 : 17));
      // Checkout already finalizes a fully served, paid order. Read its durable
      // state instead of issuing a second close against a terminal order.
      const closed = await request.get(
        `/api/restaurant/orders/detail?orderId=${encodeURIComponent(opened.orderId)}`,
        { headers: manager.headers }
      );
      expect(closed.status(), await closed.text()).toBe(200);
      expect(await closed.json()).toMatchObject({ id: opened.orderId, status: 'CLOSED' });
      // An authorized close against the terminal order is refused, so it cannot
      // earn the settled points a second time.
      const reclosed = await request.post('/api/restaurant/orders/close', {
        headers: { ...manager.headers, 'Idempotency-Key': `wha1600-reclose-${opened.orderId}` },
        data: { orderId: opened.orderId },
      });
      expect(reclosed.status(), await reclosed.text()).toBe(409);
      expect((await snapshot(attached.billId)).balance).toBe(
        openingBalance + (sale === 0 ? 14 : 17)
      );
      if (sale === 1) {
        secondBillId = attached.billId;
        secondTenderId = paid.tenderId;
      }
    }
    await page.getByRole('button', { name: 'Refund', exact: true }).click();
    const refundDialog = page.getByRole('dialog', { name: 'Refund settled payment' });
    await refundDialog.getByLabel('Settled receipt').selectOption(secondTenderId);
    await refundDialog.getByLabel('Refund amount').fill('13.90');
    await refundDialog
      .getByLabel('Reason', { exact: true })
      .fill('Loyalty earned-points reversal regression');
    const approvers = refundDialog.getByLabel('Approving manager');
    await expect(
      approvers.locator(`option[value="${fixture.manager.staffProfileId}"]`)
    ).toHaveCount(0);
    // The seed gives Alex the manager role and manager PIN. Refunds require a
    // distinct approver; the acting E2E Manager must not approve their own refund.
    await approvers.selectOption('staff_chai_chowk_alex');
    await refundDialog.getByLabel('Manager PIN').fill(fixture.manager.pin);
    await refundDialog.getByRole('button', { name: 'Review refund', exact: true }).click();
    const refund = responseFor('checkout/refund');
    await page.getByRole('button', { name: 'Confirm refund', exact: true }).click();
    const refundedResponse = await refund;
    expect(refundedResponse.status(), await refundedResponse.text()).toBe(200);
    expect(await refundedResponse.json()).toMatchObject({ amount: '13.90' });
    await expect(page.getByText('refund recorded', { exact: true })).toBeVisible();
    // The second sale earned floor(13.90)=13 points; the full refund reverses
    // those 13. The first sale's 14 and the 10-point redemption remain booked.
    const final = await snapshot(secondBillId);
    expect(final.balance).toBe(openingBalance + 4);
    expect(Number(final.redeemedValue)).toBe(0.1);
    await test.info().attach('loyalty-refund-proof', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await test.info().attach('loyalty-balances', {
      body: JSON.stringify({
        openingBalance,
        firstEarn: 14,
        redeemed: 10,
        secondEarn: 13,
        reversed: 13,
        finalBalance: final.balance,
      }),
      contentType: 'application/json',
    });
  } finally {
    await test.info().attach('loyalty-network', {
      body: JSON.stringify(network),
      contentType: 'application/json',
    });
    await kitchen.close();
  }
});

test('integrated restaurant route matrix remains tenant-safe and browser-clean', async ({
  page,
}) => {
  test.slow();
  const failures = observeRuntimeFailures(page);
  const routes: Array<[string, string]> = [
    ['/dashboard', 'Restaurant dashboard'],
    ['/restaurant/staff', 'Staff'],
    ['/restaurant/devices', 'Devices'],
    ['/restaurant/reports', 'Reports'],
    ['/restaurant/inventory', 'Inventory'],
    ['/restaurant/purchasing', 'Purchasing'],
    ['/restaurant/sop', 'Branch SOP board'],
    ['/restaurant/loyalty', 'Customers & Loyalty'],
    ['/restaurant/insights', 'Insights'],
  ];
  const origin = await signInAs(page, 'restaurantAdmin');

  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const response = await page.goto(new URL(routes[0][0], origin).href);
    expect(response?.ok(), `dashboard at ${width}px`).toBe(true);
    await expect(page).toHaveURL(new RegExp(`${routes[0][0]}(?:\\?|$)`));
    await expect(page.getByRole('heading', { name: routes[0][1], exact: true })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toBeVisible();
  }

  for (const [route, heading] of routes.slice(1)) {
    const response = await page.goto(new URL(route, origin).href);
    expect(response?.ok(), route).toBe(true);
    await expect(page).toHaveURL(new RegExp(`${route}(?:\\?|$)`));
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }

  const forbidden = await page.goto(
    new URL(
      `/dashboard?organizationId=org_restaurant_b_forbidden&branchId=${fixture.branchA2Id}`,
      origin
    ).href
  );
  expect(forbidden?.ok()).toBe(true);
  await expect(
    page.getByRole('heading', { name: 'Restaurant dashboard', exact: true })
  ).toBeVisible();
  await expect(page).not.toHaveURL(/org_restaurant_b_forbidden/);
  expect(failures, failures.join('\n')).toEqual([]);
});

test('fixture publishes named order inputs and explicit pending UI seams', async ({ page }) => {
  const terminalBaseUrl = terminalBrowserBaseUrl();
  await installSeededTerminalCookie(page.context(), fixture.pos, terminalBaseUrl);
  const establishedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/restaurant/terminal/establish') &&
      response.request().method() === 'POST'
  );
  await page.goto(new URL('/pos', terminalBaseUrl).href);
  expect((await establishedResponse).status()).toBe(201);
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
  await expect(page.getByText(fixture.menuItem.name)).toBeVisible();
  await assertTerminalSecretIsBrowserIsolated(page, fixture.pos.secret);

  test
    .info()
    .annotations.push(
      { type: 'pending-service-charge-ui', description: fixture.seams.servicePolicy },
      { type: 'refund-request-api-seam', description: fixture.seams.refundEvidence }
    );
});
