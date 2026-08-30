import { expect, test, type Page } from '@playwright/test';

import { restaurantE2eCredentials as fixture } from './restaurant-fixture';

test.describe.configure({ mode: 'serial' });

const enabled = Boolean(process.env.RESTAURANT_INTEGRATED_E2E);
test.skip(!enabled, 'Requires the disposable integrated fixture and production next start.');

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
  const routes = [
    '/dashboard',
    '/restaurant/staff',
    '/restaurant/devices',
    '/pos',
    '/kds',
    '/restaurant/reports',
    '/restaurant/inventory',
    '/restaurant/purchasing',
    '/restaurant/sop',
    '/restaurant/loyalty',
    '/restaurant/insights',
  ];

  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(routes[0]);
    await expect(page.locator('body')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toBeVisible();
  }

  for (const route of routes.slice(1)) {
    const response = await page.goto(route);
    expect(response?.status(), route).toBeLessThan(500);
    await expect(page.locator('body')).toBeVisible();
  }

  await page.goto(
    `/dashboard?organizationId=org_restaurant_b_forbidden&branchId=${fixture.branchA2Id}`
  );
  await expect(page).not.toHaveURL(/org_restaurant_b_forbidden/);
  expect(failures, failures.join('\n')).toEqual([]);
});

test('fixture publishes named order inputs and explicit pending UI seams', async ({ page }) => {
  await page.goto('/pos');
  await page.getByLabel('Bearer device secret').fill(fixture.pos.secret);
  await page.getByRole('button', { name: 'Establish session' }).click();
  await page.getByLabel('Operator profile ID').fill(fixture.operator.staffProfileId);
  await page.getByLabel('Operator PIN').fill(fixture.operator.pin);
  await page.getByRole('button', { name: 'Unlock terminal' }).click();
  await expect(page.getByRole('heading', { name: 'Order pad' })).toBeVisible();
  await expect(page.getByText(fixture.menuItem.name)).toBeVisible();

  test
    .info()
    .annotations.push(
      { type: 'pending-service-charge-ui', description: fixture.seams.servicePolicy },
      { type: 'refund-request-api-seam', description: fixture.seams.refundEvidence }
    );
});
