import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Request } from '@playwright/test';

import {
  assertTerminalSecretIsBrowserIsolated,
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

test('WHA-1186 print bridge device and settings visual QA', async ({ page }, testInfo) => {
  test.slow();
  const failures = observeRuntimeFailures(page);
  const origin = await signInAs(page, 'restaurantAdmin');

  for (const theme of ['light', 'dark'] as const) {
    for (const width of [375, 768, 1024, 1440]) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.evaluate((value) => {
        window.localStorage.setItem('theme', value);
        document.documentElement.setAttribute('data-theme', value);
        document.documentElement.style.colorScheme = value;
      }, theme);
      await page.setViewportSize({ width, height: 900 });

      const response = await page.goto(new URL('/restaurant/devices', origin).href);
      expect(response?.ok(), `/restaurant/devices at ${width}px in ${theme}`).toBe(true);
      const addBridge = page.getByRole('button', { name: 'Add print bridge' });
      await expect(addBridge).toBeVisible();
      await addBridge.click();

      const dialog = page.getByRole('dialog', { name: 'Add print bridge' });
      await expect(dialog).toBeVisible();
      const bounds = await dialog.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth
        ),
        `/restaurant/devices overflows horizontally at ${width}px in ${theme}`
      ).toBe(false);

      await page.screenshot({
        fullPage: true,
        path: testInfo.outputPath(`WHA-1186-print-bridge-${width}-${theme}.png`),
      });

      await page.keyboard.press('Tab');
      await expect(page.locator(':focus-visible')).toBeVisible();

      if (width === 1024 && theme === 'light') {
        const results = await new AxeBuilder({ page })
          .include('[role="dialog"]')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
      }

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
  }

  const settingsResponse = await page.goto(new URL('/settings', origin).href);
  expect(settingsResponse?.ok(), '/settings').toBe(true);
  await expect(page.getByText('Printing', { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      'A kitchen printer (KOT) prints paper tickets; a kitchen display (KDS) shows the same station queue on screen, and each station may use either, both, or neither.',
      { exact: true }
    )
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    ),
    '/settings overflows horizontally'
  ).toBe(false);
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
