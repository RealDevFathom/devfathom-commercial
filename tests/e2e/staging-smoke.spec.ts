import { expect, test } from '@playwright/test';

test('staging health and tenant login render', async ({ page, request }) => {
  const health = await request.get('/api/health');
  expect(health.status()).toBe(200);
  await expect(health.json()).resolves.toEqual({ status: 'ok' });

  const response = await page.goto('/login');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
});

test('seeded tenant administrator can sign in', async ({ page }) => {
  test.skip(!process.env.STAGING_TEST_PASSWORD, 'STAGING_TEST_PASSWORD is required');

  await page.goto('/login');
  await page.getByLabel('Email').fill('alex@company.com');
  await page.locator('input[name="password"]').fill(process.env.STAGING_TEST_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/, { timeout: 30_000 });
});
