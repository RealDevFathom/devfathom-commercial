import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

// Dark-theme visual QA for the token-level contrast fix (QA UI batches 3 and 4).
// Read-only: it signs in, switches to the dark theme and captures Counter,
// Inventory, Settings and the dashboard. Nothing is submitted. Requires an
// owner/admin in a pharmacy tenant whose saved brand primary is the default ink.
const email = process.env.PHARMACY_DARK_QA_EMAIL ?? process.env.PHARMACY_IMPORT_QA_EMAIL;
const password = process.env.PHARMACY_DARK_QA_PASSWORD ?? process.env.PHARMACY_IMPORT_QA_PASSWORD;
const output = path.join('test-results', 'pharmacy-dark-mode');
const viewports = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];
const routes = [
  { name: 'dashboard', path: '/dashboard' },
  { name: 'counter', path: '/pharmacy/counter' },
  { name: 'inventory', path: '/pharmacy/inventory' },
  { name: 'settings', path: '/settings' },
] as const;

async function useDarkTheme(page: Page) {
  await page.evaluate(() => {
    localStorage.setItem('theme', 'dark');
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.style.colorScheme = 'dark';
  });
}

function luminance(rgb: string): number {
  const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map((part) => {
    const c = Number(part) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const cardColour = (page: Page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--surface-card').trim()
  );

async function hexToRgb(page: Page, hex: string): Promise<string> {
  return page.evaluate((value) => {
    const probe = document.createElement('span');
    probe.style.color = value;
    document.body.append(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    return rgb;
  }, hex);
}

test.describe('pharmacy dark-theme contrast visual QA', () => {
  test.skip(
    !email || !password,
    'Requires PHARMACY_DARK_QA_EMAIL/PASSWORD (or PHARMACY_IMPORT_QA_EMAIL/PASSWORD)'
  );

  test('Counter, Inventory, Settings and dashboard read clearly in dark', async ({ page }) => {
    test.slow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await mkdir(output, { recursive: true });

    await page.goto('/login');
    await page.getByLabel('Email').fill(email!);
    await page.locator('input[name="password"]').fill(password!);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'));

    for (const reducedMotion of ['no-preference', 'reduce'] as const) {
      await page.emulateMedia({ reducedMotion, colorScheme: 'dark' });
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        for (const route of routes) {
          await page.goto(route.path);
          await useDarkTheme(page);
          await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
          await expect(page.locator('main, [role="main"], #main-content').first()).toBeVisible();

          const name = `${route.name}-dark-${reducedMotion}-${viewport.width}`;
          await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });

          expect(
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
            ),
            `${name} must not overflow horizontally`
          ).toBe(false);
        }
      }
    }

    // Token-level assertions at desktop width, where the active navigation pill renders.
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/pharmacy/counter');
    await useDarkTheme(page);
    const card = await hexToRgb(page, await cardColour(page));

    // Inputs: the boundary must hold 3:1 against the card.
    const search = page.locator('#counter-search');
    await expect(search).toBeVisible();
    const inputBorder = await search.evaluate((node) => getComputedStyle(node).borderTopColor);
    expect(contrast(inputBorder, card), 'counter search input border').toBeGreaterThanOrEqual(3);

    // Primary button, enabled or disabled, carries a visible edge in dark.
    const takePayment = page.getByRole('button', { name: /Take payment/ });
    await expect(takePayment).toBeVisible();
    const edge = await takePayment.evaluate((node) => {
      const style = getComputedStyle(node);
      return { width: style.outlineWidth, style: style.outlineStyle, color: style.outlineColor };
    });
    expect(edge.style).toBe('solid');
    expect(edge.width).toBe('1px');
    expect(contrast(edge.color, card), 'primary edge').toBeGreaterThanOrEqual(3);
    await takePayment.screenshot({ path: path.join(output, 'counter-take-payment-dark.png') });

    // Active navigation pill stands out from the header.
    const pill = page.locator('[aria-current="page"] > span.bg-primary').first();
    await expect(pill).toBeVisible();
    const pillEdge = await pill.evaluate((node) => getComputedStyle(node).outlineColor);
    expect(contrast(pillEdge, card), 'active nav pill edge').toBeGreaterThanOrEqual(3);

    // Settings: notification toggles differ on vs off; Profile Edit and API Docs read.
    await page.goto('/settings');
    await useDarkTheme(page);
    const toggles = page.getByRole('switch');
    await expect(toggles.first()).toBeVisible();
    const tracks = await toggles.evaluateAll((nodes) =>
      nodes.map((node) => ({
        checked: node.hasAttribute('data-checked'),
        background: getComputedStyle(node).backgroundColor,
      }))
    );
    const on = tracks.find((track) => track.checked);
    const off = tracks.find((track) => !track.checked);
    if (on && off) {
      expect(contrast(on.background, off.background), 'switch on vs off').toBeGreaterThanOrEqual(3);
    }
    if (on) expect(contrast(on.background, card), 'switch on vs card').toBeGreaterThanOrEqual(3);

    for (const link of [
      page.getByRole('button', { name: 'Edit', exact: true }),
      page.getByRole('link', { name: /API Docs/ }),
    ]) {
      if (!(await link.count())) continue;
      const colour = await link.first().evaluate((node) => getComputedStyle(node).color);
      expect(contrast(colour, card), 'settings link colour').toBeGreaterThanOrEqual(4.5);
    }

    // Command palette: the search focus ring follows the rounded group, in the focus token.
    await page.keyboard.press('ControlOrMeta+k');
    const paletteInput = page.locator('[data-slot="command-input"]');
    if (await paletteInput.isVisible().catch(() => false)) {
      await paletteInput.focus();
      const group = page.locator('[data-slot="input-group"]', { has: paletteInput });
      const ring = await group.evaluate((node) => {
        const style = getComputedStyle(node);
        return { outline: style.outlineStyle, radius: style.borderTopLeftRadius };
      });
      expect(ring.outline).toBe('solid');
      expect(Number.parseFloat(ring.radius)).toBeGreaterThan(0);
      expect(await paletteInput.evaluate((node) => getComputedStyle(node).outlineStyle)).toBe(
        'none'
      );
      await page.screenshot({ path: path.join(output, 'command-palette-dark-focus.png') });
    }

    expect(errors).toEqual([]);
  });
});
