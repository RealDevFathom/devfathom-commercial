import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
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

async function accessiblePage(page: Page, heading: RegExp) {
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
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

  for (const viewport of viewports) {
    test(`${viewport.name}: SuperAdmin can inspect Restaurant creation`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const actorOrigin = await signInAs(page, 'superAdmin');
      await page.goto(`${actorOrigin}/platform/organizations/new?vertical=RESTAURANT`);
      await accessiblePage(page, /organization/i);
      await expect(page.getByText(/restaurant/i).first()).toBeVisible();
      await page.screenshot({
        path: path.join(OUTPUT, `super-admin-${viewport.name}.png`),
        fullPage: true,
      });
    });

    test(`${viewport.name}: Agency remains usable and Restaurant is denied`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const actorOrigin = await signInAs(page, 'agency');
      await page.goto(`${actorOrigin}/dashboard`);
      await expect(page).toHaveURL(`${actorOrigin}/dashboard`);
      await accessiblePage(page, /^Good (?:morning|afternoon|evening), .+\.$/);
      await page.goto(`${actorOrigin}/restaurant/catalog`);
      await expect(page).not.toHaveURL(/\/restaurant\/catalog$/);
      await page.screenshot({
        path: path.join(OUTPUT, `agency-denied-${viewport.name}.png`),
        fullPage: true,
      });
    });

    for (const [actor, label] of [
      ['restaurantAdmin', 'admin'],
      ['restaurantOperator', 'operator'],
    ] as const satisfies readonly (readonly [ActorKey, string])[]) {
      test(`${viewport.name}: Restaurant ${label} uses its named workspace`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await signInAs(page, actor);
        await page.goto('/dashboard');
        await accessiblePage(page, /restaurant|dashboard|workspace/i);
        await expect(page.getByText(/restaurant/i).first()).toBeVisible();
        await page.screenshot({
          path: path.join(OUTPUT, `${label}-${viewport.name}.png`),
          fullPage: true,
        });
      });
    }
  }

  test('Restaurant A session cannot select Restaurant B by a raw database id', async ({ page }) => {
    await signInAs(page, 'restaurantAdmin');
    await page.goto('/dashboard?organizationId=org_restaurant_b_forbidden');
    await expect(page).not.toHaveURL(/organizationId=org_restaurant_b_forbidden/);
    await assertNoRawDatabaseIds(page);
  });

  test('loading, error, retry and recovery remain named and keyboard operable', async ({
    page,
  }) => {
    await signInAs(page, 'restaurantAdmin');
    let failed = true;
    await page.route('**/api/trpc/**', async (route) => {
      if (failed) await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      else await route.continue();
    });
    await page.goto('/restaurant/sop/admin');
    await expect(page.locator('[aria-busy="true"]')).toBeVisible();
    const retry = page.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible();
    await retry.focus();
    await expect(retry).toBeFocused();
    failed = false;
    await retry.click();
    await expect(page.locator('[aria-busy="true"]')).toBeHidden();
  });

  test('reduced motion exposes content immediately', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signInAs(page, 'restaurantAdmin');
    await page.goto('/dashboard');
    await expect(page.getByRole('main')).toBeVisible();
  });

  test('RTL is NOT-RUN because the accepted manifest names no launch language', () => {});
});
