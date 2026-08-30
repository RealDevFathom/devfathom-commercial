import { expect, test } from '@playwright/test';

import { restaurantE2eCredentials as fixture } from './restaurant-fixture';

async function connectKds(page: import('@playwright/test').Page) {
  await page.goto('/kds');
  const load = page.getByRole('button', { name: 'Load branch operators' });
  await expect
    .poll(async () => {
      await page.getByLabel('Bearer device secret').fill(fixture.kds.secret);
      return load.isEnabled();
    })
    .toBe(true);
  await load.click();
  await page.getByLabel('Acting operator').selectOption(fixture.operator.staffProfileId);
  await page.getByRole('button', { name: 'Connect display' }).click();
  await expect(page.getByRole('heading', { name: 'Kitchen floor' })).toBeVisible();
}

test.describe('restaurant browser resilience', () => {
  test('KDS keeps stale state offline, reconnects, and refreshes server 86 availability', async ({
    page,
  }) => {
    await connectKds(page);
    await expect(page.getByText(/Last synced/)).toBeVisible();

    await page.context().setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByRole('alert')).toContainText('Queue refresh failed');
    await expect(page.getByText(/Showing the last confirmed station state/)).toBeVisible();
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByText(/Last synced/)).toBeVisible();

    const pos = await page.context().newPage();
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
    await pos.goto('/pos');
    await pos.getByLabel('Bearer device secret').fill(fixture.pos.secret);
    await pos.getByRole('button', { name: 'Establish session' }).click();
    await pos.getByLabel('Operator').selectOption(fixture.operator.staffProfileId);
    await pos.getByLabel('Operator PIN').fill(fixture.operator.pin);
    await pos.getByRole('button', { name: 'Unlock terminal' }).click();
    await expect(pos.getByRole('button', { name: /Test Burger/ })).toBeDisabled();
  });

  test('a dropped KDS mutation retries with the same idempotency key exactly once', async ({
    page,
  }) => {
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
      .getByRole('button', { name: /^(Start|Mark ready|Recall) Test Burger/ })
      .first();
    test.skip((await action.count()) === 0, 'A fired E2E burger is required for replay coverage');
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
