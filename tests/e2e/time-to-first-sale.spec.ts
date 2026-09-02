import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

import { PHARMACY_E2E } from './pharmacy-counter-fixture';
import {
  installSeededTerminalCookie,
  restaurantE2eCredentials as restaurant,
} from './restaurant-fixture';
import { signInAs } from './fixtures/restaurant-actor-accessibility';

test.describe.configure({ mode: 'serial' });

async function activate(target: Locator, metric: { clicks: number }) {
  metric.clicks += 1;
  await target.click();
}

function observe4xx(page: Page) {
  const failures: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400 && response.status() < 500)
      failures.push(
        `${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`
      );
  });
  return failures;
}

async function assertNoRawIdInputs(page: Page) {
  const visibleInputs = page.locator('input:visible, select:visible, textarea:visible');
  const accessibleNames = await visibleInputs.evaluateAll((inputs) =>
    inputs.map((input) => input.getAttribute('aria-label') ?? input.getAttribute('name') ?? '')
  );
  expect(accessibleNames.join(' ')).not.toMatch(
    /\b(?:organization|branch|staff|device|medicine|sale) id\b/i
  );
  await expect(
    page.getByText(/\b(?:org|branch|staff|device|medicine|sale)_[a-z0-9_-]{6,}\b/i)
  ).toHaveCount(0);
}

async function pharmacyFirstSale(page: Page, metric: { clicks: number }) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(process.env.PHARMACY_E2E_ADMIN_EMAIL!);
  await page
    .getByRole('textbox', { name: 'Password' })
    .fill(process.env.PHARMACY_E2E_ADMIN_PASSWORD!);
  await activate(page.getByRole('button', { name: 'Sign in' }), metric);
  const chooser = page.getByText('Choose a workspace', { exact: true });
  if (await chooser.isVisible({ timeout: 10_000 }).catch(() => false))
    await activate(page.getByRole('button', { name: /Fathom Pharmacy E2E/i }), metric);

  await page.goto('/dashboard');
  const checklist = page.getByTestId('first-run-checklist');
  await expect(checklist).toBeVisible();
  await activate(checklist.getByRole('link', { name: /Make a test sale/ }), metric);
  await expect(page).toHaveURL(/\/pharmacy\/counter/);
  await assertNoRawIdInputs(page);

  await activate(page.getByRole('button', { name: 'Open drawer' }), metric);
  const search = page.getByLabel('Scan or search');
  await search.fill(PHARMACY_E2E.medicines.otc.barcode);
  await search.press('Enter');
  const result = page
    .getByRole('list', { name: 'Search results' })
    .getByRole('button')
    .filter({ hasText: PHARMACY_E2E.medicines.otc.name })
    .first();
  await activate(result, metric);
  await page.keyboard.press('F4');
  await page.keyboard.press('F6');
  await page.keyboard.press('F9');
  await page.getByLabel('Amount').fill('25.00');
  await page.getByLabel('Cash received').fill('25.00');
  await activate(page.getByRole('button', { name: 'Take payment' }), metric);
  await expect(page.getByRole('region', { name: /^Receipt \d+$/ })).toBeVisible();
}

async function restaurantFirstSale(page: Page, browser: Browser, metric: { clicks: number }) {
  const origin = await signInAs(page, 'restaurantAdmin');
  await installSeededTerminalCookie(page.context(), restaurant.pos, origin);
  await page.goto(new URL('/dashboard', origin).href);
  const checklist = page.getByTestId('first-run-checklist');
  await expect(checklist).toBeVisible();
  const established = page.waitForResponse((response) =>
    response.url().endsWith('/api/restaurant/terminal/establish')
  );
  await activate(checklist.getByRole('link', { name: /Make a test sale/ }), metric);
  expect((await established).status()).toBe(201);
  await page
    .getByLabel('Operator', { exact: true })
    .selectOption(restaurant.operator.staffProfileId);
  await page.getByLabel('Operator PIN', { exact: true }).fill(restaurant.operator.pin);
  await activate(page.getByRole('button', { name: 'Unlock terminal' }), metric);
  await assertNoRawIdInputs(page);

  await page.getByRole('checkbox').first().check();
  await activate(page.getByRole('button', { name: 'Open order' }), metric);
  await activate(page.getByRole('button', { name: new RegExp(restaurant.menuItem.name) }), metric);
  await activate(page.getByRole('button', { name: 'Add to order' }), metric);
  await activate(page.getByRole('button', { name: 'Send whole order' }), metric);
  const order = page.getByRole('button', { name: /#\d+ · 1 item/ });
  await expect(order).toBeVisible();
  const orderNumber = (await order.textContent())?.match(/#(\d+)/)?.[1];
  expect(orderNumber).toBeTruthy();

  const kdsContext = await browser.newContext();
  await installSeededTerminalCookie(kdsContext, restaurant.kds, origin);
  const kds = await kdsContext.newPage();
  const kdsEstablished = kds.waitForResponse((response) =>
    response.url().endsWith('/api/restaurant/terminal/establish')
  );
  await kds.goto(new URL('/kds', origin).href);
  expect((await kdsEstablished).status()).toBe(201);
  await kds.getByLabel('Acting operator').selectOption(restaurant.operator.staffProfileId);
  await kds.getByLabel('Operator PIN', { exact: true }).fill(restaurant.operator.pin);
  await activate(kds.getByRole('button', { name: 'Verify PIN and unlock' }), metric);
  await activate(
    kds.getByRole('button', { name: new RegExp(`Start .* for order ${orderNumber}`) }),
    metric
  );
  await activate(
    kds.getByRole('button', { name: new RegExp(`Mark ready .* for order ${orderNumber}`) }),
    metric
  );
  await kdsContext.close();

  await page.bringToFront();
  await activate(order, metric);
  await activate(page.getByRole('button', { name: 'Mark served' }), metric);
  await activate(page.getByRole('button', { name: 'Close order' }), metric);
  await page.getByLabel('Amount').fill(restaurant.menuItem.unitPrice);
  await page.getByLabel('Cash received').fill(restaurant.menuItem.unitPrice);
  await activate(page.getByRole('button', { name: 'Apply tender' }), metric);
  await expect(page.getByRole('region', { name: /^Receipt \d+$/ })).toBeVisible();
}

test('admin follows the first-run checklist to the first completed sale', async ({
  page,
  browser,
}, testInfo) => {
  test.slow();
  const started = Date.now();
  const metric = { clicks: 0 };
  const fourXx = observe4xx(page);
  const vertical = process.env.PHARMACY_E2E === '1' ? 'PHARMACY' : 'RESTAURANT';

  if (vertical === 'PHARMACY') await pharmacyFirstSale(page, metric);
  else await restaurantFirstSale(page, browser, metric);

  const wallTimeMs = Date.now() - started;
  testInfo.annotations.push(
    { type: 'vertical', description: vertical },
    { type: 'click-count', description: String(metric.clicks) },
    { type: 'wall-time-ms', description: String(wallTimeMs) }
  );
  console.log(
    `time-to-first-sale vertical=${vertical} clicks=${metric.clicks} wallTimeMs=${wallTimeMs}`
  );
  expect(fourXx).toEqual([]);
});
