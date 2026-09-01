import { expect, test } from '@playwright/test';

import {
  assertTerminalSecretIsBrowserIsolated,
  e2eIdempotencyKey,
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
  await expect(owner.getByLabel('Branch')).toContainText(/Gulberg Café|DHA Café/);
  await assertNoRawDatabaseIds(owner);

  const operatorContext = await browser.newContext();
  const operator = await operatorContext.newPage();
  const operatorOrigin = await signInAs(operator, 'restaurantOperator');
  await operator.goto(new URL('/restaurant/money', operatorOrigin).href);
  await expect(operator.getByRole('heading', { name: 'Restaurant Finance' })).not.toBeVisible();
  await expect(operator.locator('body')).not.toContainText(/gross sales|cash variance/i);
  await expect(operator.locator('body')).not.toContainText(fixture.branchA2Id);
  await expect(operator.locator('body')).not.toContainText('org_restaurant_b_forbidden');
});

test('a newly opened drawer survives reload and lock recovery while a foreign device fails closed', async ({
  page,
  request,
}) => {
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
  const openedDrawer = (await opened.json()) as { drawerSessionId: string; replayed: boolean };
  expect(openedDrawer.replayed).toBe(false);
  await expect(page.getByText('Active drawer')).toBeVisible();
  await page.getByRole('button', { name: 'Close drawer panel' }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Order pad' })).toBeVisible();
  await page.getByRole('button', { name: /lock terminal/i }).click();
  await expect(page.getByRole('button', { name: 'Unlock terminal' })).toBeVisible();
  await page
    .getByLabel('Operator', { exact: true })
    .selectOption(fixture.deliveryOperator.staffProfileId);
  await page.getByLabel('Operator PIN', { exact: true }).fill(fixture.deliveryOperator.pin);
  await page.getByRole('button', { name: 'Unlock terminal' }).click();
  await expect(page.getByRole('heading', { name: 'Order pad' })).toBeVisible();
  await page.getByRole('button', { name: 'Cash drawer' }).click();
  await expect(page.getByText('Active drawer')).toBeVisible();
  await expect(page.getByText('125.00')).toBeVisible();
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
});

test('branch controls use readable codes and enforce duplicate, limit, deactivation, and tenant guards', async ({
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
  await expect(page.getByText('2 of 2 active')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create branch' })).toBeDisabled();
  await expect(page.getByText(/branch limit has been reached/i)).toBeVisible();
  await expect(page.getByTitle('Choose another primary branch first.')).toBeDisabled();
  await assertNoRawDatabaseIds(page);

  const dhaRow = locations.getByRole('listitem').filter({ hasText: 'DHA Café' });
  await dhaRow.getByRole('button', { name: 'Deactivate' }).click();
  await expect(
    page.getByText(/active terminals, assigned staff, open orders or drawers/i)
  ).toBeVisible();
  await expect(page.getByText('2 of 2 active')).toBeVisible();

  await dhaRow.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByLabel('Branch code')).toBeDisabled();
  await page.getByLabel('Name').fill('Gulberg Café');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/branch with this name or code already exists/i)).toBeVisible();
  await expect(locations.getByRole('listitem')).toHaveCount(2);
  await expect(page.locator('body')).not.toContainText(/foreign|org_restaurant_b_forbidden/i);
  await assertNoRawDatabaseIds(page);
});

test('Pakistan profiles and custom tax calculation render exact settlement rounding', async ({
  page,
}) => {
  const origin = await signInAs(page, 'restaurantAdmin');
  await page.goto(new URL('/restaurant/tax', origin).href);
  await expect(page.getByRole('heading', { name: 'Tax configuration' })).toBeVisible();
  await expect(page.getByLabel('Jurisdiction and profile')).toContainText(/Pakistan|Punjab|Sindh/i);
  await page.locator('input[name="profileName"]').fill('Final browser profile');
  await page.locator('select[name="customBranchId"]').selectOption(fixture.branchId);
  await page.getByLabel('Cash tax rate (%)').fill('8.25');
  await page.getByLabel('Card tax rate (%)').fill('16');
  await page.getByLabel('Other tax rate (%)').fill('15.5');
  await page.getByLabel('Sample amount').fill('1000.01');
  await expect(page.getByText(/Net 1000\.01 · Tax 82\.50 · Total 1082\.51/)).toBeVisible();
});

test('dashboard preferences persist and report filters produce a scoped export link', async ({
  page,
  browser,
}) => {
  const origin = await signInAs(page, 'restaurantAdmin');
  await page.goto(new URL('/dashboard', origin).href);
  await expect(page.getByRole('heading', { name: 'Restaurant dashboard' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit dashboard' }).click();
  await page.getByLabel('Saved date range').selectOption('30');
  await page.getByRole('button', { name: 'Hide Exceptions' }).click();
  await page.getByRole('button', { name: 'Save dashboard' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Edit dashboard' }).click();
  await expect(page.getByLabel('Saved date range')).toHaveValue('30');
  await expect(page.getByRole('button', { name: 'Show Exceptions' })).toBeVisible();

  await page.goto(new URL('/restaurant/reports', origin).href);
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
  await expect(page.getByLabel('Branch')).toContainText(/All active branches|Gulberg Café/);
  await expect(page.getByLabel('From closed day')).toHaveAttribute('type', 'date');
  await expect(page.getByLabel('To closed day')).toHaveAttribute('type', 'date');
  const exportLink = page.getByRole('link', { name: /export/i }).first();
  await expect(exportLink).toBeVisible();
  await expect(exportLink).toHaveAttribute(
    'href',
    /branch=.*&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/
  );

  const operatorContext = await browser.newContext();
  const operator = await operatorContext.newPage();
  const operatorOrigin = await signInAs(operator, 'restaurantOperator');
  await operator.goto(new URL('/restaurant/reports', operatorOrigin).href);
  await expect(operator.getByRole('heading', { name: 'Reports' })).toBeVisible();
  await expect(operator.getByText('Permission required')).toBeVisible();
  await expect(operator.getByRole('link', { name: /export/i })).toHaveCount(0);
});
