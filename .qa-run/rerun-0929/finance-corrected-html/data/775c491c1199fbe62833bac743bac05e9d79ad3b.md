# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: pharmacy-finance.spec.ts >> fresh organization posts, locks, reopens, and versions pharmacy tax without raw ids
- Location: tests/e2e/pharmacy-finance.spec.ts:27:5

# Error details

```
Error: expect(locator).toHaveValue(expected) failed

Locator: getByLabel('Branch')
Expected: "branch_pharmacy_finance_e2e"
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toHaveValue" with timeout 5000ms
  - waiting for getByLabel('Branch')

```

```yaml
- banner:
  - link "Open dashboard":
    - /url: /dashboard
    - text: Chai Chowk Café Company workspace
  - link "Open projects":
    - /url: /projects
  - text: Alex Carter Owner
  - navigation "Breadcrumb": Pharmacy Finance
  - button "Search company hub": Search workspace ⌘K
  - button "Open AI assistant": Ask Fathom
  - button "Use dark theme"
  - button "Notifications"
  - button "Open account menu": AC
- navigation "Primary navigation":
  - link "01 Dashboard":
    - /url: /dashboard
  - link "02 Point of sale":
    - /url: /pos
  - link "03 Kitchen display":
    - /url: /kds
  - link "04 Floor":
    - /url: /restaurant/floor
  - link "05 Orders":
    - /url: /restaurant/orders
  - link "06 Catering":
    - /url: /restaurant/catering
  - link "07 Finance & reconciliation":
    - /url: /restaurant/money
  - link "08 Inventory":
    - /url: /restaurant/inventory
  - link "09 Purchasing":
    - /url: /restaurant/purchasing
  - link "10 SOP board":
    - /url: /restaurant/sop
  - link "11 SOP reports":
    - /url: /restaurant/sop/reports
  - link "12 Restaurant staff":
    - /url: /restaurant/staff
  - link "13 Roster":
    - /url: /restaurant/staff/roster
  - link "14 Catalog":
    - /url: /restaurant/catalog
  - link "15 Menus":
    - /url: /restaurant/menus
  - link "16 Notifications":
    - /url: /restaurant/notifications
  - link "17 Customers & Loyalty":
    - /url: /restaurant/loyalty
  - link "18 Reports":
    - /url: /restaurant/reports
  - link "19 Advanced Insights":
    - /url: /restaurant/insights
  - link "20 Settings":
    - /url: /settings
- main:
  - main:
    - text: Pharmacy operations
    - heading "Finance" [level=1]
    - paragraph: Bookkeeping, reconciliation, close, and tax profile controls.
    - heading "Permission required" [level=3]
    - paragraph: An organization administrator must perform financial postings and approve tax versions.
- region "Notifications alt+T"
- alert
```

# Test source

```ts
  1  | import { expect, test } from '@playwright/test';
  2  | import pg from 'pg';
  3  | import { assertDisposableDatabaseRoles, signInAs } from './fixtures/restaurant-actor-accessibility';
  4  | 
  5  | test.describe.configure({ mode: 'serial' });
  6  | const branchId = 'branch_pharmacy_finance_e2e';
  7  | 
  8  | test.beforeAll(async () => {
  9  |   await assertDisposableDatabaseRoles();
  10 |   const ownerUrl = process.env.RESTAURANT_ACTOR_OWNER_DATABASE_URL;
  11 |   if (!ownerUrl) throw new Error('RESTAURANT_ACTOR_OWNER_DATABASE_URL is required.');
  12 |   const db = new pg.Client({ connectionString: ownerUrl });
  13 |   await db.connect();
  14 |   try {
  15 |     await db.query(`SET app.is_platform_admin='true'`);
  16 |     await db.query(
  17 |       `INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","createdAt","updatedAt")
  18 |        VALUES ($1,'org_chai_chowk','FIN-E2E','Main pharmacy finance','1 Test Road','Lahore','PB',now(),now())
  19 |        ON CONFLICT (id) DO NOTHING`,
  20 |       [branchId]
  21 |     );
  22 |   } finally {
  23 |     await db.end();
  24 |   }
  25 | });
  26 | 
  27 | test('fresh organization posts, locks, reopens, and versions pharmacy tax without raw ids', async ({
  28 |   page,
  29 | }) => {
  30 |   test.slow();
  31 |   const started = Date.now();
  32 |   const origin = await signInAs(page, 'restaurantAdmin');
  33 |   await page.goto(new URL(`/pharmacy/finance?branch=${branchId}`, origin).href);
  34 |   await expect(page.getByRole('heading', { name: 'Finance', exact: true })).toBeVisible();
> 35 |   await expect(page.getByLabel('Branch')).toHaveValue(branchId);
     |                                           ^ Error: expect(locator).toHaveValue(expected) failed
  36 |   await expect(page.locator('body')).not.toContainText(branchId);
  37 | 
  38 |   const record = page
  39 |     .locator('[data-slot="section-card"]')
  40 |     .filter({ hasText: 'Record money movement' });
  41 |   await record.getByLabel('Workflow').selectOption('EXPENSE');
  42 |   await record.getByLabel('Reference').fill('EXP-E2E-001');
  43 |   await record.getByLabel('Amount (PKR)').fill('1250.00');
  44 |   await record.getByLabel('Posting date').fill('2026-09-02');
  45 |   await record.getByLabel('Counterparty name').fill('City power company');
  46 |   const postStarted = Date.now();
  47 |   await record.getByRole('button', { name: 'Post transaction' }).click();
  48 |   await expect(page.getByText('Transaction posted and journal balanced.')).toBeVisible();
  49 |   const postMs = Date.now() - postStarted;
  50 |   await expect(page.getByText('EXP-E2E-001')).toBeVisible();
  51 | 
  52 |   const close = page
  53 |     .locator('[data-slot="section-card"]')
  54 |     .filter({ hasText: 'Close accounting period' });
  55 |   await close.getByLabel('Period starts').fill('2026-09-01');
  56 |   await close.getByLabel('Period ends (exclusive)').fill('2026-10-01');
  57 |   await close.getByRole('button', { name: 'Close period' }).click();
  58 |   await expect(page.getByText(/Period closed/)).toBeVisible();
  59 |   await page.getByPlaceholder('Reason for controlled reopen').fill('Approved E2E correction');
  60 |   await page.getByRole('button', { name: 'Reopen' }).click();
  61 |   await expect(page.getByText(/Period reopened/)).toBeVisible();
  62 | 
  63 |   const tax = page.locator('[data-slot="section-card"]').filter({ hasText: 'Publish tax profile' });
  64 |   await tax.getByLabel('Profile name').fill('E2E pharmacy tax');
  65 |   await tax.getByLabel('Accountant approval reference').fill('ACC-E2E-001');
  66 |   await tax.getByLabel('Effective from').fill('2026-01-01');
  67 |   await tax.getByLabel('Medicine PCT / HS code').fill('3004');
  68 |   await tax.getByLabel('Front-shop PCT / HS code').fill('3304');
  69 |   await tax.getByLabel('Rate (0–1)').fill('0.18');
  70 |   await tax.getByRole('button', { name: 'Publish approved version' }).click();
  71 |   await expect(page.getByText('Approved tax profile version published.')).toBeVisible();
  72 |   await expect(page.getByText(/v1 · E2E pharmacy tax/)).toBeVisible();
  73 | 
  74 |   test.info().annotations.push(
  75 |     {
  76 |       type: 'core-action-clicks',
  77 |       description: '1 click after completing the visible transaction form',
  78 |     },
  79 |     { type: 'slowest-interaction', description: `Post transaction: ${postMs}ms` },
  80 |     { type: 'end-to-end-duration', description: `${Date.now() - started}ms` }
  81 |   );
  82 | });
  83 | 
```