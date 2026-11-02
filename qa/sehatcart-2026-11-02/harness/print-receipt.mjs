// Complete one sale (optionally Urdu receipt) and capture the browser print popup.
import fs from 'node:fs';
import { roleContext, capture, closeBrowser, BASE, shot, statePath } from './lib.mjs';
const lang = process.argv[2] ?? 'English';
const fmt = process.argv[3] ?? 'Thermal · 80 mm';
const name = process.argv[4] ?? 'cash-receipt-print';
const ctx = await roleContext('cashier', { viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const log = capture(page);
page.setDefaultTimeout(15000);
await page.addInitScript(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });
await page.goto(BASE + '/pharmacy/counter', { waitUntil: 'networkidle' });
await page.keyboard.press('F2');
await page.getByLabel('Scan or search').pressSequentially('panadol', { delay: 30 });
await page.waitForTimeout(1500);
await page.getByRole('button', { name: 'Paracetamol 500mg Tablets' }).click();
await page.waitForTimeout(600);
await page.getByRole('button', { name: 'Add to cart (F6)' }).click();
await page.waitForTimeout(2500);
await page.getByLabel('Cash received').fill('30');
await page.getByRole('button', { name: 'Take payment' }).click();
await page.waitForTimeout(3500);
const status = await page.evaluate(() => [...document.querySelectorAll('[role=status],[role=alert]')].map((e) => e.innerText.trim()).filter(Boolean).join(' | '));
console.log('STATUS', status.slice(0, 600));
await page.getByLabel('Language').selectOption({ label: lang }).catch((e) => console.log('lang fail', String(e).slice(0, 100)));
await page.getByLabel('Format').selectOption({ label: fmt }).catch((e) => console.log('fmt fail', String(e).slice(0, 100)));
await page.waitForTimeout(800);
const [popup] = await Promise.all([
  ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null),
  page.getByRole('button', { name: 'Print receipt' }).click(),
]);
if (popup) {
  await popup.addInitScript(() => { window.print = () => {}; });
  await popup.waitForLoadState('load').catch(() => {});
  await popup.waitForTimeout(1500);
  await popup.setViewportSize({ width: 420, height: 900 });
  const txt = await popup.evaluate(() => document.body.innerText);
  console.log('POPUP TEXT\n' + txt.slice(0, 2500));
  console.log('POPUP DIR', await popup.evaluate(() => document.documentElement.dir + ' ' + document.documentElement.lang));
  console.log('SHOT', await shot(popup, name, { fullPage: true }));
  fs.writeFileSync(`/home/user/devfathom-commercial/qa-evidence/${name}.html`, await popup.content());
} else console.log('no popup');
if (log.http.length) console.log('HTTP', JSON.stringify(log.http.map((h) => [h.status, h.url.slice(-80), h.body.slice(0, 200)])));
await ctx.storageState({ path: statePath('cashier') });
await ctx.close();
await closeBrowser();
