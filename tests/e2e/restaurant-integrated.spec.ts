import { expect, test, type Page } from '@playwright/test';

import {
  assertTerminalSecretIsBrowserIsolated,
  installSeededTerminalCookie,
  restaurantE2eCredentials as fixture,
} from './restaurant-fixture';
import { signInAs } from './fixtures/restaurant-actor-accessibility';

test.describe.configure({ mode: 'serial' });

if (process.env.RESTAURANT_INTEGRATED_E2E !== '1') {
  throw new Error('RESTAURANT_INTEGRATED_E2E=1 is required.');
}

function observeRuntimeFailures(page: Page) {
  const failures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon/i.test(message.text()))
      failures.push(message.text());
  });
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('requestfailed', (request) =>
    failures.push(`${request.method()} ${new URL(request.url()).pathname}`)
  );
  return failures;
}

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

  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const origin = await signInAs(page, 'restaurantAdmin');
    const response = await page.goto(new URL(routes[0][0], origin).href);
    expect(response?.ok(), `dashboard at ${width}px`).toBe(true);
    await expect(page).toHaveURL(new RegExp(`${routes[0][0]}(?:\\?|$)`));
    await expect(page.getByRole('heading', { name: routes[0][1] })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toBeVisible();
  }

  for (const [route, heading] of routes.slice(1)) {
    const origin = await signInAs(page, 'restaurantAdmin');
    const response = await page.goto(new URL(route, origin).href);
    expect(response?.ok(), route).toBe(true);
    await expect(page).toHaveURL(new RegExp(`${route}(?:\\?|$)`));
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }

  const origin = await signInAs(page, 'restaurantAdmin');
  const forbidden = await page.goto(
    new URL(
      `/dashboard?organizationId=org_restaurant_b_forbidden&branchId=${fixture.branchA2Id}`,
      origin
    ).href
  );
  expect(forbidden?.ok()).toBe(true);
  await expect(page.getByRole('heading', { name: 'Restaurant dashboard' })).toBeVisible();
  await expect(page).not.toHaveURL(/org_restaurant_b_forbidden/);
  expect(failures, failures.join('\n')).toEqual([]);
});

test('fixture publishes named order inputs and explicit pending UI seams', async ({ page }) => {
  await installSeededTerminalCookie(page.context(), fixture.pos);
  await page.goto('/pos');
  await page.getByLabel('Operator').selectOption(fixture.operator.staffProfileId);
  await page.getByLabel('Operator PIN').fill(fixture.operator.pin);
  await page.getByRole('button', { name: 'Unlock terminal' }).click();
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
