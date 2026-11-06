import { chromium } from '@playwright/test';

const HOUSE = 'http://qa-karahi-house.localhost:3000';
const branchId = 'cmvhhcldp000m1yjs2sc9obnz';
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
page.on('request', (request) => {
  if (!request.url().includes('/api/restaurant/')) return;
  const headers = request.headers();
  console.log(request.method(), request.url().slice(HOUSE.length), 'keys', Object.keys(headers).join(','), 'cookieLen', (headers.cookie ?? '').length);
});
await page.goto(`${HOUSE}/login`);
await page.locator('input[name="email"]').fill('qa-karahi-owner@example.com');
await page.locator('input[name="password"]').fill('QaRestaurant!Owner2026');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL((url) => !url.pathname.startsWith('/login'));
await page.evaluate((id) => {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/api/restaurant/devices/browser-enroll';
  for (const [name, value] of Object.entries({ name: 'QA header', branchId: id, kind: 'POS', confirmation: 'confirmed' })) {
    const input = document.createElement('input');
    input.name = name; input.value = String(value); form.append(input);
  }
  document.body.append(form); form.submit();
}, branchId);
await page.waitForURL(/\/pos/);
const viaFetch = await page.evaluate(async () => {
  const response = await fetch('/api/restaurant/orders/open', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  return { status: response.status, href: location.href, visible: document.cookie.split(';').map((part) => part.trim().split('=')[0]).filter(Boolean) };
});
console.log('fetch', JSON.stringify(viaFetch));
const viaContext = await page.context().request.post(`${HOUSE}/api/restaurant/orders/open`, {
  headers: { origin: HOUSE, 'content-type': 'application/json' },
  data: {},
});
console.log('context status', viaContext.status());
await browser.close();
