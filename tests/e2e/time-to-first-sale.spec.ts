import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

import pg from 'pg';

import { freshPharmacyFirstSale } from './fixtures/pharmacy-first-sale';
import { installSeededTerminalCookie } from './restaurant-fixture';
import { completeWorkspaceSelection } from './fixtures/restaurant-actor-accessibility';

// Dedicated setup-only tenant; never reuse Chai Chowk's historical sales.
const restaurant = {
  organizationId: 'org_restaurant_first_sale',
  operator: { staffProfileId: 'first_sale_staff', pin: '424242' },
  pos: {
    deviceId: 'first_sale_pos',
    secret: 'rdk_first_sale_pos_local_ci_only',
    clientIp: '198.51.100.71',
  },
  kds: {
    deviceId: 'first_sale_kds',
    secret: 'rdk_first_sale_kds_local_ci_only',
    clientIp: '198.51.100.72',
  },
  menuItem: { name: 'First Sale Bun', unitPrice: '12.50' },
};

async function tradingEvidence() {
  const connectionString = process.env.RESTAURANT_ACTOR_RUNTIME_DATABASE_URL;
  if (!connectionString) throw new Error('Disposable runtime database URL required.');
  const target = new URL(connectionString);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    Number(target.port) < 55600 ||
    Number(target.port) > 55699 ||
    !/(?:^|[_-])(?:test|e2e|tmp|disposable)(?:[_-]|$)/i.test(target.pathname.slice(1))
  )
    throw new Error('First-sale evidence requires the authorized loopback disposable DB range.');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.current_organization_id', $1, true), set_config('app.is_platform_admin', 'false', true)",
      [restaurant.organizationId]
    );
    const { rows } = await client.query(`SELECT
      (SELECT count(*)::int FROM restaurant_orders) AS orders,
      (SELECT count(*)::int FROM restaurant_bills) AS bills,
      (SELECT count(*)::int FROM restaurant_bills WHERE status = 'SETTLED') AS settled,
      (SELECT role FROM users WHERE id = 'first_sale_user') AS role`);
    await client.query('COMMIT');
    return rows[0];
  } finally {
    await client.end();
  }
}

test.describe.configure({ mode: 'serial' });

async function activate(target: Locator, metric: { clicks: number }) {
  metric.clicks += 1;
  await target.click();
}

function observe4xx(page: Page, failures: string[] = []) {
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

async function restaurantFirstSale(
  page: Page,
  browser: Browser,
  metric: { clicks: number },
  fourXx: string[]
) {
  expect(await tradingEvidence()).toEqual({ orders: 0, bills: 0, settled: 0, role: 'EMPLOYEE' });
  const origin = `http://restaurant-first-sale.localhost:${process.env.PLAYWRIGHT_PORT ?? 4319}`;
  await page.goto(new URL('/login', origin).href);
  await page.getByLabel('Email').fill('first-sale@restaurant-e2e.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill(process.env.RESTAURANT_ACTOR_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await completeWorkspaceSelection(page, '/login', /First Sale Cafe/);
  await installSeededTerminalCookie(page.context(), restaurant.pos, origin);
  await page.goto(new URL('/dashboard', origin).href);
  const checklist = page.getByTestId('first-run-checklist');
  await expect(checklist).toBeVisible();
  await expect(
    checklist.getByRole('listitem').filter({ hasText: 'First test sale' })
  ).toHaveAttribute('data-state', 'NEEDS_YOU');
  await expect(checklist.locator('[data-state="DONE"]')).toHaveCount(5);
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

  await activate(page.getByRole('button', { name: 'Cash drawer', exact: true }), metric);
  const drawer = page.getByRole('dialog', { name: 'Cash drawer', exact: true });
  // The fresh first-sale seed already opens this drawer with its canonical float.
  await expect(drawer.getByText('Active drawer', { exact: true })).toBeVisible();
  await activate(drawer.getByRole('button', { name: 'Close drawer panel' }), metric);

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
  observe4xx(kds, fourXx);
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
  const checkout = page.getByRole('dialog', { name: 'Collect payment', exact: true });
  await activate(checkout.getByRole('button', { name: 'Cut single bill', exact: true }), metric);
  await page.getByLabel('Amount').fill(restaurant.menuItem.unitPrice);
  await page.getByLabel('Cash received').fill(restaurant.menuItem.unitPrice);
  await activate(page.getByRole('button', { name: 'Apply tender' }), metric);
  await expect(page.getByRole('region', { name: /^Receipt \d+$/ })).toBeVisible();
  expect(await tradingEvidence()).toEqual({ orders: 1, bills: 1, settled: 1, role: 'EMPLOYEE' });
  await page.goto(new URL('/dashboard', origin).href);
  await expect(page.getByRole('heading', { name: 'Restaurant dashboard' })).toBeVisible();
  await expect(page.getByTestId('first-run-checklist')).toHaveCount(0);
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

  if (vertical === 'PHARMACY')
    await freshPharmacyFirstSale(page, browser, metric, fourXx, testInfo);
  else await restaurantFirstSale(page, browser, metric, fourXx);

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
