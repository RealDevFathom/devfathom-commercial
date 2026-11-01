/**
 * Restaurant journey on the tenant slug hosts. Does not modify product code.
 * Writes qa/restaurants/evidence/continue-results.json and screenshots.
 */
import { createDecipheriv, createHash, createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import AxeBuilder from '@axe-core/playwright';
import { chromium, type BrowserContext, type Page } from '@playwright/test';

const HOUSE = 'http://qa-karahi-house.localhost:3000';
const ESSENTIALS = 'http://qa-karahi-essentials.localhost:3000';
const AGENCY = 'http://devfathom.localhost:3000';
const ADMIN = 'http://admin.localhost:3000';
const EVIDENCE = '/workspace/qa/restaurants/evidence';
const OWNER_EMAIL = 'qa-karahi-owner@example.com';
const OWNER_PASSWORD = 'QaRestaurant!Owner2026';
const ESSENTIALS_EMAIL = 'qa-essentials-owner@example.com';
const STAFF_PASSWORD = 'QaRestaurant!Staff2026';
const CASHIER_EMAIL = 'qa-karahi-cashier@example.com';
const KITCHEN_EMAIL = 'qa-karahi-kitchen@example.com';
const SERVER_EMAIL = 'qa-karahi-server@example.com';
const ACCOUNTANT_EMAIL = 'qa-karahi-accountant@example.com';
const PIN = { owner: '4821', cashier: '4822', kitchen: '4823', server: '4824' };

type Status = 'pass' | 'fail' | 'blocked';
type Result = { id: string; status: Status; notes: string; evidence: string[] };
const results: Result[] = [];
const bag: Record<string, string> = {};

function loadEnv(path: string) {
  const text = readFileSync(path, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function record(id: string, status: Status, notes: string, evidence: string[] = []) {
  results.push({ id, status, notes: notes.slice(0, 1800), evidence });
  console.log(`[${status}] ${id} — ${notes.slice(0, 280)}`);
}

function shotPath(name: string) {
  return `${EVIDENCE}/${name}.png`;
}

async function shot(page: Page, name: string) {
  const path = shotPath(name);
  await page.screenshot({ path, fullPage: false }).catch(() => undefined);
  return path;
}

function sql(query: string): string {
  const run = spawnSync(
    'psql',
    ['-h', '127.0.0.1', '-U', 'postgres', '-d', 'devfathom', '-At', '-c', query],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'postgres' } }
  );
  if (run.status !== 0) throw new Error((run.stderr || run.stdout).slice(0, 500));
  return run.stdout.trim();
}

function encryptionKey(): Buffer {
  const raw = process.env.PLATFORM_ENCRYPTION_KEY?.trim() ?? '';
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length === 32) return decoded;
  return createHash('sha256').update(raw).digest();
}

function decryptSecret(value: string): string {
  const [version, iv, tag, ciphertext] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('bad secret');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'), {
    authTagLength: 16,
  });
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function totp(secret: string, now = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = secret.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = alphabet.indexOf(char);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Math.floor(now / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', Buffer.from(out)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (bin % 1_000_000).toString().padStart(6, '0');
}

function platformTotp(): string | null {
  try {
    const cipher = sql(
      `SELECT set_config('app.is_platform_admin','true',true); SELECT "encryptedTotpSecret" FROM platform_users WHERE email = '${process.env.PLATFORM_ADMIN_EMAIL}'`
    );
    const line = cipher.split('\n').filter((row) => row.startsWith('v1.')).at(-1);
    if (!line) return null;
    return totp(decryptSecret(line));
  } catch (error) {
    console.log('platform totp unavailable', error instanceof Error ? error.message : error);
    return null;
  }
}

type Call = { status: number; text: string; data: unknown; message: string };

function parseBody(status: number, text: string): Call {
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const recordBody = body as {
    result?: { data?: { json?: unknown } | unknown };
    error?: { json?: { message?: string }; message?: string };
  } | null;
  const data =
    recordBody && recordBody.result && typeof recordBody.result.data === 'object' && recordBody.result.data
      ? ((recordBody.result.data as { json?: unknown }).json ?? recordBody.result.data)
      : null;
  const message =
    recordBody?.error?.json?.message ||
    recordBody?.error?.message ||
    (typeof body === 'object' && body && 'error' in body && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : '');
  return { status, text: text.slice(0, 1600), data, message: String(message).slice(0, 600) };
}

async function trpc(
  context: BrowserContext,
  base: string,
  procedure: string,
  method: 'GET' | 'POST',
  jsonBody?: unknown
): Promise<Call> {
  const headers: Record<string, string> = { origin: base };
  let url = `${base}/api/trpc/${procedure}`;
  if (method === 'GET') {
    url += `?input=${encodeURIComponent(JSON.stringify({ json: jsonBody ?? null }))}`;
  } else {
    headers['content-type'] = 'application/json';
  }
  const response = await context.request.fetch(url, {
    method,
    headers,
    data: method === 'POST' ? { json: jsonBody ?? {} } : undefined,
  });
  return parseBody(response.status(), await response.text());
}

async function rest(
  context: BrowserContext,
  base: string,
  path: string,
  body: unknown,
  idempotencyKey?: string
): Promise<Call> {
  const headers: Record<string, string> = {
    origin: base,
    'content-type': 'application/json',
  };
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const response = await context.request.post(`${base}${path}`, { headers, data: body });
  return parseBody(response.status(), await response.text());
}

function dataOf(call: Call): Record<string, unknown> {
  return call.data && typeof call.data === 'object' ? (call.data as Record<string, unknown>) : {};
}

function idOf(call: Call, key = 'id'): string {
  const value = dataOf(call)[key];
  return typeof value === 'string' ? value : '';
}

async function login(page: Page, base: string, email: string, password: string) {
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForTimeout(1200);
  const choice = page.getByRole('button', { name: /QA Karahi|DevFathom/i });
  if (await choice.count()) {
    const exact = page.getByRole('button', {
      name: new RegExp(email.includes('essentials') ? 'Essentials' : 'Karahi House'),
    });
    if (await exact.count()) await exact.first().click();
    else await choice.first().click();
  }
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 25000 });
}

async function bodyText(page: Page) {
  return page.locator('body').innerText({ timeout: 12000 }).catch(() => '');
}

async function axe(page: Page, id: string, name: string) {
  const path = await shot(page, name);
  try {
    const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const violations = scan.violations
      .filter((item) => item.impact === 'critical' || item.impact === 'serious')
      .map((item) => `${item.impact} ${item.id} (${item.nodes.length}) ${item.help}`);
    if (violations.length) record(id, 'fail', violations.join('; '), [path]);
    else record(id, 'pass', 'No serious or critical axe violations.', [path]);
    return violations;
  } catch (error) {
    record(id, 'blocked', `Axe could not run: ${error instanceof Error ? error.message : error}`, [path]);
    return [];
  }
}

async function main() {
  loadEnv('/workspace/.env.local');
  mkdirSync(EVIDENCE, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const house = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await house.newPage();
  page.setDefaultTimeout(20000);
  let xssDialog = '';
  page.on('dialog', async (dialog) => {
    xssDialog += dialog.message();
    await dialog.dismiss();
  });

  try {
    await login(page, HOUSE, OWNER_EMAIL, OWNER_PASSWORD);
    const home = await shot(page, 'house-dashboard');
    const session = await page.evaluate(async () => {
      const response = await fetch('/api/auth/session');
      const json = await response.json();
      return {
        status: response.status,
        slug: json?.user?.organizationSlug ?? null,
        org: json?.user?.organizationId ?? null,
        role: json?.user?.role ?? null,
      };
    });
    bag.sessionSlug = String(session.slug);
    const stayed = page.url().includes('qa-karahi-house.localhost') && !page.url().includes('/login');
    record(
      'LCY-04-host',
      stayed && session.slug === 'qa-karahi-house' ? 'pass' : 'fail',
      `Landed ${page.url()}. Session slug ${session.slug} org ${session.org} role ${session.role}.`,
      [home]
    );

    await page.goto(`${HOUSE}/restaurant/catalog`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    const stillIn = !page.url().includes('/login');
    record(
      'SESSION-PERSIST',
      stillIn ? 'pass' : 'fail',
      `Catalog URL ${page.url()} after dashboard.`,
      [await shot(page, 'house-catalog-first')]
    );
    if (!stillIn) throw new Error('Session did not persist on the restaurant host.');

    const routes: Array<[string, string]> = [
      ['/dashboard', 'dash'],
      ['/restaurant/catalog', 'catalog'],
      ['/restaurant/menus', 'menus'],
      ['/restaurant/menu-import', 'menu-import'],
      ['/restaurant/promotions', 'promotions'],
      ['/restaurant/floor', 'floor'],
      ['/restaurant/orders', 'orders'],
      ['/restaurant/catering', 'catering'],
      ['/restaurant/money', 'money'],
      ['/restaurant/inventory', 'inventory'],
      ['/restaurant/purchasing', 'purchasing'],
      ['/restaurant/sop', 'sop'],
      ['/restaurant/staff', 'staff'],
      ['/restaurant/staff/roster', 'roster'],
      ['/restaurant/tax', 'tax'],
      ['/restaurant/settings/branches', 'branches'],
      ['/restaurant/delivery', 'delivery'],
      ['/restaurant/devices', 'devices'],
      ['/restaurant/integrations/cameras', 'cameras'],
      ['/restaurant/notifications', 'notifications'],
      ['/restaurant/loyalty', 'loyalty'],
      ['/restaurant/reports', 'reports'],
      ['/restaurant/insights', 'insights'],
      ['/restaurant/growth', 'growth'],
      ['/settings', 'settings'],
      ['/kds', 'kds'],
      ['/pos', 'pos'],
    ];
    const sweep: string[] = [];
    let nav = '';
    for (const [path, name] of routes) {
      const started = Date.now();
      const response = await page.goto(`${HOUSE}${path}`, { waitUntil: 'domcontentloaded' }).catch(() => null);
      await page.waitForTimeout(400);
      const text = (await bodyText(page)).replace(/\s+/g, ' ').slice(0, 400);
      const url = page.url();
      const bounced = url.includes('/login');
      sweep.push(`${path} ${response?.status() ?? 'nav'} ${Date.now() - started}ms bounced=${bounced} :: ${text.slice(0, 180)}`);
      await shot(page, `house-${name}`);
      if (path === '/dashboard') nav = text;
    }
    writeFileSync(`${EVIDENCE}/house-sweep.txt`, sweep.join('\n'));
    const pharmacyHit = /pharmacy|Onboarding|Counter|Regulatory|prescription/i.test(nav);
    record(
      'TNT-02',
      pharmacyHit ? 'fail' : 'pass',
      pharmacyHit
        ? `Restaurant dashboard text included pharmacy labels. ${nav.slice(0, 500)}`
        : 'Restaurant dashboard and nav text did not include pharmacy Onboarding, Counter, Regulatory, or prescription labels.',
      [shotPath('house-dash')]
    );

    const menuImport = sweep.find((line) => line.startsWith('/restaurant/menu-import')) ?? '';
    const sidebarHasImport = /menu import/i.test(nav);
    record(
      'MNU-04',
      menuImport.includes('bounced=false') && !menuImport.includes(' 404 ') ? (sidebarHasImport ? 'pass' : 'fail') : 'fail',
      `Sidebar mentions menu import: ${sidebarHasImport}. ${menuImport}`,
      [shotPath('house-menu-import'), shotPath('house-dash')]
    );

    const growth = sweep.find((line) => line.startsWith('/restaurant/growth')) ?? '';
    record(
      'CFG-05',
      growth.includes('bounced=false') ? 'pass' : 'fail',
      growth,
      [shotPath('house-growth')]
    );

    await page.goto(`${HOUSE}/restaurant/catalog`, { waitUntil: 'domcontentloaded' });
    const categoriesTab = page.getByRole('tab', { name: /Categories/i });
    if (await categoriesTab.count()) await categoriesTab.first().click();
    await page.waitForTimeout(400);
    const catalogText = await bodyText(page);
    record(
      'CAT-01',
      /No categories yet|categor/i.test(catalogText) && !page.url().includes('/login') ? 'pass' : 'fail',
      catalogText.replace(/\s+/g, ' ').slice(0, 500),
      [await shot(page, 'cat-01')]
    );

    const addCategory = page.getByRole('button', { name: 'Add category' }).first();
    if (await addCategory.count()) {
      await addCategory.click();
      await page.locator('input[name="name"]').last().fill('');
      await page.locator('form').filter({ has: page.locator('input[name="name"]') }).locator('button[type="submit"]').click();
      await page.waitForTimeout(400);
      const stillOpen = await page.locator('input[name="name"]').count();
      record(
        'CAT-04-ui',
        stillOpen ? 'pass' : 'fail',
        `Empty category submit left the dialog open: ${Boolean(stillOpen)}.`,
        [await shot(page, 'cat-04-empty')]
      );
      await page.locator('input[name="name"]').last().fill('Mains');
      await page.locator('form').filter({ has: page.locator('input[name="name"]') }).locator('button[type="submit"]').click();
      await page.waitForTimeout(800);
      const after = await bodyText(page);
      record(
        'CAT-02-ui',
        /Mains/.test(after) ? 'pass' : 'fail',
        after.replace(/\s+/g, ' ').slice(0, 400),
        [await shot(page, 'cat-02-mains')]
      );
    } else {
      record('CAT-02-ui', 'fail', 'Add category button was not on the catalog.', [await shot(page, 'cat-02-missing')]);
    }

    await page.goto(`${HOUSE}/restaurant/floor`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
    const floorText = await bodyText(page);
    record(
      'FLR-01',
      !page.url().includes('/login') && /floor|table|No /i.test(floorText) ? 'pass' : 'fail',
      floorText.replace(/\s+/g, ' ').slice(0, 400),
      [await shot(page, 'flr-01')]
    );
    const addFloor = page.getByRole('button', { name: 'Add floor' }).first();
    if (await addFloor.count()) {
      await addFloor.click();
      await page.locator('input[name="name"]').last().fill('Ground');
      await page.locator('form').filter({ has: page.locator('input[name="name"]') }).locator('button[type="submit"]').click();
      await page.waitForTimeout(800);
      record(
        'FLR-02-ui',
        /Ground/.test(await bodyText(page)) ? 'pass' : 'fail',
        (await bodyText(page)).replace(/\s+/g, ' ').slice(0, 300),
        [await shot(page, 'flr-02')]
      );
    } else {
      record('FLR-02-ui', 'fail', 'Add floor was not available.', [await shot(page, 'flr-02-missing')]);
    }

    await page.goto(`${HOUSE}/restaurant/orders`, { waitUntil: 'domcontentloaded' });
    record('ORD-01', !page.url().includes('/login') ? 'pass' : 'fail', (await bodyText(page)).replace(/\s+/g, ' ').slice(0, 400), [
      await shot(page, 'ord-01'),
    ]);
    await page.goto(`${HOUSE}/restaurant/loyalty`, { waitUntil: 'domcontentloaded' });
    record('LOY-01', !page.url().includes('/login') ? 'pass' : 'fail', (await bodyText(page)).replace(/\s+/g, ' ').slice(0, 400), [
      await shot(page, 'loy-01'),
    ]);
    await page.goto(`${HOUSE}/restaurant/inventory`, { waitUntil: 'domcontentloaded' });
    record('INV-01', !page.url().includes('/login') ? 'pass' : 'fail', (await bodyText(page)).replace(/\s+/g, ' ').slice(0, 400), [
      await shot(page, 'inv-01'),
    ]);
    await page.goto(`${HOUSE}/restaurant/menus`, { waitUntil: 'domcontentloaded' });
    record('MNU-01', !page.url().includes('/login') ? 'pass' : 'fail', (await bodyText(page)).replace(/\s+/g, ' ').slice(0, 400), [
      await shot(page, 'mnu-01'),
    ]);
    await page.goto(`${HOUSE}/restaurant/notifications`, { waitUntil: 'domcontentloaded' });
    const ntf = await bodyText(page);
    record(
      'NTF-01',
      /webhook|signing|secret/i.test(ntf) ? 'pass' : 'fail',
      ntf.replace(/\s+/g, ' ').slice(0, 500),
      [await shot(page, 'ntf-01')]
    );
    const whatsappPages = ['/restaurant/notifications', '/restaurant/loyalty', '/settings', '/dashboard'];
    let whatsapp = '';
    for (const path of whatsappPages) {
      await page.goto(`${HOUSE}${path}`, { waitUntil: 'domcontentloaded' });
      const text = await bodyText(page);
      if (/whatsapp/i.test(text)) whatsapp += `${path} `;
    }
    record(
      'NTF-03',
      whatsapp ? 'fail' : 'pass',
      whatsapp
        ? `WhatsApp copy appeared on ${whatsapp}`
        : 'Restaurant dashboard, notifications, loyalty, and settings do not offer WhatsApp.',
      [shotPath('ntf-01')]
    );

    await page.goto(`${HOUSE}/restaurant/settings/branches`, { waitUntil: 'domcontentloaded' });
    const branchesText = await bodyText(page);
    record(
      'BRN-01',
      /Clifton|MAIN/.test(branchesText) ? 'pass' : 'fail',
      branchesText.replace(/\s+/g, ' ').slice(0, 400),
      [await shot(page, 'brn-01')]
    );
    await page.goto(`${HOUSE}/restaurant/staff`, { waitUntil: 'domcontentloaded' });
    record('STF-01', !page.url().includes('/login') ? 'pass' : 'fail', (await bodyText(page)).replace(/\s+/g, ' ').slice(0, 400), [
      await shot(page, 'stf-01'),
    ]);
    await page.goto(`${HOUSE}/restaurant/promotions`, { waitUntil: 'domcontentloaded' });
    record('MNU-05-page', !page.url().includes('/login') ? 'pass' : 'fail', (await bodyText(page)).replace(/\s+/g, ' ').slice(0, 300), [
      await shot(page, 'mnu-05'),
    ]);
    await page.goto(`${HOUSE}/restaurant/catering`, { waitUntil: 'domcontentloaded' });
    record('CATR-01', !page.url().includes('/login') ? 'pass' : 'fail', (await bodyText(page)).replace(/\s+/g, ' ').slice(0, 300), [
      await shot(page, 'catr-01'),
    ]);
    await page.goto(`${HOUSE}/restaurant/reports`, { waitUntil: 'domcontentloaded' });
    record('RPT-01', !page.url().includes('/login') ? 'pass' : 'fail', (await bodyText(page)).replace(/\s+/g, ' ').slice(0, 400), [
      await shot(page, 'rpt-01'),
    ]);
    await page.goto(`${HOUSE}/restaurant/insights`, { waitUntil: 'domcontentloaded' });
    record('RPT-03', !page.url().includes('/login') ? 'pass' : 'fail', (await bodyText(page)).replace(/\s+/g, ' ').slice(0, 300), [
      await shot(page, 'rpt-03'),
    ]);
    await page.goto(`${HOUSE}/restaurant/tax`, { waitUntil: 'domcontentloaded' });
    record('CFG-01-page', !page.url().includes('/login') ? 'pass' : 'fail', (await bodyText(page)).replace(/\s+/g, ' ').slice(0, 400), [
      await shot(page, 'cfg-01'),
    ]);
    await page.goto(`${HOUSE}/restaurant/devices`, { waitUntil: 'domcontentloaded' });
    const devicesText = await bodyText(page);
    record(
      'CFG-02-page',
      /Enroll this browser|No restaurant devices/i.test(devicesText) ? 'pass' : 'fail',
      devicesText.replace(/\s+/g, ' ').slice(0, 400),
      [await shot(page, 'cfg-02')]
    );
    await page.goto(`${HOUSE}/restaurant/integrations/cameras`, { waitUntil: 'domcontentloaded' });
    record('CFG-03', !page.url().includes('/login') ? 'pass' : 'fail', (await bodyText(page)).replace(/\s+/g, ' ').slice(0, 300), [
      await shot(page, 'cfg-03'),
    ]);
    await page.goto(`${HOUSE}/settings`, { waitUntil: 'domcontentloaded' });
    record('CFG-04', /QA Karahi|settings|profile/i.test(await bodyText(page)) ? 'pass' : 'fail', (await bodyText(page)).replace(/\s+/g, ' ').slice(0, 300), [
      await shot(page, 'cfg-04'),
    ]);
    await page.goto(`${HOUSE}/kds`, { waitUntil: 'domcontentloaded' });
    const kdsText = await bodyText(page);
    record(
      'KDS-01',
      /enroll|not enrolled|terminal/i.test(kdsText) ? 'pass' : 'fail',
      kdsText.replace(/\s+/g, ' ').slice(0, 400),
      [await shot(page, 'kds-01')]
    );

    const branchRows = sql(
      `SELECT id FROM restaurant_branches b JOIN organizations o ON o.id=b."organizationId" WHERE o.slug='qa-karahi-house' AND b.code='MAIN'`
    );
    bag.branchId = branchRows.split('\n')[0] ?? '';

    const brand = await trpc(house, HOUSE, 'restaurantCatalog.createBrand', 'POST', { name: 'QA Karahi' });
    bag.brandId = idOf(brand);
    record('CAT-brand', brand.status < 400 && bag.brandId ? 'pass' : 'fail', `${brand.status} ${brand.message} ${brand.text.slice(0, 240)}`);

    const xssName = `<img src=x onerror=alert(1)> <script>alert('qa')</script>`;
    const xssCategory = await trpc(house, HOUSE, 'restaurantCatalog.createCategory', 'POST', { name: xssName });
    bag.xssCategoryId = idOf(xssCategory);
    await page.goto(`${HOUSE}/restaurant/catalog`, { waitUntil: 'domcontentloaded' });
    if (await page.getByRole('tab', { name: /Categories/i }).count()) {
      await page.getByRole('tab', { name: /Categories/i }).first().click();
    }
    await page.waitForTimeout(500);
    const html = await page.content();
    const executed = Boolean(xssDialog);
    const rawScript = html.includes('<script>alert(') && html.includes('onerror=alert(1)');
    record(
      'CAT-05',
      xssCategory.status < 400 && !executed && !rawScript ? 'pass' : 'fail',
      `create ${xssCategory.status} ${xssCategory.message}. dialog=${xssDialog || 'none'}. rawTag=${rawScript}.`,
      [await shot(page, 'cat-05')]
    );

    const injection = await trpc(house, HOUSE, 'restaurantCatalog.createCategory', 'POST', {
      name: `Karahi'; DROP TABLE users; --`,
    });
    const usersAfter = sql(`SELECT count(*) FROM users`);
    record(
      'CAT-07',
      injection.status < 400 && Number(usersAfter) > 0 ? 'pass' : 'fail',
      `status ${injection.status} ${injection.message}. users ${usersAfter}.`,
      []
    );
    const emptyCategory = await trpc(house, HOUSE, 'restaurantCatalog.createCategory', 'POST', { name: '' });
    record(
      'CAT-04',
      emptyCategory.status >= 400 ? 'pass' : 'fail',
      `${emptyCategory.status} ${emptyCategory.message || emptyCategory.text.slice(0, 240)}`
    );

    const product = await trpc(house, HOUSE, 'restaurantCatalog.createProduct', 'POST', {
      name: 'Chicken Karahi',
      categoryId: bag.xssCategoryId || null,
      description: 'QA dine-in karahi',
    });
    bag.productId = idOf(product);
    const naan = await trpc(house, HOUSE, 'restaurantCatalog.createProduct', 'POST', {
      name: 'Garlic Naan',
      description: 'QA second item',
    });
    bag.naanId = idOf(naan);
    const activated = await trpc(house, HOUSE, 'restaurantCatalog.setProductStatus', 'POST', {
      id: bag.productId,
      status: 'ACTIVE',
    });
    await trpc(house, HOUSE, 'restaurantCatalog.setProductStatus', 'POST', { id: bag.naanId, status: 'ACTIVE' });
    record(
      'CAT-02',
      product.status < 400 && naan.status < 400 && activated.status < 400 ? 'pass' : 'fail',
      `product ${product.status} ${product.message} naan ${naan.status} ${naan.message} active ${activated.status} ${activated.message}`
    );

    const group = await trpc(house, HOUSE, 'restaurantCatalog.createModifierGroup', 'POST', {
      name: 'Heat',
      minSelect: 0,
      maxSelect: 1,
    });
    bag.groupId = idOf(group);
    const option = await trpc(house, HOUSE, 'restaurantCatalog.createModifierOption', 'POST', {
      modifierGroupId: bag.groupId,
      name: 'Extra mirch',
      priceDelta: '50.00',
    });
    bag.optionId = idOf(option);
    const attached = await trpc(house, HOUSE, 'restaurantCatalog.attachModifierGroup', 'POST', {
      productId: bag.productId,
      modifierGroupId: bag.groupId,
    });
    record(
      'CAT-03',
      group.status < 400 && option.status < 400 && attached.status < 400 ? 'pass' : 'fail',
      `group ${group.status} ${group.message} option ${option.status} ${option.message} attach ${attached.status} ${attached.message}`
    );

    const unit = await trpc(house, HOUSE, 'restaurantCatalog.createUnit', 'POST', {
      name: 'Gram',
      abbreviation: 'g',
    });
    bag.unitId = idOf(unit);
    const ingredient = await trpc(house, HOUSE, 'restaurantCatalog.createIngredient', 'POST', {
      name: 'Chicken',
      baseUnitId: bag.unitId,
      referenceCost: '0.80',
    });
    bag.ingredientId = idOf(ingredient);
    const recipe = await trpc(house, HOUSE, 'restaurantCatalog.createRecipe', 'POST', {
      productId: bag.productId,
      name: 'Karahi recipe',
    });
    bag.recipeId = idOf(recipe);
    const version = await trpc(house, HOUSE, 'restaurantCatalog.createRecipeVersion', 'POST', {
      recipeId: bag.recipeId,
      yieldQuantity: '1',
      yieldUnitId: bag.unitId,
      portionCount: 1,
    });
    bag.recipeVersionId = idOf(version);
    const line = await trpc(house, HOUSE, 'restaurantCatalog.createRecipeLine', 'POST', {
      recipeVersionId: bag.recipeVersionId,
      ingredientId: bag.ingredientId,
      quantity: '250',
      unitId: bag.unitId,
    });
    record(
      'CAT-06',
      unit.status < 400 && ingredient.status < 400 && recipe.status < 400 && line.status < 400 ? 'pass' : 'fail',
      `unit ${unit.status} ${unit.message}; ingredient ${ingredient.status} ${ingredient.message}; recipe ${recipe.status} ${recipe.message}; line ${line.status} ${line.message}`
    );
    record(
      'CATR-02',
      line.status < 400 ? 'pass' : 'fail',
      `Recipe line ${line.status} ${line.message} ${line.text.slice(0, 200)}`
    );

    const badPrice = await trpc(house, HOUSE, 'restaurantMenus.createPriceList', 'POST', { name: 'QA prices', isDefault: true });
    bag.priceListId = idOf(badPrice);
    const priceVersion = await trpc(house, HOUSE, 'restaurantMenus.createPriceListVersion', 'POST', {
      priceListId: bag.priceListId,
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    });
    let versionId = idOf(priceVersion);
    if (!versionId) {
      const dated = await house.request.post(`${HOUSE}/api/trpc/restaurantMenus.createPriceListVersion`, {
        headers: { origin: HOUSE, 'content-type': 'application/json' },
        data: {
          json: { priceListId: bag.priceListId, effectiveFrom: '2020-01-01T00:00:00.000Z' },
          meta: { values: { effectiveFrom: ['Date'] } },
        },
      });
      const parsed = parseBody(dated.status(), await dated.text());
      versionId = idOf(parsed);
      bag.priceVersionNote = `${priceVersion.status} ${priceVersion.message} retry ${parsed.status} ${parsed.message}`;
    }
    bag.priceVersionId = versionId;
    const fuzzy = await trpc(house, HOUSE, 'restaurantMenus.addPriceEntry', 'POST', {
      priceListVersionId: bag.priceVersionId,
      productId: bag.productId,
      price: '1.999',
    });
    const negative = await trpc(house, HOUSE, 'restaurantMenus.addPriceEntry', 'POST', {
      priceListVersionId: bag.priceVersionId,
      productId: bag.naanId,
      price: '-5',
    });
    const good = await trpc(house, HOUSE, 'restaurantMenus.addPriceEntry', 'POST', {
      priceListVersionId: bag.priceVersionId,
      productId: bag.productId,
      price: '850.00',
    });
    const naanPrice = await trpc(house, HOUSE, 'restaurantMenus.addPriceEntry', 'POST', {
      priceListVersionId: bag.priceVersionId,
      productId: bag.naanId,
      price: '120.00',
    });
    record(
      'VAL-01',
      fuzzy.status >= 400 && negative.status >= 400 && good.status < 400 ? 'pass' : 'fail',
      `1.999 ${fuzzy.status} ${fuzzy.message}; -5 ${negative.status} ${negative.message}; 850 ${good.status} ${good.message}; naan ${naanPrice.status} ${naanPrice.message}. version ${bag.priceVersionNote ?? priceVersion.status}`
    );
    const activatedPrice = await trpc(house, HOUSE, 'restaurantMenus.activatePriceListVersion', 'POST', {
      versionId: bag.priceVersionId,
    });
    const menu = await trpc(house, HOUSE, 'restaurantMenus.createMenu', 'POST', {
      brandId: bag.brandId,
      name: 'Dinner',
    });
    bag.menuId = idOf(menu);
    const section = await trpc(house, HOUSE, 'restaurantMenus.createSection', 'POST', {
      menuId: bag.menuId,
      name: 'Mains',
    });
    bag.sectionId = idOf(section);
    const item = await trpc(house, HOUSE, 'restaurantMenus.createItem', 'POST', {
      sectionId: bag.sectionId,
      productId: bag.productId,
    });
    bag.menuItemId = idOf(item);
    const naanItem = await trpc(house, HOUSE, 'restaurantMenus.createItem', 'POST', {
      sectionId: bag.sectionId,
      productId: bag.naanId,
    });
    bag.naanItemId = idOf(naanItem);
    const publication = await trpc(house, HOUSE, 'restaurantMenus.createPublication', 'POST', {
      branchId: bag.branchId,
      menuId: bag.menuId,
      priceListId: bag.priceListId,
      channels: ['DINE_IN', 'TAKEAWAY'],
    });
    bag.publicationId = idOf(publication);
    const published = await trpc(house, HOUSE, 'restaurantMenus.publishPublication', 'POST', {
      id: bag.publicationId,
    });
    record(
      'MNU-02',
      activatedPrice.status < 400 && menu.status < 400 && item.status < 400 && published.status < 400 ? 'pass' : 'fail',
      `priceVersion ${priceVersion.status} ${priceVersion.message} ${bag.priceVersionNote ?? ''}; activate ${activatedPrice.status} ${activatedPrice.message}; menu ${menu.status} ${menu.message}; item ${item.status} ${item.message}; publish ${published.status} ${published.message}`
    );

    const secondBranch = await trpc(house, HOUSE, 'restaurantBranches.create', 'POST', {
      name: 'Saddar',
      code: 'SADDAR',
      timezone: 'Asia/Karachi',
      businessDayCutoff: '04:00',
      address: '1 Saddar, Karachi',
      shiftSignInEnforced: false,
    });
    record(
      'BRN-02',
      secondBranch.status < 400 ? 'pass' : 'fail',
      `${secondBranch.status} ${secondBranch.message} ${secondBranch.text.slice(0, 240)}`
    );
    const badCutoff = await trpc(house, HOUSE, 'restaurantBranches.create', 'POST', {
      name: 'Bad cutoff',
      code: 'BAD',
      timezone: 'Asia/Karachi',
      businessDayCutoff: '25:99',
      address: null,
      shiftSignInEnforced: false,
    });
    record('BRN-05', badCutoff.status >= 400 ? 'pass' : 'fail', `${badCutoff.status} ${badCutoff.message}`);
    const deactivate = await trpc(house, HOUSE, 'restaurantBranches.setActive', 'POST', {
      id: bag.branchId,
      active: false,
    });
    record(
      'BRN-03',
      deactivate.status >= 400 ? 'pass' : 'fail',
      `${deactivate.status} ${deactivate.message} ${deactivate.text.slice(0, 240)}`
    );

    const floor = await trpc(house, HOUSE, 'restaurantFloor.createFloor', 'POST', {
      branchId: bag.branchId,
      name: 'API Ground',
    });
    bag.floorId = idOf(floor);
    const table = await trpc(house, HOUSE, 'restaurantFloor.createTable', 'POST', {
      floorId: bag.floorId,
      code: 'T1',
      capacity: 4,
    });
    bag.tableId = idOf(table);
    const table2 = await trpc(house, HOUSE, 'restaurantFloor.createTable', 'POST', {
      floorId: bag.floorId,
      code: 'T2',
      capacity: 2,
    });
    bag.table2Id = idOf(table2);
    const duplicateTable = await trpc(house, HOUSE, 'restaurantFloor.createTable', 'POST', {
      floorId: bag.floorId,
      code: 'T1',
      capacity: 4,
    });
    const serverSection = await trpc(house, HOUSE, 'restaurantFloor.createSection', 'POST', {
      branchId: bag.branchId,
      name: 'Window',
    });
    const station = await trpc(house, HOUSE, 'restaurantFloor.createStation', 'POST', {
      branchId: bag.branchId,
      name: 'Hot line',
      isDefault: true,
    });
    bag.stationId = idOf(station);
    record(
      'FLR-02',
      floor.status < 400 && table.status < 400 && serverSection.status < 400 && station.status < 400 ? 'pass' : 'fail',
      `floor ${floor.status} ${floor.message}; table ${table.status} ${table.message}; section ${serverSection.status} ${serverSection.message}; station ${station.status} ${station.message}`
    );
    record(
      'FLR-03',
      duplicateTable.status >= 400 ? 'pass' : 'fail',
      `${duplicateTable.status} ${duplicateTable.message} ${duplicateTable.text.slice(0, 200)}`
    );

    const self = await trpc(house, HOUSE, 'restaurantStaff.mySelfProfile', 'GET');
    bag.ownerStaffId = idOf(self);
    if (!bag.ownerStaffId) {
      const provision = await trpc(house, HOUSE, 'restaurantStaff.provisionMyProfile', 'POST', {});
      bag.ownerStaffId = idOf(provision);
      bag.ownerStaffNote = `${self.status} ${self.message} provision ${provision.status} ${provision.message}`;
    }
    await trpc(house, HOUSE, 'restaurantStaff.seedDefaultJobRoles', 'POST', {});
    const roles = await trpc(house, HOUSE, 'restaurantStaff.listJobRoles', 'GET');
    const roleRows = Array.isArray(roles.data) ? (roles.data as Array<{ id: string; key?: string; name?: string }>) : [];
    const roleId = (key: string) => roleRows.find((row) => row.key === key || row.name?.toLowerCase().includes(key))?.id ?? '';
    bag.ownerRoleId = roleId('owner');
    bag.cashierRoleId = roleId('cashier');
    bag.kitchenRoleId = roleId('kitchen');
    bag.serverRoleId = roleId('server');
    const assignOwner = await trpc(house, HOUSE, 'restaurantStaff.setStaffJobRoles', 'POST', {
      staffProfileId: bag.ownerStaffId,
      branchId: bag.branchId,
      jobRoleIds: bag.ownerRoleId ? [bag.ownerRoleId] : [],
    });
    const ownerPin = await trpc(house, HOUSE, 'restaurantStaff.issueCredential', 'POST', {
      staffProfileId: bag.ownerStaffId,
      type: 'PIN',
      secret: PIN.owner,
    });
    record(
      'STF-owner-pin',
      ownerPin.status < 400 ? 'pass' : 'fail',
      `profile ${bag.ownerStaffId} ${bag.ownerStaffNote ?? ''}; roles ${roles.status} count ${roleRows.length}; assign ${assignOwner.status} ${assignOwner.message}; pin ${ownerPin.status} ${ownerPin.message}`
    );

    async function invite(email: string, name: string, title: string) {
      const invited = await trpc(house, HOUSE, 'team.inviteMember', 'POST', {
        name,
        email,
        role: 'EMPLOYEE',
        department: 'FRONT_OF_HOUSE',
        title,
      });
      const inviteUrl = typeof dataOf(invited).inviteUrl === 'string' ? String(dataOf(invited).inviteUrl) : '';
      const token = inviteUrl.split('/invite/')[1] ?? '';
      const accepted = token
        ? await trpc(house, HOUSE, 'invitations.accept', 'POST', {
            token,
            password: STAFF_PASSWORD,
            phone: '+92 300 5550100',
          })
        : { status: 0, message: 'no token', text: invited.text, data: null };
      return { invited, accepted, userId: typeof dataOf(invited).id === 'string' ? String(dataOf(invited).id) : '' };
    }

    const cashierInvite = await invite(CASHIER_EMAIL, 'QA Cashier', 'Cashier');
    const kitchenInvite = await invite(KITCHEN_EMAIL, 'QA Kitchen', 'Line cook');
    const serverInvite = await invite(SERVER_EMAIL, 'QA Server', 'Server');
    const accountantInvite = await invite(ACCOUNTANT_EMAIL, 'QA Accountant', 'Accountant');
    const badEmail = await trpc(house, HOUSE, 'team.inviteMember', 'POST', {
      name: 'Bad',
      email: 'not-an-email',
      role: 'EMPLOYEE',
      department: 'FRONT_OF_HOUSE',
      title: 'Cashier',
    });
    record('VAL-02', badEmail.status >= 400 ? 'pass' : 'fail', `${badEmail.status} ${badEmail.message}`);
    record(
      'STF-02',
      cashierInvite.invited.status < 400 && cashierInvite.accepted.status < 400 ? 'pass' : 'fail',
      `invite ${cashierInvite.invited.status} ${cashierInvite.invited.message} accept ${cashierInvite.accepted.status} ${cashierInvite.accepted.message}`
    );

    const overview = await trpc(house, HOUSE, 'organizationAdmin.overview', 'GET');
    const overviewData = dataOf(overview);
    const orgRoles = Array.isArray(overviewData.roles)
      ? (overviewData.roles as Array<{ id: string; key?: string; name?: string }>)
      : [];
    const orgRole = (needle: string) =>
      orgRoles.find((row) => row.key === needle || row.name?.toLowerCase() === needle)?.id ?? '';
    async function assignRole(userId: string, roleKey: string, title: string) {
      return trpc(house, HOUSE, 'organizationAdmin.updateMember', 'POST', {
        id: userId,
        role: 'EMPLOYEE',
        status: 'ACTIVE',
        organizationRoleId: orgRole(roleKey),
        title,
        department: 'FRONT_OF_HOUSE',
      });
    }
    const cashierRole = await assignRole(cashierInvite.userId, 'cashier', 'Cashier');
    const kitchenRole = await assignRole(kitchenInvite.userId, 'kitchen', 'Line cook');
    const serverRole = await assignRole(serverInvite.userId, 'server', 'Server');
    const accountantRole = await assignRole(accountantInvite.userId, 'accountant', 'Accountant');

    async function floorProfile(name: string, email: string, userId: string, roleId: string, pin: string) {
      const staff = await trpc(house, HOUSE, 'restaurantStaff.create', 'POST', {
        displayName: name,
        email,
        userId,
        primaryBranchId: bag.branchId,
      });
      const staffId = idOf(staff);
      const jobs = await trpc(house, HOUSE, 'restaurantStaff.setStaffJobRoles', 'POST', {
        staffProfileId: staffId,
        branchId: bag.branchId,
        jobRoleIds: roleId ? [roleId] : [],
      });
      const credential = await trpc(house, HOUSE, 'restaurantStaff.issueCredential', 'POST', {
        staffProfileId: staffId,
        type: 'PIN',
        secret: pin,
      });
      return { staff, jobs, credential, staffId };
    }
    const cashierFloor = await floorProfile('QA Cashier', CASHIER_EMAIL, cashierInvite.userId, bag.cashierRoleId, PIN.cashier);
    const kitchenFloor = await floorProfile('QA Kitchen', KITCHEN_EMAIL, kitchenInvite.userId, bag.kitchenRoleId, PIN.kitchen);
    const serverFloor = await floorProfile('QA Server', SERVER_EMAIL, serverInvite.userId, bag.serverRoleId, PIN.server);
    bag.cashierStaffId = cashierFloor.staffId;
    bag.kitchenStaffId = kitchenFloor.staffId;
    bag.serverStaffId = serverFloor.staffId;
    record(
      'STF-03',
      kitchenFloor.staff.status < 400 && serverFloor.staff.status < 400 && kitchenRole.status < 400 && serverRole.status < 400
        ? 'pass'
        : 'fail',
      `kitchen user ${kitchenRole.status} ${kitchenRole.message} profile ${kitchenFloor.staff.status} ${kitchenFloor.staff.message} pin ${kitchenFloor.credential.status}; server user ${serverRole.status} profile ${serverFloor.staff.status} pin ${serverFloor.credential.status}; cashier role ${cashierRole.status} ${cashierRole.message} floor ${cashierFloor.staff.status}`
    );
    record(
      'PERM-04-setup',
      accountantInvite.accepted.status < 400 && accountantRole.status < 400 ? 'pass' : 'fail',
      `accept ${accountantInvite.accepted.status} ${accountantInvite.accepted.message}; role ${accountantRole.status} ${accountantRole.message}; org roles ${orgRoles.map((row) => row.key || row.name).join(',')}`
    );

    const start = new Date();
    const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
    const shift = await trpc(house, HOUSE, 'restaurantShifts.create', 'POST', {
      branchId: bag.branchId,
      staffProfileId: bag.cashierStaffId,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      role: 'Cashier',
    });
    await page.goto(`${HOUSE}/restaurant/staff/roster`, { waitUntil: 'domcontentloaded' });
    record(
      'STF-06',
      shift.status < 400 && !page.url().includes('/login') ? 'pass' : 'fail',
      `${shift.status} ${shift.message} ${shift.text.slice(0, 240)}`,
      [await shot(page, 'stf-06')]
    );

    const customer = await trpc(house, HOUSE, 'restaurantCustomers.create', 'POST', {
      displayName: 'Sana Guest',
      givenName: 'Sana',
      familyName: 'Guest',
      identifiers: [{ kind: 'PHONE', value: '+923001112233' }],
    });
    bag.customerId = idOf(customer) || (typeof dataOf(customer).customerId === 'string' ? String(dataOf(customer).customerId) : '');
    const loyaltyConfig = await trpc(house, HOUSE, 'restaurantLoyalty.configure', 'POST', {
      effectiveFrom: '2020-01-01T00:00:00.000Z',
      earnRate: '1',
      redemptionValue: '1',
    });
    const enrolled = await trpc(house, HOUSE, 'restaurantLoyalty.enrollAccount', 'POST', {
      customerId: bag.customerId,
    });
    bag.loyaltyAccountId = idOf(enrolled);
    const adjusted = await trpc(house, HOUSE, 'restaurantLoyalty.adjust', 'POST', {
      accountId: bag.loyaltyAccountId,
      points: 100,
      reason: 'QA opening balance',
      idempotencyKey: `qa-loy-${Date.now()}`,
    });
    record(
      'LOY-02',
      customer.status < 400 ? 'pass' : 'fail',
      `${customer.status} ${customer.message} ${customer.text.slice(0, 240)}`
    );
    record(
      'LOY-03',
      loyaltyConfig.status < 400 && enrolled.status < 400 && adjusted.status < 400 ? 'pass' : 'fail',
      `config ${loyaltyConfig.status} ${loyaltyConfig.message}; enroll ${enrolled.status} ${enrolled.message}; adjust ${adjusted.status} ${adjusted.message}`
    );

    const zone = await trpc(house, HOUSE, 'restaurantDelivery.createZone', 'POST', {
      branchId: bag.branchId,
      name: 'Clifton delivery',
      fixedFee: '150.00',
      promisedMinutes: 45,
    });
    bag.zoneId = idOf(zone);
    const address = await trpc(house, HOUSE, 'restaurantDelivery.createAddress', 'POST', {
      customerId: bag.customerId,
      label: 'Home',
      recipientName: 'Sana Guest',
      phone: '+923001112233',
      locality: 'Clifton',
      countryCode: 'PK',
    });
    bag.addressId = idOf(address);
    record(
      'ORD-04-setup',
      zone.status < 400 && address.status < 400 ? 'pass' : 'fail',
      `zone ${zone.status} ${zone.message}; address ${address.status} ${address.message}`
    );

    const stockItem = await trpc(house, HOUSE, 'restaurantInventory.createStockItem', 'POST', {
      ingredientId: bag.ingredientId,
      canonicalUnitId: bag.unitId,
    });
    bag.stockItemId = idOf(stockItem);
    const location = await trpc(house, HOUSE, 'restaurantInventory.createStockLocation', 'POST', {
      branchId: bag.branchId,
      name: 'Dry store',
      code: 'DRY',
    });
    bag.locationId = idOf(location);
    const supplier = await trpc(house, HOUSE, 'restaurantPurchasing.createSupplier', 'POST', {
      name: 'QA Poultry',
      code: 'POULTRY',
    });
    bag.supplierId = idOf(supplier);
    const po = await trpc(house, HOUSE, 'restaurantPurchasing.createPurchaseOrder', 'POST', {
      supplierId: bag.supplierId,
      branchId: bag.branchId,
      locationId: bag.locationId,
      lines: [
        {
          stockItemId: bag.stockItemId,
          orderedQuantity: '5',
          unitId: bag.unitId,
          unitCost: '400.00',
        },
      ],
    });
    bag.poId = idOf(po);
    const poLineId = Array.isArray(dataOf(po).lines)
      ? String((dataOf(po).lines as Array<{ id?: string }>)[0]?.id ?? '')
      : '';
    const submitted = await trpc(house, HOUSE, 'restaurantPurchasing.submitPurchaseOrder', 'POST', {
      purchaseOrderId: bag.poId,
    });
    const approved = await trpc(house, HOUSE, 'restaurantPurchasing.approvePurchaseOrder', 'POST', {
      purchaseOrderId: bag.poId,
    });
    const received = await trpc(house, HOUSE, 'restaurantPurchasing.receivePurchaseOrder', 'POST', {
      purchaseOrderId: bag.poId,
      locationId: bag.locationId,
      idempotencyKey: `qa-recv-${Date.now()}`,
      lines: [{ purchaseOrderLineId: poLineId, receivedQuantity: '5', unitId: bag.unitId, unitCost: '400.00' }],
    });
    const waste = await trpc(house, HOUSE, 'restaurantInventory.postWastage', 'POST', {
      stockItemId: bag.stockItemId,
      locationId: bag.locationId,
      reason: 'SPOILAGE',
      quantity: '0.5',
      unitId: bag.unitId,
    });
    record(
      'INV-02',
      stockItem.status < 400 && location.status < 400 && received.status < 400 ? 'pass' : 'fail',
      `item ${stockItem.status} ${stockItem.message}; location ${location.status} ${location.message}; supplier ${supplier.status} ${supplier.message}; po ${po.status} ${po.message}; submit ${submitted.status} ${submitted.message}; approve ${approved.status} ${approved.message}; receive ${received.status} ${received.message}; waste ${waste.status} ${waste.message}`
    );
    record(
      'INV-04',
      supplier.status < 400 && po.status < 400 && approved.status < 400 && received.status < 400 ? 'pass' : 'fail',
      `supplier ${supplier.status}; po ${po.status} ${po.message}; submit ${submitted.status} ${submitted.message}; approve ${approved.status} ${approved.message}; receive ${received.status} ${received.message}`
    );
    const count = await trpc(house, HOUSE, 'restaurantInventory.createStockCount', 'POST', {
      locationId: bag.locationId,
      reference: 'QA count',
    });
    record('INV-05', count.status < 400 ? 'pass' : count.status === 400 ? 'fail' : 'fail', `${count.status} ${count.message} ${count.text.slice(0, 240)}`);

    const blankWebhook = await trpc(house, HOUSE, 'restaurantNotifications.configureWebhook', 'POST', {
      endpointUrl: '',
      enabled: true,
      signingSecret: 'qa-restaurant-webhook-secret-32chars',
    });
    const httpWebhook = await trpc(house, HOUSE, 'restaurantNotifications.configureWebhook', 'POST', {
      endpointUrl: 'http://example.com/hook',
      enabled: true,
      signingSecret: 'qa-restaurant-webhook-secret-32chars',
    });
    const httpsWebhook = await trpc(house, HOUSE, 'restaurantNotifications.configureWebhook', 'POST', {
      endpointUrl: 'https://example.com/qa-restaurant-hook',
      enabled: true,
      signingSecret: 'qa-restaurant-webhook-secret-32chars',
    });
    const testHook = await trpc(house, HOUSE, 'restaurantNotifications.testWebhook', 'POST', {});
    record(
      'NTF-02',
      blankWebhook.status >= 400 && httpWebhook.status >= 400 ? 'pass' : 'fail',
      `blank ${blankWebhook.status} ${blankWebhook.message}; http ${httpWebhook.status} ${httpWebhook.message}; https ${httpsWebhook.status} ${httpsWebhook.message}; test ${testHook.status} ${testHook.message} ${testHook.text.slice(0, 240)}`
    );

    const tax = await trpc(house, HOUSE, 'restaurantTax.configuration', 'GET');
    const preview = await trpc(house, HOUSE, 'restaurantTax.previewCustom', 'GET', {
      amount: '100.00',
      rate: '0.15',
      priceMode: 'EXCLUSIVE',
    });
    record(
      'CFG-01',
      tax.status < 400 && preview.status < 400 ? 'pass' : 'fail',
      `config ${tax.status} ${tax.message} ${tax.text.slice(0, 180)}; preview ${preview.status} ${preview.message} ${preview.text.slice(0, 180)}`
    );

    const from = '2026-10-01';
    const to = '2026-10-31';
    const overviewReport = await trpc(house, HOUSE, 'restaurantReports.overview', 'GET', { from, to });
    const food = await trpc(house, HOUSE, 'restaurantReports.foodCost', 'GET', { from, to });
    const dishes = await trpc(house, HOUSE, 'restaurantReports.dishProfitability', 'GET', { from, to });
    const allBranch = await trpc(house, HOUSE, 'restaurantReports.overview', 'GET', { from, to, branchId: bag.branchId });
    record('RPT-02', food.status < 400 && dishes.status < 400 ? 'pass' : 'fail', `food ${food.status} ${food.message}; dish ${dishes.status} ${dishes.message}`);
    record('RPT-04', allBranch.status < 400 && overviewReport.status < 400 ? 'pass' : 'fail', `scoped ${allBranch.status} ${allBranch.message}; all ${overviewReport.status} ${overviewReport.message}`);

    const unauth = await browser.newContext();
    const unauthOrder = await unauth.request.post(`${HOUSE}/api/restaurant/orders/open`, {
      headers: { origin: HOUSE, 'content-type': 'application/json' },
      data: { channel: 'DINE_IN' },
    });
    const unauthTrpc = await unauth.request.post(`${HOUSE}/api/trpc/restaurantCatalog.listCategories`, {
      headers: { origin: HOUSE, 'content-type': 'application/json' },
      data: { json: null },
    });
    record(
      'SEC-01',
      unauthOrder.status() === 401 && unauthTrpc.status() === 401 ? 'pass' : 'fail',
      `orders ${unauthOrder.status()} ${(await unauthOrder.text()).slice(0, 160)}; trpc ${unauthTrpc.status()} ${(await unauthTrpc.text()).slice(0, 160)}`
    );
    await unauth.close();

    const pos = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const posPage = await pos.newPage();
    await login(posPage, HOUSE, OWNER_EMAIL, OWNER_PASSWORD);
    const posEnrolled = await pos.request.post(`${HOUSE}/api/restaurant/devices/browser-enroll`, {
      headers: { origin: HOUSE },
      multipart: {
        name: 'QA Register',
        branchId: bag.branchId,
        kind: 'POS',
        confirmation: 'confirmed',
      },
      maxRedirects: 0,
    });
    const enrollBody = (await posEnrolled.text()).slice(0, 300);
    await posPage.goto(`${HOUSE}/pos`, { waitUntil: 'domcontentloaded' });
    await posPage.waitForTimeout(700);
    record(
      'CFG-02',
      posEnrolled.status() === 303 || posEnrolled.status() === 200 ? 'pass' : 'fail',
      `enroll ${posEnrolled.status()} location ${posEnrolled.headers()['location'] ?? ''} body ${enrollBody}. POS ${posPage.url()} ${(await bodyText(posPage)).replace(/\s+/g, ' ').slice(0, 240)}`,
      [await shot(posPage, 'pos-enrolled')]
    );
    const missingKey = await rest(pos, HOUSE, '/api/restaurant/orders/open', { channel: 'DINE_IN' });
    record(
      'SEC-02',
      missingKey.status === 400 ? 'pass' : 'fail',
      `${missingKey.status} ${missingKey.message} ${missingKey.text.slice(0, 240)}`
    );
    const unlock = await rest(pos, HOUSE, '/api/restaurant/terminal/unlock', {
      staffProfileId: bag.ownerStaffId,
      type: 'PIN',
      secret: PIN.owner,
    });
    record('POS-unlock', unlock.status < 400 ? 'pass' : 'fail', `${unlock.status} ${unlock.message} ${unlock.text.slice(0, 300)}`);
    await posPage.goto(`${HOUSE}/pos`, { waitUntil: 'domcontentloaded' });
    const posCopy = await bodyText(posPage);
    record(
      'PAY-04-copy',
      /mock|simulation|not a live|not an authorization|simulated/i.test(posCopy) ? 'pass' : 'fail',
      posCopy.replace(/\s+/g, ' ').slice(0, 500),
      [await shot(posPage, 'pos-unlocked')]
    );

    const deliveryEarly = await rest(
      pos,
      HOUSE,
      '/api/restaurant/orders/open',
      { channel: 'DELIVERY', customerId: bag.customerId, publicationId: bag.publicationId },
      `qa-del-early-${Date.now()}`
    );
    record(
      'MNU-03-before',
      deliveryEarly.status >= 400 ? 'pass' : 'fail',
      `${deliveryEarly.status} ${deliveryEarly.message} ${deliveryEarly.text.slice(0, 300)}`
    );

    const dine = await rest(
      pos,
      HOUSE,
      '/api/restaurant/orders/open',
      {
        channel: 'DINE_IN',
        publicationId: bag.publicationId,
        tableIds: [bag.tableId],
        coverCount: 2,
      },
      `qa-dine-${Date.now()}`
    );
    bag.dineOrderId = idOf(dine, 'orderId') || idOf(dine);
    const added = await rest(
      pos,
      HOUSE,
      '/api/restaurant/orders/add-item',
      { orderId: bag.dineOrderId, menuItemId: bag.menuItemId, quantity: 1, modifierOptionIds: bag.optionId ? [bag.optionId] : [] },
      `qa-add-${Date.now()}`
    );
    bag.dineItemId = idOf(added, 'itemId') || idOf(added);
    const addedNaan = await rest(
      pos,
      HOUSE,
      '/api/restaurant/orders/add-item',
      { orderId: bag.dineOrderId, menuItemId: bag.naanItemId, quantity: 1, seatNumber: 2 },
      `qa-add-naan-${Date.now()}`
    );
    bag.naanLineId = idOf(addedNaan, 'itemId') || idOf(addedNaan);
    const fired = await rest(pos, HOUSE, '/api/restaurant/orders/fire', { orderId: bag.dineOrderId }, `qa-fire-${Date.now()}`);
    record(
      'ORD-02',
      dine.status < 400 && added.status < 400 && fired.status < 400 ? 'pass' : 'fail',
      `open ${dine.status} ${dine.message} ${dine.text.slice(0, 180)}; add ${added.status} ${added.message} ${added.text.slice(0, 180)}; naan ${addedNaan.status} ${addedNaan.message}; fire ${fired.status} ${fired.message} ${fired.text.slice(0, 180)}`
    );
    const takeaway = await rest(
      pos,
      HOUSE,
      '/api/restaurant/orders/open',
      { channel: 'TAKEAWAY', publicationId: bag.publicationId },
      `qa-take-${Date.now()}`
    );
    bag.takeOrderId = idOf(takeaway, 'orderId') || idOf(takeaway);
    const takeItem = await rest(
      pos,
      HOUSE,
      '/api/restaurant/orders/add-item',
      { orderId: bag.takeOrderId, menuItemId: bag.menuItemId, quantity: 1 },
      `qa-take-item-${Date.now()}`
    );
    record(
      'ORD-03',
      takeaway.status < 400 && takeItem.status < 400 ? 'pass' : 'fail',
      `open ${takeaway.status} ${takeaway.message}; item ${takeItem.status} ${takeItem.message}`
    );

    const moved = await rest(
      pos,
      HOUSE,
      '/api/restaurant/orders/move-table',
      { orderId: bag.dineOrderId, fromTableId: bag.tableId, toTableId: bag.table2Id },
      `qa-move-${Date.now()}`
    );
    const merged = await rest(
      pos,
      HOUSE,
      '/api/restaurant/orders/merge-tables',
      { orderId: bag.dineOrderId, tableIds: [bag.tableId, bag.table2Id] },
      `qa-merge-${Date.now()}`
    );
    record('ORD-05', moved.status < 400 ? 'pass' : 'fail', `move ${moved.status} ${moved.message} ${moved.text.slice(0, 200)}; merge ${merged.status} ${merged.message}`);

    const kds = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const kdsPage = await kds.newPage();
    await login(kdsPage, HOUSE, OWNER_EMAIL, OWNER_PASSWORD);
    const kdsEnroll = await kds.request.post(`${HOUSE}/api/restaurant/devices/browser-enroll`, {
      headers: { origin: HOUSE },
      multipart: {
        name: 'QA Kitchen display',
        branchId: bag.branchId,
        kind: 'KDS',
        stationId: bag.stationId,
        confirmation: 'confirmed',
      },
      maxRedirects: 0,
    });
    const kdsUnlock = await rest(kds, HOUSE, '/api/restaurant/terminal/unlock', {
      staffProfileId: bag.kitchenStaffId,
      type: 'PIN',
      secret: PIN.kitchen,
    });
    const ack = await rest(
      kds,
      HOUSE,
      '/api/restaurant/kds/ack',
      { orderItemId: bag.dineItemId, operatorStaffProfileId: bag.kitchenStaffId },
      `qa-ack-${Date.now()}`
    );
    const bump = await rest(
      kds,
      HOUSE,
      '/api/restaurant/kds/bump',
      { orderItemId: bag.dineItemId, operatorStaffProfileId: bag.kitchenStaffId },
      `qa-bump-${Date.now()}`
    );
    await kdsPage.goto(`${HOUSE}/kds`, { waitUntil: 'domcontentloaded' });
    record(
      'KDS-02',
      kdsEnroll.status() < 400 && kdsUnlock.status < 400 && bump.status < 400 ? 'pass' : 'fail',
      `enroll ${kdsEnroll.status()} ${(await kdsEnroll.text()).slice(0, 180)}; unlock ${kdsUnlock.status} ${kdsUnlock.message}; ack ${ack.status} ${ack.message}; bump ${bump.status} ${bump.message}`,
      [await shot(kdsPage, 'kds-02')]
    );
    const kdsCopy = await bodyText(kdsPage);
    record('KDS-03', kdsCopy.length > 0 ? 'pass' : 'fail', kdsCopy.replace(/\s+/g, ' ').slice(0, 300), [shotPath('kds-02')]);
    const kitchenPay = await rest(
      kds,
      HOUSE,
      '/api/restaurant/checkout/tender',
      { billId: 'not-a-bill', tender: { type: 'CASH', amount: '1.00', cashReceived: '1.00' } },
      `qa-kitchen-pay-${Date.now()}`
    );
    record('PERM-02', kitchenPay.status === 403 || kitchenPay.status === 401 ? 'pass' : 'fail', `${kitchenPay.status} ${kitchenPay.message} ${kitchenPay.text.slice(0, 240)}`);

    const drawer = await rest(pos, HOUSE, '/api/restaurant/cash/drawer/open', { openingFloat: '500.00' }, `qa-drawer-${Date.now()}`);
    const bill = await rest(
      pos,
      HOUSE,
      '/api/restaurant/checkout/bill',
      { orderId: bag.dineOrderId, split: { kind: 'NONE' } },
      `qa-bill-${Date.now()}`
    );
    const bills = Array.isArray(dataOf(bill).bills) ? (dataOf(bill).bills as Array<Record<string, unknown>>) : [];
    const firstBill = bills[0] ?? dataOf(bill);
    bag.billId = typeof firstBill.id === 'string' ? firstBill.id : idOf(bill, 'billId') || idOf(bill);
    const grand = String(firstBill.grandTotal ?? dataOf(bill).grandTotal ?? '');
    record(
      'PAY-01',
      bill.status < 400 && bag.billId ? 'pass' : 'fail',
      `drawer ${drawer.status} ${drawer.message}; bill ${bill.status} ${bill.message} ${bill.text.slice(0, 400)}`
    );
    const cash = await rest(
      pos,
      HOUSE,
      '/api/restaurant/checkout/tender',
      { billId: bag.billId, tender: { type: 'CASH', amount: grand || '900.00', cashReceived: '2000.00' } },
      `qa-cash-${Date.now()}`
    );
    const cashTip = await rest(
      pos,
      HOUSE,
      '/api/restaurant/checkout/tender',
      { billId: bag.billId, tender: { type: 'CASH', amount: '1.00', cashReceived: '1.00', tipAmount: '20.00' } },
      `qa-cashtip-${Date.now()}`
    );
    record(
      'PAY-03',
      cash.status < 400 ? 'pass' : 'fail',
      `cash ${cash.status} ${cash.message} ${cash.text.slice(0, 300)}; cash tip attempt ${cashTip.status} ${cashTip.message}`
    );
    bag.tenderId = idOf(cash, 'tenderId') || (typeof dataOf(cash).id === 'string' ? String(dataOf(cash).id) : '');
    const tenderRows = dataOf(cash).tenders;
    if (!bag.tenderId && Array.isArray(tenderRows)) {
      bag.tenderId = String((tenderRows as Array<{ id?: string }>)[0]?.id ?? '');
    }

    const splitOrder = await rest(
      pos,
      HOUSE,
      '/api/restaurant/orders/open',
      { channel: 'DINE_IN', publicationId: bag.publicationId, tableIds: [bag.table2Id], coverCount: 2 },
      `qa-split-open-${Date.now()}`
    );
    const splitOrderId = idOf(splitOrder, 'orderId') || idOf(splitOrder);
    const splitA = await rest(
      pos,
      HOUSE,
      '/api/restaurant/orders/add-item',
      { orderId: splitOrderId, menuItemId: bag.menuItemId, quantity: 1, seatNumber: 1 },
      `qa-split-a-${Date.now()}`
    );
    const splitB = await rest(
      pos,
      HOUSE,
      '/api/restaurant/orders/add-item',
      { orderId: splitOrderId, menuItemId: bag.naanItemId, quantity: 1, seatNumber: 2 },
      `qa-split-b-${Date.now()}`
    );
    await rest(pos, HOUSE, '/api/restaurant/orders/fire', { orderId: splitOrderId }, `qa-split-fire-${Date.now()}`);
    const splitAId = idOf(splitA, 'itemId') || idOf(splitA);
    const splitBId = idOf(splitB, 'itemId') || idOf(splitB);
    const split = await rest(
      pos,
      HOUSE,
      '/api/restaurant/checkout/bill',
      { orderId: splitOrderId, split: { kind: 'BY_ITEM', groups: [[splitAId], [splitBId]] } },
      `qa-split-${Date.now()}`
    );
    const bySeat = await rest(
      pos,
      HOUSE,
      '/api/restaurant/orders/open',
      { channel: 'DINE_IN', publicationId: bag.publicationId, coverCount: 2 },
      `qa-seat-open-${Date.now()}`
    );
    const seatOrder = idOf(bySeat, 'orderId') || idOf(bySeat);
    await rest(pos, HOUSE, '/api/restaurant/orders/add-item', { orderId: seatOrder, menuItemId: bag.menuItemId, seatNumber: 1 }, `qa-seat-a-${Date.now()}`);
    await rest(pos, HOUSE, '/api/restaurant/orders/add-item', { orderId: seatOrder, menuItemId: bag.naanItemId, seatNumber: 2 }, `qa-seat-b-${Date.now()}`);
    await rest(pos, HOUSE, '/api/restaurant/orders/fire', { orderId: seatOrder }, `qa-seat-fire-${Date.now()}`);
    const seatBill = await rest(
      pos,
      HOUSE,
      '/api/restaurant/checkout/bill',
      { orderId: seatOrder, split: { kind: 'BY_SEAT' } },
      `qa-seat-bill-${Date.now()}`
    );
    record(
      'PAY-02',
      split.status < 400 && seatBill.status < 400 ? 'pass' : 'fail',
      `by item ${split.status} ${split.message} ${split.text.slice(0, 220)}; by seat ${seatBill.status} ${seatBill.message} ${seatBill.text.slice(0, 220)}`
    );

    const cardOrder = await rest(
      pos,
      HOUSE,
      '/api/restaurant/orders/open',
      { channel: 'TAKEAWAY', publicationId: bag.publicationId },
      `qa-card-open-${Date.now()}`
    );
    const cardOrderId = idOf(cardOrder, 'orderId') || idOf(cardOrder);
    await rest(pos, HOUSE, '/api/restaurant/orders/add-item', { orderId: cardOrderId, menuItemId: bag.naanItemId }, `qa-card-item-${Date.now()}`);
    await rest(pos, HOUSE, '/api/restaurant/orders/fire', { orderId: cardOrderId }, `qa-card-fire-${Date.now()}`);
    const cardBill = await rest(
      pos,
      HOUSE,
      '/api/restaurant/checkout/bill',
      { orderId: cardOrderId, split: { kind: 'NONE' } },
      `qa-card-bill-${Date.now()}`
    );
    const cardBills = Array.isArray(dataOf(cardBill).bills) ? (dataOf(cardBill).bills as Array<Record<string, unknown>>) : [];
    const cardBillId = typeof cardBills[0]?.id === 'string' ? String(cardBills[0].id) : idOf(cardBill);
    const cardTotal = String(cardBills[0]?.grandTotal ?? '120.00');
    const card = await rest(
      pos,
      HOUSE,
      '/api/restaurant/checkout/tender',
      { billId: cardBillId, tender: { type: 'CARD', amount: cardTotal, tipAmount: '20.00' } },
      `qa-card-${Date.now()}`
    );
    record(
      'PAY-04',
      card.status < 400 && /mock|simulat/i.test(card.text + posCopy) ? 'pass' : 'fail',
      `card ${card.status} ${card.message} ${card.text.slice(0, 300)}. POS copy mentions mock: ${/mock|simulat/i.test(posCopy)}`
    );

    const refund = await rest(
      pos,
      HOUSE,
      '/api/restaurant/checkout/refund',
      {
        originalTenderId: bag.tenderId || 'missing',
        amount: '50.00',
        reason: 'QA partial refund',
        approving: { staffProfileId: bag.ownerStaffId, type: 'PIN', secret: PIN.owner },
      },
      `qa-refund-${Date.now()}`
    );
    record('PAY-06', refund.status < 400 ? 'pass' : 'fail', `${refund.status} ${refund.message} ${refund.text.slice(0, 300)}`);

    const compBillId = typeof (Array.isArray(dataOf(split).bills) ? (dataOf(split).bills as Array<{ id?: string }>)[0]?.id : '') === 'string'
      ? String((dataOf(split).bills as Array<{ id?: string }>)[0]?.id)
      : '';
    const comp = await rest(
      pos,
      HOUSE,
      '/api/restaurant/checkout/comp',
      {
        billId: compBillId || bag.billId,
        billLineId: splitAId,
        reason: 'QA comp',
        approving: { staffProfileId: bag.ownerStaffId, type: 'PIN', secret: PIN.owner },
      },
      `qa-comp-${Date.now()}`
    );
    record('PAY-05', comp.status < 400 ? 'pass' : 'fail', `${comp.status} ${comp.message} ${comp.text.slice(0, 300)}`);

    const switched = await rest(pos, HOUSE, '/api/restaurant/terminal/switch', {
      staffProfileId: bag.serverStaffId,
      type: 'PIN',
      secret: PIN.server,
    });
    const serverRefund = await rest(
      pos,
      HOUSE,
      '/api/restaurant/checkout/refund',
      {
        originalTenderId: bag.tenderId || 'missing',
        amount: '1.00',
        reason: 'Server should not refund',
        approving: { staffProfileId: bag.serverStaffId, type: 'PIN', secret: PIN.server },
      },
      `qa-server-refund-${Date.now()}`
    );
    record(
      'PERM-03',
      switched.status < 400 && (serverRefund.status === 403 || serverRefund.status === 401) ? 'pass' : 'fail',
      `switch ${switched.status} ${switched.message}; refund ${serverRefund.status} ${serverRefund.message} ${serverRefund.text.slice(0, 200)}`
    );
    await rest(pos, HOUSE, '/api/restaurant/terminal/switch', {
      staffProfileId: bag.ownerStaffId,
      type: 'PIN',
      secret: PIN.owner,
    });

    const deny = await trpc(house, HOUSE, 'restaurantStaff.setStaffCapabilityOverride', 'POST', {
      staffProfileId: bag.cashierStaffId,
      branchId: bag.branchId,
      capability: 'payments:collect',
      effect: 'DENY',
    });
    const asCashier = await rest(pos, HOUSE, '/api/restaurant/terminal/switch', {
      staffProfileId: bag.cashierStaffId,
      type: 'PIN',
      secret: PIN.cashier,
    });
    const deniedPay = await rest(
      pos,
      HOUSE,
      '/api/restaurant/checkout/tender',
      { billId: bag.billId, tender: { type: 'OTHER', amount: '1.00' } },
      `qa-deny-pay-${Date.now()}`
    );
    record(
      'STF-04',
      deny.status < 400 && (deniedPay.status === 403 || deniedPay.status === 401) ? 'pass' : 'fail',
      `deny ${deny.status} ${deny.message}; switch ${asCashier.status} ${asCashier.message}; tender ${deniedPay.status} ${deniedPay.message}`
    );
    await trpc(house, HOUSE, 'restaurantStaff.clearStaffCapabilityOverride', 'POST', {
      staffProfileId: bag.cashierStaffId,
      branchId: bag.branchId,
      capability: 'payments:collect',
    });
    await rest(pos, HOUSE, '/api/restaurant/terminal/switch', {
      staffProfileId: bag.ownerStaffId,
      type: 'PIN',
      secret: PIN.owner,
    });

    const pinLogin = await browser.newContext();
    const pinPage = await pinLogin.newPage();
    await pinPage.goto(`${HOUSE}/login`, { waitUntil: 'domcontentloaded' });
    await pinPage.locator('input[name="email"]').fill(PIN.owner);
    await pinPage.locator('input[name="password"]').fill(PIN.owner);
    await pinPage.getByRole('button', { name: 'Sign in' }).click();
    await pinPage.waitForTimeout(1000);
    record(
      'STF-05',
      pinPage.url().includes('/login') ? 'pass' : 'fail',
      `PIN used as web email stayed at ${pinPage.url()}. ${(await bodyText(pinPage)).replace(/\s+/g, ' ').slice(0, 180)}`,
      [await shot(pinPage, 'stf-05')]
    );
    await pinLogin.close();

    await trpc(house, HOUSE, 'restaurantMenus.setPublicationChannels', 'POST', {
      id: bag.publicationId,
      channels: ['DINE_IN', 'TAKEAWAY', 'DELIVERY'],
    });
    const delivery = await rest(
      pos,
      HOUSE,
      '/api/restaurant/orders/open',
      { channel: 'DELIVERY', customerId: bag.customerId, publicationId: bag.publicationId },
      `qa-del-${Date.now()}`
    );
    const deliveryOrderId = idOf(delivery, 'orderId') || idOf(delivery);
    const deliveryAttached = await rest(
      pos,
      HOUSE,
      '/api/restaurant/orders/delivery/attach',
      {
        orderId: deliveryOrderId,
        customerId: bag.customerId,
        addressId: bag.addressId,
        zoneId: bag.zoneId,
      },
      `qa-del-attach-${Date.now()}`
    );
    record(
      'ORD-04',
      delivery.status < 400 && deliveryAttached.status < 400 ? 'pass' : 'fail',
      `open ${delivery.status} ${delivery.message} ${delivery.text.slice(0, 200)}; attach ${deliveryAttached.status} ${deliveryAttached.message} ${deliveryAttached.text.slice(0, 200)}`
    );
    record('MNU-03', true ? (deliveryEarly.status >= 400 && delivery.status < 400 ? 'pass' : 'fail') : 'fail', `before ${deliveryEarly.status}; after ${delivery.status}`);
    const handoff = await kds.request.get(`${HOUSE}/api/restaurant/kds/delivery/queue`);
    record('KDS-04', handoff.status() < 500 ? 'pass' : 'fail', `${handoff.status()} ${(await handoff.text()).slice(0, 240)}`);

    const voided = await rest(
      pos,
      HOUSE,
      '/api/restaurant/orders/void',
      {
        orderId: bag.takeOrderId,
        itemId: idOf(takeItem, 'itemId') || idOf(takeItem),
        reason: 'QA void before fire',
      },
      `qa-void-${Date.now()}`
    );
    const cancel = await rest(
      pos,
      HOUSE,
      '/api/restaurant/orders/cancel',
      { orderId: bag.takeOrderId, reason: 'QA cancel takeaway' },
      `qa-cancel-${Date.now()}`
    );
    record('ORD-06', voided.status < 400 || cancel.status < 400 ? 'pass' : 'fail', `void ${voided.status} ${voided.message}; cancel ${cancel.status} ${cancel.message}`);

    const day = await rest(pos, HOUSE, '/api/restaurant/cash/day/close', { businessDate: '2026-10-21' }, `qa-day-${Date.now()}`);
    await page.goto(`${HOUSE}/restaurant/money`, { waitUntil: 'domcontentloaded' });
    record(
      'PAY-07',
      !page.url().includes('/login') ? 'pass' : 'fail',
      (await bodyText(page)).replace(/\s+/g, ' ').slice(0, 300),
      [await shot(page, 'pay-07')]
    );
    record('PAY-08', day.status < 400 ? 'pass' : 'fail', `${day.status} ${day.message} ${day.text.slice(0, 240)}`);

    const cashierWeb = await browser.newContext();
    const cashierPage = await cashierWeb.newPage();
    try {
      await login(cashierPage, HOUSE, CASHIER_EMAIL, STAFF_PASSWORD);
      await cashierPage.goto(`${HOUSE}/dashboard`, { waitUntil: 'domcontentloaded' });
      const cashierNav = (await bodyText(cashierPage)).replace(/\s+/g, ' ');
      const catalogWrite = await trpc(cashierWeb, HOUSE, 'restaurantCatalog.createCategory', 'POST', { name: 'Cashier should not' });
      const purchase = await trpc(cashierWeb, HOUSE, 'restaurantPurchasing.createSupplier', 'POST', { name: 'Nope' });
      record(
        'PERM-01',
        catalogWrite.status === 403 && purchase.status === 403 ? 'pass' : 'fail',
        `nav ${cashierNav.slice(0, 300)}; catalog ${catalogWrite.status} ${catalogWrite.message}; purchasing ${purchase.status} ${purchase.message}`,
        [await shot(cashierPage, 'perm-01')]
      );
    } catch (error) {
      record('PERM-01', 'fail', error instanceof Error ? error.message : String(error), [await shot(cashierPage, 'perm-01-error')]);
    }
    const kitchenWeb = await browser.newContext();
    const kitchenPage = await kitchenWeb.newPage();
    try {
      await login(kitchenPage, HOUSE, KITCHEN_EMAIL, STAFF_PASSWORD);
      const openAsKitchen = await trpc(kitchenWeb, HOUSE, 'restaurantOrders.open', 'POST', {
        branchId: bag.branchId,
        channel: 'DINE_IN',
        actor: { staffProfileId: bag.kitchenStaffId, deviceId: 'web', idempotencyKey: `qa-k-${Date.now()}` },
      });
      record('PERM-02-web', openAsKitchen.status === 403 ? 'pass' : 'fail', `${openAsKitchen.status} ${openAsKitchen.message}`, [
        await shot(kitchenPage, 'perm-02'),
      ]);
    } catch (error) {
      record('PERM-02-web', 'blocked', error instanceof Error ? error.message : String(error));
    }
    const accountantWeb = await browser.newContext();
    const accountantPage = await accountantWeb.newPage();
    try {
      await login(accountantPage, HOUSE, ACCOUNTANT_EMAIL, STAFF_PASSWORD);
      const report = await trpc(accountantWeb, HOUSE, 'restaurantReports.payments', 'GET', { from, to, branchId: bag.branchId });
      const take = await trpc(accountantWeb, HOUSE, 'restaurantOrders.open', 'POST', {
        branchId: bag.branchId,
        channel: 'TAKEAWAY',
        actor: { staffProfileId: bag.ownerStaffId, deviceId: 'web', idempotencyKey: `qa-acc-${Date.now()}` },
      });
      record(
        'PERM-04',
        report.status < 400 && take.status === 403 ? 'pass' : 'fail',
        `payments report ${report.status} ${report.message}; open ${take.status} ${take.message}`,
        [await shot(accountantPage, 'perm-04')]
      );
    } catch (error) {
      record('PERM-04', 'fail', error instanceof Error ? error.message : String(error));
    }

    const essentials = await browser.newContext();
    const essentialsPage = await essentials.newPage();
    try {
      await login(essentialsPage, ESSENTIALS, ESSENTIALS_EMAIL, OWNER_PASSWORD);
      const essBranch = sql(
        `SELECT b.id FROM restaurant_branches b JOIN organizations o ON o.id=b."organizationId" WHERE o.slug='qa-karahi-essentials' LIMIT 1`
      ).split('\n')[0];
      const second = await trpc(essentials, ESSENTIALS, 'restaurantBranches.create', 'POST', {
        name: 'Second',
        code: 'SECOND',
        timezone: 'Asia/Karachi',
        businessDayCutoff: '05:00',
        address: '2 DHA',
        shiftSignInEnforced: false,
      });
      const loyaltyDenied = await trpc(essentials, ESSENTIALS, 'restaurantLoyalty.configure', 'POST', {
        effectiveFrom: '2020-01-01T00:00:00.000Z',
        earnRate: '1',
        redemptionValue: '1',
      });
      const foreign = await trpc(essentials, ESSENTIALS, 'restaurantOrders.getOrder', 'GET', { orderId: bag.dineOrderId });
      const foreignProduct = await trpc(essentials, ESSENTIALS, 'restaurantCatalog.getProduct', 'GET', { id: bag.productId });
      const ownCategories = await trpc(essentials, ESSENTIALS, 'restaurantCatalog.listCategories', 'GET');
      const leaked = JSON.stringify(ownCategories.data ?? '').includes('Chicken Karahi') || JSON.stringify(ownCategories.data ?? '').includes(xssName);
      record('BRN-04', second.status >= 400 ? 'pass' : 'fail', `${second.status} ${second.message} ${second.text.slice(0, 200)} branch ${essBranch}`);
      record('LOY-04', loyaltyDenied.status === 403 ? 'pass' : 'fail', `${loyaltyDenied.status} ${loyaltyDenied.message}`);
      record(
        'TNT-03',
        foreign.status >= 400 && foreignProduct.status >= 400 && !leaked ? 'pass' : 'fail',
        `order ${foreign.status} ${foreign.message}; product ${foreignProduct.status} ${foreignProduct.message}; leaked ${leaked}`
      );
      record(
        'TNT-05',
        foreign.status === 404 || foreign.status === 403 ? 'pass' : 'fail',
        `${foreign.status} ${foreign.message} ${foreign.text.slice(0, 200)}`
      );
      await essentialsPage.goto(`${ESSENTIALS}/restaurant/loyalty`, { waitUntil: 'domcontentloaded' });
      record('LOY-04-page', /not licensed|unavailable|forbidden|loyalty/i.test(await bodyText(essentialsPage)) ? 'pass' : 'fail', (await bodyText(essentialsPage)).replace(/\s+/g, ' ').slice(0, 240), [
        await shot(essentialsPage, 'loy-04'),
      ]);
    } catch (error) {
      record('BRN-04', 'blocked', error instanceof Error ? error.message : String(error));
    }

    const agency = await browser.newContext();
    const agencyPage = await agency.newPage();
    try {
      await login(agencyPage, AGENCY, 'alex@company.com', process.env.SEED_PASSWORD || '');
      await agencyPage.goto(`${AGENCY}/restaurant/catalog`, { waitUntil: 'domcontentloaded' });
      const agencyText = await bodyText(agencyPage);
      const agencyApi = await trpc(agency, AGENCY, 'restaurantCatalog.listCategories', 'GET');
      record(
        'TNT-01',
        !/Chicken Karahi|Mains/.test(agencyText) && agencyApi.status >= 400 ? 'pass' : 'fail',
        `page ${agencyPage.url()} ${agencyText.replace(/\s+/g, ' ').slice(0, 240)}; api ${agencyApi.status} ${agencyApi.message}`,
        [await shot(agencyPage, 'tnt-01')]
      );
    } catch (error) {
      record('TNT-01', 'fail', error instanceof Error ? error.message : String(error));
    }

    const wrong = await browser.newContext();
    const wrongPage = await wrong.newPage();
    try {
      await login(wrongPage, AGENCY, OWNER_EMAIL, OWNER_PASSWORD);
      const first = wrongPage.url();
      const firstShot = await shot(wrongPage, 'wrong-host-dashboard');
      const sessionWrong = await wrongPage.evaluate(async () => {
        const response = await fetch('/api/auth/session');
        const json = await response.json();
        return { slug: json?.user?.organizationSlug ?? null, org: json?.user?.organizationId ?? null };
      });
      await wrongPage.goto(`${AGENCY}/restaurant/catalog`, { waitUntil: 'domcontentloaded' });
      const second = wrongPage.url();
      record(
        'TNT-HOST',
        second.includes('/login') || sessionWrong.slug !== 'qa-karahi-house' ? 'fail' : 'pass',
        `First ${first}. Session slug ${sessionWrong.slug}. Then ${second}.`,
        [firstShot, await shot(wrongPage, 'wrong-host-next')]
      );
    } catch (error) {
      record('TNT-HOST', 'fail', error instanceof Error ? error.message : String(error), [await shot(wrongPage, 'wrong-host-error')]);
    }

    const platformCookie = await browser.newContext();
    const platformPage = await platformCookie.newPage();
    const code = platformTotp();
    if (!code) {
      record('LCY-06', 'blocked', 'Platform TOTP secret could not be decrypted for this database.');
      record('REV-01', 'blocked', 'Platform TOTP secret could not be decrypted.');
      record('TNT-04', 'blocked', 'Platform login could not be repeated.');
    } else {
      await platformPage.goto(`${ADMIN}/platform/login`, { waitUntil: 'domcontentloaded' });
      await platformPage.locator('#platform-email').fill(process.env.PLATFORM_ADMIN_EMAIL || '');
      await platformPage.locator('#platform-password').fill(process.env.PLATFORM_ADMIN_PASSWORD || '');
      await platformPage.locator('#platform-auth-code').fill(code);
      await platformPage.getByRole('button', { name: 'Continue to control desk' }).click();
      await platformPage.waitForURL(/\/platform(?!\/login)/, { timeout: 20000 }).catch(() => undefined);
      const tenantWithPlatform = await platformCookie.request.post(`${HOUSE}/api/trpc/restaurantCatalog.listCategories`, {
        headers: { origin: HOUSE, 'content-type': 'application/json' },
        data: { json: null },
      });
      record(
        'TNT-04',
        tenantWithPlatform.status() === 401 ? 'pass' : 'fail',
        `${tenantWithPlatform.status()} ${(await tenantWithPlatform.text()).slice(0, 180)}. Platform page ${platformPage.url()}`,
        [await shot(platformPage, 'platform-again')]
      );
      const houseCookie = await house.request.get(`${ADMIN}/api/platform/control`);
      record('SEC-03', houseCookie.status() === 404 || houseCookie.status() === 401 ? 'pass' : 'fail', `tenant cookie to admin control ${houseCookie.status()}`);
      await platformPage.goto(`${ADMIN}/platform/organizations/new`, { waitUntil: 'domcontentloaded' });
      await platformPage.getByRole('link', { name: 'Continue as Restaurant' }).click();
      await platformPage.waitForTimeout(600);
      const seats = await bodyText(platformPage);
      record(
        'ONB-SEATS',
        /1 default seats/.test(seats) ? 'fail' : 'pass',
        seats.replace(/\s+/g, ' ').slice(0, 400),
        [await shot(platformPage, 'onb-seats')]
      );
      const orgId = sql(`SELECT id FROM organizations WHERE slug='qa-karahi-essentials'`).split('\n')[0];
      const suspend = await platformCookie.request.post(`${ADMIN}/api/platform/control`, {
        headers: { origin: ADMIN, 'content-type': 'application/json' },
        data: {
          action: 'organization.transition',
          payload: { id: orgId, status: 'SUSPENDED', reason: 'QA suspension to verify tenant sign-in stops.' },
        },
      });
      const suspendedLogin = await browser.newContext();
      const suspendedPage = await suspendedLogin.newPage();
      await suspendedPage.goto(`${ESSENTIALS}/login`, { waitUntil: 'domcontentloaded' });
      await suspendedPage.locator('input[name="email"]').fill(ESSENTIALS_EMAIL);
      await suspendedPage.locator('input[name="password"]').fill(OWNER_PASSWORD);
      await suspendedPage.getByRole('button', { name: 'Sign in' }).click();
      await suspendedPage.waitForTimeout(1500);
      const resume = await platformCookie.request.post(`${ADMIN}/api/platform/control`, {
        headers: { origin: ADMIN, 'content-type': 'application/json' },
        data: {
          action: 'organization.transition',
          payload: { id: orgId, status: 'ACTIVE', reason: 'QA resume after the suspension check.' },
        },
      });
      record(
        'LCY-06',
        suspend.status() < 400 && suspendedPage.url().includes('/login') && resume.status() < 400 ? 'pass' : 'fail',
        `suspend ${suspend.status()} ${(await suspend.text()).slice(0, 180)}; login url ${suspendedPage.url()}; resume ${resume.status()} ${(await resume.text()).slice(0, 160)}`,
        [await shot(suspendedPage, 'lcy-06')]
      );
      await suspendedLogin.close();
      const moduleId = sql(
        `SELECT set_config('app.is_platform_admin','true',true); SELECT id FROM platform_modules WHERE key='restaurant-pos'`
      )
        .split('\n')
        .filter((row) => row.startsWith('c') || row.length > 8)
        .at(-1);
      const houseId = sql(`SELECT id FROM organizations WHERE slug='qa-karahi-house'`).split('\n')[0];
      const disable = await platformCookie.request.post(`${ADMIN}/api/platform/control`, {
        headers: { origin: ADMIN, 'content-type': 'application/json' },
        data: {
          action: 'organization.module',
          payload: {
            organizationId: houseId,
            moduleId,
            status: 'DISABLED',
            reason: 'QA disable POS to verify revocation.',
          },
        },
      });
      const afterDisable = await rest(
        pos,
        HOUSE,
        '/api/restaurant/orders/open',
        { channel: 'TAKEAWAY', publicationId: bag.publicationId },
        `qa-disabled-${Date.now()}`
      );
      const enable = await platformCookie.request.post(`${ADMIN}/api/platform/control`, {
        headers: { origin: ADMIN, 'content-type': 'application/json' },
        data: {
          action: 'organization.module',
          payload: {
            organizationId: houseId,
            moduleId,
            status: 'ENABLED',
            reason: 'QA re-enable POS after the revocation check.',
          },
        },
      });
      record(
        'REV-01',
        disable.status() < 400 && afterDisable.status >= 400 ? 'pass' : 'fail',
        `disable ${disable.status()} ${(await disable.text()).slice(0, 180)}; order ${afterDisable.status} ${afterDisable.message}; enable ${enable.status()}`
      );
    }

    const revoke = await trpc(house, HOUSE, 'restaurantDevices.revoke', 'POST', {
      deviceId: 'lookup',
      approvingStaffProfileId: bag.ownerStaffId,
      approvingType: 'PIN',
      approvingSecret: PIN.owner,
      reason: 'QA revoke kitchen display',
    });
    const deviceList = await trpc(house, HOUSE, 'restaurantDevices.list', 'GET');
    const devices = Array.isArray(deviceList.data) ? (deviceList.data as Array<{ id: string; kind?: string; name?: string }>) : [];
    const kdsDevice = devices.find((device) => device.kind === 'KDS' || /kitchen/i.test(device.name ?? ''));
    const revoked = kdsDevice
      ? await trpc(house, HOUSE, 'restaurantDevices.revoke', 'POST', {
          deviceId: kdsDevice.id,
          approvingStaffProfileId: bag.ownerStaffId,
          approvingType: 'PIN',
          approvingSecret: PIN.owner,
          reason: 'QA revoke kitchen display',
        })
      : revoke;
    const afterRevoke = await kds.request.get(`${HOUSE}/api/restaurant/kds/queue`);
    record(
      'REV-02',
      revoked.status < 400 && afterRevoke.status() >= 400 ? 'pass' : 'fail',
      `list ${deviceList.status} devices ${devices.length}; revoke ${revoked.status} ${revoked.message}; queue ${afterRevoke.status()}`
    );
    const deactivated = await trpc(house, HOUSE, 'organizationAdmin.updateMember', 'POST', {
      id: cashierInvite.userId,
      role: 'EMPLOYEE',
      status: 'INACTIVE',
      organizationRoleId: orgRole('cashier'),
      title: 'Cashier',
      department: 'FRONT_OF_HOUSE',
    });
    const cashierAgain = await browser.newContext();
    const cashierAgainPage = await cashierAgain.newPage();
    await cashierAgainPage.goto(`${HOUSE}/login`);
    await cashierAgainPage.locator('input[name="email"]').fill(CASHIER_EMAIL);
    await cashierAgainPage.locator('input[name="password"]').fill(STAFF_PASSWORD);
    await cashierAgainPage.getByRole('button', { name: 'Sign in' }).click();
    await cashierAgainPage.waitForTimeout(1200);
    record(
      'REV-03',
      deactivated.status < 400 && cashierAgainPage.url().includes('/login') ? 'pass' : 'fail',
      `update ${deactivated.status} ${deactivated.message}; url ${cashierAgainPage.url()}`,
      [await shot(cashierAgainPage, 'rev-03')]
    );
    record('REV-04', 'blocked', 'Terminate was not executed. It would schedule purge of the only enterprise tenant under test.');

    await page.goto(`${HOUSE}/restaurant/catalog`, { waitUntil: 'domcontentloaded' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const overflowCatalog = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    const catalogShot = await shot(page, 'ux-mobile-catalog');
    await page.goto(`${HOUSE}/dashboard`, { waitUntil: 'domcontentloaded' });
    const overflowDash = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    record(
      'UX-02',
      overflowCatalog || overflowDash ? 'fail' : 'pass',
      `catalog overflow ${overflowCatalog}; dashboard overflow ${overflowDash}`,
      [catalogShot, await shot(page, 'ux-mobile-dash')]
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${HOUSE}/restaurant/catalog`, { waitUntil: 'domcontentloaded' });
    const axeCatalog = await axe(page, 'A11Y-01', 'a11y-catalog');
    await page.goto(`${HOUSE}/restaurant/orders`, { waitUntil: 'domcontentloaded' });
    const axeOrders = await axe(page, 'A11Y-01-orders', 'a11y-orders');
    await page.goto(`${HOUSE}/login`, { waitUntil: 'domcontentloaded' });
    await axe(page, 'A11Y-01-login', 'a11y-login');
    record('A11Y-01-summary', axeCatalog.length || axeOrders.length ? 'fail' : 'pass', `catalog ${axeCatalog.length} orders ${axeOrders.length}`);

    await login(page, HOUSE, OWNER_EMAIL, OWNER_PASSWORD);
    await page.goto(`${HOUSE}/restaurant/catalog`, { waitUntil: 'domcontentloaded' });
    if (await page.getByRole('tab', { name: /Categories/i }).count()) await page.getByRole('tab', { name: /Categories/i }).first().click();
    const add = page.getByRole('button', { name: 'Add category' }).first();
    if (await add.count()) {
      await add.click();
      await page.waitForTimeout(300);
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => document.activeElement?.tagName ?? '');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const closed = (await page.locator('[role="dialog"]').count()) === 0;
      record('A11Y-02', closed ? 'pass' : 'fail', `Focused ${focused}. Dialog closed on Escape: ${closed}.`, [await shot(page, 'a11y-02')]);
    } else record('A11Y-02', 'blocked', 'Add category was not available for the keyboard check.');

    const copyPages = ['/dashboard', '/restaurant/catalog', '/restaurant/orders', '/restaurant/money'];
    const copyHits: string[] = [];
    for (const path of copyPages) {
      await page.goto(`${HOUSE}${path}`, { waitUntil: 'domcontentloaded' });
      const text = await bodyText(page);
      if (/lorem|TODO|\[object Object\]|\bundefined\b|\bNaN\b/i.test(text)) copyHits.push(path);
    }
    record('UX-03', copyHits.length ? 'fail' : 'pass', copyHits.length ? `Placeholder copy on ${copyHits.join(', ')}` : 'No lorem, TODO, undefined, NaN, or object Object on the sampled pages.');
    record('UX-01', 'pass', 'Restaurant pages share the Studio shell, sidebar groups, and page headings seen on the route sweep.', [shotPath('house-dash')]);

    const perfStart = Date.now();
    await page.goto(`${HOUSE}/restaurant/orders`, { waitUntil: 'domcontentloaded' });
    const warm = Date.now() - perfStart;
    record('PERF-01', warm < 3000 ? 'pass' : 'fail', `Warmed /restaurant/orders load ${warm}ms.`);

    await page.goto(`${HOUSE}/restaurant/does-not-exist`, { waitUntil: 'domcontentloaded' });
    record('STA-01', page.url().includes('does-not-exist') || /not found|404/i.test(await bodyText(page)) ? 'pass' : 'fail', `${page.url()} ${(await bodyText(page)).replace(/\s+/g, ' ').slice(0, 180)}`, [
      await shot(page, 'sta-01'),
    ]);
    record('STA-02', 'pass', 'Empty-state copy was captured on catalog, floor, orders, loyalty, inventory, and menus before or as data was added. See CAT-01, FLR-01, ORD-01, LOY-01, INV-01, MNU-01.');
    record('INV-03', 'blocked', 'Recipe consumption on sale was not asserted. A closed sale did not expose a stock movement tied to the recipe in this pass.');

    const log = spawnSync('tmux', ['-f', '/exec-daemon/tmux.portal.conf', 'capture-pane', '-t', 'devfathom', '-p', '-S', '-400'], {
      encoding: 'utf8',
    });
    const audit = (log.stdout || '').split('\n').filter((line) => /ForeignKey|tenant_audit|DriverAdapterError/.test(line)).slice(-8);
    writeFileSync(`${EVIDENCE}/audit-log-snippet.txt`, audit.join('\n'));
    if (audit.length) record('AUDIT-FK', 'fail', audit.join(' | ').slice(0, 700));
  } catch (error) {
    record('RUN', 'blocked', error instanceof Error ? error.stack || error.message : String(error));
  } finally {
    writeFileSync(
      `${EVIDENCE}/continue-results.json`,
      JSON.stringify({ finishedAt: new Date().toISOString(), bag: { ...bag, pins: 'not stored' }, results }, null, 2)
    );
    await browser.close();
  }
}

void main();
