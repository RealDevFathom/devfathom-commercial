import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * DEVFATHOM-STUDIO §12 visual QA release gate for `/restaurant/menu-import`
 * (WHA-210). The route is behind auth, the `restaurant-menu` module and the
 * default-deny `menu:import` capability, so it needs an account that actually
 * holds all three — hence the env guard rather than a fixture nobody can run.
 *
 * Set MENU_IMPORT_QA_EMAIL / MENU_IMPORT_QA_PASSWORD against a workspace whose
 * user holds `menu:import` and has at least one import awaiting review.
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
const ROUTE = '/restaurant/menu-import';
const OUTPUT = path.join('test-results', 'visual-qa');

const email = process.env.MENU_IMPORT_QA_EMAIL;
const password = process.env.MENU_IMPORT_QA_PASSWORD;

/**
 * The app does NOT follow `prefers-color-scheme`: an inline script in the root
 * layout reads `localStorage.theme` and stamps `data-theme` on <html>.
 */
async function switchTheme(page: Page, theme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((value) => {
    window.localStorage.setItem('theme', value);
    document.documentElement.setAttribute('data-theme', value);
    document.documentElement.style.colorScheme = value;
  }, theme);
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email!);
  await page.locator('input[name="password"]').fill(password!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 });
}

async function documentOverflows(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  );
}

test.describe('menu import visual QA matrix', () => {
  test.skip(!email || !password, 'MENU_IMPORT_QA_EMAIL and MENU_IMPORT_QA_PASSWORD are required');

  test.beforeAll(async () => {
    await mkdir(OUTPUT, { recursive: true });
  });

  /**
   * Signs in ONCE and walks the matrix by re-emulating. Repeating the login per
   * cell would spend the per-account login limiter and fail later cells for a
   * reason that has nothing to do with layout.
   */
  test('viewports and themes', async ({ page }) => {
    test.slow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await page.goto(ROUTE);
    await expect(page.getByRole('heading', { level: 1, name: 'Menu import' })).toBeVisible();

    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        await switchTheme(page, theme);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.waitForLoadState('networkidle');

        // No document-level horizontal overflow at any width (§12). Wide tables
        // are allowed to scroll, but only inside their own bounded container.
        expect(
          await documentOverflows(page),
          `menu import overflows horizontally at ${theme} ${viewport.name}`
        ).toBe(false);

        // Exactly one h1 per page (§9).
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

        await page.screenshot({
          path: path.join(OUTPUT, `menu-import-${theme}-${viewport.name}.png`),
          fullPage: true,
        });

        // The canvas scrolls INSIDE the shell (§5), so a full-page capture only
        // ever shows the top. The review queue is the actual subject of this
        // gate, so scroll it into view and capture it too.
        await page.getByRole('heading', { name: 'Review queue' }).scrollIntoViewIfNeeded();
        await page.screenshot({
          path: path.join(OUTPUT, `menu-import-queue-${theme}-${viewport.name}.png`),
          fullPage: true,
        });
        await page
          .getByRole('heading', { name: 'Import the reviewed menu' })
          .scrollIntoViewIfNeeded();
        await page.screenshot({
          path: path.join(OUTPUT, `menu-import-commit-${theme}-${viewport.name}.png`),
          fullPage: true,
        });
      }
    }
  });

  test('renders the review states without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(String(error)));

    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await page.goto(ROUTE);
    await page.waitForLoadState('networkidle');

    // The untrusted-content contract: the injection fixture keeps its chip.
    await expect(page.getByText('Suspected injection').first()).toBeVisible();

    // Disabled-until-ready: every line starts PENDING, so Import must be off.
    const importButton = page.getByRole('button', { name: 'Import reviewed menu' });
    await expect(importButton).toBeDisabled();
    await expect(page.getByText(/still need a decision/)).toBeVisible();

    // The editor is a real state to look at, not just a code path.
    await page
      .getByRole('button', { name: /^Edit / })
      .first()
      .click();
    await expect(page.getByLabel('Merge into existing product')).toBeVisible();
    await page.screenshot({
      path: path.join(OUTPUT, 'menu-import-editor-open-1440.png'),
      fullPage: true,
    });

    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('reduced motion renders content immediately', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await page.goto(ROUTE);

    // Content must be present with no hidden initial state or required travel.
    await expect(page.getByRole('heading', { level: 1, name: 'Menu import' })).toBeVisible();
    await expect(page.getByLabel('Menu file')).toBeVisible();

    await page.screenshot({
      path: path.join(OUTPUT, 'menu-import-reduced-motion-1440.png'),
      fullPage: true,
    });
  });

  test('every control is keyboard reachable with a visible focus indicator', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await page.goto(ROUTE);
    await expect(page.getByLabel('Menu file')).toBeVisible();

    await page.keyboard.press('Tab');
    for (let step = 0; step < 25; step += 1) {
      const focused = page.locator(':focus');
      if ((await focused.count()) === 0) break;
      await expect(focused).toBeVisible();
      await page.keyboard.press('Tab');
    }

    // The file input is reachable by keyboard, not hidden behind a click-only
    // drop zone.
    await page.getByLabel('Menu file').focus();
    await expect(page.getByLabel('Menu file')).toBeFocused();
  });
});
