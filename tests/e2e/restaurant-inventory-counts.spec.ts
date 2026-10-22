import { expect, test, type Page } from '@playwright/test';

const password = process.env.STAGING_TEST_PASSWORD;
if (!password)
  throw new Error('STAGING_TEST_PASSWORD is required for authenticated inventory E2E.');

const ADMIN_EMAIL = 'inventory-admin@restaurant-e2e.test';
const READER_EMAIL = 'inventory-reader@restaurant-e2e.test';
const LOCATION = 'Gulberg Main Store';
const REFERENCE = 'WHA-587 closing count';

async function signIn(page: Page, email: string) {
  const tenantOrigin = new URL(process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4319');
  tenantOrigin.hostname = 'chai-chowk.localhost';
  await page.goto(new URL('/login', tenantOrigin).toString());
  const passwordInput = page.locator('input[name="password"]');
  await expect(passwordInput).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(passwordInput).toHaveAttribute('type', 'text', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Hide password' }).click();
  await page.getByLabel('Email').fill(email);
  await passwordInput.fill(password!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/, { timeout: 60_000 });
}

async function openFromRestaurantNavigation(page: Page) {
  const workspace = page.getByRole('main');
  await expect(workspace.getByText('Restaurant workspace')).toBeVisible();
  await workspace.getByRole('link', { name: 'Inventory', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Start a physical count' })).toBeVisible();
  await page.waitForLoadState('networkidle');
}

async function noDocumentOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1
    )
  ).toBe(true);
}

test.describe.serial('authenticated physical stock counts', () => {
  test.describe.configure({ retries: 0 });

  test('admin completes one durable reconciliation without duplicate effects', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => localStorage.setItem('theme', 'light'));
    await signIn(page, ADMIN_EMAIL);
    await openFromRestaurantNavigation(page);
    await noDocumentOverflow(page);

    await expect(page.getByLabel('Location')).toHaveValue('');
    await page.getByLabel('Location').selectOption({ label: LOCATION });
    await page.getByLabel('Reference (optional)').fill(REFERENCE);
    const [createResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/restaurant/inventory'
      ),
      page.getByRole('button', { name: 'Create count' }).click(),
    ]);
    expect(createResponse.status()).toBe(303);
    const actionRedirect = createResponse.headers()['x-action-redirect'];
    expect(actionRedirect).toMatch(
      /^\/restaurant\/inventory\?notice=Physical\+count\+created\.&kind=success&selected=[^;]+;push$/
    );
    const selectedDestination = actionRedirect!.slice(0, -';push'.length);
    await expect(page).toHaveURL(new URL(selectedDestination, page.url()).toString(), {
      timeout: 30_000,
    });
    await expect(page.getByRole('heading', { name: REFERENCE })).toBeVisible();
    const selectedCount = page
      .getByRole('heading', { name: REFERENCE })
      .locator('xpath=ancestor::div[@data-slot="section-card"]');
    await expect(page.getByRole('textbox', { name: /location|stock item|count id/i })).toHaveCount(
      0
    );

    const quantity = page.getByLabel('Counted quantity');
    const addLine = page.getByRole('button', { name: 'Add count line' });
    for (const invalid of ['', '-1', 'NaN']) {
      await page.getByLabel('Stock item').selectOption({ label: 'Chicken (boneless)' });
      await quantity.fill(invalid);
      await addLine.click();
      await expect(selectedCount.getByRole('cell', { name: 'Chicken (boneless)' })).toHaveCount(0);
    }

    for (const [item, counted] of [
      ['Chicken (boneless)', '25.125'],
      ['Basmati Rice (Super Kernel)', '30.75'],
    ] as const) {
      await page.getByLabel('Stock item').selectOption({ label: item });
      await quantity.fill(counted);
      await addLine.click();
      await expect(selectedCount.getByRole('cell', { name: item })).toBeVisible();
      await expect(selectedCount.getByRole('cell', { name: counted })).toBeVisible();
    }

    await page.getByRole('button', { name: 'Submit and freeze count' }).click();
    await expect(selectedCount.getByText('SUBMITTED', { exact: true })).toBeVisible();
    await expect(selectedCount.getByRole('cell', { name: '23.6' })).toBeVisible();
    await expect(selectedCount.getByRole('cell', { name: '25.125' })).toBeVisible();
    await expect(selectedCount.getByRole('cell', { name: '1.525' })).toBeVisible();
    await expect(selectedCount.getByRole('cell', { name: '31.5' })).toBeVisible();
    await expect(selectedCount.getByRole('cell', { name: '30.75' })).toBeVisible();
    await expect(selectedCount.getByRole('cell', { name: '-0.75' })).toBeVisible();
    await expect(addLine).toHaveCount(0);

    let rejected = false;
    await page.route('**/restaurant/inventory**', async (route) => {
      if (!rejected && route.request().method() === 'POST') {
        rejected = true;
        await route.fulfill({ status: 500, body: 'Injected reconciliation rejection' });
      } else await route.continue();
    });
    await page.getByRole('button', { name: 'Post reconciliation' }).click();
    await expect(page.getByText('Reconciliation posted to inventory.')).toHaveCount(0);
    await page.unroute('**/restaurant/inventory**');
    await page.reload();
    await expect(selectedCount.getByText('SUBMITTED', { exact: true })).toBeVisible();

    const post = page.getByRole('button', { name: 'Post reconciliation' });
    await post.dblclick();
    await expect(selectedCount.getByText('POSTED', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Add count line|Submit and freeze|Post reconciliation/ })
    ).toHaveCount(0);
    await expect(page.getByText(/This count is read-only/i)).toBeVisible();
    await page.reload();
    await expect(
      page
        .getByRole('heading', { name: REFERENCE })
        .locator('xpath=ancestor::div[@data-slot="section-card"]')
        .getByText('POSTED', { exact: true })
    ).toBeVisible();
    await expect(page.getByText('PHYSICAL_COUNT_ADJUSTMENT')).toHaveCount(2);
  });

  test('inventory reader gets a professional mobile dark read-only surface', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await context.newPage();
    await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
    await signIn(page, READER_EMAIL);
    await openFromRestaurantNavigation(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByText('Stock on hand')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create count' })).toBeDisabled();
    await expect(
      page.getByRole('button', { name: /Add count line|Submit and freeze|Post reconciliation/ })
    ).toHaveCount(0);
    await expect(page.getByText(/inventory count permission is required/i)).toBeVisible();
    await expect(page.locator('body')).not.toContainText('org_devfathom');
    await noDocumentOverflow(page);
    await context.close();
  });
});
