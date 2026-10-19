import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';
import { PHARMACY_E2E as fixture } from './pharmacy-counter-fixture';
import { resolvePharmacyE2eDatabaseUrl } from '../../scripts/pharmacy-e2e-environment';
import { waitForLoginHydrated } from './fixtures/login-hydration';

const otherOrg = 'org_pharmacy_runtime_other';
const otherUser = 'user_pharmacy_runtime_other';
const otherEmail = 'other-operations@example.test';
const otherBranch = 'branch_pharmacy_runtime_other';

async function platform(work: (db: Client) => Promise<void>) {
  const url = new URL(resolvePharmacyE2eDatabaseUrl());
  if (url.hostname !== '127.0.0.1' || Number(url.port) < 55600 || Number(url.port) > 55699)
    throw new Error('Runtime proof requires an isolated disposable pharmacy lane');
  const db = new Client({ connectionString: url.href });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.is_platform_admin','true',true)");
    await work(db);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    await db.end();
  }
}

async function login(page: Page, email = process.env.PHARMACY_E2E_ADMIN_EMAIL!) {
  await page.goto('/login');
  await waitForLoginHydrated(page);
  await page.getByLabel('Email').fill(email);
  await page
    .getByRole('textbox', { name: 'Password' })
    .fill(process.env.PHARMACY_E2E_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).press('Enter');
  await expect(page).toHaveURL(/\/(dashboard|pharmacy)/, { timeout: 30_000 });
  await page.goto('/pharmacy/counter');
  await expect(page.getByRole('heading', { name: 'Counter', exact: true })).toBeVisible();
}

async function branches(page: Page) {
  return page.request.get('/api/trpc/pharmacySales.counterBranches');
}

test.beforeAll(async () => {
  await platform(async (db) => {
    await db.query(
      `INSERT INTO organizations
      (id,slug,"legalName","displayName",vertical,status,"packageId","updatedAt")
      VALUES ($1,$1,'Other synthetic pharmacy','Other synthetic pharmacy','PHARMACY','ACTIVE',$2,now())
      ON CONFLICT(id) DO NOTHING`,
      [otherOrg, fixture.packageId]
    );
    await db.query(
      `INSERT INTO organization_departments
      (id,"organizationId",key,name,"updatedAt") VALUES ($1,$2,'LEADERSHIP','Leadership',now())
      ON CONFLICT(id) DO NOTHING`,
      [`department_${otherOrg}`, otherOrg]
    );
    await db.query(
      `INSERT INTO users
      (id,"organizationId",name,email,password,role,department,title,status,"updatedAt")
      SELECT $1,$2,'Other synthetic administrator',$3,password,'ADMIN','LEADERSHIP','Admin','ACTIVE',now()
      FROM users WHERE id=$4 ON CONFLICT(id) DO UPDATE SET password=EXCLUDED.password`,
      [otherUser, otherOrg, otherEmail, fixture.adminId]
    );
    await db.query(
      `INSERT INTO pharmacy_branches
      (id,"organizationId",code,name,"addressLine",city,"provinceCode","updatedAt")
      VALUES ($1,$2,'OTHER','Other branch','Synthetic','Synthetic','PB',now()) ON CONFLICT(id) DO NOTHING`,
      [otherBranch, otherOrg]
    );
  });
});

for (const mode of ['module', 'package'] as const) {
  test(`${mode} revocation denies an existing cookie on API and reload; other tenant retains access`, async ({
    page,
    browser,
  }) => {
    const otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    try {
      await login(page);
      await login(other, otherEmail);
      const initial = await branches(page);
      expect(initial.status()).toBe(200);
      expect(await initial.text()).toContain(fixture.branchId);
      const foreign = await branches(other);
      expect(foreign.status()).toBe(200);
      const foreignBody = await foreign.text();
      expect(foreignBody).toContain(otherBranch);
      expect(foreignBody).not.toContain(fixture.branchId);
      await platform(async (db) => {
        if (mode === 'package') {
          await db.query('UPDATE organizations SET "packageId"=NULL WHERE id=$1', [
            fixture.organizationId,
          ]);
        } else {
          await db.query(
            `INSERT INTO organization_modules
            (id,"organizationId","moduleId",status,"updatedAt")
            SELECT 'operations_revoked_module',$1,id,'DISABLED',now() FROM platform_modules
            WHERE key='pharmacy-counter'`,
            [fixture.organizationId]
          );
        }
      });
      expect((await branches(page)).status()).toBe(403);
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Counter unavailable' })).toBeVisible();
      expect((await branches(other)).status()).toBe(200);
      await other.reload();
      await expect(other.getByRole('heading', { name: 'Counter', exact: true })).toBeVisible();
    } finally {
      await platform(async (db) => {
        await db.query('DELETE FROM organization_modules WHERE id=$1', [
          'operations_revoked_module',
        ]);
        await db.query('UPDATE organizations SET "packageId"=$1 WHERE id=$2', [
          fixture.packageId,
          fixture.organizationId,
        ]);
      });
      await otherContext.close();
    }
  });
}

test('session revocation denies the existing signed-in cookie after the documented revalidation window', async ({
  page,
}) => {
  test.setTimeout(100_000);
  await login(page, otherEmail);
  expect((await branches(page)).status()).toBe(200);
  await platform(async (db) => {
    await db.query('UPDATE users SET "tokenVersion"="tokenVersion"+1 WHERE id=$1', [otherUser]);
  });
  // Real elapsed server time; no forged cookie, clock override or auth mock.
  await expect
    .poll(async () => (await branches(page)).status(), {
      timeout: 75_000,
      intervals: [10_000],
    })
    .toBe(401);
  await page.reload();
  await expect(page).toHaveURL(/\/login/);
});
