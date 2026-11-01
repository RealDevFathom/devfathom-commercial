import { expect, test } from '@playwright/test';

/**
 * At 1024px and up the auth hero sits beside the form. When the hero is taller
 * than the viewport the page itself must grow and scroll, so the hero's last
 * block (the receipt card) is reachable instead of clipped.
 */
const routes = ['/login?vertical=pharmacy', '/login/register?vertical=pharmacy'] as const;

for (const route of routes) {
  test(`auth hero scrolls into view at 1024x520: ${route}`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'Desktop split layout only');
    await page.setViewportSize({ width: 1024, height: 520 });
    await page.goto(route);
    const hero = page.locator('.studio-auth-hero');
    await expect(hero).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    const { scrollHeight, innerHeight } = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
    }));
    expect(scrollHeight).toBeGreaterThan(innerHeight);

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

    const lastChildRect = await hero.evaluate((el) => {
      const last = el.lastElementChild;
      if (!last) throw new Error('auth hero has no children');
      const r = last.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    expect(lastChildRect.bottom).toBeLessThanOrEqual(viewportHeight + 1);
    expect(lastChildRect.bottom).toBeGreaterThan(0);
  });
}
