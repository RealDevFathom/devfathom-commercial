import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route } from '@playwright/test';
import path from 'node:path';

export const actorViewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
] as const;

export const evidenceDirectory = path.join('test-results', 'wha-309');

export type BrowserActor = 'superadmin' | 'agency' | 'restaurant-admin';

const actorEnvironment = {
  superadmin: {
    baseURL: process.env.WHA309_PLATFORM_BASE_URL,
    email: process.env.WHA309_SUPERADMIN_EMAIL,
    password: process.env.WHA309_SUPERADMIN_PASSWORD,
  },
  agency: {
    baseURL: process.env.WHA309_AGENCY_BASE_URL,
    email: process.env.WHA309_AGENCY_EMAIL,
    password: process.env.WHA309_AGENCY_PASSWORD,
  },
  'restaurant-admin': {
    baseURL: process.env.WHA309_RESTAURANT_BASE_URL,
    email: process.env.WHA309_RESTAURANT_ADMIN_EMAIL,
    password: process.env.WHA309_RESTAURANT_ADMIN_PASSWORD,
  },
} as const;

export function missingActorEnvironment(actor: BrowserActor) {
  const config = actorEnvironment[actor];
  return Object.entries(config)
    .filter(([, value]) => !value)
    .map(([name]) => name)
    .join(', ');
}

export async function signInActor(page: Page, actor: BrowserActor) {
  const config = actorEnvironment[actor];
  await page.goto(`${config.baseURL}/login`);
  await page.getByLabel('Email').fill(config.email!);
  await page.locator('input[name="password"]').fill(config.password!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 60_000 });
  return config.baseURL!;
}

export async function assertAccessiblePage(page: Page, heading: string | RegExp) {
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
}

export async function assertNoRawIds(page: Page) {
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/\b(?:org|branch|staff|device|session|order)_[a-z0-9_-]+\b/i);
  await expect(
    page.getByLabel(/(?:organization|branch|staff|operator|device|session) (?:id|identifier)/i)
  ).toHaveCount(0);
}

export async function captureEvidence(page: Page, actor: string, viewport: string) {
  await page.screenshot({
    path: path.join(evidenceDirectory, `${actor}-${viewport}.png`),
    fullPage: true,
  });
}

export async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

export async function mockOperatorTerminal(page: Page) {
  let queueAttempt = 0;
  await page.route('**/api/restaurant/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/terminal/establish')) {
      return json(
        route,
        {
          sessionToken: 'session-token',
          session: { id: 'session-1', state: 'LOCKED' },
          device: { id: 'device-1', branchId: 'branch-1' },
        },
        201
      );
    }
    if (pathname.endsWith('/terminal/unlock')) {
      return json(route, { session: { id: 'session-1', state: 'UNLOCKED' } });
    }
    if (pathname.endsWith('/orders/effective-menu')) {
      return json(route, {
        publicationId: 'pub-1',
        channelOpen: true,
        menu: { id: 'menu-1', name: 'Dinner service' },
        sections: [],
      });
    }
    if (pathname.endsWith('/orders/open-orders')) return json(route, { orders: [] });
    if (pathname.endsWith('/kds/queue')) {
      queueAttempt += 1;
      if (queueAttempt === 1) return json(route, { error: 'Kitchen queue unavailable.' }, 503);
      return json(route, {
        stationId: 'hot-line',
        businessDate: '2026-08-29',
        cursor: 0,
        gap: false,
        hasMore: false,
        displayMapping: {},
        tickets: [],
      });
    }
    return json(route, {});
  });
}
