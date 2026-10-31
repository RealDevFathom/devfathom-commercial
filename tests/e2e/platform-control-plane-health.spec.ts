import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  ensureControlPlaneCatalog,
  loginPlatform,
  withAdminDatabase,
} from './fixtures/platform-control-plane';

const fixtureKey = `e2e_health_${randomUUID().replaceAll('-', '')}`;
const organizationIds = [`${fixtureKey}_restaurant`, `${fixtureKey}_pharmacy`];

// Browser CI uses a separate database from Vitest. Own these rows rather than
// relying on platform-health.db.test.ts (or a sibling spec) having run first.
test.beforeAll(async () => {
  await ensureControlPlaneCatalog();
  await withAdminDatabase(async (db) => {
    for (const [index, vertical, name] of [
      [0, 'RESTAURANT', 'Health Restaurant'],
      [1, 'PHARMACY', 'Health Pharmacy'],
    ] as const) {
      await db.query(
        `INSERT INTO organizations
          (id, slug, "legalName", "displayName", vertical, status, "updatedAt")
         VALUES ($1, $1, $2, $2, $3::"OrganizationVertical", 'ACTIVE', now())`,
        [organizationIds[index], name, vertical]
      );
    }
  });
});

test.afterAll(async () => {
  await withAdminDatabase(async (db) => {
    await db.query('DELETE FROM organizations WHERE id = ANY($1::text[])', [organizationIds]);
  });
});

test('health route requires a platform session', async ({ page }) => {
  await page.goto('/platform/health');
  await expect(page).toHaveURL(/\/platform\/login/);
});

test('health renders the disposable lane across Studio viewports, themes, and motion preferences', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await loginPlatform(page);
  await page.goto('/platform/health?vertical=RESTAURANT');
  await expect(page.getByRole('heading', { name: 'Platform health', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Worker heartbeat' })).toBeAttached();
  await expect(
    page.getByText('No bridge registry or heartbeat table.', { exact: false }).first()
  ).toBeAttached();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark']) {
      const themeButton = page.getByRole('button', {
        name: theme === 'light' ? 'Use light theme' : 'Use dark theme',
      });
      if (await themeButton.count()) await themeButton.click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        await page.emulateMedia({ reducedMotion });
        await expect(
          page.getByRole('heading', { name: 'Platform health', exact: true })
        ).toBeVisible();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
        ).toBe(true);
        expect(
          await page
            .locator('main')
            .evaluate((element) => element.scrollWidth <= element.clientWidth)
        ).toBe(true);
      }
      await page.screenshot({
        path: testInfo.outputPath(`health-${width}-${theme}.png`),
        fullPage: true,
      });
      if (width === 1440) {
        await page.getByRole('heading', { name: 'Integration health' }).scrollIntoViewIfNeeded();
        await page.screenshot({
          path: testInfo.outputPath(`health-integrations-${theme}.png`),
          fullPage: true,
        });
        await page
          .getByRole('heading', { name: 'Platform health', exact: true })
          .scrollIntoViewIfNeeded();
      }
    }
  }
  await page.setViewportSize({ width: 375, height: 1000 });
  await page.getByRole('button', { name: 'Open platform navigation' }).click();
  await expect(
    page
      .getByRole('navigation', { name: 'Platform navigation' })
      .getByRole('link', { name: 'Health', exact: true })
  ).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open platform navigation' })).toBeFocused();
  await page.getByRole('button', { name: 'Refresh snapshot' }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Vertical', { exact: true })).toBeFocused();
  expect(
    await page
      .getByLabel('Vertical', { exact: true })
      .evaluate((element) => getComputedStyle(element).outlineStyle)
  ).not.toBe('none');
  await page.getByLabel('Vertical', { exact: true }).selectOption('PHARMACY');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page).toHaveURL(/vertical=PHARMACY/);
  await expect(page.getByRole('region', { name: 'Integration health' })).toContainText(
    'Health Pharmacy'
  );
  await expect(page.getByRole('region', { name: 'Integration health' })).not.toContainText(
    'Health Restaurant'
  );
  await page.goto('/platform/health?organizationId=health_unknown');
  await expect(
    page.getByText('No organizations match these filters.', { exact: false })
  ).toBeAttached();
  await expect(
    page.getByText('No stale running or recent failed jobs in this scope.')
  ).toBeAttached();
  await page.goto('/platform/health?vertical=UNSUPPORTED');
  await expect(page.getByRole('heading', { name: 'Invalid health filters' })).toBeVisible();
  expect(errors).toEqual([]);
});
