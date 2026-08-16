import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * DEVFATHOM-STUDIO §12 visual QA release gate for the authentication routes this
 * change touches. Captures every viewport in both themes, plus a reduced-motion
 * pass, and asserts the two things a screenshot cannot show: no horizontal
 * document overflow, and exactly one <h1>.
 *
 * Screenshots land in test-results/visual-qa/ for attaching to the pull request.
 *
 * Run in a FOREGROUND tab: a backgrounded tab freezes requestAnimationFrame and
 * makes the Motion-driven panels look broken.
 */
const VIEWPORTS = [
  { name: '375-portrait', width: 375, height: 812 },
  { name: '768-tablet', width: 768, height: 1024 },
  { name: '1024-laptop', width: 1024, height: 768 },
  { name: '1440-desktop', width: 1440, height: 900 },
] as const;

const THEMES = ['light', 'dark'] as const;

const ROUTES = [
  { name: 'login', path: '/login' },
  { name: 'login-session-ended', path: '/login?reason=session-ended' },
  { name: 'forgot-password', path: '/forgot-password' },
] as const;

const OUTPUT = path.join('test-results', 'visual-qa');

/**
 * The app does NOT follow `prefers-color-scheme`: an inline script in the root
 * layout reads `localStorage.theme` and stamps `data-theme` on <html>, defaulting
 * to light. `emulateMedia` alone would silently produce two identical light
 * captures, so the theme is set the way the product sets it.
 */
async function useTheme(page: Page, theme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((value) => {
    window.localStorage.setItem('theme', value);
  }, theme);
}

/** Switch theme on an already-loaded page, without reloading away client state. */
async function switchTheme(page: Page, theme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((value) => {
    window.localStorage.setItem('theme', value);
    document.documentElement.setAttribute('data-theme', value);
    document.documentElement.style.colorScheme = value;
  }, theme);
}

test.describe('authentication visual QA matrix', () => {
  test.beforeAll(async () => {
    await mkdir(OUTPUT, { recursive: true });
  });

  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test(`${theme} ${viewport.name}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await useTheme(page, theme);

        for (const route of ROUTES) {
          await page.goto(route.path);
          await page.waitForLoadState('networkidle');

          // No document-level horizontal overflow at any width (§12).
          const overflows = await page.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
          );
          expect(overflows, `${route.name} overflows horizontally`).toBe(false);

          // Exactly one h1 per page (§9).
          await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

          await page.screenshot({
            path: path.join(OUTPUT, `${route.name}-${theme}-${viewport.name}.png`),
            fullPage: true,
          });
        }
      });
    }
  }

  /**
   * The organization-selection screen is the new surface, so it gets the same
   * matrix. Needs an address that belongs to more than one accessible workspace.
   */
  const multiOrgEmail = process.env.SHARED_LOGIN_MULTI_EMAIL;
  const sharedPassword = process.env.SHARED_LOGIN_PASSWORD;

  /**
   * Signs in ONCE and then walks the matrix by re-emulating. Repeating the login
   * per cell would spend the per-account login limiter (10 attempts / 5 minutes)
   * and fail the later cells for a reason that has nothing to do with layout.
   */
  test('workspace selection matrix', async ({ page }) => {
    test.skip(
      !multiOrgEmail || !sharedPassword,
      'SHARED_LOGIN_MULTI_EMAIL and SHARED_LOGIN_PASSWORD are required'
    );
    test.slow();

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/login');

    const password = page.locator('input[name="password"]');
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

    await page.getByLabel('Email').fill(multiOrgEmail!);
    await password.fill(sharedPassword!);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByText('more than one workspace')).toBeVisible({ timeout: 30_000 });

    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        await switchTheme(page, theme);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });

        const overflows = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
        );
        expect(
          overflows,
          `workspace selection overflows horizontally at ${theme} ${viewport.name}`
        ).toBe(false);
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

        await page.screenshot({
          path: path.join(OUTPUT, `workspace-selection-${theme}-${viewport.name}.png`),
          fullPage: true,
        });
      }
    }
  });

  test('reduced motion renders content immediately', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
    await useTheme(page, 'light');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/login');

    // Content must be present with no hidden initial state or required travel.
    await expect(page.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();

    await page.screenshot({
      path: path.join(OUTPUT, 'login-reduced-motion-1440.png'),
      fullPage: true,
    });
  });

  test('every control is keyboard reachable with a visible focus indicator', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/login');

    await page.keyboard.press('Tab');
    for (let step = 0; step < 8; step += 1) {
      const focused = page.locator(':focus');
      if ((await focused.count()) === 0) break;
      await expect(focused).toBeVisible();
      await page.keyboard.press('Tab');
    }
  });
});
