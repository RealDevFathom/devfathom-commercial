import { expect, test, type Page } from '@playwright/test';

/** Hydration under load (~15 concurrent agent runs, dev-server compile) is slow. */
export const LOGIN_HYDRATION_BUDGET_MS = 60_000;

/**
 * WHA-1623 — wait until React owns the `/login` form before typing into it.
 *
 * The form publishes `data-hydrated="true"` once hydrated. A submit that lands
 * earlier is the native POST to `/login/submit` — it signs in too, but it is
 * not the client path these suites exercise, and typing into a form React is
 * about to replace can lose keystrokes. The test's own timeout is extended by
 * the budget so the wait cannot eat the time the test body needs.
 */
export async function waitForLoginHydrated(page: Page) {
  test.info().setTimeout(test.info().timeout + LOGIN_HYDRATION_BUDGET_MS);
  await expect(page.locator('form[data-hydrated="true"]')).toHaveCount(1, {
    timeout: LOGIN_HYDRATION_BUDGET_MS,
  });
}
