import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';

import { signInAs } from './fixtures/restaurant-actor-accessibility';
import {
  assertTerminalSecretIsBrowserIsolated,
  installSeededTerminalCookie,
  restaurantE2eCredentials as fixture,
  terminalBrowserBaseUrl,
} from './restaurant-fixture';

test.describe.configure({ mode: 'serial' });

if (process.env.RESTAURANT_INTEGRATED_E2E !== '1') {
  throw new Error('RESTAURANT_INTEGRATED_E2E=1 is required.');
}

const menuImage = path.join(
  __dirname,
  'fixtures/restaurant-lifecycles-final/final-service-menu.png'
);

async function signInAsRestaurantAdmin(page: Page) {
  const origin = await signInAs(page, 'restaurantAdmin');
  return (route: string) => new URL(route, origin).href;
}

function drainRestaurantJobs() {
  const conditions = [process.env.NODE_OPTIONS, '--conditions=react-server']
    .filter(Boolean)
    .join(' ');
  const result = spawnSync(
    'bunx',
    [
      'tsx',
      'scripts/run-restaurant-jobs.ts',
      '--once',
      '--worker-id=wha1109-menu-import',
      '--max-jobs-per-org=100',
      '--max-outbox-per-org=100',
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: conditions },
      encoding: 'utf8',
      timeout: 60_000,
    }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

async function unlockPos(page: Page) {
  const baseUrl = terminalBrowserBaseUrl();
  await installSeededTerminalCookie(page.context(), fixture.pos, baseUrl);
  await page.goto(new URL('/pos', baseUrl).href);
  await page.getByLabel('Operator', { exact: true }).selectOption(fixture.operator.staffProfileId);
  await page.getByLabel('Operator PIN', { exact: true }).fill(fixture.operator.pin);
  await page.getByRole('button', { name: 'Unlock terminal' }).click();
  await expect(page.getByRole('heading', { name: 'Order pad' })).toBeVisible();
  await assertTerminalSecretIsBrowserIsolated(page, fixture.pos.secret);
}

async function tenantQuery<T extends pg.QueryResultRow>(
  pool: pg.Pool,
  text: string,
  values: unknown[] = []
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_organization_id', $1, true),
              set_config('app.is_platform_admin', 'false', true)`,
      [fixture.organizationId]
    );
    const result = await client.query<T>(text, values);
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('real menu image is extracted, reviewed, and imported as priced drafts', async ({ page }) => {
  test.slow();
  const app = await signInAsRestaurantAdmin(page);
  await page.goto(app('/restaurant/menu-import'));
  await expect(page.getByRole('heading', { name: 'Upload a menu' })).toBeVisible();

  const fileInput = page.getByLabel('Menu file');
  await expect(fileInput).toHaveCount(1, { timeout: 15_000 });
  await expect(fileInput).toBeEnabled();
  await fileInput.setInputFiles(menuImage);
  await expect(page.getByRole('region', { name: 'Menu imports' })).toContainText(
    'final-service-menu.png'
  );
  drainRestaurantJobs();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Review queue' })).toBeVisible();

  const reviewLines = page.getByRole('region', { name: 'Page 1 review lines' });
  await expect(reviewLines).toContainText('Chicken Malai Boti');
  await expect(reviewLines).toContainText('950 PKR');
  await expect(reviewLines).toContainText('Hummus & Pita');
  await expect(reviewLines).toContainText('650 PKR');
  await page.getByRole('button', { name: 'Edit Chicken Malai Boti' }).click();
  await expect(
    page.getByText('Charcoal-grilled chicken in a cream and cheese marinade.', { exact: true })
  ).toBeVisible();

  const acceptButtons = reviewLines.getByRole('button', { name: /^Accept / });
  await expect(acceptButtons.first()).toBeEnabled({ timeout: 30_000 });
  const extractedLineCount = await acceptButtons.count();
  for (let index = 0; index < extractedLineCount; index += 1) {
    await acceptButtons.nth(index).click();
  }

  await page.getByLabel('Menu name').fill('Final Service OCR');
  await expect(page.getByRole('button', { name: 'Import reviewed menu' })).toBeEnabled();
  await page.getByRole('button', { name: 'Import reviewed menu' }).click();
  await expect(page.getByText(/imported|committed/i).first()).toBeVisible();

  await page.goto(app('/restaurant/menus'));
  await expect(page.getByRole('heading', { name: 'Menus & publishing' })).toBeVisible();
  await page.getByRole('tab', { name: /^Menus \(\d+\)$/ }).click();
  await page
    .getByRole('combobox', { name: 'Menu' })
    .selectOption({ label: 'Chai Chowk — Final Service OCR' });
  await expect(page.getByRole('heading', { name: 'Final Service OCR' })).toBeVisible();
  await expect(page.getByText('Chicken Malai Boti', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Hummus & Pita', { exact: true }).first()).toBeVisible();

  await page.getByRole('tab', { name: /^Price lists \(\d+\)$/ }).click();
  await expect(
    page.getByRole('row').filter({ hasText: 'Chicken Malai Boti' }).filter({ hasText: '950.00' })
  ).toBeVisible();
  await expect(
    page.getByRole('row').filter({ hasText: 'Hummus & Pita' }).filter({ hasText: '650.00' })
  ).toBeVisible();
});

test('POS preserves an offline order and denies connected-only submission until exactly-once replay', async ({
  page,
}) => {
  test.slow();
  const databaseUrl = process.env.DATABASE_URL;
  expect(databaseUrl, 'integrated lane requires DATABASE_URL').toBeTruthy();
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const openKeys: string[] = [];
  const addItemKeys: string[] = [];
  let dropCommittedOpenResponse = true;

  try {
    await page.route('**/api/restaurant/orders/open', async (route) => {
      openKeys.push((await route.request().allHeaders())['idempotency-key'] ?? '');
      if (dropCommittedOpenResponse) {
        dropCommittedOpenResponse = false;
        const committed = await route.fetch();
        expect(committed.status()).toBe(201);
        return route.abort('connectionfailed');
      }
      return route.continue();
    });
    await page.route('**/api/restaurant/orders/add-item', async (route) => {
      addItemKeys.push((await route.request().allHeaders())['idempotency-key'] ?? '');
      return route.continue();
    });

    await unlockPos(page);
    const menuItem = page.getByRole('button', { name: new RegExp(fixture.menuItem.name) });
    await expect(menuItem).toContainText(String(Number(fixture.menuItem.unitPrice)));
    await page.getByLabel('Channel').selectOption('TAKEAWAY');

    await page.context().setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.getByText('Offline', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cash drawer' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Refund' })).toBeDisabled();

    await menuItem.click();
    await page.getByLabel(new RegExp(fixture.modifier.name)).check();
    await page.getByRole('button', { name: 'Add to order' }).click();
    await expect(page.getByText(`1 × ${fixture.menuItem.name}`)).toBeVisible();
    await expect(
      page
        .locator('[data-slot="section-card"]')
        .filter({ has: page.getByRole('heading', { name: 'Composed order', exact: true }) })
        .getByText(fixture.modifier.name, { exact: true })
    ).toBeVisible();
    await page.getByRole('button', { name: 'Open order' }).click();
    await expect(page.getByText('Queued 2', { exact: true })).toBeVisible();
    await expect(page.getByText('Order saved to the queue.')).toBeVisible();
    expect(openKeys).toEqual([]);

    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => openKeys.length).toBe(1);
    await expect(page.getByText('Queued 2', { exact: true })).toBeVisible();

    const retry = page.getByRole('button', { name: 'Retry queued orders' });
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect.poll(() => openKeys.length).toBe(2);
    await expect.poll(() => addItemKeys.length).toBeGreaterThanOrEqual(1);
    await expect(page.getByText('Queued 0', { exact: true })).toBeVisible();
    expect(openKeys[0]).toBeTruthy();
    expect(openKeys[1]).toBe(openKeys[0]);
    expect(addItemKeys[0]).toBeTruthy();
    expect(addItemKeys.every((key) => key === addItemKeys[0])).toBe(true);

    const proof = await tenantQuery<{
      orders: string;
      open_keys: string;
      add_keys: string;
      items: string;
    }>(
      pool,
      `SELECT
       (SELECT count(*)::text FROM restaurant_orders WHERE "deviceId" = $1 AND id = open_key."resultRef") orders,
       (SELECT count(*)::text FROM restaurant_order_idempotency_keys WHERE "deviceId" = $1 AND key = $2) open_keys,
       (SELECT count(*)::text FROM restaurant_order_idempotency_keys WHERE "deviceId" = $1 AND key = $3) add_keys,
       (SELECT count(*)::text FROM restaurant_order_items WHERE "orderId" = open_key."resultRef") items
       FROM restaurant_order_idempotency_keys open_key
       WHERE open_key."deviceId" = $1 AND open_key.key = $2`,
      [fixture.pos.deviceId, openKeys[0], addItemKeys[0]]
    );
    expect(proof.rows).toEqual([{ orders: '1', open_keys: '1', add_keys: '1', items: '1' }]);
  } finally {
    await pool.end();
  }
});
