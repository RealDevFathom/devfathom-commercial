# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: pharmacy-finance.spec.ts >> fresh organization posts, locks, reopens, and versions pharmacy tax without raw ids
- Location: tests/e2e/pharmacy-finance.spec.ts:27:5

# Error details

```
Error: locator.fill: Error: strict mode violation: locator('[data-slot="section-card"]').filter({ hasText: 'Record money movement' }).getByLabel('Reference') resolved to 2 elements:
    1) <input required="" name="reference" data-slot="input" placeholder="PV-2026-001" id="base-ui-_R_i9d5esnebnaqitmlb_" class="h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-n…/> aka getByRole('textbox', { name: 'Reference', exact: true })
    2) <input data-slot="input" name="bankReference" id="base-ui-_R_kpd5esnebnaqitmlb_" class="h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 di…/> aka getByRole('textbox', { name: 'Bank reference' })

Call log:
  - waiting for locator('[data-slot="section-card"]').filter({ hasText: 'Record money movement' }).getByLabel('Reference')

```

# Page snapshot

```yaml
- generic [active] [ref=f1e1]:
  - generic [ref=f1e3]:
    - banner [ref=f1e4]:
      - link "Open dashboard" [ref=f1e5] [cursor=pointer]:
        - /url: /dashboard
        - generic [ref=f1e15]:
          - generic [ref=f1e16]: Chai Chowk Café
          - generic [ref=f1e17]: Company workspace
      - link "Open projects" [ref=f1e19] [cursor=pointer]:
        - /url: /projects
      - generic [ref=f1e21]:
        - generic [ref=f1e22]: Alex Carter
        - generic [ref=f1e23]: Owner
      - navigation "Breadcrumb" [ref=f1e24]:
        - generic [ref=f1e25]: Pharmacy
        - generic [ref=f1e27]: Finance
      - generic [ref=f1e31]:
        - button "Search company hub" [ref=f1e32]:
          - generic [ref=f1e36]: Search workspace
          - generic: ⌘K
        - button "Open AI assistant" [ref=f1e37]:
          - generic [ref=f1e41]: Ask Fathom
        - button "Use dark theme" [ref=f1e42]
        - button "Notifications" [ref=f1e46]
        - button "Open account menu" [ref=f1e50]:
          - generic [ref=f1e51]: AC
    - navigation "Primary navigation" [ref=f1e54]:
      - link "01 Dashboard" [ref=f1e55] [cursor=pointer]:
        - /url: /dashboard
        - generic [ref=f1e56]: "01"
        - generic [ref=f1e57]: Dashboard
      - link "02 Point of sale" [ref=f1e58] [cursor=pointer]:
        - /url: /pos
        - generic [ref=f1e59]: "02"
        - generic [ref=f1e60]: Point of sale
      - link "03 Kitchen display" [ref=f1e61] [cursor=pointer]:
        - /url: /kds
        - generic [ref=f1e62]: "03"
        - generic [ref=f1e63]: Kitchen display
      - link "04 Floor" [ref=f1e64] [cursor=pointer]:
        - /url: /restaurant/floor
        - generic [ref=f1e65]: "04"
        - generic [ref=f1e66]: Floor
      - link "05 Orders" [ref=f1e67] [cursor=pointer]:
        - /url: /restaurant/orders
        - generic [ref=f1e68]: "05"
        - generic [ref=f1e69]: Orders
      - link "06 Catering" [ref=f1e70] [cursor=pointer]:
        - /url: /restaurant/catering
        - generic [ref=f1e71]: "06"
        - generic [ref=f1e72]: Catering
      - link "07 Finance & reconciliation" [ref=f1e73] [cursor=pointer]:
        - /url: /restaurant/money
        - generic [ref=f1e74]: "07"
        - generic [ref=f1e75]: Finance & reconciliation
      - link "08 Inventory" [ref=f1e76] [cursor=pointer]:
        - /url: /restaurant/inventory
        - generic [ref=f1e77]: "08"
        - generic [ref=f1e78]: Inventory
      - link "09 Purchasing" [ref=f1e79] [cursor=pointer]:
        - /url: /restaurant/purchasing
        - generic [ref=f1e80]: "09"
        - generic [ref=f1e81]: Purchasing
      - link "10 SOP board" [ref=f1e82] [cursor=pointer]:
        - /url: /restaurant/sop
        - generic [ref=f1e83]: "10"
        - generic [ref=f1e84]: SOP board
      - link "11 SOP reports" [ref=f1e85] [cursor=pointer]:
        - /url: /restaurant/sop/reports
        - generic [ref=f1e86]: "11"
        - generic [ref=f1e87]: SOP reports
      - link "12 SOP admin" [ref=f1e88] [cursor=pointer]:
        - /url: /restaurant/sop/admin
        - generic [ref=f1e89]: "12"
        - generic [ref=f1e90]: SOP admin
      - link "13 SOP oversight" [ref=f1e91] [cursor=pointer]:
        - /url: /restaurant/sop/oversight
        - generic [ref=f1e92]: "13"
        - generic [ref=f1e93]: SOP oversight
      - link "14 Restaurant staff" [ref=f1e94] [cursor=pointer]:
        - /url: /restaurant/staff
        - generic [ref=f1e95]: "14"
        - generic [ref=f1e96]: Restaurant staff
      - link "15 Roster" [ref=f1e97] [cursor=pointer]:
        - /url: /restaurant/staff/roster
        - generic [ref=f1e98]: "15"
        - generic [ref=f1e99]: Roster
      - link "16 Tax" [ref=f1e100] [cursor=pointer]:
        - /url: /restaurant/tax
        - generic [ref=f1e101]: "16"
        - generic [ref=f1e102]: Tax
      - link "17 Branches" [ref=f1e103] [cursor=pointer]:
        - /url: /restaurant/settings/branches
        - generic [ref=f1e104]: "17"
        - generic [ref=f1e105]: Branches
      - link "18 Delivery" [ref=f1e106] [cursor=pointer]:
        - /url: /restaurant/delivery
        - generic [ref=f1e107]: "18"
        - generic [ref=f1e108]: Delivery
      - link "19 Restaurant devices" [ref=f1e109] [cursor=pointer]:
        - /url: /restaurant/devices
        - generic [ref=f1e110]: "19"
        - generic [ref=f1e111]: Restaurant devices
      - link "20 Cameras" [ref=f1e112] [cursor=pointer]:
        - /url: /restaurant/integrations/cameras
        - generic [ref=f1e113]: "20"
        - generic [ref=f1e114]: Cameras
      - link "21 Catalog" [ref=f1e115] [cursor=pointer]:
        - /url: /restaurant/catalog
        - generic [ref=f1e116]: "21"
        - generic [ref=f1e117]: Catalog
      - link "22 Menus" [ref=f1e118] [cursor=pointer]:
        - /url: /restaurant/menus
        - generic [ref=f1e119]: "22"
        - generic [ref=f1e120]: Menus
      - link "23 Notifications" [ref=f1e121] [cursor=pointer]:
        - /url: /restaurant/notifications
        - generic [ref=f1e122]: "23"
        - generic [ref=f1e123]: Notifications
      - link "24 Customers & Loyalty" [ref=f1e124] [cursor=pointer]:
        - /url: /restaurant/loyalty
        - generic [ref=f1e125]: "24"
        - generic [ref=f1e126]: Customers & Loyalty
      - link "25 Reports" [ref=f1e127] [cursor=pointer]:
        - /url: /restaurant/reports
        - generic [ref=f1e128]: "25"
        - generic [ref=f1e129]: Reports
      - link "26 Advanced Insights" [ref=f1e130] [cursor=pointer]:
        - /url: /restaurant/insights
        - generic [ref=f1e131]: "26"
        - generic [ref=f1e132]: Advanced Insights
      - link "27 Organization" [ref=f1e133] [cursor=pointer]:
        - /url: /organization
        - generic [ref=f1e134]: "27"
        - generic [ref=f1e135]: Organization
      - link "28 Settings" [ref=f1e136] [cursor=pointer]:
        - /url: /settings
        - generic [ref=f1e137]: "28"
        - generic [ref=f1e138]: Settings
    - main [ref=f1e139]:
      - main [ref=f1e141]:
        - generic [ref=f1e145]:
          - text: Pharmacy operations
          - heading "Finance" [level=1] [ref=f1e146]
          - paragraph [ref=f1e147]: Post and allocate money, reconcile the bank, control periods, and publish approved tax versions.
        - generic [ref=f1e148]:
          - generic [ref=f1e150]:
            - text: Accounting drivers
            - heading "Gross-margin comparison" [level=2] [ref=f1e151]
          - paragraph [ref=f1e152]: "Branch: Main pharmacy finance. Compare up to 92 days with the immediately preceding equal-length period."
          - generic [ref=f1e153]:
            - generic [ref=f1e154]:
              - text: Current start (UTC)
              - textbox "Current start (UTC)" [ref=f1e155]: 2026-08-30
            - generic [ref=f1e156]:
              - text: Current end (UTC, exclusive)
              - textbox "Current end (UTC, exclusive)" [ref=f1e157]: 2026-09-29
            - button "Compare periods" [ref=f1e158]
          - alert [ref=f1e159]: "Permission required: owner financial-report access and the Pharmacy reports module."
        - generic [ref=f1e160]:
          - generic [ref=f1e162]:
            - text: Organization scope
            - heading "Working branch" [level=3] [ref=f1e163]
          - generic [ref=f1e164]:
            - generic [ref=f1e165]:
              - text: Branch
              - combobox "Branch" [ref=f1e166]:
                - option "Main pharmacy finance" [selected]
            - button "Switch branch" [ref=f1e167]
        - generic [ref=f1e168]:
          - generic [ref=f1e170]:
            - text: Card · wallet · bank transfer
            - heading "Create POS settlement batch" [level=3] [ref=f1e171]
          - paragraph [ref=f1e172]: No unsettled electronic POS tenders. Card, wallet, or bank-transfer sales appear here automatically.
        - generic [ref=f1e173]:
          - generic [ref=f1e174]:
            - generic [ref=f1e176]:
              - text: FIN-02
              - heading "Record money movement" [level=3] [ref=f1e177]
            - generic [ref=f1e178]:
              - generic [ref=f1e179]:
                - text: Workflow
                - combobox "Workflow" [ref=f1e180]:
                  - option "Supplier payment"
                  - option "Customer receipt"
                  - option "Expense" [selected]
                  - option "Petty cash"
                  - option "Bank deposit"
                  - option "Settlement"
                  - option "Voucher"
                  - option "Cheque"
              - generic [ref=f1e181]:
                - text: Reference
                - textbox "Reference" [ref=f1e182]:
                  - /placeholder: PV-2026-001
              - generic [ref=f1e183]:
                - text: Amount (PKR)
                - spinbutton "Amount (PKR)" [ref=f1e184]
              - generic [ref=f1e185]:
                - text: Posting date
                - textbox "Posting date" [ref=f1e186]: 2026-09-29
              - generic [ref=f1e187]:
                - text: Counterparty name
                - textbox "Counterparty name" [ref=f1e188]:
                  - /placeholder: Supplier or customer
              - generic [ref=f1e189]:
                - text: Pay from / receive into
                - combobox "Pay from / receive into" [ref=f1e190]:
                  - option "Bank" [selected]
                  - option "Cash / petty cash"
              - generic [ref=f1e191]:
                - text: Bank reference
                - textbox "Bank reference" [ref=f1e192]
              - generic [ref=f1e193]:
                - text: Cheque number (cheque only)
                - textbox "Cheque number (cheque only)" [ref=f1e194]
              - generic [ref=f1e195]:
                - text: Cheque due date
                - textbox "Cheque due date" [ref=f1e196]
              - generic [ref=f1e197]:
                - text: Memo
                - textbox "Memo" [ref=f1e198]
              - button "Post transaction" [ref=f1e199]
          - generic [ref=f1e200]:
            - generic [ref=f1e202]:
              - text: Controlled close
              - heading "Close accounting period" [level=3] [ref=f1e203]
            - generic [ref=f1e204]:
              - generic [ref=f1e205]:
                - text: Period starts
                - textbox "Period starts" [ref=f1e206]
              - generic [ref=f1e207]:
                - text: Period ends (exclusive)
                - textbox "Period ends (exclusive)" [ref=f1e208]
              - button "Close period" [ref=f1e209]
            - paragraph [ref=f1e211]: No closed periods yet. Close a completed date range to prevent back-posting.
        - generic [ref=f1e212]:
          - generic [ref=f1e214]:
            - text: Balanced shared journal
            - heading "Recent transactions" [level=3] [ref=f1e215]
          - paragraph [ref=f1e217]: No transactions yet. Use “Record money movement” to post the first balanced entry.
        - generic [ref=f1e218]:
          - generic [ref=f1e219]:
            - generic [ref=f1e221]:
              - text: Statement matching
              - heading "Bank reconciliation" [level=3] [ref=f1e222]
            - generic [ref=f1e223]:
              - generic [ref=f1e224]:
                - text: Statement reference
                - textbox "Statement reference" [ref=f1e225]
              - generic [ref=f1e226]:
                - text: Line reference
                - textbox "Line reference" [ref=f1e227]
              - generic [ref=f1e228]:
                - text: Booked date
                - textbox "Booked date" [ref=f1e229]
              - generic [ref=f1e230]:
                - text: Amount (PKR)
                - spinbutton "Amount (PKR)" [ref=f1e231]
              - generic [ref=f1e232]:
                - text: Bank description
                - textbox "Bank description" [ref=f1e233]
              - button "Add statement line" [ref=f1e234]
            - paragraph [ref=f1e235]: Add a statement line and post a transaction before matching.
          - generic [ref=f1e236]:
            - generic [ref=f1e238]:
              - text: FIN-04 · Accountant approval
              - heading "Publish tax profile" [level=3] [ref=f1e239]
            - generic [ref=f1e240]:
              - generic [ref=f1e241]:
                - text: Profile name
                - textbox "Profile name" [ref=f1e242]
              - generic [ref=f1e243]:
                - text: Accountant approval reference
                - textbox "Accountant approval reference" [ref=f1e244]
              - generic [ref=f1e245]:
                - text: Effective from
                - textbox "Effective from" [ref=f1e246]
              - generic [ref=f1e247]:
                - text: Effective to (optional)
                - textbox "Effective to (optional)" [ref=f1e248]
              - generic [ref=f1e249]:
                - text: Medicine PCT / HS code
                - textbox "Medicine PCT / HS code" [ref=f1e250]
              - generic [ref=f1e251]:
                - text: Front-shop PCT / HS code
                - textbox "Front-shop PCT / HS code" [ref=f1e252]
              - generic [ref=f1e253]:
                - text: Rate (0–1)
                - textbox "Rate (0–1)" [ref=f1e254]:
                  - /placeholder: "0.18"
              - generic [ref=f1e255]:
                - text: Price mode
                - combobox "Price mode" [ref=f1e256]:
                  - option "Tax inclusive" [selected]
                  - option "Tax exclusive"
              - generic [ref=f1e257]:
                - text: SRO reference (always provisional)
                - textbox "SRO reference (always provisional) Verify against the final gazette before operational use." [ref=f1e258]
                - generic [ref=f1e259]: Verify against the final gazette before operational use.
              - button "Publish approved version" [ref=f1e260]
            - paragraph [ref=f1e262]: No tax profile is active. Publish an accountant-approved, effective-dated version before taxable sales.
  - region "Notifications alt+T"
  - button "Open Next.js Dev Tools" [ref=f1e268] [cursor=pointer]:
    - generic [ref=f1e271]:
      - text: Compiling
      - generic [ref=f1e272]:
        - generic [ref=f1e273]: .
        - generic [ref=f1e274]: .
        - generic [ref=f1e275]: .
  - alert [ref=f1e276]
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
  35 |   await expect(page.getByLabel('Branch')).toHaveValue(branchId);
  36 |   await expect(page.locator('body')).not.toContainText(branchId);
  37 | 
  38 |   const record = page
  39 |     .locator('[data-slot="section-card"]')
  40 |     .filter({ hasText: 'Record money movement' });
  41 |   await record.getByLabel('Workflow').selectOption('EXPENSE');
> 42 |   await record.getByLabel('Reference').fill('EXP-E2E-001');
     |                                        ^ Error: locator.fill: Error: strict mode violation: locator('[data-slot="section-card"]').filter({ hasText: 'Record money movement' }).getByLabel('Reference') resolved to 2 elements:
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