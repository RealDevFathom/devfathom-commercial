import { expect, test } from '@playwright/test';

import {
  assertTerminalSecretIsBrowserIsolated,
  installSeededTerminalCookie,
  restaurantE2eCredentials as fixture,
} from './restaurant-fixture';

async function connectKds(page: import('@playwright/test').Page) {
  await installSeededTerminalCookie(page.context(), fixture.kds);
  await page.goto('/kds');
  await page.getByLabel('Acting operator').selectOption(fixture.operator.staffProfileId);
  await page.getByLabel('Operator PIN', { exact: true }).fill(fixture.operator.pin);
  await page.getByRole('button', { name: 'Verify PIN and unlock' }).click();
  await expect(page.getByRole('heading', { name: 'Kitchen floor' })).toBeVisible();
  await assertTerminalSecretIsBrowserIsolated(page, fixture.kds.secret);
}

async function createAndFireOrder(page: import('@playwright/test').Page) {
  await installSeededTerminalCookie(page.context(), fixture.pos);
  await page.goto('/pos');
  await page.getByLabel('Operator', { exact: true }).selectOption(fixture.operator.staffProfileId);
  await page.getByLabel('Operator PIN', { exact: true }).fill(fixture.operator.pin);
  await page.getByRole('button', { name: 'Unlock terminal' }).click();
  await expect(page.getByRole('option', { name: 'Delivery' })).toBeEnabled();
  await page.getByLabel('Channel').selectOption('TAKEAWAY');
  const openedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/restaurant/orders/open') &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Open order' }).click();
  const opened = (await (await openedResponse).json()) as { orderNumber: number };
  await expect(
    page.getByText(`Order ${opened.orderNumber} active.`, { exact: true })
  ).toBeVisible();
  await page.getByRole('button', { name: new RegExp(fixture.menuItem.name) }).click();
  await page.getByLabel(new RegExp(fixture.modifier.name)).check();
  await page.getByRole('button', { name: 'Add to order' }).click();
  await page.getByRole('button', { name: 'Send whole order' }).click();
  await expect(page.getByText('Order sent to kitchen.')).toBeVisible();
}

test.describe('restaurant browser resilience', () => {
  test('KDS keeps stale state offline, reconnects, and refreshes server 86 availability', async ({
    page,
    browser,
    baseURL,
  }) => {
    await connectKds(page);
    await expect(page.getByText(/Last synced/)).toBeVisible();

    await page.context().setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByRole('alert').filter({ hasText: 'Queue refresh failed' })).toContainText(
      'Queue refresh failed'
    );
    await expect(page.getByText(/Showing the last confirmed station state/)).toBeVisible();
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByText(/Last synced/)).toBeVisible();

    const posContext = await browser.newContext({ baseURL });
    const pos = await posContext.newPage();
    await pos.route('**/api/restaurant/orders/effective-menu?**', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          sections: body.sections.map((section: { items: Record<string, unknown>[] }) => ({
            ...section,
            items: section.items.map((item) => ({ ...item, available: false })),
          })),
        },
      });
    });
    await installSeededTerminalCookie(posContext, fixture.pos);
    await pos.goto('/pos');
    await pos.getByLabel('Operator', { exact: true }).selectOption(fixture.operator.staffProfileId);
    await pos.getByLabel('Operator PIN', { exact: true }).fill(fixture.operator.pin);
    await pos.getByRole('button', { name: 'Unlock terminal' }).click();
    await expect(
      pos.getByRole('button', { name: new RegExp(fixture.menuItem.name) })
    ).toBeDisabled();
    await assertTerminalSecretIsBrowserIsolated(pos, fixture.pos.secret);
    await posContext.close();
  });

  test('a dropped KDS mutation retries with the same idempotency key exactly once', async ({
    page,
    browser,
    baseURL,
  }) => {
    const posContext = await browser.newContext({ baseURL });
    const pos = await posContext.newPage();
    await createAndFireOrder(pos);
    await posContext.close();
    const keys: string[] = [];
    let dropped = false;
    await page.route('**/api/restaurant/kds/*', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      keys.push((await route.request().allHeaders())['idempotency-key'] ?? '');
      if (!dropped) {
        dropped = true;
        return route.abort('connectionfailed');
      }
      return route.continue();
    });
    await connectKds(page);
    const action = page
      .getByRole('button', {
        name: new RegExp(`^(Start|Mark ready|Recall) ${fixture.menuItem.name}`),
      })
      .first();
    await expect(action).toBeVisible();
    await action.click();
    await expect(page.getByText('Network request failed. Retry this action.')).toBeVisible();
    await action.click();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  test('gap response forces a bounded full queue review before accepting the next cursor', async ({
    page,
  }) => {
    const queueUrls: string[] = [];
    let injected = false;
    await page.route('**/api/restaurant/kds/queue?**', async (route) => {
      queueUrls.push(route.request().url());
      const response = await route.fetch();
      const body = await response.json();
      if (!injected && route.request().url().includes('sinceCursor=')) {
        injected = true;
        return route.fulfill({ response, json: { ...body, gap: true } });
      }
      return route.fulfill({ response, json: body });
    });
    await connectKds(page);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => queueUrls.some((url) => url.includes('sinceCursor='))).toBeTruthy();
    await expect
      .poll(() => queueUrls.filter((url) => !url.includes('sinceCursor=')).length)
      .toBeGreaterThan(1);
    await expect(page.getByText(/Last synced/)).toBeVisible();
  });
});
