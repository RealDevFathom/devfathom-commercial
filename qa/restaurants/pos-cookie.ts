import { chromium } from '@playwright/test';

const HOUSE = 'http://qa-karahi-house.localhost:3000';
const branchId = process.argv[2];
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
await page.goto(`${HOUSE}/login`);
await page.locator('input[name="email"]').fill('qa-karahi-owner@example.com');
await page.locator('input[name="password"]').fill('QaRestaurant!Owner2026');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL((url) => !url.pathname.startsWith('/login'));
await page.evaluate((id) => {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/api/restaurant/devices/browser-enroll';
  for (const [name, value] of Object.entries({
    name: 'QA Register form',
    branchId: id,
    kind: 'POS',
    confirmation: 'confirmed',
  })) {
    const input = document.createElement('input');
    input.name = name;
    input.value = String(value);
    form.append(input);
  }
  document.body.append(form);
  form.submit();
}, branchId);
await page.waitForURL(/\/pos/, { timeout: 20000 });
await page.waitForTimeout(2500);
const cookies = (await page.context().cookies()).map((cookie) => `${cookie.name}@${cookie.domain};secure=${cookie.secure};sameSite=${cookie.sameSite}`);
const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 280);
console.log('URL', page.url());
console.log('COOKIES', cookies.join(' | ') || 'none');
console.log('TEXT', text);
await page.screenshot({ path: '/workspace/qa/restaurants/evidence/pos-form-enroll.png' });
await browser.close();
