import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * At 1024px and up the auth hero sits beside the form. When the hero is taller
 * than the viewport it must not clip its own content behind an internal
 * scroller: the page grows, the hero stays pinned beside long forms, and the
 * hero's bottom block (receipt card / setup guide) is reachable.
 */
const routes = ['/login?vertical=pharmacy', '/login/register?vertical=pharmacy'] as const;

async function heroRect(hero: Locator) {
  return hero.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
}

async function scrollTo(page: Page, y: number) {
  await page.evaluate((top) => window.scrollTo(0, top), y);
}

for (const route of routes) {
  test(`auth hero is fully reachable at 1024x520: ${route}`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'Desktop split layout only');
    await page.setViewportSize({ width: 1024, height: 520 });
    await page.goto(route);
    const hero = page.locator('.studio-auth-hero');
    await expect(hero).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    // The old layout clamped the hero to 100dvh with overflow:auto, hiding its
    // lower content inside a nested scroller. The hero must hold all of it.
    const heroBox = await hero.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(heroBox.scrollHeight).toBeLessThanOrEqual(heroBox.clientHeight + 1);

    const { scrollHeight, innerHeight } = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
    }));
    expect(scrollHeight).toBeGreaterThan(innerHeight);

    // Mid-scroll the hero still covers the viewport beside the form: no blank
    // ink panel, and the sticky behaviour beside long forms is preserved.
    await scrollTo(page, Math.floor((scrollHeight - innerHeight) / 2));
    const mid = await heroRect(hero);
    expect(mid.top).toBeLessThanOrEqual(1);
    expect(mid.bottom).toBeGreaterThanOrEqual(innerHeight - 1);

    // At the end of the page the hero's bottom edge and its last block are on
    // screen.
    await scrollTo(page, scrollHeight);
    const end = await heroRect(hero);
    expect(end.bottom).toBeLessThanOrEqual(innerHeight + 1);
    expect(end.bottom).toBeGreaterThan(0);

    const last = await hero.evaluate((el) => {
      const child = el.lastElementChild;
      if (!child) throw new Error('auth hero has no children');
      return { bottom: child.getBoundingClientRect().bottom };
    });
    expect(last.bottom).toBeLessThanOrEqual(innerHeight + 1);
    expect(last.bottom).toBeGreaterThan(0);
  });
}
