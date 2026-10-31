import { expect, test, type Page } from '@playwright/test';

/**
 * The shared, slug-free login.
 *
 * Requires a shared host. Locally that is `app.localhost` (a reserved label under
 * PLATFORM_BASE_DOMAIN=localhost); on staging it is `staging.devfathom.com`.
 * Point PLAYWRIGHT_SHARED_BASE_URL at whichever applies.
 *
 * SHARED_LOGIN_PASSWORD must be the seeded password. SHARED_LOGIN_MULTI_EMAIL,
 * when set, must be an address that exists in more than one accessible
 * organization — that is what makes the selection screen appear at all.
 */
const sharedBaseUrl = process.env.PLAYWRIGHT_SHARED_BASE_URL;
const password = process.env.SHARED_LOGIN_PASSWORD;
const singleOrgEmail = process.env.SHARED_LOGIN_SINGLE_EMAIL ?? 'alex@company.com';
const multiOrgEmail = process.env.SHARED_LOGIN_MULTI_EMAIL;

test.skip(!sharedBaseUrl, 'PLAYWRIGHT_SHARED_BASE_URL is required for the shared-host suite');

/**
 * The form carries `method="post"` as a no-JavaScript fallback, so a click that
 * lands before React hydrates performs a native submit and clears the fields.
 * Password visibility only toggles once the client handler is attached.
 */
async function signInFormReady(page: Page) {
  const password = page.locator('input[name="password"]');
  await expect(password).toHaveAttribute('type', 'password');
  await expect
    .poll(
      async () => {
        await page.getByRole('button', { name: 'Show password' }).click();
        return password.getAttribute('type');
      },
      { timeout: 60_000, intervals: [250, 500, 1000] }
    )
    .toBe('text');
  await page.getByRole('button', { name: 'Hide password' }).click();
}

async function submitCredentials(page: Page, email: string, secret: string) {
  await page.goto(`${sharedBaseUrl}/login`);
  await signInFormReady(page);
  await page.getByLabel('Email').fill(email);
  await page.locator('input[name="password"]').fill(secret);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('the login URL carries no workspace slug or parameter', async ({ page }) => {
  await page.goto(`${sharedBaseUrl}/login`);

  const url = new URL(page.url());
  expect(url.searchParams.has('workspace')).toBe(false);
  expect(url.pathname).toBe('/login');
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
});

test('the password visibility control is keyboard reachable and touch sized', async ({ page }) => {
  await page.goto(`${sharedBaseUrl}/login`);
  await signInFormReady(page);

  const password = page.getByLabel('Password', { exact: true });
  const toggle = page.getByRole('button', { name: 'Show password' });
  await password.fill('correct horse battery staple');
  await password.focus();
  await page.keyboard.press('Tab');
  await expect(toggle).toBeFocused();
  await expect(toggle).not.toHaveCSS('box-shadow', 'none');
  expect(
    await toggle.evaluate((element) => element.getBoundingClientRect().toJSON())
  ).toMatchObject({ height: 44, width: 44 });

  await toggle.click();
  await expect(password).toHaveAttribute('type', 'text');
  await expect(password).toHaveValue('correct horse battery staple');
});

test('no organization information is emitted before credentials verify', async ({ request }) => {
  const response = await request.post(`${sharedBaseUrl}/api/login`, {
    headers: { origin: sharedBaseUrl!, 'content-type': 'application/json' },
    data: { email: singleOrgEmail, password: 'definitely-the-wrong-password' },
    failOnStatusCode: false,
  });

  expect(response.status()).toBe(401);
  const body = await response.text();
  expect(JSON.parse(body)).toEqual({
    outcome: 'failed',
    message: 'Invalid email or password. Please try again.',
  });
  expect(body).not.toMatch(/organizations|slug|displayName|org_/);
  expect(response.headers()['set-cookie']).toBeUndefined();

  // An unknown address must produce the identical response.
  const unknown = await request.post(`${sharedBaseUrl}/api/login`, {
    headers: { origin: sharedBaseUrl!, 'content-type': 'application/json' },
    data: { email: 'nobody-at-all@example.test', password: 'definitely-the-wrong-password' },
    failOnStatusCode: false,
  });
  expect(await unknown.text()).toBe(body);
});

test('one eligible workspace continues without an extra step', async ({ page }) => {
  test.skip(!password, 'SHARED_LOGIN_PASSWORD is required');

  await submitCredentials(page, singleOrgEmail, password!);

  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/, { timeout: 30_000 });
  // The organization lives in the session, never in the URL.
  expect(new URL(page.url()).searchParams.has('workspace')).toBe(false);
});

test('more than one workspace renders the selection screen', async ({ page }) => {
  test.skip(!password || !multiOrgEmail, 'SHARED_LOGIN_MULTI_EMAIL is required');

  await submitCredentials(page, multiOrgEmail!, password!);

  const choices = page.getByRole('button', { name: /.+/ }).filter({ hasNotText: 'Sign in' });
  await expect(page.getByText('more than one workspace')).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe('/login');
  expect(new URL(page.url()).searchParams.has('workspace')).toBe(false);

  // Keyboard reachable with a visible focus indicator.
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();

  await choices.first().click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/, { timeout: 30_000 });
  expect(new URL(page.url()).searchParams.has('workspace')).toBe(false);
});

test('a forged organization id cannot be selected', async ({ request }) => {
  test.skip(!password, 'SHARED_LOGIN_PASSWORD is required');

  const context = await request.post(`${sharedBaseUrl}/api/login`, {
    headers: { origin: sharedBaseUrl!, 'content-type': 'application/json' },
    data: { email: singleOrgEmail, password },
  });
  expect(context.ok()).toBe(true);

  // The intent cookie is now held by the request context. Selecting an
  // organization outside the server-computed candidate set must not sign in.
  const forged = await request.post(`${sharedBaseUrl}/api/auth/callback/login-intent`, {
    headers: { origin: sharedBaseUrl!, 'content-type': 'application/x-www-form-urlencoded' },
    form: { organizationId: 'org_forged_by_the_client', redirect: 'false' },
    failOnStatusCode: false,
  });

  const cookies = (await request.storageState()).cookies.map((cookie) => cookie.name);
  expect(cookies).not.toContain('authjs.session-token');
  expect(cookies).not.toContain('__Secure-authjs.session-token');
  expect(forged.status()).toBeLessThan(500);
});

test('sign-out clears the pending organization-selection state', async ({ request }) => {
  test.skip(!password, 'SHARED_LOGIN_PASSWORD is required');

  await request.post(`${sharedBaseUrl}/api/login`, {
    headers: { origin: sharedBaseUrl!, 'content-type': 'application/json' },
    data: { email: singleOrgEmail, password },
  });
  const cleared = await request.delete(`${sharedBaseUrl}/api/login`);
  expect(cleared.ok()).toBe(true);

  const setCookie = cleared.headers()['set-cookie'] ?? '';
  expect(setCookie).toContain('df_login_intent=');
  expect(setCookie).toContain('Max-Age=0');
});
