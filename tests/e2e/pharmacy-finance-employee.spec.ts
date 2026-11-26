import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { hash } from 'bcryptjs';
import pg from 'pg';
import { PHARMACY_ROLE_TEMPLATES } from '../../src/lib/vertical-catalog';

test('a Finance employee reads the branch journal and records a supplier payment', async ({
  page,
  browser,
  baseURL,
}, info) => {
  test.setTimeout(240_000);
  const owner =
    process.env.PHARMACY_DB_TEST_OWNER_URL ?? process.env.RESTAURANT_ACTOR_OWNER_DATABASE_URL;
  const runtime = process.env.DATABASE_URL;
  if (!owner || !runtime || !baseURL)
    throw new Error('Local test owner, runtime and app URLs are required.');
  const target = new URL(owner);
  const app = new URL(baseURL);
  const local = ['localhost', '127.0.0.1'];
  if (
    !local.includes(target.hostname) ||
    !local.includes(app.hostname) ||
    !/(?:^|[_-])(test|e2e)(?:[_-]|$)/.test(target.pathname.slice(1)) ||
    new URL(runtime).host !== target.host ||
    new URL(runtime).pathname !== target.pathname
  )
    throw new Error(
      'Finance browser fixtures require the same disposable local database for both roles.'
    );
  const org = 'finance-' + randomUUID().slice(0, 8);
  const branch = org + '-branch';
  const user = org + '-user';
  const email = user + '@example.test';
  const password = randomUUID();
  const db = new pg.Client({ connectionString: owner });
  await db.connect();
  try {
    const identity = await db.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user'
    );
    expect(identity.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.is_platform_admin','true',true)");
    await db.query(
      `INSERT INTO organizations (id,slug,"legalName","displayName",vertical,status,"deploymentMode","createdAt","updatedAt") VALUES ($1,$1,'Synthetic Finance Pharmacy','Synthetic Finance Pharmacy','PHARMACY','ACTIVE','SHARED',now(),now())`,
      [org]
    );
    await db.query(
      `INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'Finance','Finance',now())`,
      [org + '-department', org]
    );
    await db.query(
      `INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt") VALUES ($1,$2,'finance','Finance',true,now())`,
      [org + '-role', org]
    );
    for (const capability of PHARMACY_ROLE_TEMPLATES.find((role) => role.key === 'finance')!
      .capabilities)
      await db.query(
        `INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect) VALUES ($1,$2,$3,$4,'ALLOW')`,
        [randomUUID(), org, org + '-role', capability]
      );
    for (const [person, address] of [
      [user, email],
      [user + '-payer', 'payer-' + email],
    ])
      await db.query(
        `INSERT INTO users (id,"organizationId","organizationRoleId",name,email,password,department,title,role,status,"updatedAt") VALUES ($1,$2,$3,'Test Accountant',$4,$5,'Finance','Accountant','EMPLOYEE','ACTIVE',now())`,
        [person, org, org + '-role', address, await hash(password, 10)]
      );
    for (const [id, name] of [
      [branch, 'Admitted branch'],
      [org + '-other', 'Other branch'],
    ])
      await db.query(
        `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","updatedAt") VALUES ($1,$2,$1,$3,'Test Road','Lahore','PB',now())`,
        [id, org, name]
      );
    for (const person of [user, user + '-payer'])
      await db.query(
        `INSERT INTO pharmacy_branch_assignments (id,"organizationId","branchId","userId","updatedAt") VALUES ($1,$2,$3,$4,now())`,
        [randomUUID(), org, branch, person]
      );
    for (const key of ['pharmacy-core', 'pharmacy-finance', 'pharmacy-reports']) {
      await db.query(
        `INSERT INTO platform_modules (id,key,name,category,band,vertical,"updatedAt") VALUES ($1,$1,$1,'Pharmacy','VERTICAL_OPTIONAL','PHARMACY',now()) ON CONFLICT (key) DO NOTHING`,
        [key]
      );
      await db.query(
        `INSERT INTO organization_modules (id,"organizationId","moduleId",status,"startsAt","updatedAt") SELECT $1,$2,id,'ENABLED',now(),now() FROM platform_modules WHERE key=$3`,
        [randomUUID(), org, key]
      );
    }
    await db.query('COMMIT');
  } finally {
    await db.end();
  }
  app.hostname = org + '.localhost';
  await page.goto(new URL('/login', app).href);
  await page.getByLabel(/email/i).fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(
    (url) => url.pathname != '/login' && !url.pathname.startsWith('/api/auth'),
    { timeout: 60_000 }
  );
  const clientErrors: string[] = [];
  page.on('pageerror', (error) => clientErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') clientErrors.push(message.text());
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('link', { name: 'Finance', exact: true }).click();
  await expect(page).toHaveURL(/\/pharmacy\/finance/);
  const form = page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Post transaction' }) });
  await expect(page.getByRole('heading', { name: 'Trial balance', exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Other branch');
  await form.getByLabel('Reference', { exact: true }).fill(org);
  await form.getByLabel('Amount (PKR)').fill('10.00');
  await form.getByLabel('Posting date').fill(new Date().toISOString().slice(0, 10));
  await form.getByLabel('Counterparty name').fill('Synthetic supplier');
  await form.getByRole('button', { name: 'Post transaction' }).click();
  await expect(page.getByText('Supplier payment draft saved for approval.')).toBeVisible();
  await page.getByRole('button', { name: 'Post supplier payment', exact: true }).click();
  await expect(page.getByText('Someone else must pay an invoice you recorded.')).toBeVisible();
  const payerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await payerContext.newPage();
  page.on('pageerror', (error) => clientErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') clientErrors.push(message.text());
  });
  await page.goto(new URL('/login', app).href);
  await page.getByLabel(/email/i).fill('payer-' + email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((url) => url.pathname != '/login' && !url.pathname.startsWith('/api/auth'));
  await page.getByRole('link', { name: 'Finance', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: org })
    .getByRole('button', { name: 'Post supplier payment' })
    .click();
  await expect(page.getByText('Transaction posted and journal balanced.')).toBeVisible();
  const posted = page.getByRole('row').filter({ hasText: org });
  await expect(posted).toContainText(/supplier payment/i);
  await expect(posted).toContainText('Synthetic supplier');
  await expect(page.getByRole('button', { name: 'Reopen', exact: true })).toHaveCount(0);
  for (const theme of ['light', 'dark'] as const) {
    await page.setViewportSize({ width: 1440, height: 900 });
    const toggle = page.getByRole('button', { name: 'Use ' + theme + ' theme' });
    if (await toggle.isVisible()) await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        await page.emulateMedia({ reducedMotion });
        await expect(page.getByRole('heading', { name: 'Finance', exact: true })).toBeVisible();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
        ).toBe(true);
      }
      const path = info.outputPath(`finance-${theme}-${width}.png`);
      await page.screenshot({ path });
      await info.attach('Finance ' + theme + ' ' + width, {
        path,
        contentType: 'image/png',
      });
    }
  }
  await page.keyboard.press('Tab');
  expect(await page.locator(':focus-visible').count()).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  expect(clientErrors).toEqual([]);
  await payerContext.close();
});
