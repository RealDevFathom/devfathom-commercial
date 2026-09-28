import { chromium, expect, type FullConfig, type Page } from '@playwright/test';
import path from 'node:path';

import { TRANSFERS_ARTIFACTS, TRANSFERS_FIXTURE } from './pharmacy-transfers-fixture';

/**
 * WHA-1603 — sign both people in once for the INV-07 lane. The login route is
 * rate limited per IP, and the surface under test is the transfers console,
 * not the sign-in form.
 */
export const DISPATCHER_STATE = path.join(TRANSFERS_ARTIFACTS, 'dispatcher-state.json');
export const APPROVER_STATE = path.join(TRANSFERS_ARTIFACTS, 'approver-state.json');

/** Password visibility only toggles once React has hydrated the form. */
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

export default async function authenticate(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (typeof baseURL !== 'string') throw new Error('The INV-07 lane requires a string baseURL.');

  const browser = await chromium.launch();
  try {
    for (const [person, statePath] of [
      [TRANSFERS_FIXTURE.dispatcher, DISPATCHER_STATE],
      [TRANSFERS_FIXTURE.approver, APPROVER_STATE],
    ] as const) {
      const context = await browser.newContext({ baseURL });
      const page = await context.newPage();
      await page.goto('/login');
      await signInFormReady(page);
      await page.getByLabel('Email').fill(person.email);
      await page.locator('input[name="password"]').fill(person.password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 });
      await context.storageState({ path: statePath });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
