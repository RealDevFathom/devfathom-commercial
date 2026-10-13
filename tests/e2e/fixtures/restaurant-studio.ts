import { expect, type Page, type TestInfo } from '@playwright/test';
import { restaurantE2eCredentials as fixture } from '../restaurant-fixture';

export async function captureRestaurantStudio(
  page: Page,
  info: TestInfo,
  prefix: string,
  widths = [375, 768, 1024, 1440]
) {
  for (const width of widths)
    for (const theme of ['light', 'dark'])
      for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: theme as 'light' | 'dark', reducedMotion });
        // Existing ThemeProvider's supported persistence/storage-event path; no palette override.
        await page.evaluate((value) => {
          localStorage.setItem('theme', value);
          window.dispatchEvent(new Event('storage'));
        }, theme);
        // POS omits app providers; its saved theme is applied by the root bootstrap on load.
        if (prefix === 'pos' && (await page.locator('html').getAttribute('data-theme')) !== theme) {
          await page.reload();
          await page
            .getByLabel('Operator', { exact: true })
            .selectOption(fixture.manager.staffProfileId);
          await page.getByLabel('Operator PIN', { exact: true }).fill(fixture.manager.pin);
          await page.getByRole('button', { name: 'Unlock terminal', exact: true }).click();
          await expect(page.getByRole('heading', { name: 'Order pad' })).toBeVisible();
        }
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true
        );
        const firstControl =
          prefix === 'pos'
            ? page.getByLabel('Channel', { exact: true })
            : prefix === 'catering'
              ? page.getByRole('button', { name: 'New order', exact: true })
              : page.getByLabel('Branch ID', { exact: true });
        await firstControl.focus();
        await page.keyboard.press('Tab');
        expect(
          await page.evaluate(() => {
            const active = document.activeElement;
            if (!(active instanceof HTMLElement) || !active.matches(':focus-visible')) return false;
            const style = getComputedStyle(active);
            return (
              (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) ||
              style.boxShadow !== 'none'
            );
          })
        ).toBe(true);
        const file = `${prefix}-${width}-${theme}-${reducedMotion}.png`;
        await page.screenshot({ path: info.outputPath(file), fullPage: true });
        await info.attach(file, { path: info.outputPath(file), contentType: 'image/png' });
        if (theme === 'dark' && reducedMotion === 'reduce' && prefix !== 'growth-empty') {
          const lowerTarget =
            prefix === 'pos'
              ? page.getByText('No active order', { exact: true })
              : prefix === 'growth-ready'
                ? page.getByRole('button', { name: 'Approve to draft', exact: true }).first()
                : page.locator('main form').last();
          await lowerTarget.scrollIntoViewIfNeeded();
          const lower = `${prefix}-lower-${width}.png`;
          await page.screenshot({ path: info.outputPath(lower), fullPage: true });
          await info.attach(lower, { path: info.outputPath(lower), contentType: 'image/png' });
        }
      }
}
