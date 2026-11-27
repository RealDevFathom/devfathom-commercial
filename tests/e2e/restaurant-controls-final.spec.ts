import { chooseSelectField, selectFieldNative } from './fixtures/select-field';
import { expect, test, type Page } from '@playwright/test';
import { RESTAURANT_E2E_BRANCH_COUNT } from '../../scripts/restaurant-e2e-database';

import {
  assertTerminalSecretIsBrowserIsolated,
  e2eIdempotencyKey,
  establishDeliveryPosFixture,
  establishPosFixture,
  installSeededTerminalCookie,
  restaurantE2eCredentials as fixture,
  terminalBrowserBaseUrl,
} from './restaurant-fixture';
import { assertNoRawDatabaseIds, signInAs } from './fixtures/restaurant-actor-accessibility';

test.describe.configure({ mode: 'serial' });

if (process.env.RESTAURANT_INTEGRATED_E2E !== '1') {
  throw new Error('RESTAURANT_INTEGRATED_E2E=1 is required.');
}

test('Finance is readable by the owner and denied to an authenticated assigned-branch operator', async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const ownerOrigin = await signInAs(owner, 'restaurantAdmin');
  await owner.goto(new URL('/restaurant/money', ownerOrigin).href);
  await expect(owner.getByRole('heading', { name: 'Restaurant Finance' })).toBeVisible();
  const ownerBranchFilter = owner
    .locator('[data-slot="section-card"]', {
      has: owner.getByRole('heading', { name: 'Filters' }),
    })
    .getByRole('combobox', { name: 'Branch', exact: true })
    .filter({ visible: true });
  await expect(await selectFieldNative(ownerBranchFilter)).toContainText(/Gulberg Café|DHA Café/);
  await assertNoRawDatabaseIds(owner);

  const operatorContext = await browser.newContext();
  const operator = await operatorContext.newPage();
  const operatorOrigin = await signInAs(operator, 'restaurantOperator');
  await operator.goto(new URL('/restaurant/money', operatorOrigin).href);
  await expect(operator.getByRole('heading', { name: 'Restaurant Finance' })).toBeVisible();
  await expect(
    operator.getByText('Restaurant Finance access denied', { exact: true }).first()
  ).toBeVisible();
  await expect(operator.locator('body')).not.toContainText(/gross sales|cash variance/i);
  await expect(operator.locator('body')).not.toContainText(fixture.branchA2Id);
  await expect(operator.locator('body')).not.toContainText('org_restaurant_b_forbidden');
  await assertNoRawDatabaseIds(operator);
  await operatorContext.close();
  await ownerContext.close();
});

test('a newly opened drawer survives reload and lock recovery while a foreign device fails closed', async ({
  page,
  request,
}) => {
  let openedDrawer: { drawerSessionId: string; replayed: boolean } | undefined;
  let primaryFailure: unknown;
  try {
    const terminalOrigin = terminalBrowserBaseUrl();
    await installSeededTerminalCookie(page.context(), fixture.delivery.pos, terminalOrigin);
    await page.goto(new URL('/pos', terminalOrigin).href);
    await page
      .getByLabel('Operator', { exact: true })
      .selectOption(fixture.deliveryOperator.staffProfileId);
    await page.getByLabel('Operator PIN', { exact: true }).fill(fixture.deliveryOperator.pin);
    await page.getByRole('button', { name: 'Unlock terminal' }).click();
    await expect(page.getByRole('heading', { name: 'Order pad' })).toBeVisible();
    await page.getByRole('button', { name: 'Cash drawer' }).click();
    await expect(page.getByRole('heading', { name: 'No open drawer' })).toBeVisible();
    await page.getByLabel('Opening float').fill('125.00');
    const openedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/restaurant/cash/drawer/open') &&
        response.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Open drawer' }).click();
    const opened = await openedResponse;
    expect(opened.status()).toBe(200);
    openedDrawer = (await opened.json()) as { drawerSessionId: string; replayed: boolean };
    expect(openedDrawer.replayed).toBe(false);
    await expect(page.getByText('Active drawer')).toBeVisible();
    await page.getByRole('button', { name: 'Close drawer panel' }).click();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Terminal locked' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unlock terminal' })).toBeVisible();
    await page
      .getByLabel('Operator', { exact: true })
      .selectOption(fixture.deliveryOperator.staffProfileId);
    await page.getByLabel('Operator PIN', { exact: true }).fill(fixture.deliveryOperator.pin);
    await page.getByRole('button', { name: 'Unlock terminal' }).click();
    await expect(page.getByRole('heading', { name: 'Order pad' })).toBeVisible();
    await page.getByRole('button', { name: 'Cash drawer' }).click();
    await expect(page.getByText('Active drawer')).toBeVisible();
    await expect(
      page.getByRole('dialog').getByText(openedDrawer.drawerSessionId, { exact: true })
    ).toBeVisible();
    await assertTerminalSecretIsBrowserIsolated(page, fixture.delivery.pos.secret);

    const foreign = await establishPosFixture(request);
    const foreignRead = await request.get('/api/restaurant/cash/drawer/current', {
      headers: foreign.headers,
    });
    expect(foreignRead.status()).toBe(200);
    expect(await foreignRead.json()).toMatchObject({ drawerSessionId: 'drawer_restaurant_e2e' });
    const foreignClose = await request.post('/api/restaurant/cash/drawer/close', {
      headers: {
        ...foreign.headers,
        'idempotency-key': e2eIdempotencyKey('foreign-drawer-close', openedDrawer.drawerSessionId),
      },
      data: { drawerSessionId: openedDrawer.drawerSessionId, countedCash: '125.00' },
    });
    expect(foreignClose.status()).toBe(404);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    if (openedDrawer) {
      try {
        const delivery = await establishDeliveryPosFixture(request);
        const currentResponse = await request.get('/api/restaurant/cash/drawer/current', {
          headers: delivery.headers,
        });
        expect(currentResponse.status()).toBe(200);
        const current = (await currentResponse.json()) as {
          drawerSessionId: string;
          openingFloat: string;
        };
        expect(current.drawerSessionId).toBe(openedDrawer.drawerSessionId);
        const closeResponse = await request.post('/api/restaurant/cash/drawer/close', {
          headers: {
            ...delivery.headers,
            'idempotency-key': e2eIdempotencyKey(
              'controls-drawer-cleanup',
              openedDrawer.drawerSessionId
            ),
          },
          data: {
            drawerSessionId: openedDrawer.drawerSessionId,
            countedCash: current.openingFloat,
          },
        });
        expect(closeResponse.status()).toBe(200);
        const afterResponse = await request.get('/api/restaurant/cash/drawer/current', {
          headers: delivery.headers,
        });
        expect(afterResponse.status()).toBe(200);
        expect(await afterResponse.json()).toBeNull();
      } catch (cleanupError) {
        if (!primaryFailure) throw cleanupError;
      }
    }
  }
});

test('branch controls use readable codes and enforce duplicate, limit, and deactivation guards', async ({
  page,
}) => {
  const origin = await signInAs(page, 'restaurantAdmin');
  await page.goto(new URL('/restaurant/settings/branches', origin).href);
  await expect(page.getByRole('heading', { name: 'Branches' })).toBeVisible();
  const locations = page.locator('[data-slot="section-card"]', {
    has: page.getByRole('heading', { name: 'Locations' }),
  });
  await expect(page.getByText('DHA Café')).toBeVisible();
  await expect(locations.getByRole('listitem').filter({ hasText: 'DHA Café' })).toContainText(
    /BR-\d+/
  );
  await expect(
    page.getByText(`${RESTAURANT_E2E_BRANCH_COUNT} of ${RESTAURANT_E2E_BRANCH_COUNT} active`)
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create branch' })).toBeDisabled();
  await expect(page.getByText(/branch limit has been reached/i)).toBeVisible();
  await expect(page.getByTitle('Choose another primary branch first.')).toBeDisabled();
  await assertNoRawDatabaseIds(page);

  const dhaRow = locations.getByRole('listitem').filter({ hasText: 'DHA Café' });
  await dhaRow.getByRole('button', { name: 'Deactivate' }).click();
  await expect(
    page.getByText(/active terminals, assigned staff, open orders or drawers/i)
  ).toBeVisible();
  await expect(
    page.getByText(`${RESTAURANT_E2E_BRANCH_COUNT} of ${RESTAURANT_E2E_BRANCH_COUNT} active`)
  ).toBeVisible();

  await dhaRow.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByLabel('Branch code')).toBeDisabled();
  await page.getByLabel('Name').fill('Gulberg Café');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/branch with this name or code already exists/i)).toBeVisible();
  await expect(locations.getByRole('listitem')).toHaveCount(RESTAURANT_E2E_BRANCH_COUNT);
  await assertNoRawDatabaseIds(page);
});

test('Pakistan profiles and the CASH preview render exact rounding', async ({ page }) => {
  const origin = await signInAs(page, 'restaurantAdmin');
  await page.goto(new URL('/restaurant/tax', origin).href);
  await expect(page.getByRole('heading', { name: 'Tax configuration', exact: true })).toBeVisible();
  await expect(page.getByLabel('Jurisdiction and profile')).toContainText(/Pakistan|Punjab|Sindh/i);
  await page.getByLabel('Cash tax rate (%)').fill('8.25');
  await page.getByLabel('Sample amount').fill('1000.01');
  await expect(page.getByText(/Net 1000\.01 · Tax 82\.50 · Total 1082\.51/)).toBeVisible();
});

test('dashboard date and visibility preferences persist and reports render the selected export link', async ({
  page,
  browser,
}) => {
  const origin = await signInAs(page, 'restaurantAdmin');
  let primaryFailure: unknown;
  try {
    await page.goto(new URL('/dashboard', origin).href);
    await expect(page.getByRole('heading', { name: 'Restaurant dashboard' })).toBeVisible();
    const managementOverview = page.locator('[data-slot="section-card"]', {
      has: page.getByRole('heading', { name: 'Management overview', exact: true, level: 2 }),
    });
    await managementOverview.getByRole('button', { name: 'Edit dashboard' }).click();
    const widgetLayout = page.locator('[data-slot="section-card"]', {
      has: page.getByRole('heading', { name: 'Widget layout', exact: true, level: 2 }),
    });
    await managementOverview.getByLabel('Saved date range').selectOption('30');
    await widgetLayout.getByRole('button', { name: 'Hide Exceptions' }).click();
    await managementOverview.getByRole('button', { name: 'Save dashboard' }).click();
    await expect(managementOverview.getByRole('button', { name: 'Edit dashboard' })).toBeVisible();
    await page.reload();
    await expect(managementOverview.getByLabel('Closed-date range')).toHaveValue('30');
    await managementOverview.getByRole('button', { name: 'Edit dashboard' }).click();
    await expect(widgetLayout.getByRole('button', { name: 'Show Exceptions' })).toBeVisible();

    await page.goto(new URL('/restaurant/reports', origin).href);
    await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
    const reportFilters = page.locator('[data-slot="section-card"]', {
      has: page.getByRole('heading', { name: 'Report filters', exact: true, level: 2 }),
    });
    await chooseSelectField(
      reportFilters.getByRole('combobox', { name: 'Branch', exact: true }),
      fixture.branchId
    );
    await reportFilters.getByLabel('From date').fill('2026-08-27');
    await reportFilters.getByLabel('To date').fill('2026-08-27');
    await reportFilters.getByRole('button', { name: 'Apply filters' }).click();
    await expect
      .poll(() => {
        const url = new URL(page.url());
        return [
          url.pathname,
          url.searchParams.get('branch'),
          url.searchParams.get('from'),
          url.searchParams.get('to'),
        ];
      })
      .toEqual(['/restaurant/reports', fixture.branchId, '2026-08-27', '2026-08-27']);
    const reportUrl = new URL(page.url());
    expect(reportUrl.searchParams.get('branch')).toBe(fixture.branchId);
    expect(reportUrl.searchParams.get('from')).toBe('2026-08-27');
    expect(reportUrl.searchParams.get('to')).toBe('2026-08-27');
    const overview = page.locator('[data-slot="section-card"]', {
      has: page.getByRole('heading', { name: 'Overview', exact: true, level: 2 }),
    });
    const exportLink = overview.getByRole('link', { name: 'Export CSV', exact: true });
    await expect(exportLink).toBeVisible();
    await expect(exportLink).toHaveAttribute(
      'href',
      '/api/restaurant/reports/export?section=overview&branch=branch_restaurant_e2e&from=2026-08-27&to=2026-08-27'
    );

    const operatorContext = await browser.newContext();
    try {
      const operator = await operatorContext.newPage();
      const operatorOrigin = await signInAs(operator, 'restaurantOperator');
      await operator.goto(new URL('/restaurant/reports', operatorOrigin).href);
      await expect(operator.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
      const unavailable = operator.locator('[data-slot="section-card"]', {
        has: operator.getByRole('heading', { name: 'Reports unavailable', exact: true }),
      });
      await expect(unavailable.getByText('Permission required', { exact: true })).toBeVisible();
      await expect(unavailable.getByRole('link', { name: 'Export CSV', exact: true })).toHaveCount(
        0
      );
      await expect(operator.getByRole('link', { name: 'Export CSV', exact: true })).toHaveCount(0);
    } finally {
      await operatorContext.close();
    }
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await page.goto(new URL('/dashboard', origin).href);
      const managementOverview = page.locator('[data-slot="section-card"]', {
        has: page.getByRole('heading', { name: 'Management overview', exact: true, level: 2 }),
      });
      await managementOverview.getByRole('button', { name: 'Edit dashboard' }).click();
      await managementOverview.getByRole('button', { name: 'Restore default' }).click();
      await managementOverview.getByRole('button', { name: 'Save dashboard' }).click();
      await expect(
        managementOverview.getByRole('button', { name: 'Edit dashboard' })
      ).toBeVisible();
    } catch (cleanupError) {
      if (!primaryFailure) throw cleanupError;
    }
  }
});

/**
 * WHA-1576 — the settlement path walked in a browser: drawer float, a cash and a card
 * sale through KDS and checkout, the receipt preview, a refund attempt, the day-close
 * preview, the counted drawer close, the day close, and the Finance record of it.
 *
 * Every seeded branch posts money later in this lane on today's business date, and a
 * closed day refuses money: `restaurant-pos-kds.spec.ts` (Gulberg),
 * `restaurant-delivery.spec.ts` (DHA) and `restaurant-software-receipt-acceptance.spec.ts`
 * (the ASCII receipt branch). So the owner moves the ASCII branch's business-day
 * cutoff to 23:59 — the operating day becomes yesterday — the walk closes THAT day,
 * and `finally` restores 00:00. The one minute from 23:59 Asia/Karachi cannot shift
 * the day, so the case fails fast there instead of closing today.
 *
 * The branch ships no kitchen display, so the owner enrols this browser as one through
 * the devices console. That enrolment is residue — revocation on this branch is
 * refused to the owner (WHA-1576 defect list) — and it touches no other case.
 *
 * The branch's only register operator holds no `payments:refund`, and the terminal
 * directory lists no manager here, so the refund is asserted as refused. The
 * approved refund is covered in the browser by `restaurant-pos-kds.spec.ts`.
 */
const DAY_CLOSE_BRANCH = {
  branchId: 'branch_restaurant_e2e_ascii_receipt',
  branchName: 'Gulberg Cafe Receipt Lab',
  operator: { staffProfileId: 'staff_restaurant_e2e_ascii_receipt_operator', pin: '353535' },
  pos: {
    deviceId: 'device_restaurant_e2e_ascii_receipt_pos',
    secret: process.env.RESTAURANT_E2E_ASCII_RECEIPT_DEVICE_SECRET ?? '',
    clientIp: '198.51.100.14',
  },
  saleTotal: '14.00',
} as const;

async function setDayCloseBranchCutoff(page: Page, origin: string, cutoff: string) {
  await page.goto(new URL('/restaurant/settings/branches', origin).href);
  const row = page
    .locator('[data-slot="section-card"]', {
      has: page.getByRole('heading', { name: 'Locations' }),
    })
    .getByRole('listitem')
    .filter({ hasText: DAY_CLOSE_BRANCH.branchName });
  await row.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Business day cutoff').fill(cutoff);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(row).toContainText(`business day ${cutoff}`);
}

async function unlockDayCloseRegister(pos: Page) {
  await expect(pos.getByRole('heading', { name: 'Terminal locked' })).toBeVisible();
  await pos
    .getByLabel('Operator', { exact: true })
    .selectOption(DAY_CLOSE_BRANCH.operator.staffProfileId);
  await pos.getByLabel('Operator PIN', { exact: true }).fill(DAY_CLOSE_BRANCH.operator.pin);
  await pos.getByRole('button', { name: 'Unlock terminal' }).click();
  await expect(pos.getByRole('heading', { name: 'Order pad' })).toBeVisible();
}

async function sellThroughCheckout(pos: Page, kds: Page, tender: 'CASH' | 'CARD') {
  // The branch publishes DINE_IN only; a counter check needs no table.
  await expect(pos.getByLabel('Channel')).toHaveValue('DINE_IN');
  await pos.getByLabel('Covers').fill('1');
  await pos.getByRole('button', { name: new RegExp(`^${fixture.menuItem.name}`) }).click();
  await pos.getByRole('spinbutton', { name: 'Quantity', exact: true }).fill('1');
  await pos.getByLabel(new RegExp(fixture.modifier.name)).check();
  await pos.getByRole('button', { name: 'Add to order' }).click();
  const openedResponse = pos.waitForResponse(
    (response) =>
      response.url().endsWith('/api/restaurant/orders/open') &&
      response.request().method() === 'POST'
  );
  await pos.getByRole('button', { name: 'Open order' }).click();
  const opened = await openedResponse;
  expect(opened.status()).toBe(201);
  const { orderNumber } = (await opened.json()) as { orderNumber: number };
  const orderButton = pos.getByRole('button', { name: new RegExp(`^#${orderNumber} ·`) });
  // Online, the composed check opens directly and becomes the active order.
  await expect(pos.getByText(`Order ${orderNumber} opened.`)).toBeVisible();
  await expect(pos.getByRole('heading', { name: `Order ${orderNumber}` })).toBeVisible();
  await expect(pos.getByText(`1 × ${fixture.menuItem.name}`)).toBeVisible();
  await pos.getByRole('button', { name: 'Send whole order' }).click();
  await expect(pos.getByText('Order sent to kitchen.')).toBeVisible();

  await kds.bringToFront();
  await expect(kds.getByText(`Order #${orderNumber}`)).toBeVisible();
  await kds
    .getByRole('button', {
      name: new RegExp(`Start ${fixture.menuItem.name} for order ${orderNumber}`),
    })
    .click();
  await expect(kds.getByText('Item started.')).toBeVisible();
  await kds
    .getByRole('button', {
      name: new RegExp(`Mark ready ${fixture.menuItem.name} for order ${orderNumber}`),
    })
    .click();
  await expect(kds.getByText('Item marked ready.')).toBeVisible();

  await pos.bringToFront();
  await orderButton.click();
  await expect(pos.getByText('PREPARED')).toBeVisible();
  await pos.getByRole('button', { name: 'Mark served' }).click();
  await pos.getByRole('button', { name: 'Close order' }).click();
  const checkout = pos.getByRole('dialog', { name: 'Collect payment' });
  await expect(checkout).toBeVisible();
  // The cashier reads (never redeems) loyalty for the bill: no 403 on checkout.
  const loyaltyRead = pos.waitForResponse(
    (response) =>
      response.url().includes('/api/restaurant/checkout/loyalty?') &&
      response.request().method() === 'GET'
  );
  await checkout.getByRole('button', { name: 'Cut single bill' }).click();
  expect((await loyaltyRead).status()).toBe(200);
  await checkout.getByLabel('Tender type').selectOption(tender);
  await checkout.getByLabel('Amount').fill(DAY_CLOSE_BRANCH.saleTotal);
  if (tender === 'CASH') await checkout.getByLabel('Cash received').fill('20.00');
  if (tender === 'CARD') {
    await checkout.getByLabel('Approval code').fill('E2E739');
    await checkout.getByLabel('Last 4 digits or reference').fill('4242');
  }
  const tenderResponse = pos.waitForResponse(
    (response) =>
      response.url().endsWith('/api/restaurant/checkout/tender') &&
      response.request().method() === 'POST'
  );
  await checkout.getByRole('button', { name: 'Apply tender' }).click();
  const tendered = await tenderResponse;
  expect(tendered.status()).toBe(200);
  expect(await tendered.json()).toMatchObject({
    type: tender,
    amount: DAY_CLOSE_BRANCH.saleTotal,
    settled: true,
    remainingDue: '0.00',
    ...(tender === 'CASH' ? { changeGiven: '6.00' } : { changeGiven: null }),
  });
  const receipt = checkout.getByRole('region', { name: /^Receipt \d+$/ });
  await expect(receipt).toBeVisible();
  return { orderNumber, receipt, checkout };
}

test('a cashier walks drawer, cash and card sales, receipt, day close, and Finance records the variance', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  expect(DAY_CLOSE_BRANCH.pos.secret, 'the ASCII receipt register secret is required').toMatch(
    /^rdk_/
  );
  const terminalOrigin = terminalBrowserBaseUrl();
  const posContext = await browser.newContext();
  const kdsContext = await browser.newContext();
  const financeContext = await browser.newContext();
  const finance = await financeContext.newPage();
  const financeOrigin = await signInAs(finance, 'restaurantAdmin');
  const karachiToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(
    new Date()
  );
  let cutoffMoved = false;
  let primaryFailure: unknown;
  try {
    await setDayCloseBranchCutoff(finance, financeOrigin, '23:59');
    cutoffMoved = true;

    // Kitchen display: the owner enrols this browser for the branch, then it unlocks.
    const kds = await kdsContext.newPage();
    const ownerOrigin = await signInAs(kds, 'restaurantAdmin');
    await kds.goto(new URL('/restaurant/devices', ownerOrigin).href);
    await kds.getByRole('button', { name: 'Enroll device' }).click();
    const enrol = kds.getByRole('dialog', { name: 'Enroll this browser' });
    await enrol.getByLabel('Device name').fill('WHA-1576 Day-close KDS');
    await expect(enrol.getByRole('combobox', { name: 'Branch', exact: true })).toBeEnabled();
    await chooseSelectField(
      enrol.getByRole('combobox', { name: 'Branch', exact: true }),
      DAY_CLOSE_BRANCH.branchId
    );
    await enrol.getByLabel('Device kind').selectOption('KDS');
    await expect(enrol.getByLabel('KDS station')).toBeEnabled();
    await enrol.getByLabel('KDS station').selectOption({ index: 1 });
    await enrol.getByRole('checkbox').check();
    await enrol.getByRole('button', { name: 'Enroll this browser' }).click();
    await expect(kds).toHaveURL(/\/kds$/);
    await expect(
      kds.getByText(`WHA-1576 Day-close KDS · ${DAY_CLOSE_BRANCH.branchName}`)
    ).toBeVisible();
    await kds.getByLabel('Acting operator').selectOption(DAY_CLOSE_BRANCH.operator.staffProfileId);
    await kds.getByLabel('Operator PIN', { exact: true }).fill(DAY_CLOSE_BRANCH.operator.pin);
    await kds.getByRole('button', { name: 'Verify PIN and unlock' }).click();
    await expect(kds.getByRole('heading', { name: 'Kitchen floor' })).toBeVisible();

    // Register: the seeded enrolment establishes a device session and the cashier unlocks.
    await installSeededTerminalCookie(posContext, DAY_CLOSE_BRANCH.pos, terminalOrigin);
    const pos = await posContext.newPage();
    const establishedResponse = pos.waitForResponse(
      (response) =>
        response.url().endsWith('/api/restaurant/terminal/establish') &&
        response.request().method() === 'POST'
    );
    await pos.goto(new URL('/pos', terminalOrigin).href);
    expect((await establishedResponse).status()).toBe(201);
    await expect(pos.getByRole('heading', { name: 'Terminal locked' })).toBeVisible();
    await expect(pos.getByText(DAY_CLOSE_BRANCH.branchName)).toBeVisible();
    await unlockDayCloseRegister(pos);
    await assertTerminalSecretIsBrowserIsolated(pos, DAY_CLOSE_BRANCH.pos.secret);

    const drawer = pos.getByRole('dialog', { name: 'Cash drawer' });
    await pos.getByRole('button', { name: 'Cash drawer' }).click();
    await expect(drawer.getByRole('heading', { name: 'No open drawer' })).toBeVisible();
    await drawer.getByLabel('Opening float').fill('50.00');
    const drawerOpenResponse = pos.waitForResponse(
      (response) =>
        response.url().endsWith('/api/restaurant/cash/drawer/open') &&
        response.request().method() === 'POST'
    );
    await drawer.getByRole('button', { name: 'Open drawer' }).click();
    const drawerOpened = await drawerOpenResponse;
    expect(drawerOpened.status()).toBe(200);
    const { businessDate } = (await drawerOpened.json()) as { businessDate: string };
    expect(
      businessDate < karachiToday,
      `the 23:59 cutoff must move the operating day off ${karachiToday}`
    ).toBe(true);
    await expect(drawer.getByText('Active drawer')).toBeVisible();
    await pos.getByRole('button', { name: 'Close drawer panel' }).click();

    const cashSale = await sellThroughCheckout(pos, kds, 'CASH');
    await expect(cashSale.receipt).toContainText(
      `${DAY_CLOSE_BRANCH.branchName} · Order ${cashSale.orderNumber}`
    );
    await expect(cashSale.receipt).toContainText(`1 × ${fixture.menuItem.name}`);
    await expect(cashSale.receipt).toContainText(/CASH\s*14\.00\s*Change\s*6\.00/);
    await expect(cashSale.receipt.getByRole('region', { name: 'Receipt printing' })).toBeVisible();
    await cashSale.checkout.getByRole('button', { name: 'Close checkout' }).click();
    await expect(cashSale.checkout).toHaveCount(0);
    // Closing a settled checkout starts a fresh draft for the next check.
    await expect(pos.getByRole('heading', { name: 'No active order' })).toBeVisible();

    const cardSale = await sellThroughCheckout(pos, kds, 'CARD');
    await expect(cardSale.receipt).toContainText(/CARD\s*14\.00/);
    await cardSale.checkout.getByRole('button', { name: 'Close checkout' }).click();
    await expect(cardSale.checkout).toHaveCount(0);

    // Refund is refused to an operator without `payments:refund`; nothing is recorded.
    const refundRead = pos.waitForResponse(
      (response) =>
        response.url().endsWith('/api/restaurant/checkout/refund') &&
        response.request().method() === 'GET'
    );
    await pos.getByRole('button', { name: 'Refund' }).click();
    expect((await refundRead).status()).toBe(403);
    const refund = pos.getByRole('dialog', { name: 'Refund settled payment' });
    await expect(refund.getByRole('alert')).toBeVisible();
    await refund.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(refund).toHaveCount(0);

    const dayClose = pos.getByRole('dialog', { name: 'Close business day' });
    const readiness = async () => {
      const previewResponse = pos.waitForResponse(
        (response) =>
          response.url().includes('/api/restaurant/cash/day/preview') &&
          response.request().method() === 'GET'
      );
      await dayClose.getByRole('button', { name: 'Check readiness' }).click();
      const preview = await previewResponse;
      expect(preview.status()).toBe(200);
      return preview.json();
    };
    await pos.getByRole('button', { name: 'Close day' }).click();
    await expect(dayClose.getByLabel('Business date')).toHaveValue(businessDate);
    const blocked = await readiness();
    expect(blocked.readiness).toMatchObject({
      openBillCount: 0,
      unresolvedOrderCount: 0,
      openDrawerCount: 1,
    });
    expect(blocked.totals).toMatchObject({ grossSales: '28.00', refundTotal: '0.00' });
    await expect(dayClose.getByRole('heading', { name: 'Close blocked' })).toBeVisible();
    await expect(
      dayClose.getByText('Resolve 0 active order(s), 0 open bill(s) and 1 open drawer(s).')
    ).toBeVisible();
    await expect(dayClose.getByRole('button', { name: 'Close business day' })).toHaveCount(0);
    await dayClose.getByRole('button', { name: 'Close day panel' }).click();

    // Blind count 0.50 short of float 50.00 + cash sale 14.00.
    await pos.getByRole('button', { name: 'Cash drawer' }).click();
    await drawer.getByLabel('Counted cash').fill('63.50');
    const drawerCloseResponse = pos.waitForResponse(
      (response) =>
        response.url().endsWith('/api/restaurant/cash/drawer/close') &&
        response.request().method() === 'POST'
    );
    await drawer.getByRole('button', { name: 'Close drawer', exact: true }).click();
    const drawerClosed = await drawerCloseResponse;
    expect(drawerClosed.status()).toBe(200);
    expect(await drawerClosed.json()).toMatchObject({
      expectedCash: '64.00',
      countedCash: '63.50',
      variance: '-0.50',
    });
    await expect(drawer.getByRole('heading', { name: 'Closed drawer' })).toBeVisible();
    await expect(drawer.locator('dl').first()).toContainText(
      /Expected\s*64\.00\s*Counted\s*63\.50\s*Variance\s*-0\.50/
    );
    await pos.getByRole('button', { name: 'Close drawer panel' }).click();

    await pos.getByRole('button', { name: 'Close day' }).click();
    const ready = await readiness();
    expect(ready.readiness).toMatchObject({
      openBillCount: 0,
      unresolvedOrderCount: 0,
      openDrawerCount: 0,
    });
    expect(ready.existingCloseId).toBeNull();
    await expect(dayClose.getByRole('heading', { name: 'Ready to close' })).toBeVisible();
    const closeResponse = pos.waitForResponse(
      (response) =>
        response.url().endsWith('/api/restaurant/cash/day/close') &&
        response.request().method() === 'POST'
    );
    await dayClose.getByRole('button', { name: 'Close business day' }).click();
    const closed = await closeResponse;
    expect(closed.status()).toBe(200);
    const close = (await closed.json()) as {
      dailyCloseId: string;
      totals: Record<string, string>;
      tenderTotals: Array<{ tenderType: string; amount: string; count: number }>;
      replayed: boolean;
    };
    expect(close.replayed).toBe(false);
    expect(close.totals).toMatchObject({
      grossSales: '28.00',
      netSales: '28.00',
      refundTotal: '0.00',
      cashExpected: '64.00',
      cashCounted: '63.50',
      cashVariance: '-0.50',
    });
    expect(close.tenderTotals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tenderType: 'CASH', amount: '14.00', count: 1 }),
        expect.objectContaining({ tenderType: 'CARD', amount: '14.00', count: 1 }),
      ])
    );
    await expect(dayClose.getByRole('heading', { name: 'Closed day' })).toBeVisible();
    // The post-close summary shows the count and variance beside cash expected.
    await expect(dayClose.locator('dl').first()).toContainText(
      /Refunds\s*0\.00[\s\S]*Cash expected\s*64\.00\s*Cash counted\s*63\.50\s*Cash variance\s*-0\.50/
    );
    await expect(
      dayClose.getByRole('link', { name: 'Review in Restaurant Finance' })
    ).toBeVisible();
    await dayClose.getByRole('button', { name: 'Close day panel' }).click();

    // Finance: the owner finds the close and its variance for the branch and date.
    await finance.goto(new URL('/restaurant/money?tab=daily-close', financeOrigin).href);
    await expect(finance.getByRole('heading', { name: 'Restaurant Finance' })).toBeVisible();
    const filters = finance.locator('[data-slot="section-card"]', {
      has: finance.getByRole('heading', { name: 'Filters' }),
    });
    await chooseSelectField(
      filters.getByRole('combobox', { name: 'Branch', exact: true }),
      DAY_CLOSE_BRANCH.branchId
    );
    await filters.getByLabel('Business date').fill(businessDate);
    const closeRow = finance
      .getByRole('region', { name: `Daily close chain table for ${businessDate}` })
      .getByRole('row')
      .filter({ hasText: close.dailyCloseId });
    await expect(closeRow).toContainText('Authoritative tip');
    await expect(closeRow).toContainText('Original close');
    // Gross, Net, Refunds, Cash variance — money renders at 2dp.
    await expect(closeRow.getByRole('cell').nth(4)).toHaveText('28.00');
    await expect(closeRow.getByRole('cell').nth(6)).toHaveText('0.00');
    await expect(closeRow.getByRole('cell').nth(7)).toHaveText('-0.50');
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      if (cutoffMoved) await setDayCloseBranchCutoff(finance, financeOrigin, '00:00');
    } catch (cleanupError) {
      if (!primaryFailure) throw cleanupError;
    } finally {
      await financeContext.close();
      await kdsContext.close();
      await posContext.close();
    }
  }
});
