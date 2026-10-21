/**
 * Second pass: tenant journey, lifecycle action, module revoke, IDOR.
 * Reads the same env as the first runner. Writes evidence with a fu- prefix.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = path.join(ROOT, 'qa/pharmacy/evidence');
const results = [];

function loadEnv(file) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx);
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnv(path.join(ROOT, '.env'));

function record(id, status, detail, evidence = []) {
  results.push({ id, status, detail: String(detail).slice(0, 2500), evidence });
  console.log(`[${status}] ${id} — ${String(detail).slice(0, 300)}`);
  fs.writeFileSync(path.join(OUT, 'followup-results.json'), JSON.stringify(results, null, 2));
}
async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, animations: 'disabled' }).catch(() => {});
  return path.relative(ROOT, file);
}
async function dump(page, name) {
  const text = await page.locator('body').innerText().catch(() => '');
  fs.writeFileSync(path.join(OUT, `${name}.txt`), text.slice(0, 20000));
  return text;
}
function sql(query) {
  return execFileSync('psql', [process.env.SUPER_DATABASE_URL, '-tAc', query], { encoding: 'utf8' }).trim();
}

const CLIFTON = 'http://qa-clifton.localhost:3000';
const RIVAL = 'http://qa-rival.localhost:3000';
const PLATFORM = 'http://admin.localhost:3000';
const OWNER_EMAIL = 'owner@qa-clifton.test';
const OWNER_PASSWORD = 'Qa-Clifton-Owner-42!';
const RIVAL_EMAIL = 'owner@qa-rival.test';
const RIVAL_PASSWORD = 'Qa-Rival-Owner-42!';

async function signIn(page, origin, email, password) {
  await page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: /sign in|log in|continue/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60000 });
}

async function main() {
  const cliftonId = sql(`SELECT id FROM organizations WHERE slug='qa-clifton'`);
  const rivalId = sql(`SELECT id FROM organizations WHERE slug='qa-rival'`);
  const agencyPackage = sql(`SELECT id FROM platform_packages WHERE key='agency-suite'`);
  const crmModule = sql(`SELECT id FROM platform_modules WHERE key='pharmacy-crm'`);
  const coreModule = sql(`SELECT id FROM platform_modules WHERE key='pharmacy-core'`);

  const browser = await chromium.launch({ headless: true });
  const platform = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pp = await platform.newPage();
  pp.setDefaultTimeout(20000);
  pp.setDefaultNavigationTimeout(90000);

  // Reuse enrolled MFA secret
  const secret = fs.readFileSync('/tmp/qa-pharmacy-mfa-secret', 'utf8').trim();
  const { createHmac } = await import('node:crypto');
  function totp(input) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const clean = input.toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
    let bits = 0, value = 0; const out = [];
    for (const c of clean) {
      const idx = alphabet.indexOf(c);
      if (idx < 0) continue;
      value = (value << 5) | idx; bits += 5;
      if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
    }
    const key = Buffer.from(out);
    const counter = Math.floor(Date.now() / 1000 / 30);
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const hmac = createHmac('sha1', key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0xf;
    const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
    return String(bin % 1_000_000).padStart(6, '0');
  }
  await pp.goto(`${PLATFORM}/platform/login`, { waitUntil: 'domcontentloaded' });
  await pp.getByLabel('Work email').fill(process.env.PLATFORM_ADMIN_EMAIL);
  await pp.getByLabel('Password', { exact: true }).fill(process.env.PLATFORM_ADMIN_PASSWORD);
  await pp.getByLabel('Authentication code').fill(totp(secret));
  await pp.getByRole('button', { name: 'Continue to control desk' }).click();
  await pp.waitForURL(/\/platform(\/|$)/, { timeout: 30000 });
  record('FU-LOGIN-PLATFORM', 'pass', pp.url());

  async function platformCommand(action, payload) {
    return pp.evaluate(async ({ action, payload }) => {
      const res = await fetch('/api/platform/control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, payload }),
      });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, json };
    }, { action, payload });
  }

  const cross = await platformCommand('organization.update', { id: cliftonId, packageId: agencyPackage });
  record(
    'PH-SA-05',
    cross.status === 400 ? 'pass' : 'fail',
    `HTTP ${cross.status} ${JSON.stringify(cross.json).slice(0, 400)}`
  );

  const coreOff = await platformCommand('organization.module', {
    organizationId: cliftonId,
    moduleId: coreModule,
    status: 'DISABLED',
    reason: 'QA attempt to disable mandatory core',
  });
  record(
    'PH-SA-08',
    coreOff.status >= 400 ? 'pass' : 'fail',
    `Disable core HTTP ${coreOff.status} ${JSON.stringify(coreOff.json).slice(0, 400)}`
  );

  const activate = await platformCommand('organization.transition', {
    id: cliftonId,
    status: 'ACTIVE',
    reason: 'QA activation before pharmacy readiness',
  });
  const statusAfter = sql(`SELECT status FROM organizations WHERE id='${cliftonId}'`);
  record(
    'PH-SA-07',
    activate.status >= 400 && statusAfter === 'ONBOARDING' ? 'pass' : 'fail',
    `HTTP ${activate.status} db=${statusAfter} body ${JSON.stringify(activate.json).slice(0, 700)}`
  );

  // Tenant
  const tenant = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const tp = await tenant.newPage();
  tp.setDefaultNavigationTimeout(90000);
  tp.setDefaultTimeout(15000);
  const pageErrors = [];
  tp.on('pageerror', (error) => pageErrors.push(error.message.slice(0, 300)));
  try {
    await signIn(tp, CLIFTON, OWNER_EMAIL, OWNER_PASSWORD);
    record('PH-ON-01', 'pass', `Landed on ${tp.url()}`, [await shot(tp, 'fu-on-01')]);
  } catch (error) {
    record('PH-ON-01', 'fail', `${error.message} url=${tp.url()}`, [await shot(tp, 'fu-on-01-fail')]);
    await dump(tp, 'fu-on-01-fail');
    await browser.close();
    return;
  }

  // wrong vs unknown, fresh context
  const anon = await browser.newContext();
  const ap = await anon.newPage();
  async function loginError(email) {
    await ap.goto(`${CLIFTON}/login`, { waitUntil: 'domcontentloaded' });
    await ap.getByLabel('Email').fill(email);
    await ap.getByLabel('Password', { exact: true }).fill('definitely-wrong-99');
    await ap.getByRole('button', { name: /sign in|log in|continue/i }).click();
    const alert = ap.getByRole('alert');
    await alert.waitFor({ timeout: 30000 }).catch(() => {});
    return (await alert.innerText().catch(() => '')) || (await dump(ap, 'tmp-login'));
  }
  const wrong = await loginError(OWNER_EMAIL);
  const unknown = await loginError('nobody@qa-clifton.test');
  record('PH-ON-02', wrong.trim() === unknown.trim() && /invalid email or password/i.test(wrong) ? 'pass' : 'fail', `wrong="${wrong.trim()}" unknown="${unknown.trim()}"`);
  await anon.close();

  const routes = [
    '/dashboard','/pharmacy','/pharmacy/regulatory','/pharmacy/inventory','/pharmacy/inventory/expiry','/pharmacy/inventory/transfers','/pharmacy/inventory/imports',
    '/organization','/team','/pharmacy/medicines','/pharmacy/medicines/prices','/pharmacy/medicines/staged','/pharmacy/counter','/pharmacy/counter/close',
    '/pharmacy/purchasing','/pharmacy/purchasing/suppliers','/pharmacy/purchasing/orders','/pharmacy/purchasing/receiving','/pharmacy/purchasing/returns',
    '/pharmacy/finance','/pharmacy/reports','/pharmacy/reports/replenishment','/pharmacy/reports/repeat-purchasing','/pharmacy/reports/supplier-credit-follow-up',
    '/pharmacy/orders','/pharmacy/prescriptions','/pharmacy/pharmacist-queue','/pharmacy/substitution','/pharmacy/controlled-register','/pharmacy/loyalty','/pharmacy/marketing',
    '/pharmacy/cameras','/pharmacy/settings/cameras/privacy','/settings','/settings/modules','/settings/receipts',
    '/pharmacy/procurement','/pharmacy/dispensing','/pharmacy/safety','/pharmacy/crm',
  ];
  const routeReport = [];
  for (const href of routes) {
    const started = Date.now();
    try {
      const response = await tp.goto(`${CLIFTON}${href}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await tp.waitForTimeout(400);
      const text = await dump(tp, `fu-${href.replaceAll('/', '_') || 'root'}`);
      const evidence = await shot(tp, `fu-${href.replaceAll('/', '_') || 'root'}`);
      const crash = /Application error|Unhandled Runtime Error|Internal Server Error|This page couldn’t load/.test(text);
      routeReport.push({ href, status: response?.status() ?? 0, ms: Date.now() - started, crash, head: text.split('\n').filter(Boolean).slice(0, 12).join(' | '), evidence });
      console.log(` route ${href} ${response?.status()} ${Date.now() - started}ms`);
    } catch (error) {
      routeReport.push({ href, status: 0, ms: Date.now() - started, crash: true, head: error.message, evidence: '' });
      console.log(` route ${href} ERROR ${error.message}`);
    }
  }
  fs.writeFileSync(path.join(OUT, 'followup-routes.json'), JSON.stringify(routeReport, null, 2));
  const crashed = routeReport.filter((item) => item.crash || item.status >= 500);
  record('PH-ROUTES', crashed.length ? 'fail' : 'pass', crashed.length ? crashed.map((item) => `${item.href} ${item.status} ${item.head.slice(0, 120)}`).join(' || ') : `${routeReport.length} routes rendered without a 500.`);

  // Onboarding gate text
  const onboarding = fs.readFileSync(path.join(OUT, 'fu-_pharmacy.txt'), 'utf8');
  record('PH-ON-04', /Onboarding/.test(onboarding) ? 'pass' : 'fail', onboarding.replace(/\s+/g, ' ').slice(0, 900), ['qa/pharmacy/evidence/fu-_pharmacy.png']);

  // Try attest with empty evidence if a control exists
  try {
    await tp.goto(`${CLIFTON}/pharmacy`, { waitUntil: 'domcontentloaded' });
    const buttons = await tp.getByRole('button').allTextContents();
    const inputs = await tp.locator('input, textarea, select').evaluateAll((els) => els.map((el) => ({ name: el.getAttribute('name'), type: el.getAttribute('type'), label: el.getAttribute('aria-label') })).slice(0, 40));
    fs.writeFileSync(path.join(OUT, 'fu-onboarding-controls.json'), JSON.stringify({ buttons, inputs }, null, 2));
    record('PH-ON-05', 'see-report', `buttons=${buttons.slice(0, 30).join(' | ')}`);
  } catch (error) {
    record('PH-ON-05', 'fail', error.message);
  }

  // Regulatory validation + save
  try {
    await tp.goto(`${CLIFTON}/pharmacy/regulatory`, { waitUntil: 'domcontentloaded' });
    const labels = await tp.locator('label').allTextContents();
    fs.writeFileSync(path.join(OUT, 'fu-regulatory-labels.txt'), labels.join('\n'));
    record('PH-ST-01', /licen|branch|Sindh|Karachi|Clifton/i.test(labels.join(' ') + (await dump(tp, 'fu-reg-again'))) ? 'pass' : 'fail', labels.slice(0, 25).join(' | '), [await shot(tp, 'fu-regulatory')]);
    const text = fs.readFileSync(path.join(OUT, 'fu-_pharmacy_regulatory.txt'), 'utf8');
    record('PH-ST-02', 'see-report', `Regulatory excerpt: ${text.replace(/\s+/g, ' ').slice(0, 500)}`);
  } catch (error) {
    record('PH-ST-01', 'fail', error.message);
  }

  // Counter + xss + search
  try {
    await tp.goto(`${CLIFTON}/pharmacy/counter`, { waitUntil: 'domcontentloaded' });
    const search = tp.getByPlaceholder(/Brand, generic|Search/i);
    const count = await search.count();
    if (!count) {
      record('PH-POS-01', 'fail', 'Counter has no search box. ' + (await dump(tp, 'fu-counter-body')).replace(/\s+/g, ' ').slice(0, 300), [await shot(tp, 'fu-counter')]);
    } else {
      record('PH-POS-01', 'pass', 'Counter search is present.', [await shot(tp, 'fu-counter')]);
      await search.first().fill('<img src=x onerror=alert(1)>');
      await tp.keyboard.press('Enter');
      await tp.waitForTimeout(1000);
      const imgs = await tp.evaluate(() => document.querySelectorAll('img[src="x"]').length);
      record('PH-VL-01', imgs ? 'fail' : 'pass', `Injected img nodes: ${imgs}`, [await shot(tp, 'fu-xss')]);
      await search.first().fill(`' OR '1'='1`);
      await tp.keyboard.press('Enter');
      await tp.waitForTimeout(1000);
      const body = await tp.locator('body').innerText();
      record('PH-VL-02', /SQLSTATE|syntax error/i.test(body) ? 'fail' : 'pass', /SQLSTATE/i.test(body) ? body.slice(0, 200) : 'No SQL error text.');
      await search.first().fill('پیراسیٹامول');
      await tp.keyboard.press('Enter');
      await tp.waitForTimeout(800);
      const urduBody = await tp.locator('body').innerText();
      record('PH-VL-03', /Application error|Internal Server Error/.test(urduBody) ? 'fail' : 'pass', 'Urdu search did not crash the counter.', [await shot(tp, 'fu-urdu')]);
    }
  } catch (error) {
    record('PH-POS-01', 'fail', error.message);
  }

  // Purchasing suppliers buttons
  try {
    await tp.goto(`${CLIFTON}/pharmacy/purchasing/suppliers`, { waitUntil: 'domcontentloaded' });
    const buttons = await tp.getByRole('button').allTextContents();
    record('PH-PU-01', 'see-report', `Supplier buttons: ${buttons.slice(0, 20).join(' | ')}. ${(await dump(tp, 'fu-suppliers')).replace(/\s+/g, ' ').slice(0, 400)}`, [await shot(tp, 'fu-suppliers')]);
  } catch (error) {
    record('PH-PU-01', 'fail', error.message);
  }

  // Team / organization controls for users
  try {
    await tp.goto(`${CLIFTON}/team`, { waitUntil: 'domcontentloaded' });
    const buttons = await tp.getByRole('button').allTextContents();
    const links = await tp.getByRole('link').allTextContents();
    record('PH-UR-01', 'see-report', `Team buttons: ${buttons.slice(0, 15).join(' | ')} links: ${links.slice(0, 15).join(' | ')}`, [await shot(tp, 'fu-team')]);
    await tp.goto(`${CLIFTON}/organization`, { waitUntil: 'domcontentloaded' });
    const obuttons = await tp.getByRole('button').allTextContents();
    record('PH-UR-01b', 'see-report', `Org buttons: ${obuttons.slice(0, 20).join(' | ')}`, [await shot(tp, 'fu-org')]);
  } catch (error) {
    record('PH-UR-01', 'fail', error.message);
  }

  // Axe + mobile + keyboard
  try {
    await tp.goto(`${CLIFTON}/pharmacy/counter`, { waitUntil: 'domcontentloaded' });
    await tp.keyboard.press('Tab');
    const active = await tp.evaluate(() => document.activeElement?.tagName + ':' + (document.activeElement?.getAttribute('aria-label') || document.activeElement?.innerText || '').slice(0, 80));
    const unlabeled = await tp.evaluate(() => [...document.querySelectorAll('input,select,textarea')].filter((el) => el.type !== 'hidden' && !(el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')).map((el) => el.name || el.placeholder || el.id || el.tagName));
    record('PH-A11Y-01', unlabeled.length ? 'fail' : 'pass', `focus=${active}; unlabeled=${unlabeled.join(', ') || 'none'}`);
    const axe = await new AxeBuilder({ page: tp }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    fs.writeFileSync(path.join(OUT, 'fu-axe-counter.json'), JSON.stringify(serious.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target) })), null, 2));
    record('PH-A11Y-02', serious.length ? 'fail' : 'pass', serious.length ? serious.map((v) => `${v.impact} ${v.id}: ${v.help}`).join('; ') : `${axe.violations.length} non-serious violations.`);
  } catch (error) {
    record('PH-A11Y-01', 'fail', error.message);
  }

  try {
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await mobile.addCookies(await tenant.cookies());
    const mp = await mobile.newPage();
    await mp.goto(`${CLIFTON}/pharmacy`, { waitUntil: 'domcontentloaded' });
    const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 4);
    const s1 = await shot(mp, 'fu-mobile-onboarding');
    await mp.goto(`${CLIFTON}/pharmacy/counter`, { waitUntil: 'domcontentloaded' });
    const overflowC = await mp.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 4);
    const s2 = await shot(mp, 'fu-mobile-counter');
    await mp.setViewportSize({ width: 768, height: 1024 });
    await mp.goto(`${CLIFTON}/dashboard`, { waitUntil: 'domcontentloaded' });
    const s3 = await shot(mp, 'fu-tablet-dashboard');
    record('PH-RS-01', overflow || overflowC ? 'fail' : 'pass', `onboarding overflow=${overflow} counter overflow=${overflowC}`, [s1, s2, s3]);
    await mobile.close();
  } catch (error) {
    record('PH-RS-01', 'fail', error.message);
  }

  // IDOR: rival calls clifton branch id
  const cliftonBranch = sql(`SELECT id FROM pharmacy_branches WHERE "organizationId"='${cliftonId}' LIMIT 1`);
  const rival = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const rp = await rival.newPage();
  try {
    await signIn(rp, RIVAL, RIVAL_EMAIL, RIVAL_PASSWORD);
    const idor = await rp.evaluate(async (branchId) => {
      async function call(path, input) {
        const url = `/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
        const res = await fetch(url);
        const text = await res.text();
        return { path, status: res.status, text: text.slice(0, 300) };
      }
      return [
        await call('pharmacyInventory.lots', { branchId }),
        await call('pharmacySales.counterBranches', null),
        await call('pharmacyPurchasing.suppliers', { branchId }),
      ];
    }, cliftonBranch);
    fs.writeFileSync(path.join(OUT, 'fu-idor.json'), JSON.stringify(idor, null, 2));
    const leak = idor.some((item) => /Clifton|qa-clifton/i.test(item.text));
    record('PH-MT-02', leak ? 'fail' : 'pass', JSON.stringify(idor).slice(0, 800));
  } catch (error) {
    record('PH-MT-02', 'fail', error.message);
  }

  // Tenant calling platform
  const forged = await tp.evaluate(async (orgId) => {
    const res = await fetch('/api/platform/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: location.origin },
      body: JSON.stringify({ action: 'organization.transition', payload: { id: orgId, status: 'SUSPENDED', reason: 'tenant trying platform' } }),
    });
    return { status: res.status, body: (await res.text()).slice(0, 200) };
  }, rivalId);
  record('PH-SEC-03', forged.status >= 400 ? 'pass' : 'fail', JSON.stringify(forged));

  // Supplier portal anonymous
  const portal = await tp.evaluate(async () => {
    const url = `/api/trpc/pharmacySupplierLinks.get?input=${encodeURIComponent(JSON.stringify({ json: { token: 'not-a-real-token' } }))}`;
    const res = await fetch(url);
    return { status: res.status, body: (await res.text()).slice(0, 250) };
  });
  record('PH-SEC-02', portal.status >= 400 ? 'pass' : 'fail', JSON.stringify(portal));

  // Logout
  try {
    await tp.goto(`${CLIFTON}/pharmacy/counter`, { waitUntil: 'domcontentloaded' });
    const signOut = tp.getByRole('button', { name: /sign out|log out/i });
    if (await signOut.count()) {
      await signOut.first().click();
      await tp.waitForTimeout(1500);
    } else {
      await tp.evaluate(async () => { await fetch('/api/login', { method: 'DELETE' }); });
      await tp.goto(`${CLIFTON}/pharmacy/counter`, { waitUntil: 'domcontentloaded' });
    }
    record('PH-SEC-04', tp.url().includes('/login') ? 'pass' : 'fail', `After sign-out URL ${tp.url()}`, [await shot(tp, 'fu-logout')]);
  } catch (error) {
    record('PH-SEC-04', 'fail', error.message);
  }

  // Disable CRM then check tenant
  const crm = await platformCommand('organization.module', {
    organizationId: cliftonId,
    moduleId: crmModule,
    status: 'DISABLED',
    reason: 'QA revoke CRM module',
  });
  const tenant2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const t2 = await tenant2.newPage();
  try {
    await signIn(t2, CLIFTON, OWNER_EMAIL, OWNER_PASSWORD);
    const response = await t2.goto(`${CLIFTON}/pharmacy/marketing`, { waitUntil: 'domcontentloaded' });
    const text = await dump(t2, 'fu-crm-disabled');
    const denied = /not available|unavailable|licence|license|permission|module/i.test(text);
    record('PH-RV-01', crm.status < 400 && (response?.status() === 403 || denied) ? 'pass' : 'fail', `module HTTP ${crm.status} ${JSON.stringify(crm.json).slice(0, 200)} page ${response?.status()} ${text.replace(/\s+/g, ' ').slice(0, 300)}`, [await shot(t2, 'fu-crm-disabled')]);
  } catch (error) {
    record('PH-RV-01', 'fail', `${error.message} module ${crm.status} ${JSON.stringify(crm.json).slice(0, 200)}`);
  }

  // Suspend
  const suspend = await platformCommand('organization.transition', {
    id: cliftonId,
    status: 'SUSPENDED',
    reason: 'QA suspension of Clifton Chemist',
  });
  const suspendedStatus = sql(`SELECT status FROM organizations WHERE id='${cliftonId}'`);
  const suspendedLogin = await browser.newContext();
  const sp = await suspendedLogin.newPage();
  await sp.goto(`${CLIFTON}/login`, { waitUntil: 'domcontentloaded' });
  await sp.getByLabel('Email').fill(OWNER_EMAIL);
  await sp.getByLabel('Password', { exact: true }).fill(OWNER_PASSWORD);
  await sp.getByRole('button', { name: /sign in|log in|continue/i }).click();
  await sp.waitForTimeout(4000);
  const stext = await dump(sp, 'fu-suspended-login');
  record(
    'PH-RV-03',
    suspendedStatus === 'SUSPENDED' && (sp.url().includes('/login') || /unavailable|suspended/i.test(stext)) ? 'pass' : 'fail',
    `db=${suspendedStatus} HTTP ${suspend.status} url=${sp.url()} text=${stext.replace(/\s+/g, ' ').slice(0, 300)} body=${JSON.stringify(suspend.json).slice(0, 250)}`,
    [await shot(sp, 'fu-suspended')]
  );
  const resume = await platformCommand('organization.transition', {
    id: cliftonId,
    status: 'ONBOARDING',
    reason: 'QA resume Clifton after suspension',
  });
  const resumed = sql(`SELECT status FROM organizations WHERE id='${cliftonId}'`);
  record('PH-RV-04', resumed === 'ONBOARDING' && resume.status < 400 ? 'pass' : 'fail', `db=${resumed} HTTP ${resume.status} ${JSON.stringify(resume.json).slice(0, 200)}`);

  // Performance from route report
  const watched = routeReport.filter((item) => ['/dashboard', '/pharmacy', '/pharmacy/counter', '/pharmacy/inventory'].includes(item.href));
  const slow = watched.filter((item) => item.ms > 5000);
  record('PH-PF-01', slow.length ? 'fail' : 'pass', watched.map((item) => `${item.href}=${item.ms}ms`).join(', '));

  fs.writeFileSync(path.join(OUT, 'fu-pageerrors.json'), JSON.stringify(pageErrors, null, 2));
  record('PH-PAGEERRORS', pageErrors.length ? 'fail' : 'pass', pageErrors.slice(0, 8).join(' | ') || 'No pageerrors.');

  await browser.close();
  console.log('FOLLOWUP_DONE', results.length);
}

main().catch((error) => {
  console.error(error);
  record('CRASH', 'fail', error.stack || error.message);
  process.exit(1);
});
