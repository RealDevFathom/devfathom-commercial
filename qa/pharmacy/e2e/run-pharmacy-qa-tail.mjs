/**
 * Tail pass: authenticated platform lifecycle, attestation, regulatory save,
 * supplier/location, remaining routes, IDOR, XSS, mobile, logout.
 * Does not change product code. Writes qa/pharmacy/evidence/tail-*.
 */
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnv(path.join(ROOT, '.env'));

function record(id, status, detail, evidence = []) {
  results.push({ id, status, detail: String(detail).slice(0, 2500), evidence });
  console.log(`[${status}] ${id} — ${String(detail).replace(/\s+/g, ' ').slice(0, 280)}`);
  fs.writeFileSync(path.join(OUT, 'tail-results.json'), JSON.stringify(results, null, 2));
}
async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, animations: 'disabled', timeout: 15000 }).catch(() => {});
  return path.relative(ROOT, file);
}
async function dump(page, name) {
  const text = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
  fs.writeFileSync(path.join(OUT, `${name}.txt`), text.slice(0, 16000));
  return text;
}
function sql(query) {
  return execFileSync('psql', [process.env.SUPER_DATABASE_URL, '-tAc', query], {
    encoding: 'utf8',
    timeout: 15000,
  }).trim();
}
function totp(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of clean) {
    const idx = alphabet.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
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
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 70000 });
}

async function main() {
  const cliftonId = sql(`SELECT id FROM organizations WHERE slug='qa-clifton'`);
  const rivalId = sql(`SELECT id FROM organizations WHERE slug='qa-rival'`);
  const agencyPackage = sql(`SELECT id FROM platform_packages WHERE key='agency-suite'`);
  const crmModule = sql(`SELECT id FROM platform_modules WHERE key='pharmacy-crm'`);
  const coreModule = sql(`SELECT id FROM platform_modules WHERE key='pharmacy-core'`);
  const cliftonBranch = sql(`SELECT id FROM pharmacy_branches WHERE "organizationId"='${cliftonId}' LIMIT 1`);
  const secret = fs.readFileSync('/tmp/qa-pharmacy-mfa-secret', 'utf8').trim();

  const browser = await chromium.launch({ headless: true });
  const platform = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pp = await platform.newPage();
  pp.setDefaultTimeout(20000);
  pp.setDefaultNavigationTimeout(90000);

  await pp.goto(`${PLATFORM}/platform/login`, { waitUntil: 'domcontentloaded' });
  await pp.getByLabel('Work email').fill(process.env.PLATFORM_ADMIN_EMAIL);
  await pp.getByLabel('Password', { exact: true }).fill(process.env.PLATFORM_ADMIN_PASSWORD);
  await pp.getByLabel('Authentication code').fill(totp(secret));
  await pp.getByRole('button', { name: 'Continue to control desk' }).click();
  try {
    await pp.waitForURL(
      (url) => url.pathname === '/platform' || (url.pathname.startsWith('/platform/') && !url.pathname.startsWith('/platform/login')),
      { timeout: 40000 }
    );
    record('TAIL-PLATFORM', 'pass', pp.url());
  } catch (error) {
    const alert = await pp.getByRole('alert').innerText().catch(() => '');
    record('TAIL-PLATFORM', 'fail', `${error.message} url=${pp.url()} alert=${alert}`, [await shot(pp, 'tail-platform-fail')]);
    await browser.close();
    return;
  }

  async function platformCommand(action, payload) {
    return pp.evaluate(async ({ action, payload }) => {
      const res = await fetch('/api/platform/control', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: location.origin },
        body: JSON.stringify({ action, payload }),
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
      return { status: res.status, json };
    }, { action, payload });
  }

  const cross = await platformCommand('organization.update', { id: cliftonId, packageId: agencyPackage });
  record(
    'PH-SA-05',
    cross.status === 400 ? 'pass' : 'fail',
    `HTTP ${cross.status} ${JSON.stringify(cross.json).slice(0, 500)}`
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
    `HTTP ${coreOff.status} ${JSON.stringify(coreOff.json).slice(0, 500)}`
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
    `HTTP ${activate.status} db=${statusAfter} ${JSON.stringify(activate.json).slice(0, 800)}`
  );
  fs.writeFileSync(path.join(OUT, 'tail-sa-07.json'), JSON.stringify(activate, null, 2));

  const tenant = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const tp = await tenant.newPage();
  tp.setDefaultNavigationTimeout(60000);
  tp.setDefaultTimeout(12000);
  await signIn(tp, CLIFTON, OWNER_EMAIL, OWNER_PASSWORD);
  record('TAIL-TENANT', 'pass', tp.url());

  // Wrong-password vs unknown email, after the auth route is warm.
  const anon = await browser.newContext();
  const ap = await anon.newPage();
  ap.setDefaultTimeout(20000);
  async function badLogin(email, password) {
    await ap.goto(`${CLIFTON}/login`, { waitUntil: 'domcontentloaded' });
    await ap.getByLabel('Email').fill(email);
    await ap.getByLabel('Password', { exact: true }).fill(password);
    await ap.getByRole('button', { name: /sign in/i }).click();
    const alert = ap.getByRole('alert');
    await alert.waitFor({ timeout: 25000 }).catch(() => {});
    return (await alert.innerText().catch(() => '')) || (await ap.locator('body').innerText()).slice(0, 400);
  }
  const wrong = await badLogin(OWNER_EMAIL, 'wrong-password-42');
  const unknown = await badLogin('nobody-qa@qa-clifton.test', 'wrong-password-42');
  record(
    'PH-ON-02',
    wrong.trim() === unknown.trim() && /invalid email or password/i.test(wrong) ? 'pass' : 'fail',
    `wrong=${JSON.stringify(wrong.slice(0, 240))} unknown=${JSON.stringify(unknown.slice(0, 240))}`,
    [await shot(ap, 'tail-on-02')]
  );
  await anon.close();

  // Attestation
  await tp.goto(`${CLIFTON}/pharmacy`, { waitUntil: 'domcontentloaded' });
  const confirm = tp.getByRole('button', { name: 'Confirm this step' }).first();
  await confirm.click();
  await tp.getByRole('button', { name: 'Mark as done' }).click();
  const emptyAlert = await tp.getByRole('alert').innerText().catch(() => '');
  record(
    'PH-ON-05-empty',
    /evidence/i.test(emptyAlert) ? 'pass' : 'fail',
    emptyAlert || 'no alert',
    [await shot(tp, 'tail-on-05-empty')]
  );
  await tp.getByLabel(/Where is the evidence/i).fill('QA board minute 2026-10-21');
  await tp.getByRole('button', { name: 'Mark as done' }).click();
  await tp.waitForTimeout(1500);
  await tp.reload({ waitUntil: 'domcontentloaded' });
  const after = await dump(tp, 'tail-on-05-after');
  const orgTypeDone = /Organization type[\s\S]{0,80}DONE/.test(after);
  record(
    'PH-ON-05',
    orgTypeDone ? 'pass' : 'fail',
    orgTypeDone ? 'Organization type shows DONE after evidence.' : after.replace(/\s+/g, ' ').slice(0, 500),
    [await shot(tp, 'tail-on-05-after')]
  );

  // Regulatory save
  await tp.goto(`${CLIFTON}/pharmacy/regulatory`, { waitUntil: 'domcontentloaded' });
  const today = '2026-10-21';
  async function fillLabeled(label, value) {
    const field = tp.getByLabel(label, { exact: false });
    if (await field.count()) await field.first().fill(value).catch(() => {});
  }
  await fillLabeled('Effective from', today);
  await fillLabeled('Premises address', '12 Clifton Road');
  await fillLabeled('Premises city', 'Karachi');
  await fillLabeled('Medicine storage', 'General shelving');
  await fillLabeled('Licence number', 'QA-LIC-1001');
  await fillLabeled('Licence valid from', today);
  await fillLabeled('Licence valid to', '2027-10-21');
  await fillLabeled('Registration number', 'QP-1001');
  await fillLabeled('Registered from', today);
  await fillLabeled('Registered to', '2027-10-21');
  await tp.getByRole('button', { name: /Save this version/i }).click();
  await tp.waitForTimeout(2000);
  const reg = await dump(tp, 'tail-regulatory-save');
  let versions = 'unknown';
  try {
    versions = sql(`SELECT count(*) FROM pharmacy_branch_regulatory_profiles`);
  } catch (error) {
    versions = String(error.message || error).slice(0, 160);
  }
  record(
    'PH-ST-03',
    /cannot operate|provisional|Sindh|refused|error|required/i.test(reg) ? 'see-report' : 'see-report',
    `profiles=${versions} ${reg.replace(/\s+/g, ' ').slice(0, 700)}`,
    [await shot(tp, 'tail-regulatory-save')]
  );

  // Location + supplier
  await tp.goto(`${CLIFTON}/pharmacy/inventory`, { waitUntil: 'domcontentloaded' });
  const name = tp.getByLabel(/^Name$/i);
  if (await name.count()) {
    await name.first().fill('Shelf A');
    const code = tp.getByLabel(/^Code$/i);
    if (await code.count()) await code.first().fill('SHELF-A');
    await tp.getByRole('button', { name: /Create location/i }).click();
    await tp.waitForTimeout(1500);
    record('TAIL-LOCATION', 'see-report', (await dump(tp, 'tail-location')).replace(/\s+/g, ' ').slice(0, 400), [await shot(tp, 'tail-location')]);
  } else {
    record('TAIL-LOCATION', 'fail', 'No location name field');
  }

  await tp.goto(`${CLIFTON}/pharmacy/purchasing/suppliers`, { waitUntil: 'domcontentloaded' });
  await tp.getByLabel(/Trading name/i).fill('QA Distributors');
  await tp.getByLabel(/Registered legal name/i).fill('QA Distributors Pvt Ltd');
  await tp.getByLabel(/Service area/i).fill('Karachi');
  await tp.getByLabel(/Contact name/i).fill('QA Buyer');
  await tp.getByLabel(/Contact phone/i).fill('03001234567');
  await tp.getByRole('button', { name: /Add supplier/i }).click();
  await tp.waitForTimeout(2000);
  record('PH-PU-02', 'see-report', (await dump(tp, 'tail-supplier')).replace(/\s+/g, ' ').slice(0, 500), [await shot(tp, 'tail-supplier')]);

  const routes = [
    '/pharmacy/prescriptions',
    '/pharmacy/pharmacist-queue',
    '/pharmacy/substitution',
    '/pharmacy/controlled-register',
    '/pharmacy/loyalty',
    '/pharmacy/marketing',
    '/pharmacy/cameras',
    '/pharmacy/settings/cameras/privacy',
    '/settings',
    '/settings/modules',
    '/settings/receipts',
    '/pharmacy/procurement',
    '/pharmacy/dispensing',
    '/pharmacy/safety',
    '/pharmacy/crm',
  ];
  const routeReport = [];
  for (const href of routes) {
    const started = Date.now();
    try {
      const response = await tp.goto(`${CLIFTON}${href}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const text = await dump(tp, `tail-${href.replaceAll('/', '_')}`);
      const evidence = await shot(tp, `tail-${href.replaceAll('/', '_')}`);
      const crash = /Application error|Unhandled Runtime Error|Internal Server Error/.test(text);
      routeReport.push({ href, status: response?.status() ?? 0, ms: Date.now() - started, crash, head: text.split('\n').filter(Boolean).slice(0, 8).join(' | ') });
      console.log(` route ${href} ${response?.status()} ${Date.now() - started}ms`);
    } catch (error) {
      routeReport.push({ href, status: 0, ms: Date.now() - started, crash: true, head: error.message });
      console.log(` route ${href} ERROR ${error.message}`);
    }
  }
  fs.writeFileSync(path.join(OUT, 'tail-routes.json'), JSON.stringify(routeReport, null, 2));
  const crashed = routeReport.filter((item) => item.crash || item.status >= 500);
  record('PH-ROUTES-TAIL', crashed.length ? 'fail' : 'pass', crashed.length ? JSON.stringify(crashed) : `${routeReport.length} routes without a 500`);

  // Counter XSS / injection
  await tp.goto(`${CLIFTON}/pharmacy/counter`, { waitUntil: 'domcontentloaded' });
  const search = tp.getByPlaceholder(/Brand, generic|Scan a barcode|Search/i);
  if (await search.count()) {
    await search.first().fill('<img src=x onerror=alert(1)>');
    await tp.keyboard.press('Enter');
    await tp.waitForTimeout(800);
    const imgs = await tp.evaluate(() => document.querySelectorAll('img[src="x"]').length);
    record('PH-VL-01', imgs ? 'fail' : 'pass', `Injected img nodes: ${imgs}`, [await shot(tp, 'tail-xss')]);
    await search.first().fill(`' OR '1'='1`);
    await tp.keyboard.press('Enter');
    await tp.waitForTimeout(800);
    const body = await tp.locator('body').innerText();
    record('PH-VL-02', /SQLSTATE|syntax error/i.test(body) ? 'fail' : 'pass', /SQLSTATE/i.test(body) ? body.slice(0, 200) : 'No SQL error text.');
    await search.first().fill('پیراسیٹامول');
    await tp.keyboard.press('Enter');
    await tp.waitForTimeout(600);
    const urdu = await tp.locator('body').innerText();
    record('PH-VL-03', /Application error|Internal Server Error/.test(urdu) ? 'fail' : 'pass', 'Urdu search did not crash the counter.');
  } else {
    record('PH-VL-01', 'fail', 'No counter search');
  }

  // axe + keyboard
  await tp.keyboard.press('Tab');
  const active = await tp.evaluate(() => document.activeElement?.tagName + ':' + (document.activeElement?.getAttribute('aria-label') || document.activeElement?.innerText || '').slice(0, 60));
  const unlabeled = await tp.evaluate(() => [...document.querySelectorAll('input,select,textarea')].filter((el) => el.type !== 'hidden' && !(el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')).map((el) => el.name || el.placeholder || el.id || el.tagName));
  record('PH-A11Y-01', unlabeled.length ? 'fail' : 'pass', `focus=${active}; unlabeled=${unlabeled.join(', ') || 'none'}`);
  try {
    const axe = await new AxeBuilder({ page: tp }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    fs.writeFileSync(path.join(OUT, 'tail-axe.json'), JSON.stringify(serious.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target) })), null, 2));
    record('PH-A11Y-02', serious.length ? 'fail' : 'pass', serious.length ? serious.map((v) => `${v.impact} ${v.id}: ${v.help}`).join('; ') : `${axe.violations.length} non-serious`);
  } catch (error) {
    record('PH-A11Y-02', 'fail', error.message);
  }

  // Mobile
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await mobile.addCookies(await tenant.cookies());
  const mp = await mobile.newPage();
  await mp.goto(`${CLIFTON}/pharmacy`, { waitUntil: 'domcontentloaded' });
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 4);
  const s1 = await shot(mp, 'tail-mobile-onboarding');
  await mp.goto(`${CLIFTON}/pharmacy/counter`, { waitUntil: 'domcontentloaded' });
  const overflowC = await mp.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 4);
  const s2 = await shot(mp, 'tail-mobile-counter');
  await mp.setViewportSize({ width: 768, height: 1024 });
  await mp.goto(`${CLIFTON}/dashboard`, { waitUntil: 'domcontentloaded' });
  await mp.waitForTimeout(1500);
  const s3 = await shot(mp, 'tail-tablet-dashboard');
  record('PH-RS-01', overflow || overflowC ? 'fail' : 'pass', `onboarding overflow=${overflow} counter overflow=${overflowC}`, [s1, s2, s3]);
  await mobile.close();

  // IDOR
  const rival = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const rp = await rival.newPage();
  try {
    await signIn(rp, RIVAL, RIVAL_EMAIL, RIVAL_PASSWORD);
    const idor = await rp.evaluate(async (branchId) => {
      async function call(proc, input) {
        const url = `/api/trpc/${proc}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
        const res = await fetch(url);
        const text = await res.text();
        return { proc, status: res.status, text: text.slice(0, 400) };
      }
      return [
        await call('pharmacyInventory.lots', { branchId }),
        await call('pharmacySales.counterBranches', null),
        await call('pharmacyPurchasing.suppliers', { branchId }),
      ];
    }, cliftonBranch);
    fs.writeFileSync(path.join(OUT, 'tail-idor.json'), JSON.stringify(idor, null, 2));
    const leak = idor.some((item) => /Clifton|qa-clifton/i.test(item.text));
    record('PH-MT-02', leak ? 'fail' : 'pass', JSON.stringify(idor).slice(0, 900));
  } catch (error) {
    record('PH-MT-02', 'fail', error.message);
  }
  await rival.close();

  const forged = await tp.evaluate(async (orgId) => {
    const res = await fetch('/api/platform/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: location.origin },
      body: JSON.stringify({ action: 'organization.transition', payload: { id: orgId, status: 'SUSPENDED', reason: 'tenant trying platform' } }),
    });
    return { status: res.status, body: (await res.text()).slice(0, 240) };
  }, rivalId);
  record('PH-SEC-03', forged.status >= 400 ? 'pass' : 'fail', JSON.stringify(forged));

  const portal = await tp.evaluate(async () => {
    const url = `/api/trpc/pharmacySupplierLinks.get?input=${encodeURIComponent(JSON.stringify({ json: { token: 'not-a-real-token' } }))}`;
    const res = await fetch(url);
    return { status: res.status, body: (await res.text()).slice(0, 250) };
  });
  record('PH-SEC-02', portal.status >= 400 ? 'pass' : 'fail', JSON.stringify(portal));

  // Logout
  await tp.goto(`${CLIFTON}/pharmacy/counter`, { waitUntil: 'domcontentloaded' });
  const signOut = tp.getByRole('button', { name: /sign out|log out/i });
  if (await signOut.count()) {
    await signOut.first().click();
    await tp.waitForTimeout(1500);
  } else {
    await tp.evaluate(async () => { await fetch('/api/auth/signout', { method: 'POST' }); });
    await tp.goto(`${CLIFTON}/pharmacy/counter`, { waitUntil: 'domcontentloaded' });
  }
  record('PH-SEC-04', tp.url().includes('/login') ? 'pass' : 'fail', `After sign-out URL ${tp.url()}`, [await shot(tp, 'tail-logout')]);

  // CRM disable then re-enable. Suspend then resume, last.
  const crm = await platformCommand('organization.module', {
    organizationId: cliftonId,
    moduleId: crmModule,
    status: 'DISABLED',
    reason: 'QA revoke CRM module',
  });
  const t2ctx = await browser.newContext();
  const t2 = await t2ctx.newPage();
  try {
    await signIn(t2, CLIFTON, OWNER_EMAIL, OWNER_PASSWORD);
    const response = await t2.goto(`${CLIFTON}/pharmacy/marketing`, { waitUntil: 'domcontentloaded' });
    const text = await dump(t2, 'tail-crm-disabled');
    const denied = /not available|unavailable|not enabled|licence|license|permission|module/i.test(text);
    record('PH-RV-01', crm.status < 400 && (response?.status() === 403 || denied) ? 'pass' : 'fail', `module HTTP ${crm.status} ${JSON.stringify(crm.json).slice(0, 180)} page ${response?.status()} ${text.replace(/\s+/g, ' ').slice(0, 240)}`, [await shot(t2, 'tail-crm-disabled')]);
  } catch (error) {
    record('PH-RV-01', 'fail', `${error.message} module ${crm.status}`);
  }
  const crmOn = await platformCommand('organization.module', {
    organizationId: cliftonId,
    moduleId: crmModule,
    status: 'ENABLED',
    reason: 'QA restore CRM module',
  });
  record('PH-RV-02', crmOn.status < 400 ? 'pass' : 'fail', `HTTP ${crmOn.status} ${JSON.stringify(crmOn.json).slice(0, 200)}`);
  await t2ctx.close();

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
  await sp.getByRole('button', { name: /sign in/i }).click();
  await sp.waitForTimeout(4000);
  const stext = await dump(sp, 'tail-suspended-login');
  record(
    'PH-RV-03',
    suspendedStatus === 'SUSPENDED' && (sp.url().includes('/login') || /unavailable|suspended/i.test(stext)) ? 'pass' : 'fail',
    `db=${suspendedStatus} HTTP ${suspend.status} url=${sp.url()} text=${stext.replace(/\s+/g, ' ').slice(0, 240)} body=${JSON.stringify(suspend.json).slice(0, 240)}`,
    [await shot(sp, 'tail-suspended')]
  );
  const resume = await platformCommand('organization.transition', {
    id: cliftonId,
    status: 'ONBOARDING',
    reason: 'QA resume Clifton after suspension',
  });
  const resumed = sql(`SELECT status FROM organizations WHERE id='${cliftonId}'`);
  record('PH-RV-04', resumed === 'ONBOARDING' && resume.status < 400 ? 'pass' : 'fail', `db=${resumed} HTTP ${resume.status} ${JSON.stringify(resume.json).slice(0, 240)}`);
  await suspendedLogin.close();

  await browser.close();
  console.log('TAIL_DONE');
}

main().catch((error) => {
  console.error(error);
  record('TAIL-CRASH', 'fail', error.stack || error.message);
  process.exit(1);
});
