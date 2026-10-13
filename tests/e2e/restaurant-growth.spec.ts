import { expect, test } from '@playwright/test';
import { signInAs } from './fixtures/restaurant-actor-accessibility';
import {
  assertAcceptanceBrowser,
  readAcceptanceReceipt,
} from '../../scripts/restaurant-acceptance-target';
import { captureRestaurantStudio } from './fixtures/restaurant-studio';
test.beforeEach(async ({ page, baseURL }) => {
  const origin = assertAcceptanceBrowser(baseURL, readAcceptanceReceipt());
  if (
    process.env.RESTAURANT_GROWTH_BROWSER_URL !== origin ||
    process.env.PLAYWRIGHT_BASE_URL !== origin
  )
    throw new Error('Growth, staff authentication, and Playwright must target the admitted app');
  expect(await signInAs(page, 'restaurantAdmin')).toBe(origin);
});
for (const width of [375, 768, 1024, 1440]) {
  test(`empty growth review at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const branch = process.env.RESTAURANT_GROWTH_BROWSER_BRANCH;
    if (!branch) throw new Error('Explicit seeded branch required');
    if (width === 1440) {
      await page.goto(`/restaurant/reports?${new URLSearchParams({ branch })}`);
      await page.getByRole('link', { name: 'Review growth', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/restaurant/growth\\?branch=${branch}`));
    } else {
      await page.goto(`/restaurant/growth?${new URLSearchParams({ branch })}`);
    }
    await expect(page.getByRole('heading', { name: 'Growth review', exact: true })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('No saved recommendation');
    await expect(page.getByRole('button', { name: 'Approve to draft' })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    expect(errors).toEqual([]);
    for (const label of ['Branch ID', 'From', 'Through']) {
      expect(
        (await page.getByLabel(label, { exact: true }).boundingBox())!.height
      ).toBeGreaterThanOrEqual(44);
    }
    await captureRestaurantStudio(page, info, 'growth-empty', [width]);
    await page.getByRole('status').scrollIntoViewIfNeeded();
    const lower = `growth-lower-${width}.png`;
    await page.screenshot({ path: info.outputPath(lower), fullPage: true });
    await info.attach(lower, { path: info.outputPath(lower), contentType: 'image/png' });

    if (width === 1440) {
      await page.getByLabel('From', { exact: true }).fill('2026-10-01');
      await page.getByLabel('Through', { exact: true }).fill('2026-10-02');
      expect(
        await page.getByLabel('From', { exact: true }).evaluate((input) =>
          Array.from((input as HTMLInputElement).form!.elements)
            .filter((element): element is HTMLInputElement => element instanceof HTMLInputElement)
            .map((element) => ({
              name: element.name,
              value: element.value,
              error: element.validationMessage,
            }))
        )
      ).toEqual([
        { name: 'from', value: '2026-10-01', error: '' },
        { name: 'to', value: '2026-10-02', error: '' },
      ]);
      await page.getByRole('button', { name: 'Generate insight', exact: true }).click();
      await expect(page).toHaveURL(/insight=/);
      const unavailable = /Recommendations are unavailable|not enough qualifying evidence/;
      await expect(page.getByRole('status')).toContainText(unavailable);
      await page.reload();
      await expect(page.getByRole('status')).toContainText(unavailable);
      await expect(page.getByRole('button', { name: 'Approve to draft' })).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });
}
test('composed READY fixture saves edited settings and creates one draft', async ({
  page,
}, info) => {
  const branch = process.env.RESTAURANT_GROWTH_READY_BRANCH;
  const insight = process.env.RESTAURANT_GROWTH_BROWSER_INSIGHT;
  if (!branch || !insight || process.env.RESTAURANT_GROWTH_SEMANTICS_ACCEPTED !== '1')
    throw new Error(
      'BLOCKED: accepted cohort/freshness binding and real persisted READY fixture required; never substitute TEST_DOUBLE binding in the app'
    );
  await page.goto(
    `/restaurant/growth?${new URLSearchParams({ branch: branch!, insight: insight! })}`
  );
  await expect(page.getByRole('note')).toContainText(
    'Synthetic diagnostic: deterministic model double'
  );
  await expect(page.getByRole('button', { name: 'Approve to draft' }).first()).toBeEnabled();
  await captureRestaurantStudio(page, info, 'growth-ready');
  await page.getByLabel('Review priority').first().selectOption('HIGH');
  await page.getByRole('button', { name: 'Save reviewed settings' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: 'Saving review' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Approve to draft' }).first().click();
  await page.getByRole('button', { name: 'Confirm approve' }).click();
  await expect(page.getByText('Internal draft created. Nothing published or sent.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Internal draft created. Nothing published or sent.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve to draft' }).first()).toBeDisabled();
  await expect(page.getByLabel('Review priority').first()).toHaveValue('HIGH');
});
