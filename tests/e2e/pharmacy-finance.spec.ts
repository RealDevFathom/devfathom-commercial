import { expect, test } from '@playwright/test';
import pg from 'pg';
import { assertDisposableDatabaseRoles, signInAs } from './fixtures/restaurant-actor-accessibility';

test.describe.configure({ mode: 'serial' });
const branchId = 'branch_pharmacy_finance_e2e';

test.beforeAll(async () => {
  await assertDisposableDatabaseRoles();
  const ownerUrl = process.env.RESTAURANT_ACTOR_OWNER_DATABASE_URL;
  if (!ownerUrl) throw new Error('RESTAURANT_ACTOR_OWNER_DATABASE_URL is required.');
  const db = new pg.Client({ connectionString: ownerUrl });
  await db.connect();
  try {
    await db.query(`SET app.is_platform_admin='true'`);
    await db.query(
      `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","createdAt","updatedAt")
       VALUES ($1,'org_chai_chowk','FIN-E2E','Main pharmacy finance','1 Test Road','Lahore','PB',now(),now())
       ON CONFLICT (id) DO NOTHING`,
      [branchId]
    );
  } finally {
    await db.end();
  }
});

test('fresh organization posts, locks, reopens, and versions pharmacy tax without raw ids', async ({
  page,
}) => {
  test.slow();
  const started = Date.now();
  const origin = await signInAs(page, 'restaurantAdmin');
  await page.goto(new URL(`/pharmacy/finance?branch=${branchId}`, origin).href);
  await expect(page.getByRole('heading', { name: 'Finance', exact: true })).toBeVisible();
  await expect(page.getByLabel('Branch')).toHaveValue(branchId);
  await expect(page.locator('body')).not.toContainText(branchId);

  const record = page
    .locator('[data-slot="section-card"]')
    .filter({ hasText: 'Record money movement' });
  await record.getByLabel('Workflow').selectOption('EXPENSE');
  await record.getByLabel('Reference').fill('EXP-E2E-001');
  await record.getByLabel('Amount (PKR)').fill('1250.00');
  await record.getByLabel('Posting date').fill('2026-09-02');
  await record.getByLabel('Counterparty name').fill('City power company');
  const postStarted = Date.now();
  await record.getByRole('button', { name: 'Post transaction' }).click();
  await expect(page.getByText('Transaction posted and journal balanced.')).toBeVisible();
  const postMs = Date.now() - postStarted;
  await expect(page.getByText('EXP-E2E-001')).toBeVisible();

  const close = page
    .locator('[data-slot="section-card"]')
    .filter({ hasText: 'Close accounting period' });
  await close.getByLabel('Period starts').fill('2026-09-01');
  await close.getByLabel('Period ends (exclusive)').fill('2026-10-01');
  await close.getByRole('button', { name: 'Close period' }).click();
  await expect(page.getByText(/Period closed/)).toBeVisible();
  await page.getByPlaceholder('Reason for controlled reopen').fill('Approved E2E correction');
  await page.getByRole('button', { name: 'Reopen' }).click();
  await expect(page.getByText(/Period reopened/)).toBeVisible();

  const tax = page.locator('[data-slot="section-card"]').filter({ hasText: 'Publish tax profile' });
  await tax.getByLabel('Profile name').fill('E2E pharmacy tax');
  await tax.getByLabel('Accountant approval reference').fill('ACC-E2E-001');
  await tax.getByLabel('Effective from').fill('2026-01-01');
  await tax.getByLabel('Medicine PCT / HS code').fill('3004');
  await tax.getByLabel('Front-shop PCT / HS code').fill('3304');
  await tax.getByLabel('Rate (0–1)').fill('0.18');
  await tax.getByRole('button', { name: 'Publish approved version' }).click();
  await expect(page.getByText('Approved tax profile version published.')).toBeVisible();
  await expect(page.getByText(/v1 · E2E pharmacy tax/)).toBeVisible();

  test
    .info()
    .annotations.push(
      {
        type: 'core-action-clicks',
        description: '1 click after completing the visible transaction form',
      },
      { type: 'slowest-interaction', description: `Post transaction: ${postMs}ms` },
      { type: 'end-to-end-duration', description: `${Date.now() - started}ms` }
    );
});
