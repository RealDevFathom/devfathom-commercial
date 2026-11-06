import { createDecipheriv, createHash, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from '@playwright/test';

const HOUSE = 'http://qa-karahi-house.localhost:3000';
const ESSENTIALS = 'http://qa-karahi-essentials.localhost:3000';
const AGENCY = 'http://devfathom.localhost:3000';
const ADMIN = 'http://admin.localhost:3000';
const HOUSE_PRODUCT = 'cmvhjueo300f51yjsrcfr7m60';
const out: Array<{ id: string; status: number | string; note: string }> = [];
function note(id: string, status: number | string, text: string) {
  out.push({ id, status, note: text.slice(0, 400) });
  console.log(status, id, text.slice(0, 160));
}
function loadEnv(path: string) {
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    let value = trimmed.slice(eq + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[trimmed.slice(0, eq)]) process.env[trimmed.slice(0, eq)] = value;
  }
}
function sql(query: string) {
  const run = spawnSync('psql', ['-h', '127.0.0.1', '-U', 'postgres', '-d', 'devfathom', '-At', '-c', query], {
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: 'postgres' },
    timeout: 15000,
  });
  if (run.status !== 0) throw new Error((run.stderr || run.stdout || 'sql').slice(0, 300));
  return run.stdout.trim();
}
function encryptionKey() {
  const raw = process.env.PLATFORM_ENCRYPTION_KEY?.trim() ?? '';
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length === 32) return decoded;
  return createHash('sha256').update(raw).digest();
}
function decryptSecret(value: string) {
  const [version, iv, tag, ciphertext] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('bad secret');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'), {
    authTagLength: 16,
  });
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
function totp(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of secret.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '')) {
    const idx = alphabet.indexOf(char);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const hmac = createHmac('sha1', Buffer.from(bytes)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const bin = ((hmac[offset]! & 0x7f) << 24) | ((hmac[offset + 1]! & 0xff) << 16) | ((hmac[offset + 2]! & 0xff) << 8) | (hmac[offset + 3]! & 0xff);
  return (bin % 1_000_000).toString().padStart(6, '0');
}
function platformTotp() {
  const cipher = sql(`SELECT set_config('app.is_platform_admin','true',true); SELECT "encryptedTotpSecret" FROM platform_users WHERE email='${process.env.PLATFORM_ADMIN_EMAIL}'`);
  const line = cipher.split('\n').filter((row) => row.startsWith('v1.')).at(-1);
  if (!line) return null;
  return totp(decryptSecret(line));
}
loadEnv('/workspace/.env.local');
loadEnv('/workspace/.env');

async function login(page: import('@playwright/test').Page, base: string, email: string, password: string) {
  await page.goto(`${base}/login`);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForTimeout(1500);
}

const browser = await chromium.launch({ headless: true });

const essentials = await (await browser.newContext()).newPage();
essentials.setDefaultTimeout(30000);
await login(essentials, ESSENTIALS, 'qa-essentials-owner@example.com', 'QaRestaurant!Owner2026');
const ess = await essentials.evaluate(async (houseProduct) => {
  async function trpc(proc: string, method: 'GET' | 'POST', json: unknown) {
    const headers: Record<string, string> = {};
    let url = `/api/trpc/${proc}`;
    if (method === 'GET') url += `?input=${encodeURIComponent(JSON.stringify({ json }))}`;
    else headers['content-type'] = 'application/json';
    const response = await fetch(url, { method, headers, body: method === 'POST' ? JSON.stringify({ json }) : undefined });
    return { status: response.status, text: (await response.text()).slice(0, 300) };
  }
  const branch = await trpc('restaurantBranches.create', 'POST', { name: 'Phase Two', code: 'PHASE2', timezone: 'Asia/Karachi', businessDayCutoff: '05:00', address: '2 DHA', shiftSignInEnforced: false });
  const loyalty = await trpc('restaurantLoyalty.configure', 'POST', { effectiveFrom: '2020-01-01T00:00:00.000Z', earnRate: '1', redemptionValue: '1' });
  const foreign = await trpc('restaurantCatalog.getProduct', 'GET', { id: houseProduct });
  const ownResponse = await fetch('/api/trpc/restaurantCatalog.listProducts?input=' + encodeURIComponent(JSON.stringify({ json: {} })));
  const ownText = await ownResponse.text();
  let ownId = '';
  try {
    const products = JSON.parse(ownText).result?.data?.json;
    if (Array.isArray(products) && products[0]?.id) ownId = products[0].id;
  } catch { /* ignore */ }
  return { branch, loyalty, foreign, ownId, url: location.href };
}, HOUSE_PRODUCT);
note('BRN-04', ess.branch.status, ess.branch.text);
note('LOY-04', ess.loyalty.status, ess.loyalty.text);
note('TNT-03-ess', ess.foreign.status, ess.foreign.text);
note('ESS-URL', essentials.url(), ess.url);
await essentials.screenshot({ path: '/workspace/qa/restaurants/evidence/essentials-cap.png' });
const essentialsProduct = ess.ownId || '';

const house = await (await browser.newContext()).newPage();
house.setDefaultTimeout(30000);
await login(house, HOUSE, 'qa-karahi-owner@example.com', 'QaRestaurant!Owner2026');
await house.goto(`${HOUSE}/restaurant/settings/branches`);
await house.waitForTimeout(800);
await house.screenshot({ path: '/workspace/qa/restaurants/evidence/brn-01-recheck.png' });
note('BRN-01', house.url(), (await house.locator('body').innerText()).slice(0, 240));
if (essentialsProduct) {
  const cross = await house.evaluate(async (id) => {
    const response = await fetch(`/api/trpc/restaurantCatalog.getProduct?input=${encodeURIComponent(JSON.stringify({ json: { id } }))}`);
    return { status: response.status, text: (await response.text()).slice(0, 240) };
  }, essentialsProduct);
  note('TNT-03-house', cross.status, cross.text);
} else note('TNT-03-house', 'skipped', 'essentials list had no product id');

await house.setViewportSize({ width: 390, height: 844 });
await house.goto(`${HOUSE}/dashboard`);
await house.waitForTimeout(500);
const overflow = await house.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
note('UX-02', overflow ? 'fail' : 'pass', `dashboard horizontal overflow at 390px: ${overflow}`);
await house.screenshot({ path: '/workspace/qa/restaurants/evidence/mobile-dashboard.png' });
await house.setViewportSize({ width: 1440, height: 900 });
await house.goto(`${HOUSE}/restaurant/notifications`);
try {
  const scan = await new AxeBuilder({ page: house }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = scan.violations.filter((item) => item.impact === 'critical' || item.impact === 'serious');
  note('A11Y-01', serious.length ? 'fail' : 'pass', serious.map((item) => `${item.impact} ${item.id} ${item.help}`).join('; ') || 'No serious or critical violations on notifications.');
  writeFileSync('/workspace/qa/restaurants/evidence/axe-notifications.json', JSON.stringify(scan.violations.map((item) => ({ id: item.id, impact: item.impact, help: item.help, nodes: item.nodes.length })), null, 2));
} catch (error) {
  note('A11Y-01', 'blocked', error instanceof Error ? error.message : String(error));
}
await house.screenshot({ path: '/workspace/qa/restaurants/evidence/a11y-notifications.png' });
const started = Date.now();
await house.goto(`${HOUSE}/restaurant/orders`);
const nav = await house.evaluate(() => {
  const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  return entry ? Math.round(entry.duration) : null;
});
note('PERF-01', Date.now() - started, `wall ${Date.now() - started}ms navigation ${nav}ms`);

const agency = await (await browser.newContext()).newPage();
agency.setDefaultTimeout(30000);
await login(agency, AGENCY, 'alex@company.com', process.env.SEED_PASSWORD || '');
const agencyApi = await agency.evaluate(async () => {
  const response = await fetch('/api/trpc/restaurantCatalog.listCategories?input=' + encodeURIComponent(JSON.stringify({ json: null })));
  return { status: response.status, text: (await response.text()).slice(0, 200), body: document.body.innerText.slice(0, 180) };
});
note('TNT-01', agencyApi.status, `${agency.url()} ${agencyApi.body} api ${agencyApi.text}`);
await agency.screenshot({ path: '/workspace/qa/restaurants/evidence/tnt-01.png' });

const wrong = await (await browser.newContext()).newPage();
wrong.setDefaultTimeout(30000);
await login(wrong, AGENCY, 'qa-karahi-owner@example.com', 'QaRestaurant!Owner2026');
const session = await wrong.evaluate(async () => {
  const json = await (await fetch('/api/auth/session')).json();
  return { slug: json?.user?.organizationSlug ?? null, url: location.href };
});
await wrong.screenshot({ path: '/workspace/qa/restaurants/evidence/tnt-host.png' });
const next = await wrong.goto(`${AGENCY}/restaurant/catalog`);
note('TNT-HOST', next?.status() ?? 0, `first ${session.url} slug ${session.slug} next ${wrong.url()}`);

const code = platformTotp();
if (!code) note('LCY-06', 'blocked', 'Platform authenticator could not be read.');
else {
  const platform = await (await browser.newContext()).newPage();
  platform.setDefaultTimeout(30000);
  await platform.goto(`${ADMIN}/platform/login`);
  await platform.locator('#platform-email').fill(process.env.PLATFORM_ADMIN_EMAIL || '');
  await platform.locator('#platform-password').fill(process.env.PLATFORM_ADMIN_PASSWORD || '');
  await platform.locator('#platform-auth-code').fill(code);
  await platform.getByRole('button', { name: 'Continue to control desk' }).click();
  await platform.waitForTimeout(2000);
  note('PLATFORM', platform.url(), platform.url());
  const essId = sql(`SELECT id FROM organizations WHERE slug='qa-karahi-essentials'`).split('\n')[0];
  const houseId = sql(`SELECT id FROM organizations WHERE slug='qa-karahi-house'`).split('\n')[0];
  const posModule = sql(`SELECT set_config('app.is_platform_admin','true',true); SELECT id FROM platform_modules WHERE key='restaurant-pos'`).split('\n').filter((row) => row.startsWith('cm')).at(-1);
  const suspend = await platform.request.post(`${ADMIN}/api/platform/control`, {
    headers: { origin: ADMIN, 'content-type': 'application/json' },
    data: { action: 'organization.transition', payload: { id: essId, status: 'SUSPENDED', reason: 'QA suspension to verify tenant sign-in stops.' } },
    timeout: 20000,
  });
  const suspended = await (await browser.newContext()).newPage();
  await login(suspended, ESSENTIALS, 'qa-essentials-owner@example.com', 'QaRestaurant!Owner2026');
  await suspended.screenshot({ path: '/workspace/qa/restaurants/evidence/lcy-06.png' });
  const resume = await platform.request.post(`${ADMIN}/api/platform/control`, {
    headers: { origin: ADMIN, 'content-type': 'application/json' },
    data: { action: 'organization.transition', payload: { id: essId, status: 'ACTIVE', reason: 'QA resume after the suspension check.' } },
    timeout: 20000,
  });
  note('LCY-06', suspend.status(), `suspend ${suspend.status()} ${(await suspend.text()).slice(0, 160)}; login ${suspended.url()}; resume ${resume.status()} ${(await resume.text()).slice(0, 120)}`);
  const disable = await platform.request.post(`${ADMIN}/api/platform/control`, {
    headers: { origin: ADMIN, 'content-type': 'application/json' },
    data: { action: 'organization.module', payload: { organizationId: houseId, moduleId: posModule, status: 'DISABLED', reason: 'QA disable POS to verify revocation.' } },
    timeout: 20000,
  });
  const posPage = await house.goto(`${HOUSE}/pos`);
  const enable = await platform.request.post(`${ADMIN}/api/platform/control`, {
    headers: { origin: ADMIN, 'content-type': 'application/json' },
    data: { action: 'organization.module', payload: { organizationId: houseId, moduleId: posModule, status: 'ENABLED', reason: 'QA re-enable POS after the revocation check.' } },
    timeout: 20000,
  });
  note('REV-01', disable.status(), `disable ${disable.status()} ${(await disable.text()).slice(0, 180)}; pos ${posPage?.status()} ${house.url()}; enable ${enable.status()}`);
  await house.screenshot({ path: '/workspace/qa/restaurants/evidence/rev-01.png' });
}

writeFileSync('/workspace/qa/restaurants/evidence/pos-rest.json', JSON.stringify(out, null, 2));
await browser.close();
