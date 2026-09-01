import { expect, test } from '@playwright/test';

import {
  assertTerminalSecretIsBrowserIsolated,
  e2eIdempotencyKey,
  establishDeliveryPosFixture,
  establishPosFixture,
  installSeededTerminalCookie,
  restaurantE2eCredentials as fixture,
  terminalBrowserBaseUrl,
} from './restaurant-fixture';
import { assertNoRawDatabaseIds, signInAs } from './fixtures/restaurant-actor-accessibility';

test.describe.configure({ mode: 'serial' });

if (process.env.RESTAURANT_INTEGRATED_E2E !== '1') {
  throw new Error('RESTAURANT_INTEGRATED_E2E=1 is required.');
}

test('Finance is readable by the owner and denied to an authenticated assigned-branch operator', async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const ownerOrigin = await signInAs(owner, 'restaurantAdmin');
  await owner.goto(new URL('/restaurant/money', ownerOrigin).href);
  await expect(owner.getByRole('heading', { name: 'Restaurant Finance' })).toBeVisible();
  const ownerBranchFilter = owner
    .locator('[data-slot="section-card"]', {
      has: owner.getByRole('heading', { name: 'Filters' }),
    })
    .getByLabel('Branch')
    .filter({ visible: true });
  await expect(ownerBranchFilter).toContainText(/Gulberg Café|DHA Café/);
  await assertNoRawDatabaseIds(owner);

  const operatorContext = await browser.newContext();
  const operator = await operatorContext.newPage();
  const operatorOrigin = await signInAs(operator, 'restaurantOperator');
  await operator.goto(new URL('/restaurant/money', operatorOrigin).href);
  await expect(operator.getByRole('heading', { name: 'Restaurant Finance' })).toBeVisible();
  await expect(
    operator.getByText('Restaurant Finance access denied', { exact: true }).first()
  ).toBeVisible();
  await expect(operator.locator('body')).not.toContainText(/gross sales|cash variance/i);
  await expect(operator.locator('body')).not.toContainText(fixture.branchA2Id);
  await expect(operator.locator('body')).not.toContainText('org_restaurant_b_forbidden');
  await assertNoRawDatabaseIds(operator);
  await operatorContext.close();
  await ownerContext.close();
});

test('a newly opened drawer survives reload and lock recovery while a foreign device fails closed', async ({
  page,
  request,
}) => {
  let openedDrawer: { drawerSessionId: string; replayed: boolean } | undefined;
  let primaryFailure: unknown;
  try {
    const terminalOrigin = terminalBrowserBaseUrl();
    await installSeededTerminalCookie(page.context(), fixture.delivery.pos, terminalOrigin);
    await page.goto(new URL('/pos', terminalOrigin).href);
    await page
      .getByLabel('Operator', { exact: true })
      .selectOption(fixture.deliveryOperator.staffProfileId);
    await page.getByLabel('Operator PIN', { exact: true }).fill(fixture.deliveryOperator.pin);
    await page.getByRole('button', { name: 'Unlock terminal' }).click();
    await expect(page.getByRole('heading', { name: 'Order pad' })).toBeVisible();
    await page.getByRole('button', { name: 'Cash drawer' }).click();
    await expect(page.getByRole('heading', { name: 'No open drawer' })).toBeVisible();
    await page.getByLabel('Opening float').fill('125.00');
    const openedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/restaurant/cash/drawer/open') &&
        response.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Open drawer' }).click();
    const opened = await openedResponse;
    expect(opened.status()).toBe(200);
    openedDrawer = (await opened.json()) as { drawerSessionId: string; replayed: boolean };
    expect(openedDrawer.replayed).toBe(false);
    await expect(page.getByText('Active drawer')).toBeVisible();
    await page.getByRole('button', { name: 'Close drawer panel' }).click();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Terminal locked' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unlock terminal' })).toBeVisible();
    await page
      .getByLabel('Operator', { exact: true })
      .selectOption(fixture.deliveryOperator.staffProfileId);
    await page.getByLabel('Operator PIN', { exact: true }).fill(fixture.deliveryOperator.pin);
    await page.getByRole('button', { name: 'Unlock terminal' }).click();
    await expect(page.getByRole('heading', { name: 'Order pad' })).toBeVisible();
    await page.getByRole('button', { name: 'Cash drawer' }).click();
    await expect(page.getByText('Active drawer')).toBeVisible();
    await expect(
      page.getByRole('dialog').getByText(openedDrawer.drawerSessionId, { exact: true })
    ).toBeVisible();
    await assertTerminalSecretIsBrowserIsolated(page, fixture.delivery.pos.secret);

    const foreign = await establishPosFixture(request);
    const foreignRead = await request.get('/api/restaurant/cash/drawer/current', {
      headers: foreign.headers,
    });
    expect(foreignRead.status()).toBe(200);
    expect(await foreignRead.json()).toMatchObject({ drawerSessionId: 'drawer_restaurant_e2e' });
    const foreignClose = await request.post('/api/restaurant/cash/drawer/close', {
      headers: {
        ...foreign.headers,
        'idempotency-key': e2eIdempotencyKey('foreign-drawer-close', openedDrawer.drawerSessionId),
      },
      data: { drawerSessionId: openedDrawer.drawerSessionId, countedCash: '125.00' },
    });
    expect(foreignClose.status()).toBe(404);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    if (openedDrawer) {
      try {
        const delivery = await establishDeliveryPosFixture(request);
        const currentResponse = await request.get('/api/restaurant/cash/drawer/current', {
          headers: delivery.headers,
        });
        expect(currentResponse.status()).toBe(200);
        const current = (await currentResponse.json()) as {
          drawerSessionId: string;
          openingFloat: string;
        };
        expect(current.drawerSessionId).toBe(openedDrawer.drawerSessionId);
        const closeResponse = await request.post('/api/restaurant/cash/drawer/close', {
          headers: {
            ...delivery.headers,
            'idempotency-key': e2eIdempotencyKey(
              'controls-drawer-cleanup',
              openedDrawer.drawerSessionId
            ),
          },
          data: {
            drawerSessionId: openedDrawer.drawerSessionId,
            countedCash: current.openingFloat,
          },
        });
        expect(closeResponse.status()).toBe(200);
        const afterResponse = await request.get('/api/restaurant/cash/drawer/current', {
          headers: delivery.headers,
        });
        expect(afterResponse.status()).toBe(200);
        expect(await afterResponse.json()).toBeNull();
      } catch (cleanupError) {
        if (!primaryFailure) throw cleanupError;
      }
    }
  }
});

test('branch controls use readable codes and enforce duplicate, limit, and deactivation guards', async ({
  page,
}) => {
  const origin = await signInAs(page, 'restaurantAdmin');
  await page.goto(new URL('/restaurant/settings/branches', origin).href);
  await expect(page.getByRole('heading', { name: 'Branches' })).toBeVisible();
  const locations = page.locator('[data-slot="section-card"]', {
    has: page.getByRole('heading', { name: 'Locations' }),
  });
  await expect(page.getByText('DHA Café')).toBeVisible();
  await expect(locations.getByRole('listitem').filter({ hasText: 'DHA Café' })).toContainText(
    /BR-\d+/
  );
  await expect(page.getByText('2 of 2 active')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create branch' })).toBeDisabled();
  await expect(page.getByText(/branch limit has been reached/i)).toBeVisible();
  await expect(page.getByTitle('Choose another primary branch first.')).toBeDisabled();
  await assertNoRawDatabaseIds(page);

  const dhaRow = locations.getByRole('listitem').filter({ hasText: 'DHA Café' });
  await dhaRow.getByRole('button', { name: 'Deactivate' }).click();
  await expect(
    page.getByText(/active terminals, assigned staff, open orders or drawers/i)
  ).toBeVisible();
  await expect(page.getByText('2 of 2 active')).toBeVisible();

  await dhaRow.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByLabel('Branch code')).toBeDisabled();
  await page.getByLabel('Name').fill('Gulberg Café');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/branch with this name or code already exists/i)).toBeVisible();
  await expect(locations.getByRole('listitem')).toHaveCount(2);
  await assertNoRawDatabaseIds(page);
});

test('Pakistan profiles and the CASH preview render exact rounding', async ({ page }) => {
  const origin = await signInAs(page, 'restaurantAdmin');
  await page.goto(new URL('/restaurant/tax', origin).href);
  await expect(page.getByRole('heading', { name: 'Tax configuration', exact: true })).toBeVisible();
  await expect(page.getByLabel('Jurisdiction and profile')).toContainText(/Pakistan|Punjab|Sindh/i);
  await page.getByLabel('Cash tax rate (%)').fill('8.25');
  await page.getByLabel('Sample amount').fill('1000.01');
  await expect(page.getByText(/Net 1000\.01 · Tax 82\.50 · Total 1082\.51/)).toBeVisible();
});

test('dashboard date and visibility preferences persist and reports render the selected export link', async ({
  page,
  browser,
}) => {
  const origin = await signInAs(page, 'restaurantAdmin');
  let primaryFailure: unknown;
  try {
    await page.goto(new URL('/dashboard', origin).href);
    await expect(page.getByRole('heading', { name: 'Restaurant dashboard' })).toBeVisible();
    const managementOverview = page.locator('[data-slot="section-card"]', {
      has: page.getByRole('heading', { name: 'Management overview', exact: true, level: 2 }),
    });
    await managementOverview.getByRole('button', { name: 'Edit dashboard' }).click();
    const widgetLayout = page.locator('[data-slot="section-card"]', {
      has: page.getByRole('heading', { name: 'Widget layout', exact: true, level: 2 }),
    });
    await managementOverview.getByLabel('Saved date range').selectOption('30');
    await widgetLayout.getByRole('button', { name: 'Hide Exceptions' }).click();
    await managementOverview.getByRole('button', { name: 'Save dashboard' }).click();
    await expect(managementOverview.getByRole('button', { name: 'Edit dashboard' })).toBeVisible();
    await page.reload();
    await expect(managementOverview.getByLabel('Closed-date range')).toHaveValue('30');
    await managementOverview.getByRole('button', { name: 'Edit dashboard' }).click();
    await expect(widgetLayout.getByRole('button', { name: 'Show Exceptions' })).toBeVisible();

    await page.goto(new URL('/restaurant/reports', origin).href);
    await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
    const reportFilters = page.locator('[data-slot="section-card"]', {
      has: page.getByRole('heading', { name: 'Report filters', exact: true, level: 2 }),
    });
    await reportFilters.getByLabel('Branch').selectOption(fixture.branchId);
    await reportFilters.getByLabel('From closed day').fill('2026-08-27');
    await reportFilters.getByLabel('To closed day').fill('2026-08-27');
    await reportFilters.getByRole('button', { name: 'Apply filters' }).click();
    await expect
      .poll(() => {
        const url = new URL(page.url());
        return [
          url.pathname,
          url.searchParams.get('branch'),
          url.searchParams.get('from'),
          url.searchParams.get('to'),
        ];
      })
      .toEqual(['/restaurant/reports', fixture.branchId, '2026-08-27', '2026-08-27']);
    const reportUrl = new URL(page.url());
    expect(reportUrl.searchParams.get('branch')).toBe(fixture.branchId);
    expect(reportUrl.searchParams.get('from')).toBe('2026-08-27');
    expect(reportUrl.searchParams.get('to')).toBe('2026-08-27');
    const overview = page.locator('[data-slot="section-card"]', {
      has: page.getByRole('heading', { name: 'Overview', exact: true, level: 2 }),
    });
    const exportLink = overview.getByRole('link', { name: 'Export CSV', exact: true });
    await expect(exportLink).toBeVisible();
    await expect(exportLink).toHaveAttribute(
      'href',
      '/api/restaurant/reports/export?section=overview&branch=branch_restaurant_e2e&from=2026-08-27&to=2026-08-27'
    );

    const operatorContext = await browser.newContext();
    try {
      const operator = await operatorContext.newPage();
      const operatorOrigin = await signInAs(operator, 'restaurantOperator');
      await operator.goto(new URL('/restaurant/reports', operatorOrigin).href);
      await expect(operator.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
      const unavailable = operator.locator('[data-slot="section-card"]', {
        has: operator.getByRole('heading', { name: 'Reports unavailable', exact: true }),
      });
      await expect(unavailable.getByText('Permission required', { exact: true })).toBeVisible();
      await expect(unavailable.getByRole('link', { name: 'Export CSV', exact: true })).toHaveCount(
        0
      );
      await expect(operator.getByRole('link', { name: 'Export CSV', exact: true })).toHaveCount(0);
    } finally {
      await operatorContext.close();
    }
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await page.goto(new URL('/dashboard', origin).href);
      const managementOverview = page.locator('[data-slot="section-card"]', {
        has: page.getByRole('heading', { name: 'Management overview', exact: true, level: 2 }),
      });
      await managementOverview.getByRole('button', { name: 'Edit dashboard' }).click();
      await managementOverview.getByRole('button', { name: 'Restore default' }).click();
      await managementOverview.getByRole('button', { name: 'Save dashboard' }).click();
      await expect(
        managementOverview.getByRole('button', { name: 'Edit dashboard' })
      ).toBeVisible();
    } catch (cleanupError) {
      if (!primaryFailure) throw cleanupError;
    }
  }
});
