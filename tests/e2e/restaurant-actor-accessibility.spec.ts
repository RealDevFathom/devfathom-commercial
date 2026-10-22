import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  actorFixtureReady,
  assertDisposableDatabaseRoles,
  assertNoRawDatabaseIds,
  signInAs,
  type ActorKey,
} from './fixtures/restaurant-actor-accessibility';

const OUTPUT = path.join('test-results', 'restaurant-actor-accessibility');
const databaseReady = Boolean(
  process.env.RESTAURANT_ACTOR_OWNER_DATABASE_URL &&
  process.env.RESTAURANT_ACTOR_RUNTIME_DATABASE_URL
);

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
] as const;
const themes = ['light', 'dark'] as const;

type BrowserErrors = {
  console: string[];
  page: string[];
  request: string[];
};

const browserErrors = new WeakMap<Page, BrowserErrors>();
const sopInitialReadProcedures = new Set([
  'restaurantSop.listTemplates',
  'restaurantSop.listAssignableJobRoles',
  'restaurantSop.listAssignments',
]);

function trpcProcedures(url: string) {
  const marker = '/api/trpc/';
  const pathname = new URL(url).pathname;
  const procedurePath = pathname.slice(pathname.indexOf(marker) + marker.length);
  return decodeURIComponent(procedurePath).split(',');
}

function isInducedSopRead(url: string) {
  const procedures = trpcProcedures(url);
  return procedures.length > 0 && procedures.every((name) => sopInitialReadProcedures.has(name));
}

function collectUnexpectedErrors(page: Page) {
  const errors: BrowserErrors = { console: [], page: [], request: [] };
  browserErrors.set(page, errors);
  page.on('console', (message) => {
    if (message.type() === 'error') errors.console.push(message.text());
  });
  page.on('pageerror', (error) => errors.page.push(error.message));
  page.on('requestfailed', (request) => {
    errors.request.push(
      `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`
    );
  });
  page.on('response', (response) => {
    if (
      response.status() < 400 ||
      (response.headers()['x-wha-expected-sop-read-error'] === 'true' &&
        response.request().method() === 'GET' &&
        isInducedSopRead(response.url()))
    )
      return;
    errors.request.push(`${response.status()} ${response.request().method()} ${response.url()}`);
  });
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

  test.beforeEach(async ({ page }) => collectUnexpectedErrors(page));

  test.afterEach(async ({ page }, testInfo: TestInfo) => {
    const errors = browserErrors.get(page);
    expect(errors?.console ?? [], `${testInfo.title}: unexpected console errors`).toEqual([]);
    expect(errors?.page ?? [], `${testInfo.title}: unexpected page errors`).toEqual([]);
    expect(errors?.request ?? [], `${testInfo.title}: unexpected request errors`).toEqual([]);
  });

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
          await accessiblePage(page, /^Service dashboard$/);
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
    let inducedFailures = 0;
    let mutationRequests = 0;
    await page.route('**/api/trpc/**', async (route) => {
      const request = route.request();
      if (request.method() !== 'GET') mutationRequests += 1;
      if (failed && request.method() === 'GET' && isInducedSopRead(request.url())) {
        const procedures = trpcProcedures(request.url());
        const errors = procedures.map((procedure) => ({
          error: {
            json: {
              message: 'SOP workspace is temporarily unavailable.',
              code: -32603,
              data: {
                code: 'INTERNAL_SERVER_ERROR',
                httpStatus: 500,
                path: procedure,
                validation: null,
              },
            },
          },
        }));
        inducedFailures += 1;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          headers: { 'x-wha-expected-sop-read-error': 'true' },
          body: JSON.stringify(
            new URL(request.url()).searchParams.has('batch') ? errors : errors[0]
          ),
        });
      } else await route.continue();
    });
    await page.goto(`${actorOrigin}/restaurant/sop/admin`);
    await expect(
      page.getByRole('heading', { level: 2, name: 'SOP workspace could not load' })
    ).toBeVisible();
    await expect(page.getByRole('alert')).toContainText(
      'SOP workspace is temporarily unavailable.'
    );
    const retry = page.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible();
    await retry.focus();
    await expect(retry).toBeFocused();
    failed = false;
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText(/loading sop workspace/i);
    await expect(page.locator('[aria-busy="true"]')).toBeHidden();
    const heading = page.getByRole('heading', { level: 1, name: 'SOP administration' });
    await expect(heading).toHaveCount(1);
    await expect(heading).toBeVisible();
    expect(new URL(page.url()).origin).toBe(actorOrigin);
    await expect(page.locator(':focus')).toBeVisible();
    expect(inducedFailures).toBeGreaterThan(0);
    expect(mutationRequests).toBe(0);
  });

  test('reduced motion exposes content immediately', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const actorOrigin = await signInAs(page, 'restaurantAdmin');
    await page.goto(`${actorOrigin}/dashboard`);
    await expect(page.getByRole('main')).toBeVisible();
  });
});
