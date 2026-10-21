/**
 * Restaurant QA runner. Drives the real dev server. Does not modify product code.
 * Writes qa/restaurants/evidence/results.json and screenshots.
 */
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import AxeBuilder from '@axe-core/playwright';
import { chromium, type BrowserContext, type Page } from '@playwright/test';

const TENANT = 'http://devfathom.localhost:3000';
const ADMIN = 'http://admin.localhost:3000';
const EVIDENCE = '/workspace/qa/restaurants/evidence';
const OWNER_EMAIL = 'qa-karahi-owner@example.com';
const OWNER_PASSWORD = 'QaRestaurant!Owner2026';
const ESSENTIALS_EMAIL = 'qa-essentials-owner@example.com';
const CASHIER_EMAIL = 'qa-karahi-cashier@example.com';
const KITCHEN_EMAIL = 'qa-karahi-kitchen@example.com';
const SERVER_EMAIL = 'qa-karahi-server@example.com';
const STAFF_PASSWORD = 'QaRestaurant!Staff2026';

type Status = 'pass' | 'fail' | 'blocked';
type Result = {
  id: string;
  status: Status;
  notes: string;
  evidence: string[];
};

const results: Result[] = [];
const notes: string[] = [];

function loadEnv(path: string) {
  const text = readFileSync(path, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq);
    let value = trimmed.slice(eq + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}

function record(id: string, status: Status, note: string, evidence: string[] = []) {
  results.push({ id, status, notes: note, evidence });
  console.log(`[${status}] ${id} — ${note}`);
}

function shotName(name: string) {
  return `${EVIDENCE}/${name}.png`;
}

async function shot(page: Page, name: string) {
  const path = shotName(name);
  await page.screenshot({ path, fullPage: false });
  return path;
}

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
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
  return Buffer.from(out);
}

function totp(secret: string, now = Date.now()): string {
  const counter = Math.floor(now / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (bin % 1_000_000).toString().padStart(6, '0');
}

function sql(query: string): string {
  const run = spawnSync(
    'psql',
    ['-h', '127.0.0.1', '-U', 'postgres', '-d', 'devfathom', '-At', '-c', query],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'postgres' } }
  );
  if (run.status !== 0) throw new Error(run.stderr || run.stdout);
  return run.stdout.trim();
}

async function axe(page: Page, id: string, name: string) {
  const path = shotName(name);
  await page.screenshot({ path, fullPage: false });
  let violations: { id: string; impact: string | null; help: string; nodes: number }[] = [];
  try {
    const scan = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    violations = scan.violations
      .filter((item) => item.impact === 'critical' || item.impact === 'serious')
      .map((item) => ({
        id: item.id,
        impact: item.impact,
        help: item.help,
        nodes: item.nodes.length,
      }));
  } catch (error) {
    record(id, 'blocked', `Axe could not run: ${error instanceof Error ? error.message : error}`, [path]);
    return;
  }
  if (violations.length) {
    record(
      id,
      'fail',
      violations.map((item) => `${item.impact} ${item.id} (${item.nodes}) ${item.help}`).join('; '),
      [path]
    );
  } else {
    record(id, 'pass', 'No serious or critical axe violations.', [path]);
  }
}

async function bodyText(page: Page) {
  return page.locator('body').innerText({ timeout: 15000 }).catch(() => '');
}

async function platformLogin(page: Page) {
  await page.goto(`${ADMIN}/platform/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('#platform-email').fill(process.env.PLATFORM_ADMIN_EMAIL!);
  await page.locator('#platform-password').fill(process.env.PLATFORM_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Continue to control desk' }).click();
  const setup = page.getByRole('button', { name: 'Set up authenticator' });
  const desk = page.getByRole('heading', { name: /control desk|organizations|platform/i });
  await Promise.race([
    setup.waitFor({ state: 'visible', timeout: 20000 }),
    page.waitForURL(/\/platform(?!\/login)/, { timeout: 20000 }),
  ]).catch(() => undefined);
  if (await setup.isVisible().catch(() => false)) {
    await setup.click();
    const secret = (await page.locator('code').first().innerText()).trim();
    await page.locator('#enrollment-code').fill(totp(secret));
    await page.getByRole('button', { name: 'Verify authenticator' }).click();
    await page.getByRole('button', { name: /I saved my codes/ }).click();
  }
  await page.waitForURL(/\/platform(?!\/login)/, { timeout: 20000 });
}

async function fillRestaurantForm(
  page: Page,
  input: {
    displayName: string;
    legalName: string;
    slug: string;
    packageMatch: RegExp;
    branch: string;
    address: string;
    cutoff: string;
    contact: string;
    contactEmail: string;
    admin: string;
    adminEmail: string;
    seats: string;
  }
) {
  await page.goto(`${ADMIN}/platform/organizations/new`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('link', { name: 'Continue as Restaurant' }).click();
  await page.getByRole('heading', { name: 'Organization and tenant owner' }).waitFor();
  const form = page.locator('form').filter({ has: page.locator('input[name="slug"]') });
  await form.locator('input[name="displayName"]').fill(input.displayName);
  await form.locator('input[name="legalName"]').fill(input.legalName);
  await form.locator('input[name="slug"]').fill(input.slug);
  const packageSelect = form.locator('select[name="packageId"]');
  const options = await packageSelect.locator('option').allTextContents();
  const match = options.find((label) => input.packageMatch.test(label));
  if (!match) throw new Error(`Package not listed. Options: ${options.join(' | ')}`);
  await packageSelect.selectOption({ label: match });
  await form.locator('input[name="seatLimit"]').fill(input.seats);
  await form.locator('input[name="currency"]').fill('PKR');
  await form.locator('input[name="firstBranchName"]').fill(input.branch);
  await form.locator('input[name="firstBranchAddress"]').fill(input.address);
  await form.locator('input[name="businessDayCutoff"]').fill(input.cutoff);
  await form.locator('input[name="primaryContactName"]').fill(input.contact);
  await form.locator('input[name="primaryContactEmail"]').fill(input.contactEmail);
  await form.locator('input[name="adminName"]').fill(input.admin);
  await form.locator('input[name="adminEmail"]').fill(input.adminEmail);
  await form.locator('input[name="adminPassword"]').fill(OWNER_PASSWORD);
  return form;
}

async function submitControl(page: Page, buttonName: string) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/api/platform/control') && response.request().method() === 'POST',
    { timeout: 30000 }
  );
  await page.getByRole('button', { name: buttonName }).click();
  const response = await responsePromise;
  const body = await response.json().catch(() => ({}));
  return { status: response.status(), body };
}

async function tenantLogin(page: Page, email: string, password: string) {
  await page.goto(`${TENANT}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForTimeout(1500);
  const choice = page.getByRole('button', { name: /QA Karahi|DevFathom/i });
  if (await choice.count()) {
    const exact = page.getByRole('button', { name: new RegExp(email.includes('essentials') ? 'Essentials' : 'Karahi House') });
    if (await exact.count()) await exact.first().click();
  }
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 25000 });
}

async function trpc(
  context: BrowserContext,
  procedure: string,
  method: 'GET' | 'POST',
  jsonBody?: unknown
) {
  const headers: Record<string, string> = {};
  if (method === 'POST') headers['content-type'] = 'application/json';
  const response = await context.request.fetch(
    method === 'GET'
      ? `${TENANT}/api/trpc/${procedure}`
      : `${TENANT}/api/trpc/${procedure}`,
    {
      method,
      headers,
      data: method === 'POST' ? { json: jsonBody ?? {} } : undefined,
    }
  );
  const text = await response.text();
  return { status: response.status(), text: text.slice(0, 2000) };
}

async function main() {
  loadEnv('/workspace/.env.local');
  mkdirSync(EVIDENCE, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const platform = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await platform.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  try {
    const loginHead = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `${TENANT}/login`], {
      encoding: 'utf8',
    });
    const platformHead = spawnSync(
      'curl',
      ['-s', '-o', '/dev/null', '-w', '%{http_code}', `${ADMIN}/platform/login`],
      { encoding: 'utf8' }
    );
    const seeded = sql("SELECT count(*) FROM organizations WHERE slug = 'devfathom';");
    record(
      'SET-02',
      loginHead.stdout === '200' && platformHead.stdout === '200' && seeded === '1' ? 'pass' : 'fail',
      `tenant login HTTP ${loginHead.stdout}, platform login HTTP ${platformHead.stdout}, agency orgs ${seeded}`
    );

    await platformLogin(page);
    await shot(page, 'platform-home');
    record(
      'SET-03',
      page.url().includes('/platform') ? 'pass' : 'fail',
      `Platform session landed on ${page.url()}. MFA enrollment was completed in this local database when the product required it. docs/LOCAL_SETUP.md does not mention authenticator enrollment.`
    );

    await page.goto(`${ADMIN}/platform/organizations/new`, { waitUntil: 'domcontentloaded' });
    const typeText = await bodyText(page);
    await shot(page, 'onb-type-chooser');
    const types = ['Agency', 'Restaurant', 'Pharmacy', 'Hospitality'].every((label) =>
      typeText.includes(label)
    );
    record(
      'ONB-01',
      types && /no type is preselected/i.test(typeText) ? 'pass' : 'fail',
      types ? 'Type chooser shows four verticals and says nothing is preselected.' : typeText.slice(0, 400)
    );

    await page.getByRole('link', { name: 'Continue as Restaurant' }).click();
    await page.getByRole('heading', { name: 'Organization and tenant owner' }).waitFor();
    const formText = await bodyText(page);
    const dedicatedVisible = await page.getByText('Dedicated enterprise').count();
    await shot(page, 'onb-restaurant-form');
    const requiredBits = [
      'First branch name',
      'First branch address',
      'Business day cutoff',
      'Create onboarding record',
      'ONBOARDING',
    ].every((bit) => formText.includes(bit));
    const packageLabels = await page.locator('select[name="packageId"] option').allTextContents();
    const onlyRestaurant = packageLabels.every((label) => /restaurant/i.test(label));
    record(
      'ONB-02',
      requiredBits && onlyRestaurant && dedicatedVisible === 0 ? 'pass' : 'fail',
      `Packages: ${packageLabels.join(' | ')}. Dedicated controls: ${dedicatedVisible}. Required copy present: ${requiredBits}.`
    );

    const empty = page.locator('form').filter({ has: page.locator('input[name="slug"]') });
    await empty.locator('input[name="displayName"]').fill('');
    await empty.locator('input[name="slug"]').fill('');
    await page.getByRole('button', { name: 'Create onboarding record' }).click();
    await page.waitForTimeout(500);
    const stillOnForm = page.url().includes('/organizations/new');
    record(
      'ONB-03',
      stillOnForm ? 'pass' : 'fail',
      stillOnForm ? 'Empty submit stayed on the onboarding form.' : `Navigated to ${page.url()}`
    );

    const created = await fillRestaurantForm(page, {
      displayName: 'QA Karahi House',
      legalName: 'QA Karahi House (Pvt) Ltd',
      slug: 'qa-karahi-house',
      packageMatch: /Enterprise/,
      branch: 'Clifton',
      address: '14 Sea View, Karachi',
      cutoff: '04:00',
      contact: 'Ayesha Khan',
      contactEmail: 'qa-karahi-contact@example.com',
      admin: 'Ayesha Khan',
      adminEmail: OWNER_EMAIL,
      seats: '25',
    });
    const create = await submitControl(page, 'Create onboarding record');
    if (create.status !== 200) {
      await shot(page, 'onb-create-failed');
      record('ONB-04', 'fail', `Create returned ${create.status}: ${JSON.stringify(create.body).slice(0, 800)}`);
    } else {
      await page.waitForURL(/\/platform\/organizations\/(?!new)/, { timeout: 20000 });
      await shot(page, 'onb-org-detail');
      const detail = await bodyText(page);
      const row = sql(
        "SELECT status || '|' || vertical || '|' || COALESCE(currency,'') FROM organizations WHERE slug = 'qa-karahi-house';"
      );
      const branch = sql(
        "SELECT name || '|' || code || '|' || \"isDefault\"::text || '|' || \"businessDayCutoff\" FROM restaurant_branches rb JOIN organizations o ON o.id = rb.\"organizationId\" WHERE o.slug = 'qa-karahi-house';"
      );
      record(
        'ONB-04',
        row.startsWith('ONBOARDING|RESTAURANT') && branch.includes('Clifton|MAIN|true|04:00')
          ? 'pass'
          : 'fail',
        `DB ${row}; branch ${branch}. Page includes ONBOARDING: ${detail.includes('ONBOARDING')}.`
      );
    }

    await fillRestaurantForm(page, {
      displayName: 'QA Duplicate',
      legalName: 'QA Duplicate Ltd',
      slug: 'qa-karahi-house',
      packageMatch: /Enterprise/,
      branch: 'Duplicate',
      address: '1 Duplicate Road',
      cutoff: '04:00',
      contact: 'Dup',
      contactEmail: 'qa-dup-contact@example.com',
      admin: 'Dup Admin',
      adminEmail: 'qa-dup-admin@example.com',
      seats: '10',
    });
    const duplicate = await submitControl(page, 'Create onboarding record');
    await shot(page, 'onb-duplicate-slug');
    const dupCount = sql("SELECT count(*) FROM organizations WHERE slug = 'qa-karahi-house';");
    record(
      'ONB-05',
      duplicate.status >= 400 && dupCount === '1' ? 'pass' : 'fail',
      `HTTP ${duplicate.status} ${JSON.stringify(duplicate.body).slice(0, 400)}. Rows ${dupCount}.`
    );

    const agencyPackage = sql(
      "SELECT id FROM platform_packages WHERE vertical = 'AGENCY' AND active = true ORDER BY name LIMIT 1;"
    );
    const mismatch = await platform.request.post(`${ADMIN}/api/platform/control`, {
      headers: { origin: ADMIN, 'content-type': 'application/json' },
      data: {
        action: 'organization.create',
        payload: {
          vertical: 'RESTAURANT',
          slug: 'qa-package-mismatch',
          legalName: 'Mismatch Ltd',
          displayName: 'Mismatch',
          deploymentMode: 'SHARED',
          packageId: agencyPackage,
          timezone: 'Asia/Karachi',
          currency: 'PKR',
          seatLimit: 5,
          primaryContactName: 'Mismatch',
          primaryContactEmail: 'qa-mismatch-contact@example.com',
          adminName: 'Mismatch Admin',
          adminEmail: 'qa-mismatch-admin@example.com',
          adminPassword: OWNER_PASSWORD,
          firstBranchName: 'Mismatch Branch',
          firstBranchAddress: '1 Mismatch Road',
          businessDayCutoff: '04:00',
        },
      },
    });
    const mismatchBody = await mismatch.text();
    const mismatchRows = sql("SELECT count(*) FROM organizations WHERE slug = 'qa-package-mismatch';");
    record(
      'ONB-06',
      mismatch.status() === 400 && /not available/i.test(mismatchBody) && mismatchRows === '0'
        ? 'pass'
        : 'fail',
      `HTTP ${mismatch.status()} ${mismatchBody.slice(0, 400)}. Rows ${mismatchRows}.`
    );

    const orgId = sql("SELECT id FROM organizations WHERE slug = 'qa-karahi-house';");
    await page.goto(`${ADMIN}/platform/organizations/${orgId}`, { waitUntil: 'domcontentloaded' });
    const life = page.locator('#lifecycle');
    await life.locator('select[name="status"]').selectOption('ACTIVE');
    await life.locator('textarea[name="reason"]').fill('QA activation before readiness is complete.');
    const early = await submitControl(page, 'Apply lifecycle change');
    await shot(page, 'lcy-early-activation');
    const statusAfterEarly = sql("SELECT status FROM organizations WHERE slug = 'qa-karahi-house';");
    record(
      'LCY-01',
      early.status >= 400 && statusAfterEarly === 'ONBOARDING' ? 'pass' : 'fail',
      `HTTP ${early.status} ${JSON.stringify(early.body).slice(0, 700)}. Status ${statusAfterEarly}.`
    );

    const readiness = page.locator('section[aria-labelledby="restaurant-readiness"]');
    await readiness.locator('input[name="branchName"]').fill('Clifton');
    await readiness.locator('input[name="address"]').fill('14 Sea View, Karachi');
    await readiness.locator('input[name="businessDayCutoff"]').fill('04:00');
    await readiness.locator('input[name="taxPolicyReference"]').fill('QA-TAX-2026-01');
    await readiness.locator('input[name="taxAcknowledged"]').check();
    await readiness.locator('input[name="paymentPolicyReference"]').fill('QA-PAY-MOCK-2026-01');
    await readiness.locator('input[name="paymentAcknowledged"]').check();
    await readiness.locator('input[name="devicePolicyReference"]').fill('QA-DEVICE-2026-01');
    await readiness.locator('input[name="deviceAcknowledged"]').check();
    await readiness.locator('input[name="operatorPolicyReference"]').fill('QA-OPERATOR-2026-01');
    await readiness.locator('input[name="operatorAcknowledged"]').check();
    const saved = await submitControl(page, 'Save Restaurant readiness');
    await page.reload({ waitUntil: 'domcontentloaded' });
    const ackCount = sql(
      `SELECT count(*) FROM restaurant_activation_acknowledgements WHERE "organizationId" = '${orgId}';`
    );
    await shot(page, 'lcy-readiness');
    record(
      'LCY-02',
      saved.status === 200 && ackCount === '4' ? 'pass' : 'fail',
      `HTTP ${saved.status} ${JSON.stringify(saved.body).slice(0, 400)}. Acknowledgements ${ackCount}.`
    );

    const sharedButton = page.getByRole('button', { name: 'Use shared deployment' });
    if (await sharedButton.count()) {
      const shared = await submitControl(page, 'Use shared deployment');
      notes.push(`shared deployment click ${shared.status} ${JSON.stringify(shared.body).slice(0, 300)}`);
    }
    const jobs = spawnSync('bun', ['run', 'platform:jobs', '--', '--max-jobs=25'], {
      cwd: '/workspace',
      encoding: 'utf8',
      env: process.env,
    });
    notes.push(`platform jobs exit ${jobs.status} ${(jobs.stdout || '').slice(-400)} ${(jobs.stderr || '').slice(-400)}`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    const deployment = sql(
      `SELECT status || '|' || COALESCE(url,'') FROM organization_deployments WHERE "organizationId" = '${orgId}' AND environment = 'production';`
    );
    await shot(page, 'lcy-deployment');
    record(
      'LCY-03',
      deployment.startsWith('READY|') ? 'pass' : 'fail',
      `Deployment ${deployment || 'none'}. Jobs exit ${jobs.status}.`
    );

    await page.locator('#lifecycle select[name="status"]').selectOption('ACTIVE');
    await page.locator('#lifecycle textarea[name="reason"]').fill('QA activation after readiness acknowledgements.');
    const activated = await submitControl(page, 'Apply lifecycle change');
    await page.reload({ waitUntil: 'domcontentloaded' });
    const activeStatus = sql("SELECT status FROM organizations WHERE slug = 'qa-karahi-house';");
    await shot(page, 'lcy-active');
    record(
      'LCY-04',
      activated.status === 200 && activeStatus === 'ACTIVE' ? 'pass' : 'fail',
      `HTTP ${activated.status} ${JSON.stringify(activated.body).slice(0, 600)}. Status ${activeStatus}.`
    );

    await fillRestaurantForm(page, {
      displayName: 'QA Karahi Essentials',
      legalName: 'QA Karahi Essentials Ltd',
      slug: 'qa-karahi-essentials',
      packageMatch: /Essentials/,
      branch: 'DHA',
      address: '1 Khayaban-e-Ittehad, Karachi',
      cutoff: '05:00',
      contact: 'Essentials Contact',
      contactEmail: 'qa-essentials-contact@example.com',
      admin: 'Essentials Owner',
      adminEmail: ESSENTIALS_EMAIL,
      seats: '8',
    });
    const essentialsCreate = await submitControl(page, 'Create onboarding record');
    let essentialsOk = false;
    if (essentialsCreate.status === 200) {
      const essentialsId = sql("SELECT id FROM organizations WHERE slug = 'qa-karahi-essentials';");
      await page.goto(`${ADMIN}/platform/organizations/${essentialsId}`, { waitUntil: 'domcontentloaded' });
      const ready = page.locator('section[aria-labelledby="restaurant-readiness"]');
      await ready.locator('input[name="taxPolicyReference"]').fill('QA-TAX-ESS-01');
      await ready.locator('input[name="taxAcknowledged"]').check();
      await ready.locator('input[name="paymentPolicyReference"]').fill('QA-PAY-ESS-01');
      await ready.locator('input[name="paymentAcknowledged"]').check();
      await ready.locator('input[name="devicePolicyReference"]').fill('QA-DEV-ESS-01');
      await ready.locator('input[name="deviceAcknowledged"]').check();
      await ready.locator('input[name="operatorPolicyReference"]').fill('QA-OP-ESS-01');
      await ready.locator('input[name="operatorAcknowledged"]').check();
      await submitControl(page, 'Save Restaurant readiness');
      if (await page.getByRole('button', { name: 'Use shared deployment' }).count()) {
        await submitControl(page, 'Use shared deployment');
      }
      spawnSync('bun', ['run', 'platform:jobs', '--', '--max-jobs=25'], {
        cwd: '/workspace',
        encoding: 'utf8',
        env: process.env,
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#lifecycle select[name="status"]').selectOption('ACTIVE');
      await page.locator('#lifecycle textarea[name="reason"]').fill('QA essentials activation for the location cap.');
      const essentialsActive = await submitControl(page, 'Apply lifecycle change');
      const essentialsStatus = sql("SELECT status FROM organizations WHERE slug = 'qa-karahi-essentials';");
      essentialsOk = essentialsActive.status === 200 && essentialsStatus === 'ACTIVE';
      record('LCY-05', essentialsOk ? 'pass' : 'fail', `HTTP ${essentialsActive.status} status ${essentialsStatus}.`);
    } else {
      record(
        'LCY-05',
        'fail',
        `Essentials create HTTP ${essentialsCreate.status} ${JSON.stringify(essentialsCreate.body).slice(0, 500)}`
      );
    }

    const tenant = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const owner = await tenant.newPage();
    const ownerErrors: string[] = [];
    owner.on('pageerror', (error) => ownerErrors.push(error.message));
    try {
      await tenantLogin(owner, OWNER_EMAIL, OWNER_PASSWORD);
      await shot(owner, 'tenant-home');
      record('LCY-04-login', owner.url().includes('/login') ? 'fail' : 'pass', `Owner landed on ${owner.url()}.`);
    } catch (error) {
      await shot(owner, 'tenant-login-failed');
      record('LCY-04-login', 'fail', error instanceof Error ? error.message : String(error));
    }

    const platformOnTenant = await tenant.request.get(`${TENANT}/platform`, { maxRedirects: 0 });
    const controlOnTenant = await tenant.request.post(`${TENANT}/api/platform/control`, {
      headers: { origin: TENANT, 'content-type': 'application/json' },
      data: { action: 'organization.transition', payload: { id: orgId, status: 'SUSPENDED', reason: 'should not run' } },
    });
    record(
      'ONB-07',
      platformOnTenant.status() !== 200 && controlOnTenant.status() === 404 ? 'pass' : 'fail',
      `GET /platform on tenant host ${platformOnTenant.status()} location ${platformOnTenant.headers().location ?? ''}. Control API ${controlOnTenant.status()} ${(await controlOnTenant.text()).slice(0, 200)}.`
    );

    const routes = [
      ['/dashboard', 'dashboard'],
      ['/restaurant/settings/branches', 'branches'],
      ['/restaurant/staff', 'staff'],
      ['/restaurant/staff/roster', 'roster'],
      ['/restaurant/catalog', 'catalog'],
      ['/restaurant/menus', 'menus'],
      ['/restaurant/menu-import', 'menu-import'],
      ['/restaurant/promotions', 'promotions'],
      ['/restaurant/floor', 'floor'],
      ['/restaurant/orders', 'orders'],
      ['/restaurant/delivery', 'delivery'],
      ['/restaurant/catering', 'catering'],
      ['/restaurant/money', 'money'],
      ['/restaurant/inventory', 'inventory'],
      ['/restaurant/purchasing', 'purchasing'],
      ['/restaurant/loyalty', 'loyalty'],
      ['/restaurant/reports', 'reports'],
      ['/restaurant/insights', 'insights'],
      ['/restaurant/notifications', 'notifications'],
      ['/restaurant/tax', 'tax'],
      ['/restaurant/devices', 'devices'],
      ['/restaurant/integrations/cameras', 'cameras'],
      ['/restaurant/sop', 'sop'],
      ['/restaurant/sop/admin', 'sop-admin'],
      ['/restaurant/sop/reports', 'sop-reports'],
      ['/restaurant/growth', 'growth'],
      ['/settings', 'settings'],
      ['/settings/receipts', 'receipts'],
      ['/pos', 'pos'],
      ['/kds', 'kds'],
      ['/pharmacy', 'pharmacy-direct'],
      ['/pharmacy/counter', 'pharmacy-counter'],
    ] as const;

    const routeNotes: string[] = [];
    for (const [path, name] of routes) {
      const started = Date.now();
      const response = await owner.goto(`${TENANT}${path}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await owner.waitForTimeout(400);
      const text = await bodyText(owner);
      const file = await shot(owner, `route-${name}`);
      routeNotes.push(
        `${path} HTTP ${response?.status()} ${Date.now() - started}ms title=${await owner.title()} snippet=${text.replace(/\s+/g, ' ').slice(0, 180)}`
      );
      writeFileSync(`${EVIDENCE}/route-${name}.txt`, text.slice(0, 8000));
      void file;
    }
    writeFileSync(`${EVIDENCE}/route-notes.txt`, routeNotes.join('\n'));

    const nav = await bodyText(owner);
    await owner.goto(`${TENANT}/dashboard`, { waitUntil: 'domcontentloaded' });
    const navText = await bodyText(owner);
    await shot(owner, 'nav-dashboard');
    const pharmacyLinks = ['Onboarding', 'Counter', 'Regulatory'].filter((label) =>
      new RegExp(`\\b${label}\\b`).test(navText)
    );
    record(
      'TNT-02',
      pharmacyLinks.length ? 'fail' : 'pass',
      pharmacyLinks.length
        ? `Pharmacy-looking nav labels present: ${pharmacyLinks.join(', ')}. Confirm against issue 59.`
        : 'Primary navigation text on the dashboard did not include pharmacy Onboarding, Counter, or Regulatory labels.'
    );

    const branchText = readFileSync(`${EVIDENCE}/route-branches.txt`, 'utf8');
    record(
      'BRN-01',
      /Clifton/.test(branchText) && /MAIN/.test(branchText) ? 'pass' : 'fail',
      branchText.replace(/\s+/g, ' ').slice(0, 500)
    );

    const catalogText = readFileSync(`${EVIDENCE}/route-catalog.txt`, 'utf8');
    record(
      'CAT-01',
      /categor/i.test(catalogText) && !/application error/i.test(catalogText) ? 'pass' : 'fail',
      catalogText.replace(/\s+/g, ' ').slice(0, 400)
    );

    async function addCategory(name: string) {
      await owner.goto(`${TENANT}/restaurant/catalog`, { waitUntil: 'domcontentloaded' });
      await owner.getByRole('tab', { name: /Categories/ }).click();
      await owner.getByRole('button', { name: 'Add category' }).first().click();
      const dialog = owner.getByRole('dialog');
      await dialog.locator('input[name="name"]').fill(name);
      const responsePromise = owner.waitForResponse(
        (response) => response.url().includes('/api/trpc') && response.request().method() === 'POST'
      );
      await dialog.getByRole('button', { name: 'Add category' }).click();
      const response = await responsePromise;
      await owner.waitForTimeout(500);
      return response.status();
    }

    try {
      const categoryStatus = await addCategory('Mains');
      await shot(owner, 'cat-mains');
      const stored = sql(
        `SELECT name FROM restaurant_categories c JOIN organizations o ON o.id = c."organizationId" WHERE o.slug = 'qa-karahi-house' AND c.name = 'Mains';`
      );
      record('CAT-02', categoryStatus === 200 && stored === 'Mains' ? 'pass' : 'fail', `HTTP ${categoryStatus}, stored ${stored || 'missing'}. Product create continues separately.`);
    } catch (error) {
      await shot(owner, 'cat-mains-failed');
      record('CAT-02', 'fail', error instanceof Error ? error.message : String(error));
    }

    try {
      await owner.goto(`${TENANT}/restaurant/catalog`, { waitUntil: 'domcontentloaded' });
      await owner.getByRole('tab', { name: /Categories/ }).click();
      await owner.getByRole('button', { name: 'Add category' }).first().click();
      const dialog = owner.getByRole('dialog');
      await dialog.locator('input[name="name"]').fill('');
      await dialog.getByRole('button', { name: 'Add category' }).click();
      const invalid = await dialog.locator('input[name="name"]').evaluate((element) =>
        (element as HTMLInputElement).validity.valid
      );
      record('CAT-04', invalid === false ? 'pass' : 'fail', `Empty category name validity.valid=${invalid}.`);
      await owner.keyboard.press('Escape');
    } catch (error) {
      record('CAT-04', 'fail', error instanceof Error ? error.message : String(error));
    }

    try {
      const xssName = '<img src=x onerror=alert(1)>';
      await addCategory(xssName);
      await owner.goto(`${TENANT}/restaurant/catalog`, { waitUntil: 'domcontentloaded' });
      await owner.getByRole('tab', { name: /Categories/ }).click();
      const html = await owner.content();
      const injected = html.includes('<img src=x onerror=alert(1)>') && !html.includes('&lt;img src=x onerror=alert(1)&gt;');
      await shot(owner, 'cat-xss');
      record(
        'CAT-05',
        injected ? 'fail' : 'pass',
        injected ? 'Category name was parsed as HTML.' : 'XSS category name was escaped in the catalog DOM.'
      );
    } catch (error) {
      record('CAT-05', 'fail', error instanceof Error ? error.message : String(error));
    }

    const ordersText = readFileSync(`${EVIDENCE}/route-orders.txt`, 'utf8');
    record(
      'ORD-01',
      !/undefined|NaN|\[object Object\]/.test(ordersText) && ordersText.length > 40 ? 'pass' : 'fail',
      ordersText.replace(/\s+/g, ' ').slice(0, 400)
    );
    const loyaltyText = readFileSync(`${EVIDENCE}/route-loyalty.txt`, 'utf8');
    record('LOY-01', loyaltyText.length > 40 && !/application error/i.test(loyaltyText) ? 'pass' : 'fail', loyaltyText.replace(/\s+/g, ' ').slice(0, 400));
    const inventoryText = readFileSync(`${EVIDENCE}/route-inventory.txt`, 'utf8');
    record('INV-01', inventoryText.length > 40 && !/application error/i.test(inventoryText) ? 'pass' : 'fail', inventoryText.replace(/\s+/g, ' ').slice(0, 400));
    const floorText = readFileSync(`${EVIDENCE}/route-floor.txt`, 'utf8');
    record('FLR-01', /floor/i.test(floorText) && !/application error/i.test(floorText) ? 'pass' : 'fail', floorText.replace(/\s+/g, ' ').slice(0, 400));
    const menuImport = readFileSync(`${EVIDENCE}/route-menu-import.txt`, 'utf8');
    const sidebarHasImport = /menu import/i.test(navText);
    record(
      'MNU-04',
      /import/i.test(menuImport) ? (sidebarHasImport ? 'pass' : 'fail') : 'fail',
      `Direct page loaded: ${/import/i.test(menuImport)}. Sidebar mentions menu import: ${sidebarHasImport}. ${menuImport.replace(/\s+/g, ' ').slice(0, 300)}`
    );
    const notifications = readFileSync(`${EVIDENCE}/route-notifications.txt`, 'utf8');
    record(
      'NTF-01',
      /webhook|endpoint|notification/i.test(notifications) ? 'pass' : 'fail',
      notifications.replace(/\s+/g, ' ').slice(0, 400)
    );
    const whatsappHits = [notifications, loyaltyText, navText].some((text) => /whatsapp/i.test(text));
    record(
      'NTF-03',
      whatsappHits ? 'fail' : 'pass',
      whatsappHits
        ? 'WhatsApp copy appeared on a restaurant surface.'
        : 'No WhatsApp control on notifications, loyalty, or the dashboard shell.'
    );
    const growth = readFileSync(`${EVIDENCE}/route-growth.txt`, 'utf8');
    record('CFG-05', growth.length > 20 && !/application error/i.test(growth) ? 'pass' : 'fail', growth.replace(/\s+/g, ' ').slice(0, 300));
    const kds = readFileSync(`${EVIDENCE}/route-kds.txt`, 'utf8');
    record('KDS-01', !/Chicken Karahi/.test(kds) ? 'pass' : 'fail', kds.replace(/\s+/g, ' ').slice(0, 300));

    const unauth = await browser.newContext();
    const probes = [
      ['GET', '/api/restaurant/orders/open-orders'],
      ['POST', '/api/restaurant/orders/open'],
      ['POST', '/api/restaurant/checkout/tender'],
      ['POST', '/api/restaurant/checkout/refund'],
      ['GET', '/api/restaurant/kds/queue'],
      ['GET', '/api/trpc/restaurantCatalog.listCategories'],
    ] as const;
    const probeNotes: string[] = [];
    let unauthOk = true;
    for (const [method, path] of probes) {
      const response = await unauth.request.fetch(`${TENANT}${path}`, {
        method,
        headers: method === 'POST' ? { 'content-type': 'application/json', origin: TENANT } : {},
        data: method === 'POST' ? {} : undefined,
      });
      const text = (await response.text()).slice(0, 180);
      probeNotes.push(`${method} ${path} ${response.status()} ${text}`);
      if (![401, 403].includes(response.status())) unauthOk = false;
    }
    record('SEC-01', unauthOk ? 'pass' : 'fail', probeNotes.join(' || '));

    const list = await trpc(tenant, 'restaurantCatalog.listCategories', 'GET');
    record(
      'TNT-04-tenant-session',
      list.status === 200 ? 'pass' : 'fail',
      `Owner listCategories ${list.status} ${list.text.slice(0, 300)}`
    );
    const noCookieList = await unauth.request.get(`${TENANT}/api/trpc/restaurantCatalog.listCategories`);
    const platformCookieList = await platform.request.get(`${TENANT}/api/trpc/restaurantCatalog.listCategories`);
    record(
      'TNT-04',
      [401, 403].includes(noCookieList.status()) && [401, 403].includes(platformCookieList.status())
        ? 'pass'
        : 'fail',
      `no cookie ${noCookieList.status()} ${(await noCookieList.text()).slice(0, 160)}; platform cookie ${platformCookieList.status()} ${(await platformCookieList.text()).slice(0, 160)}`
    );

    const agency = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const alex = await agency.newPage();
    try {
      await tenantLogin(alex, 'alex@company.com', process.env.SEED_PASSWORD!);
      await alex.goto(`${TENANT}/restaurant/catalog`, { waitUntil: 'domcontentloaded' });
      await shot(alex, 'agency-catalog');
      const agencyList = await trpc(agency, 'restaurantCatalog.listCategories', 'GET');
      const agencyText = await bodyText(alex);
      const leaked = /Mains|Chicken Karahi|Clifton/.test(agencyText) || /Mains/.test(agencyList.text);
      record(
        'TNT-01',
        leaked ? 'fail' : 'pass',
        `Agency catalog HTTP list ${agencyList.status}. Leaked names: ${leaked}. Snippet ${agencyText.replace(/\s+/g, ' ').slice(0, 300)}`
      );
    } catch (error) {
      record('TNT-01', 'fail', error instanceof Error ? error.message : String(error));
    }

    if (essentialsOk) {
      const essentials = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const essPage = await essentials.newPage();
      try {
        await tenantLogin(essPage, ESSENTIALS_EMAIL, OWNER_PASSWORD);
        await essPage.goto(`${TENANT}/restaurant/loyalty`, { waitUntil: 'domcontentloaded' });
        const essLoyalty = await bodyText(essPage);
        await shot(essPage, 'essentials-loyalty');
        const denied = /not enabled|permission|module|unavailable|forbidden/i.test(essLoyalty);
        record('LOY-04', denied ? 'pass' : 'fail', essLoyalty.replace(/\s+/g, ' ').slice(0, 400));
        await essPage.goto(`${TENANT}/restaurant/settings/branches`, { waitUntil: 'domcontentloaded' });
        await shot(essPage, 'essentials-branches');
        const essBranch = await bodyText(essPage);
        record('BRN-04', /DHA/.test(essBranch) ? 'pass' : 'fail', `Essentials branch page snippet ${essBranch.replace(/\s+/g, ' ').slice(0, 300)}. Second-branch attempt follows if a create control exists.`);
        const createBranch = essPage.getByRole('button', { name: /create branch|add branch/i });
        if (await createBranch.count()) {
          await createBranch.first().click();
          record('BRN-04-control', 'pass', 'A create-branch control is present for the cap test.');
        } else {
          record('BRN-04-control', 'fail', 'No create-branch control found, so the location cap could not be exercised in the UI.');
        }
      } catch (error) {
        record('LOY-04', 'fail', error instanceof Error ? error.message : String(error));
      }
      await essentials.close();
    }

    await axe(owner, 'A11Y-01', 'axe-catalog');
    await owner.setViewportSize({ width: 390, height: 844 });
    await owner.goto(`${TENANT}/dashboard`, { waitUntil: 'domcontentloaded' });
    const overflow = await owner.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    await shot(owner, 'mobile-dashboard');
    record('UX-02', overflow ? 'fail' : 'pass', overflow ? 'Dashboard overflows horizontally at 390px.' : 'Dashboard has no horizontal overflow at 390px.');
    await owner.setViewportSize({ width: 1440, height: 900 });

    const warmed: string[] = [];
    let slow = false;
    for (const path of ['/dashboard', '/restaurant/catalog', '/restaurant/orders', '/restaurant/reports']) {
      const started = Date.now();
      await owner.goto(`${TENANT}${path}`, { waitUntil: 'domcontentloaded' });
      const elapsed = Date.now() - started;
      warmed.push(`${path} ${elapsed}ms`);
      if (elapsed > 8000) slow = true;
    }
    record('PERF-01', slow ? 'fail' : 'pass', warmed.join(', '));

    writeFileSync(`${EVIDENCE}/owner-pageerrors.txt`, ownerErrors.join('\n'));
    writeFileSync(`${EVIDENCE}/platform-console.txt`, consoleErrors.join('\n'));
    await agency.close();
    await unauth.close();
    await tenant.close();
  } catch (error) {
    await shot(page, 'runner-fatal').catch(() => undefined);
    notes.push(`FATAL ${error instanceof Error ? error.stack : String(error)}`);
    console.error(error);
  } finally {
    await browser.close();
    writeFileSync(
      `${EVIDENCE}/results.json`,
      JSON.stringify({ results, notes, commit: 'fa3658b715bf2e672f7e38f983b558d8d86b5a75' }, null, 2)
    );
  }
}

await main();
