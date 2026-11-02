import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  actorFixtureReady,
  actorFixture,
  assertDisposableDatabaseRoles,
  assertNoRawDatabaseIds,
  signInAs,
  type ActorKey,
} from './fixtures/restaurant-actor-accessibility';

const OUTPUT =
  process.env.RESTAURANT_QA_EVIDENCE_DIR ??
  path.join('test-results', 'restaurant-actor-accessibility');
const databaseReady = Boolean(
  process.env.RESTAURANT_ACTOR_OWNER_DATABASE_URL &&
  process.env.RESTAURANT_ACTOR_RUNTIME_DATABASE_URL
);

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 1024, height: 768 },
] as const;
const themes = ['light', 'dark'] as const;
const tenantAdminSurfaces = [
  { path: '/dashboard', heading: /^Restaurant dashboard$/, screenshot: 'dashboard' },
  { path: '/restaurant/orders', heading: /^Orders$/, screenshot: 'orders' },
  {
    path: '/restaurant/money?tab=daily-close',
    heading: /^Restaurant Finance$/,
    screenshot: 'daily-close',
  },
  { path: '/restaurant/staff', heading: /^Staff$/, screenshot: 'staff' },
  { path: '/restaurant/settings/branches', heading: /^Branches$/, screenshot: 'branches' },
] as const;

type BrowserErrors = {
  console: { text: string; url: string }[];
  page: string[];
  request: string[];
  expectedErrorUrls: Set<string>;
};

const browserErrors = new WeakMap<Page, BrowserErrors>();

function collectUnexpectedErrors(page: Page) {
  const errors: BrowserErrors = {
    console: [],
    page: [],
    request: [],
    expectedErrorUrls: new Set(),
  };
  browserErrors.set(page, errors);
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.console.push({ text: message.text(), url: message.location().url });
    }
  });
  page.on('pageerror', (error) => errors.page.push(error.message));
  page.on('requestfailed', (request) => {
    if (
      request.failure()?.errorText === 'net::ERR_ABORTED' &&
      new URL(request.url()).searchParams.has('_rsc')
    ) {
      return;
    }
    errors.request.push(
      `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`
    );
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    if (response.headers()['x-wha-expected-error'] === 'true') {
      errors.expectedErrorUrls.add(response.url());
      return;
    }
    errors.request.push(`${response.status()} ${response.request().method()} ${response.url()}`);
  });
}

// Chromium logs every deliberately failed (x-wha-expected-error) response as a
// "Failed to load resource" console error; only those exact URLs are excused.
function unexpectedConsoleErrors(errors: BrowserErrors | undefined) {
  return (errors?.console ?? [])
    .filter(
      ({ text, url }) =>
        !(text.startsWith('Failed to load resource:') && errors?.expectedErrorUrls.has(url))
    )
    .map(({ text }) => text);
}

async function useTheme(page: Page, theme: (typeof themes)[number]) {
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((value) => window.localStorage.setItem('theme', value), theme);
}

async function expectExactHeadingHierarchy(page: Page, h1: RegExp) {
  const headings = page.getByRole('heading');
  const count = await headings.count();
  expect(count).toBeGreaterThan(1);
  await expect(headings.nth(0)).toHaveJSProperty('tagName', 'H1');
  await expect(headings.nth(0)).toHaveText(h1);
  await expect(headings.nth(1)).toHaveJSProperty('tagName', 'H2');
  const levels = await headings.evaluateAll((items) =>
    items.map((item) => Number(item.tagName.slice(1)))
  );
  expect(levels[0]).toBe(1);
  expect(levels.slice(1).every((level, index) => level > 1 && level <= levels[index] + 1)).toBe(
    true
  );
}

async function accessiblePage(page: Page, heading: RegExp) {
  // headings.count() does not auto-wait; let the client-rendered page settle first.
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  await expectExactHeadingHierarchy(page, heading);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(
    false
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await assertNoRawDatabaseIds(page);
}

test.describe('accepted manifest: final actor and accessibility acceptance', () => {
  test.skip(
    !actorFixtureReady || !databaseReady,
    'Disposable database and four local actor users are required.'
  );

  test.beforeAll(async () => {
    await mkdir(OUTPUT, { recursive: true });
    await assertDisposableDatabaseRoles();
  });

  test.beforeEach(async ({ page }, testInfo) => {
    collectUnexpectedErrors(page);
    const testBucket = [...`${testInfo.project.name}:${testInfo.title}`].reduce(
      (bucket, character) => (bucket * 31 + character.charCodeAt(0)) >>> 0,
      0
    );
    await page.setExtraHTTPHeaders({
      'x-forwarded-for': `10.${(testBucket >>> 16) & 255}.${(testBucket >>> 8) & 255}.${testBucket & 255}`,
    });
  });

  test.afterEach(async ({ page }, testInfo: TestInfo) => {
    const errors = browserErrors.get(page);
    expect(unexpectedConsoleErrors(errors), `${testInfo.title}: unexpected console errors`).toEqual(
      []
    );
    expect(errors?.page ?? [], `${testInfo.title}: unexpected page errors`).toEqual([]);
    expect(errors?.request ?? [], `${testInfo.title}: unexpected request errors`).toEqual([]);
  });

  test('SuperAdmin successful-login boundary resets without affecting another credential bucket', async ({
    page,
  }, testInfo) => {
    const actorOrigin = await signInAs(page, 'superAdmin');
    const projectBucket = [...testInfo.project.name].reduce(
      (bucket, character) => (bucket * 31 + character.charCodeAt(0)) % 254,
      0
    );
    const clientIp = `198.51.100.${projectBucket + 1}`;
    const login = (email: string, password: string) =>
      page.request.post(new URL('/api/platform/session', actorOrigin).href, {
        headers: { origin: actorOrigin, 'x-forwarded-for': clientIp },
        data: { email, password },
      });

    for (let attempt = 0; attempt < 9; attempt += 1) {
      const response = await login(actorFixture.superAdmin.email, actorFixture.superAdmin.password);
      expect(response.status(), `successful login ${attempt + 1} crossed limiter boundary`).toBe(
        200
      );
    }

    for (let attempt = 0; attempt < 9; attempt += 1) {
      const response = await login('isolated-invalid-actor@e2e.invalid', 'invalid-password');
      expect(response.status()).toBe(attempt === 8 ? 429 : 401);
    }
    expect(
      (await login(actorFixture.superAdmin.email, actorFixture.superAdmin.password)).status()
    ).toBe(200);
  });

  for (const viewport of viewports) {
    test(`${viewport.name}: tenant admin surfaces pass the accessibility matrix`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const actorOrigin = await signInAs(page, 'restaurantAdmin');

      const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
      await navigation.getByRole('button', { name: /^Sell/ }).click();
      // Menu popups render in a body portal, so query from page, not navigation.
      await expect(page.getByRole('menuitem', { name: 'Point of sale' })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Kitchen display' })).toBeVisible();
      await page.keyboard.press('Escape');
      // Ungrouped destinations land in Settings, so a leaked Pharmacy entry would appear here.
      await navigation.getByRole('button', { name: /^Settings/ }).click();
      for (const name of ['Onboarding', 'Counter', 'Regulatory profile']) {
        await expect(page.getByRole('menuitem', { name })).toHaveCount(0);
      }
      await page.keyboard.press('Escape');

      for (const surface of tenantAdminSurfaces) {
        await page.goto(new URL(surface.path, actorOrigin).href);
        await expect(page.getByRole('heading', { level: 1, name: surface.heading })).toBeVisible();
        await accessiblePage(page, surface.heading);
        await page.screenshot({
          path: path.join(OUTPUT, `tenant-admin-${surface.screenshot}-${viewport.name}.png`),
          fullPage: true,
        });
      }
    });
  }

  for (const viewport of viewports) {
    for (const theme of themes) {
      test(`${viewport.name} ${theme}: SuperAdmin can inspect Restaurant creation`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        await useTheme(page, theme);
        const actorOrigin = await signInAs(page, 'superAdmin');
        await page.goto(`${actorOrigin}/platform/organizations/new?vertical=RESTAURANT`);
        await accessiblePage(page, /^Onboard an organization$/);
        await expect(page.getByText(/restaurant/i).first()).toBeVisible();
        await page.screenshot({
          path: path.join(OUTPUT, `super-admin-${viewport.name}-${theme}.png`),
          fullPage: true,
        });
      });

      test(`${viewport.name} ${theme}: Agency remains usable and Restaurant is denied`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        await useTheme(page, theme);
        const actorOrigin = await signInAs(page, 'agency');
        await page.goto(`${actorOrigin}/dashboard`);
        await expect(page).toHaveURL(`${actorOrigin}/dashboard`);
        await accessiblePage(page, /^Good (?:morning|afternoon|evening), .+\.$/);
        await page.goto(`${actorOrigin}/restaurant/catalog`);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(
          'This module is not enabled'
        );
        await expect(
          page.getByText(/current package, contract, or module override/i)
        ).toBeVisible();
        await expect(page.locator('body')).not.toContainText(/org_[a-z0-9_-]+|other organization/i);
        await page.screenshot({
          path: path.join(OUTPUT, `agency-denied-${viewport.name}-${theme}.png`),
          fullPage: true,
        });
      });

      for (const [actor, label] of [
        ['restaurantAdmin', 'admin'],
        ['restaurantOperator', 'operator'],
      ] as const satisfies readonly (readonly [ActorKey, string])[]) {
        test(`${viewport.name} ${theme}: Restaurant ${label} uses its named workspace`, async ({
          page,
        }) => {
          await page.setViewportSize(viewport);
          await useTheme(page, theme);
          const actorOrigin = await signInAs(page, actor);
          await page.goto(`${actorOrigin}/dashboard`);
          await accessiblePage(page, /^Restaurant dashboard$/);
          await expect(page.getByText(/restaurant/i).first()).toBeVisible();
          await page.screenshot({
            path: path.join(OUTPUT, `${label}-${viewport.name}-${theme}.png`),
            fullPage: true,
          });
        });
      }
    }
  }

  test('Restaurant A session cannot select Restaurant B by a raw database id', async ({ page }) => {
    const actorOrigin = await signInAs(page, 'restaurantAdmin');
    await page.goto(
      `${actorOrigin}/dashboard?tab=activity&organizationId=org_restaurant_b_forbidden&view=compact`
    );
    await expect(page).not.toHaveURL(/organizationId=org_restaurant_b_forbidden/);
    const url = new URL(page.url());
    expect(url.searchParams.get('tab')).toBe('activity');
    expect(url.searchParams.get('view')).toBe('compact');
    await assertNoRawDatabaseIds(page);
  });

  test('loading, error, retry and recovery remain named and keyboard operable', async ({
    page,
  }) => {
    const actorOrigin = await signInAs(page, 'restaurantAdmin');
    let failed = true;
    let mutationRequests = 0;
    await page.route('**/api/trpc/**', async (route) => {
      if (route.request().method() !== 'GET') mutationRequests += 1;
      if (failed)
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          headers: { 'x-wha-expected-error': 'true' },
          body: '{}',
        });
      else await route.continue();
    });
    await page.goto(`${actorOrigin}/restaurant/sop/admin`);
    // The query client retries a 5xx before settling on the error state; the named
    // loading status is what an operator sees while those retries run.
    await expect(page.getByRole('status', { name: /loading sop workspace/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /could not load/i })).toBeVisible({
      timeout: 30_000,
    });
    const retry = page.getByRole('button', { name: 'Retry' });
    await expect(page.getByRole('alert').filter({ has: retry })).toBeVisible();
    await retry.focus();
    await expect(retry).toBeFocused();
    failed = false;
    await page.keyboard.press('Enter');
    await expect(page.locator('[aria-busy="true"]')).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: 'SOP administration' })).toBeVisible();
    await expect(page.locator(':focus')).toBeVisible();
    expect(mutationRequests).toBe(0);
  });

  test('reduced motion exposes content immediately', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const actorOrigin = await signInAs(page, 'restaurantAdmin');
    await page.goto(`${actorOrigin}/dashboard`);
    await expect(page.getByRole('main')).toBeVisible();
  });
});
