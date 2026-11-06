import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
await page.goto('http://qa-karahi-essentials.localhost:3000/login');
await page.locator('input[name="email"]').fill('qa-essentials-owner@example.com');
await page.locator('input[name="password"]').fill('QaRestaurant!Owner2026');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL((url) => !url.pathname.startsWith('/login'));
const result = await page.evaluate(async () => {
  const session = await (await fetch('/api/auth/session')).json();
  const response = await fetch('/api/trpc/restaurantCatalog.listProducts?input=' + encodeURIComponent(JSON.stringify({ json: {} })));
  const body = await response.json();
  const products = body?.result?.data?.json ?? [];
  return {
    slug: session?.user?.organizationSlug ?? null,
    org: session?.user?.organizationId ?? null,
    url: location.href,
    count: Array.isArray(products) ? products.length : -1,
    names: Array.isArray(products) ? products.map((item: { name?: string; organizationId?: string }) => `${item.name}|${item.organizationId}`) : [],
  };
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
