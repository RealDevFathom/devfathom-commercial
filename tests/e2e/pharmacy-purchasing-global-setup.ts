import { chromium, expect, type FullConfig, type Page } from '@playwright/test';
import path from 'node:path';

import { FIXTURE } from './pharmacy-purchasing-fixture';

/**
 * WHA-1196 — sign in once, for the whole PH-PUR acceptance lane.
 *
 * Signing in per test is the obvious thing and the wrong one here: the login
 * route is rate limited per IP, so a six-test file logging in six times from
 * one loopback address starts failing on the fourth for a reason that has
 * nothing to do with purchasing. One authenticated session, written to
 * storage state and reused, is both faster and honest — the surfaces under
 * test are the consoles, not the sign-in form, which
 * `shared-host-login.spec.ts` already covers.
 */

/** Outside `outputDir`, which Playwright wipes at the start of every run. */
export const STORAGE_STATE = path.join(
  'playwright-artifacts',
  'pharmacy-purchasing-fixture',
  'receiver-state.json'
);

/**
 * The form carries `method="post"` as a no-JavaScript fallback, so a click that
 * lands before React hydrates performs a native submit and clears the fields.
 * Password visibility only toggles once the client handler is attached, which
 * makes it the honest hydration signal.
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

export default async function authenticateReceiver(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (typeof baseURL !== 'string') {
    throw new Error('The PH-PUR acceptance lane requires a string baseURL.');
  }

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await page.goto('/login');
    await signInFormReady(page);
    await page.getByLabel('Email').fill(FIXTURE.receiver.email);
    await page.locator('input[name="password"]').fill(FIXTURE.receiver.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 });
    await context.storageState({ path: STORAGE_STATE });
  } finally {
    await browser.close();
  }
}
