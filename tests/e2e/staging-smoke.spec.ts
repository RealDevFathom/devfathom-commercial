import { expect, test, type Page } from '@playwright/test';

/**
 * The sign-in form carries `method="post"` as a no-JavaScript fallback, so a
 * click that lands before React hydrates performs a native submit, reloads
 * /login and clears the fields. Toggling password visibility only works once the
 * client handler is attached, which makes it a reliable hydration probe.
 */
async function signInFormReady(page: Page) {
  const password = page.locator('input[name="password"]');
  await expect(password).toHaveAttribute('type', 'password');
  await expect
    .poll(async () => {
      await page.getByRole('button', { name: 'Show password' }).click();
      return password.getAttribute('type');
    })
    .toBe('text');
  await page.getByRole('button', { name: 'Hide password' }).click();
}

/**
 * Tenant/dedicated hosts keep the per-host login: one form, straight to the
 * dashboard. The shared host adds a step only when the account belongs to more
 * than one workspace — see shared-host-login.spec.ts.
 */
test('staging health and tenant login render', async ({ page, request }) => {
  const health = await request.get('/api/health');
  expect(health.status()).toBe(200);
  await expect(health.json()).resolves.toEqual({ status: 'ok' });

  const response = await page.goto('/login');
  expect(response?.status()).toBe(200);
  // Exactly one h1, and it is the sign-in panel's — the hero headline is
  // decorative and no longer competes with it.
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeVisible();
});

test('seeded tenant administrator can sign in', async ({ page }) => {
  test.skip(!process.env.STAGING_TEST_PASSWORD, 'STAGING_TEST_PASSWORD is required');

  await page.goto('/login');
  await signInFormReady(page);
  await page.getByLabel('Email').fill('jordan@company.com');
  await page.locator('input[name="password"]').fill(process.env.STAGING_TEST_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/, { timeout: 30_000 });
});

test('a differently-cased address reaches the same account', async ({ page }) => {
  test.skip(!process.env.STAGING_TEST_PASSWORD, 'STAGING_TEST_PASSWORD is required');

  // D10: before normalization this could not sign in at all — the stored index
  // is case-sensitive and the query used the raw string.
  await page.goto('/login');
  await signInFormReady(page);
  await page.getByLabel('Email').fill('TAYLOR@Company.com');
  await page.locator('input[name="password"]').fill(process.env.STAGING_TEST_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/, { timeout: 30_000 });
});

test('a wrong password never reveals whether the account exists', async ({ page }) => {
  await page.goto('/login');
  await signInFormReady(page);
  await page.getByLabel('Email').fill('definitely-not-a-user@example.test');
  await page.locator('input[name="password"]').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Scoped past Next's route announcer, which also carries role="alert".
  await expect(page.locator('form').locator('..').getByRole('alert').first()).toContainText(
    'Invalid email or password'
  );
});
