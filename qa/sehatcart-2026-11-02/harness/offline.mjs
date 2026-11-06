// Counter behaviour when the network drops mid-sale, and on a slow 3G-like link.
import { roleContext, capture, closeBrowser, BASE, shot, statePath, save } from './lib.mjs';
const out = {};
const ctx = await roleContext('cashier');
const page = await ctx.newPage();
const log = capture(page);
await page.goto(BASE + '/pharmacy/counter', { waitUntil: 'networkidle' });
// Slow network: 400 kbps, 400 ms RTT
const cdp = await ctx.newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', {
  offline: false,
  latency: 400,
  downloadThroughput: 50_000,
  uploadThroughput: 50_000,
});
let t0 = Date.now();
await page.keyboard.press('F2');
await page.getByLabel('Scan or search').pressSequentially('panadol', { delay: 30 });
await page
  .getByRole('button', { name: 'Paracetamol 500mg Tablets' })
  .waitFor({ timeout: 30000 })
  .catch(() => {});
out.slowSearchMs = Date.now() - t0;
await page.getByRole('button', { name: 'Paracetamol 500mg Tablets' }).click();
t0 = Date.now();
await page.getByRole('button', { name: 'Add to cart (F6)' }).click();
await page
  .getByText('added.')
  .first()
  .waitFor({ timeout: 30000 })
  .catch(() => {});
out.slowAddMs = Date.now() - t0;
await shot(page, 'cash-counter-slow-network');
// Offline
await cdp.send('Network.emulateNetworkConditions', {
  offline: true,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
});
await page
  .getByLabel('Cash received')
  .fill('100')
  .catch(() => {});
await page
  .getByRole('button', { name: 'Take payment' })
  .click()
  .catch((e) => (out.payClickErr = String(e).slice(0, 120)));
await page.waitForTimeout(4000);
out.offlineAlerts = await page.evaluate(() =>
  [...document.querySelectorAll('[role=alert],[role=status]')]
    .map((e) => e.innerText.trim())
    .filter(Boolean)
);
out.offlineBanner = await page.evaluate(
  () => document.body.innerText.match(/offline[^\n]{0,120}/i)?.[0] ?? null
);
await shot(page, 'cash-counter-offline-pay');
// Back online
await cdp.send('Network.emulateNetworkConditions', {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
});
await page.waitForTimeout(3000);
out.onlineAgainAlerts = await page.evaluate(() =>
  [...document.querySelectorAll('[role=alert],[role=status]')]
    .map((e) => e.innerText.trim())
    .filter(Boolean)
);
await shot(page, 'cash-counter-back-online');
out.failed = log.failed.slice(0, 8);
out.http = log.http.map((h) => [h.status, h.url.slice(-70), h.body.slice(0, 160)]);
console.log(JSON.stringify(out, null, 1).slice(0, 4000));
save('offline.json', out);
await ctx.storageState({ path: statePath('cashier') });
await ctx.close();
await closeBrowser();
