/**
 * UX-03 (WHA-1601) visual audit capture. Untracked, disposable lane only.
 * Walks POS / KDS / pharmacy / platform screens and, for every state, captures
 * 3 viewports x 2 themes plus DOM metrics (tap targets, overflow, truncation,
 * contrast, dark-mode light-surface leaks) into UX03_OUT.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type Browser, type Page } from '@playwright/test';

import { signInAs } from './fixtures/restaurant-actor-accessibility';
import {
  installSeededTerminalCookie,
  restaurantE2eCredentials as fixture,
  terminalBrowserBaseUrl,
} from './restaurant-fixture';

const OUT = process.env.UX03_OUT!;
const PORT = Number(process.env.UX03_PORT ?? 4353);
const VIEWPORTS = [
  { name: '1024x768', width: 1024, height: 768 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '768x1024', width: 768, height: 1024 },
] as const;
const THEMES = ['light', 'dark'] as const;
const log: string[] = [];

async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((t) => {
    localStorage.setItem('theme', t);
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
}

/* Runs in the page. Colours are resolved through a canvas so oklch() works. */
function collectMetrics(theme: string) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true })!;
  const rgba = (c: string) => {
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = '#000';
    cx.fillStyle = c;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const lum = ([r, g, b]: number[]) => {
    const f = (v: number) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a: number[], b: number[]) => {
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };
  const bgOf = (el: Element | null): number[] => {
    for (let n = el; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      const v = rgba(c);
      if (c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent' && v[3] > 0.5) return v;
    }
    return theme === 'dark' ? [0, 0, 0, 1] : [255, 255, 255, 1];
  };
  const vw = innerWidth;
  const vh = innerHeight;
  const inView = (r: DOMRect) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  const visible = (el: Element) => {
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const desc = (el: Element) => {
    const h = el as HTMLElement;
    const text = (h.getAttribute('aria-label') || h.innerText || (h as HTMLInputElement).placeholder || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 50);
    const slot = el.closest('[data-slot]')?.getAttribute('data-slot') ?? '';
    return `${el.tagName.toLowerCase()}${h.id ? '#' + h.id : ''} "${text}" slot=${slot} class="${(h.getAttribute('class') ?? '').slice(0, 160)}"`;
  };
  const dedupe = <T extends { d: string }>(xs: T[], n = 40) => {
    const seen = new Set<string>();
    return xs.filter((x) => (seen.has(x.d) ? false : (seen.add(x.d), true))).slice(0, n);
  };

  const interactive = [
    ...document.querySelectorAll(
      'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=switch], [role=checkbox], [role=menuitem], [role=option]'
    ),
  ];
  const smallTargets = dedupe(
    interactive
      .filter(visible)
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => inView(r) && (r.width < 44 || r.height < 44))
      .map(({ el, r }) => ({ d: desc(el), w: Math.round(r.width), h: Math.round(r.height) }))
  );

  const all = [...document.body.querySelectorAll('*')].filter(visible);
  const truncated = dedupe(
    all
      .filter((el) => {
        const h = el as HTMLElement;
        const s = getComputedStyle(h);
        if (!h.innerText?.trim() || !inView(h.getBoundingClientRect())) return false;
        const clipsX = s.textOverflow === 'ellipsis' || (s.overflowX !== 'visible' && s.whiteSpace === 'nowrap');
        const clamp = s.webkitLineClamp !== 'none' && s.webkitLineClamp !== '';
        return (clipsX && h.scrollWidth > h.clientWidth + 1) || (clamp && h.scrollHeight > h.clientHeight + 1);
      })
      .map((el) => ({ d: desc(el), full: (el as HTMLElement).innerText.trim().slice(0, 80) }))
  );

  const lowContrast = dedupe(
    all
      .filter((el) =>
        [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim().length > 1)
      )
      .filter((el) => inView(el.getBoundingClientRect()))
      .map((el) => {
        const s = getComputedStyle(el);
        const fg = rgba(s.color);
        const bg = bgOf(el);
        const size = parseFloat(s.fontSize);
        const bold = Number(s.fontWeight) >= 700;
        const large = size >= 24 || (bold && size >= 18.66);
        const disabled = (el as HTMLElement).closest(':disabled,[aria-disabled=true]') !== null;
        return { el, r: ratio(fg, bg), need: large ? 3 : 4.5, fg: s.color, bg: getComputedStyle(el).backgroundColor, size, disabled };
      })
      .filter((x) => !x.disabled && x.r < x.need)
      .map((x) => ({ d: desc(x.el), ratio: Math.round(x.r * 100) / 100, need: x.need, fg: x.fg, px: x.size }))
  );

  const lightLeaks =
    theme === 'dark'
      ? dedupe(
          all
            .map((el) => ({ el, r: el.getBoundingClientRect(), c: getComputedStyle(el).backgroundColor }))
            .filter(({ r, c }) => inView(r) && r.width * r.height > 600 && rgba(c)[3] > 0.5 && lum(rgba(c)) > 0.6)
            .map(({ el, r, c }) => ({ d: desc(el), bg: c, w: Math.round(r.width), h: Math.round(r.height) }))
        )
      : [];

  const se = document.scrollingElement!;
  const scrollers = dedupe(
    all
      .filter((el) => {
        const s = getComputedStyle(el);
        return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 4 && inView(el.getBoundingClientRect());
      })
      .map((el) => ({ d: desc(el).slice(0, 200), hidden: el.scrollHeight - el.clientHeight })),
    15
  );
  const hOverflow = dedupe(
    all
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.right > vw + 2 && getComputedStyle(el).position !== 'fixed';
      })
      .map((el) => ({ d: desc(el).slice(0, 200), right: Math.round(el.getBoundingClientRect().right) })),
    10
  );
  return {
    vw,
    vh,
    docScrollW: se.scrollWidth,
    docScrollH: se.scrollHeight,
    pageHorizontalScroll: se.scrollWidth > vw + 1,
    smallTargets,
    truncated,
    lowContrast,
    lightLeaks,
    scrollers,
    hOverflow,
  };
}

async function shoot(page: Page, screen: string) {
  const dir = path.join(OUT, 'shots', screen);
  mkdirSync(dir, { recursive: true });
  const metrics: Record<string, unknown> = {};
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const theme of THEMES) {
      await setTheme(page, theme);
      await page.waitForTimeout(400);
      const key = `${vp.name}-${theme}`;
      await page.screenshot({ path: path.join(dir, `${key}.png`) });
      metrics[key] = await page.evaluate(collectMetrics, theme);
    }
  }
  await setTheme(page, 'light');
  await page.setViewportSize({ width: 1366, height: 768 });
  mkdirSync(path.join(OUT, 'metrics'), { recursive: true });
  writeFileSync(path.join(OUT, 'metrics', `${screen}.json`), JSON.stringify({ url: page.url(), metrics }, null, 2));
  log.push(`ok ${screen} ${page.url()}`);
}

async function step(name: string, run: () => Promise<void>) {
  console.log('step', name);
  try {
    await run();
  } catch (error) {
    log.push(`FAIL ${name}: ${(error as Error).message.split('\n')[0]}`);
  }
}

test.afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  appendFileSync(path.join(OUT, 'capture-log.txt'), log.join('\n') + '\n');
});

test('restaurant POS + KDS', async ({ page, browser }) => {
  test.setTimeout(12 * 60_000);
  await page.setViewportSize({ width: 1366, height: 768 });
  const origin = await signInAs(page, 'restaurantAdmin');
  await installSeededTerminalCookie(page.context(), fixture.pos, origin);
  await page.goto(new URL('/pos', origin).href);
  await step('pos-locked', async () => {
    await expect(page.getByRole('heading', { name: 'Terminal locked' })).toBeVisible({ timeout: 30_000 });
    await shoot(page, 'pos-01-locked');
  });
  await page.getByLabel('Operator', { exact: true }).selectOption(fixture.operator.staffProfileId);
  await page.getByLabel('Operator PIN', { exact: true }).fill(fixture.operator.pin);
  await page.getByRole('button', { name: 'Unlock terminal' }).click();
  await expect(page.getByRole('heading', { name: 'Order pad' })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await step('pos-order-pad-empty', () => shoot(page, 'pos-02-order-pad-empty'));

  await step('pos-order-open', async () => {
    const table = page.locator('fieldset input[type=checkbox]:not(:disabled)').first();
    if (await table.isVisible().catch(() => false)) {
      await table.check();
      await page.getByLabel('Covers').fill('2');
      await page.getByRole('button', { name: 'Open order' }).click();
    } else {
      // Every table is occupied: resume the newest open order instead.
      await page.getByRole('button', { name: /^#\d+ · / }).first().click();
    }
    await page.waitForTimeout(2500);
    await shoot(page, 'pos-03-order-open-empty-ticket');
  });

  await step('pos-item-editor', async () => {
    await page.getByRole('button', { name: new RegExp(fixture.menuItem.name) }).first().click();
    await page.waitForTimeout(800);
    await page.getByLabel('Quantity').fill('2');
    // "Heat" is a required modifier group on the seeded item.
    await page.getByLabel(new RegExp(fixture.modifier.name)).check();
    await shoot(page, 'pos-04-item-editor');
    await page.getByRole('button', { name: 'Add to order' }).click();
    await expect(page.getByText(`2 × ${fixture.menuItem.name}`).first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await shoot(page, 'pos-05-ticket-with-items');
    await page.getByRole('button', { name: 'Send whole order' }).click();
    await page.waitForTimeout(2000);
    await shoot(page, 'pos-05b-ticket-sent');
  });

  await step('kds', async () => {
    await captureKds(browser);
  });

  await step('pos-checkout', async () => {
    await page.reload();
    await page.waitForTimeout(2000);
    if (await page.getByRole('heading', { name: 'Terminal locked' }).isVisible().catch(() => false)) {
      await page.getByLabel('Operator', { exact: true }).selectOption(fixture.operator.staffProfileId);
      await page.getByLabel('Operator PIN', { exact: true }).fill(fixture.operator.pin);
      await page.getByRole('button', { name: 'Unlock terminal' }).click();
      await expect(page.getByRole('heading', { name: 'Order pad' })).toBeVisible({ timeout: 30_000 });
    }
    await page.getByRole('button', { name: /^#\d+ · [1-9]\d* items?/ }).first().click().catch(() => undefined);
    await page.waitForTimeout(1500);
    const served = page.getByRole('button', { name: 'Mark served' });
    for (let i = 0; i < 4 && (await served.first().isVisible().catch(() => false)); i++) {
      await served.first().click();
      await page.waitForTimeout(800);
    }
    const close = page.getByRole('button', { name: /^(Close order|Collect payment)$/ });
    await close.first().click();
    await expect(page.getByRole('dialog', { name: 'Collect payment' })).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await shoot(page, 'pos-06-checkout');
    await page.getByRole('button', { name: 'Close checkout' }).click();
  });

  await step('pos-drawer', async () => {
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Cash drawer' }).click();
    await expect(page.getByRole('dialog', { name: 'Cash drawer' })).toBeVisible();
    await page.waitForTimeout(1000);
    await shoot(page, 'pos-07-cash-drawer');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  });

  await step('pos-day-close', async () => {
    await page.getByRole('button', { name: 'Close day' }).click();
    await expect(page.getByRole('dialog', { name: 'Close business day' })).toBeVisible();
    await page.waitForTimeout(1000);
    const preview = page.getByRole('dialog').getByRole('button', { name: /preview|check|review/i }).first();
    if (await preview.isVisible().catch(() => false)) {
      await preview.click();
      await page.waitForTimeout(1500);
    }
    await shoot(page, 'pos-08-day-close');
    await page.keyboard.press('Escape');
  });
});

async function captureKds(browser: Browser) {
  const base = terminalBrowserBaseUrl(`http://127.0.0.1:${PORT}`);
  const context = await browser.newContext({ baseURL: base, viewport: { width: 1366, height: 768 } });
  await installSeededTerminalCookie(context, fixture.kds, base);
  const kds = await context.newPage();
  await kds.goto(new URL('/kds', base).href);
  await expect(kds.getByLabel('Operator PIN', { exact: true })).toBeVisible({ timeout: 30_000 });
  await step('kds-locked', () => shoot(kds, 'kds-01-locked'));
  const op = kds.getByLabel('Acting operator');
  if (await op.isVisible().catch(() => false)) await op.selectOption(fixture.operator.staffProfileId);
  await kds.getByLabel('Operator PIN', { exact: true }).fill(fixture.operator.pin);
  await kds.getByRole('button', { name: 'Verify PIN and unlock' }).click();
  await expect(kds.getByRole('heading', { name: 'Kitchen floor' })).toBeVisible({ timeout: 30_000 });
  await kds.waitForTimeout(2000);
  await shoot(kds, 'kds-02-board');
  // Advance every visible item to ready so the POS can close the order.
  for (const label of [/^Start/, /^(Mark )?ready|^Ready/i]) {
    const buttons = kds.getByRole('button', { name: label });
    const n = await buttons.count();
    for (let i = 0; i < n; i++) {
      await buttons.first().click().catch(() => undefined);
      await kds.waitForTimeout(600);
    }
  }
  await kds.waitForTimeout(1000);
  await shoot(kds, 'kds-03-board-after-bump');
  await context.close();
}

test('pharmacy counter + inventory + receiving', async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(process.env.PHARMACY_E2E_ADMIN_EMAIL!);
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.PHARMACY_E2E_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const chooser = page.getByText('Choose a workspace', { exact: true });
  if (await chooser.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await page.getByRole('button', { name: /Pharmacy/i }).first().click();
  }
  await expect(page).toHaveURL(/\/(dashboard|pharmacy)/, { timeout: 30_000 });

  await step('ph-counter', async () => {
    await page.goto('/pharmacy/counter');
    await expect(page.getByLabel('Scan or search')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    await shoot(page, 'ph-01-counter-empty');
    await page.getByLabel('Scan or search').fill('8964000111222');
    await page.getByLabel('Scan or search').press('Enter');
    await page.waitForTimeout(1500);
    await shoot(page, 'ph-02-counter-line');
    await page.getByLabel('Scan or search').fill('Fathomcillin');
    await page.waitForTimeout(1200);
    await page.getByLabel('Scan or search').press('Enter');
    await page.waitForTimeout(1500);
    await shoot(page, 'ph-03-counter-rx-block');
  });
  await step('ph-inventory', async () => {
    await page.goto('/pharmacy/inventory');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    await shoot(page, 'ph-04-inventory');
  });
  await context.close();
});

test('pharmacy receiving (purchasing fixture)', async ({ browser }) => {
  // The counter fixture is not licensed for pharmacy-procurement; the PH-PUR
  // fixture (tests/e2e/pharmacy-purchasing-seed.ts) is, with an open PO to receive.
  test.setTimeout(4 * 60_000);
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill('receiver@ph-pur.test');
  await page.getByRole('textbox', { name: 'Password' }).fill('PhPurBench!2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const chooser = page.getByText('Choose a workspace', { exact: true });
  if (await chooser.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await page.getByRole('button', { name: /PH-PUR|Purchasing/i }).first().click();
  }
  await expect(page).toHaveURL(/\/(dashboard|pharmacy)/, { timeout: 30_000 });
  await step('ph-receiving', async () => {
    await page.goto('/pharmacy/purchasing/receiving');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    await shoot(page, 'ph-05-receiving');
    const order = page.getByRole('combobox').first();
    if (await order.isVisible().catch(() => false)) {
      const values = await order.locator('option').evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value).filter(Boolean));
      if (values.length) {
        await order.selectOption(values[values.length - 1]);
        await page.waitForTimeout(1500);
        await shoot(page, 'ph-06-receiving-order-selected');
      }
    }
  });
  await context.close();
});

test('platform console', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const origin = `http://admin.localhost:${PORT}`;
  const context = await browser.newContext({ baseURL: origin, viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  const response = await page.request.post(`${origin}/api/platform/session`, {
    headers: { origin },
    data: { email: process.env.PLATFORM_ADMIN_EMAIL, password: process.env.PLATFORM_ADMIN_PASSWORD },
  });
  expect(response.status(), await response.text()).toBe(200);
  const cookie = response.headers()['set-cookie']?.match(/df_platform_session=([^;]+)/)?.[1];
  if (!cookie) throw new Error('no platform session cookie');
  await context.addCookies([{ name: 'df_platform_session', value: cookie, domain: 'admin.localhost', path: '/' }]);
  await step('pl-orgs', async () => {
    await page.goto(`${origin}/platform/organizations`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    await shoot(page, 'pl-01-org-list');
  });
  await step('pl-org-detail', async () => {
    await page.goto(`${origin}/platform/organizations/org_chai_chowk`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    await shoot(page, 'pl-02-org-detail');
  });
  await context.close();
});
