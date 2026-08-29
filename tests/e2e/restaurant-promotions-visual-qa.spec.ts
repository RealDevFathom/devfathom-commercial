import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const VIEWPORTS = [
  { name: '375-portrait', width: 375, height: 812 },
  { name: '768-tablet', width: 768, height: 1024 },
  { name: '1024-laptop', width: 1024, height: 768 },
  { name: '1440-desktop', width: 1440, height: 900 },
] as const;
const THEMES = ['light', 'dark'] as const;
const ROUTE = '/restaurant/promotions';
const OUTPUT = path.join('test-results', 'visual-qa');
const email = process.env.PROMOTIONS_QA_EMAIL;
const password = process.env.PROMOTIONS_QA_PASSWORD;

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email!);
  await page.locator('input[name="password"]').fill(password!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 });
}

async function gotoOffers(page: Page) {
  await page.goto(ROUTE);
  await expect(page.getByRole('heading', { level: 1, name: 'Offers' })).toBeVisible();
  await page.waitForLoadState('networkidle');
}

async function switchTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.evaluate((value) => {
    localStorage.setItem('theme', value);
    document.documentElement.dataset.theme = value;
    document.documentElement.style.colorScheme = value;
  }, theme);
}

test.describe('restaurant offers Studio visual QA', () => {
  test.skip(!email || !password, 'PROMOTIONS_QA_EMAIL and PROMOTIONS_QA_PASSWORD are required');

  test.beforeAll(async () => mkdir(OUTPUT, { recursive: true }));

  test('viewports, themes, dialog, and accessibility', async ({ page }) => {
    test.slow();
    await signIn(page);
    await gotoOffers(page);

    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        await switchTheme(page, theme);
        await page.setViewportSize(viewport);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
          ),
          `document overflow at ${theme} ${viewport.name}`
        ).toBe(false);
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
        await page.screenshot({
          path: path.join(OUTPUT, `restaurant-offers-${theme}-${viewport.name}.png`),
          fullPage: true,
        });
      }
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page
      .getByRole('button', { name: /Create offer/ })
      .first()
      .click();
    await expect(page.getByRole('dialog', { name: 'Create offer' })).toBeVisible();
    await expect(page.getByLabel(/Branches/)).toBeVisible();
    await expect(page.getByLabel('Products')).toHaveCount(0);
    await page.getByLabel('Target type').selectOption('ITEM');
    await expect(page.getByLabel('Products')).toBeVisible();
    await page.screenshot({ path: path.join(OUTPUT, 'restaurant-offers-editor-1440.png') });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations).toEqual([]);
  });

  test('reduced motion and keyboard focus', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signIn(page);
    await gotoOffers(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Offers' })).toBeVisible();
    await page.keyboard.press('Tab');
    for (let index = 0; index < 12; index += 1) {
      const focused = page.locator(':focus');
      if ((await focused.count()) === 0) break;
      await expect(focused).toBeVisible();
      await page.keyboard.press('Tab');
    }
  });
});
