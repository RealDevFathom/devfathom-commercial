import { expect, test, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PHARMACY_E2E, PHARMACY_E2E_EXPECTED } from './pharmacy-counter-fixture';

/**
 * PH-POS counter browser acceptance — POS-01, POS-02, POS-03, POS-08, POS-09.
 *
 * NO MOUSE. This file never calls `click`, `hover`, `tap`, `dblclick`, or
 * `dragTo`. Every interaction is `focus()` plus a key press, or a bare key
 * press against the document — which is exactly how a counter cashier works and
 * is what POS-01's "top-10 bills completed without a mouse" means. The final
 * test asserts that property against this file's own source, so a later edit
 * cannot quietly reintroduce a pointer.
 *
 * Three bills are completed from the counter corpus:
 *   1. Barcode scan → strip → cash → receipt (POS-02 scan, POS-03, POS-08)
 *   2. Name search → loose unit on a medicine with no strip level (POS-03)
 *   3. Urdu transliteration alias → whole pack (POS-02 alias path)
 *
 * A fourth test covers POS-09: a prescription-only line raises a safety block
 * that is visually and semantically distinct from advice and commercial
 * notices, refuses tender, and is cleared only by voiding — never by an
 * acknowledgement.
 */

test.describe.configure({ mode: 'serial' });

if (process.env.PHARMACY_E2E !== '1') throw new Error('PHARMACY_E2E=1 is required.');

/** Focus a control and activate it with the keyboard. Never a pointer. */
async function pressControl(target: Locator) {
  await expect(target).toBeEnabled();
  await target.focus();
  await expect(target).toBeFocused();
  await target.press('Enter');
}

async function signIn(page: Page, email = process.env.PHARMACY_E2E_ADMIN_EMAIL!) {
  await page.goto('/login');
  // Prove the client form is hydrated before entering credentials: a native
  // pre-hydration submit otherwise posts back to /login and loses the draft.
  await expect(async () => {
    const passwordControl = page.getByRole('textbox', { name: 'Password' });
    if ((await passwordControl.getAttribute('type')) === 'password')
      await pressControl(page.getByRole('button', { name: 'Show password' }));
    await expect(passwordControl).toHaveAttribute('type', 'text');
  }).toPass({ timeout: 15_000 });
  const emailField = page.getByLabel('Email');
  await emailField.focus();
  await emailField.fill(email);
  const password = page.getByRole('textbox', { name: 'Password' });
  await password.focus();
  await password.fill(process.env.PHARMACY_E2E_ADMIN_PASSWORD!);
  await pressControl(page.getByRole('button', { name: 'Sign in' }));

  // On a shared host the sign-in may land on the workspace chooser first.
  const chooser = page.getByText('Choose a workspace', { exact: true });
  const landed = page.locator('body');
  await expect(landed).toBeVisible();
  if (await chooser.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await pressControl(page.getByRole('button', { name: /Fathom Pharmacy E2E/i }));
  }
  await expect(page).toHaveURL(/\/(dashboard|pharmacy)/, { timeout: 30_000 });
}

async function openCounter(page: Page, email?: string) {
  await signIn(page, email);
  await page.goto('/pharmacy/counter');
  await expect(page.getByRole('heading', { name: 'Counter', level: 1 })).toBeVisible({
    timeout: 60_000,
  });
  // The module is licensed by the seed, so the shell must render the counter
  // itself rather than the honest not-enabled panel.
  await expect(page.getByRole('heading', { name: 'This module is not enabled' })).toHaveCount(0);
  await expect(page.getByLabel('Scan or search')).toBeFocused();
}

test('pharmacy-only navigation exposes pharmacy destinations and excludes Restaurant routes', async ({
  page,
}) => {
  await signIn(page);
  const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(navigation.getByRole('link', { name: 'Onboarding' })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Counter' })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Regulatory profile' })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Point of sale' })).toHaveCount(0);
  await expect(navigation.getByRole('link', { name: 'Kitchen display' })).toHaveCount(0);
  await expect(navigation.getByRole('link', { name: 'Restaurant staff' })).toHaveCount(0);
});

/**
 * Cash tenders need an open drawer (POS-07), and every test that takes one must
 * open its own.
 *
 * The counter identifies its device by a `localStorage` key, so each test's
 * fresh browser context is a NEW counter device with no drawer session — the
 * drawer deliberately does not carry over from the previous bill's context.
 * Asserting the operator sentence rather than the reason code is the point: the
 * raw `DRAWER_NOT_OPEN` symbol must never reach the counter.
 */
async function openDrawer(page: Page) {
  await pressControl(page.getByRole('button', { name: 'Open drawer' }));
  await expect(
    page.getByRole('status').filter({ hasText: /Cash drawer opened for this counter/i })
  ).toBeVisible();
  await expect(page.getByText(/DRAWER_NOT_OPEN/)).toHaveCount(0);
}

async function search(page: Page, term: string) {
  // F2 is the POS-01 chord for the scan field; using it here proves the chord
  // works rather than merely that the field exists.
  await page.keyboard.press('F2');
  const field = page.getByLabel('Scan or search');
  await expect(field).toBeFocused();
  await field.fill(term);
  await field.press('Enter');
}

async function stageFirstResult(page: Page, medicineName: string) {
  const row = page
    .getByRole('list', { name: 'Search results' })
    .getByRole('button')
    .filter({ hasText: medicineName })
    .first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await pressControl(row);
  await expect(row).toHaveAttribute('aria-pressed', 'true');
}

async function setQuantity(page: Page, quantity: number) {
  // Exact: the stepper's "Decrease quantity" and "Increase quantity" buttons also carry the word.
  const field = page.getByLabel('Quantity', { exact: true });
  await field.focus();
  await field.fill(String(quantity));
  // Blur via the keyboard so React commits the controlled value.
  await field.press('Tab');
}

async function tenderCash(page: Page, amount: string) {
  await page.keyboard.press('F9');
  const amountField = page.getByLabel('Amount');
  await amountField.focus();
  await amountField.fill(amount);
  const received = page.getByLabel('Cash received');
  await received.focus();
  await received.fill(amount);
  await pressControl(page.getByRole('button', { name: 'Take payment' }));
}

test('bill 1 — barcode scan, strip unit, cash tender and a bilingual receipt', async ({ page }) => {
  const otc = PHARMACY_E2E.medicines.otc;
  // The barcode scan adds one pack at the printed MRP to the bill that holds the two strips.
  const packPrice = (otc.printedMrpMinor / 100).toFixed(2);
  const billTotal = (Number(packPrice) + Number(PHARMACY_E2E_EXPECTED.otcTwoStripTotal)).toFixed(2);
  await openCounter(page);
  await openDrawer(page);

  // POS-02: the row is read from a name search. Enter on a barcode adds the medicine rather
  // than staging it (scan-to-add, below), and the add draws the pack from the stock this row
  // reports.
  await search(page, otc.brandName);
  await stageFirstResult(page, otc.name);

  const row = page
    .getByRole('list', { name: 'Search results' })
    .getByRole('button')
    .filter({ hasText: otc.name })
    .first();
  // Every field POS-02 requires on the row.
  await expect(row).toContainText(otc.strength);
  await expect(row).toContainText(otc.presentation);
  await expect(row).toContainText(`${otc.onHandUnits} units`);
  await expect(row).toContainText(otc.batchNumber);
  await expect(row).toContainText('2028-06-30');
  await expect(row).toContainText('250.00');
  await expect(row).toContainText('Over the counter');
  await expect(row).toContainText('Store');

  // POS-03: F4 selects the strip; the preview quotes the derived strip price.
  await page.keyboard.press('F4');
  await expect(page.getByRole('radio', { name: /Strip/ })).toHaveAttribute('aria-checked', 'true');
  await setQuantity(page, 2);
  await expect(page.getByText(PHARMACY_E2E_EXPECTED.otcStripPrice).first()).toBeVisible();
  await expect(page.getByText(PHARMACY_E2E_EXPECTED.otcTwoStripTotal).first()).toBeVisible();

  await page.keyboard.press('F6');
  const cart = page.getByRole('table', { name: 'Cart lines' });
  await expect(cart).toContainText(otc.name, { timeout: 15_000 });
  await expect(cart).toContainText('2 ×');
  await expect(page.getByText('Bill open · 1 line')).toBeVisible();

  // POS-03: the cart shows the FEFO allocation, batch and expiry included.
  const allocation = page.getByRole('list', { name: `Batch allocation for ${otc.name}` });
  await expect(allocation).toContainText(`Batch ${otc.batchNumber}`);
  await expect(allocation).toContainText('Exp 2028-06-30');
  await expect(allocation).toContainText('20 units');
  await expect(allocation).toContainText('FEFO');
  await expect(allocation).not.toContainText('Batch override');

  // POS-02: a scanned barcode resolves to exactly one presentation, and Enter on a barcode
  // with a single match adds one of its first sale unit (scan-to-add, 699d5c1d; pinned by
  // counter-console.test.tsx "adds a barcode on Enter only when the search returns that
  // single medicine"). Nothing is added unless the scan matched exactly this medicine.
  await search(page, otc.barcode);
  await expect(page.getByText(`1 × ${otc.name} added.`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Bill open · 2 lines')).toBeVisible();
  await expect(
    cart.getByRole('row').filter({ hasText: `pack · ${otc.unitsPerPack} units @ ${packPrice}` })
  ).toContainText('1 × pack');
  await expect(cart).toContainText(`pack · ${otc.unitsPerPack} units @ ${packPrice}`);

  await tenderCash(page, billTotal);

  // POS-08: a settled bill renders a receipt carrying medicine, strength,
  // batch and expiry, and a receipt number the tender issued.
  const receipt = page.getByRole('region', { name: /^Receipt \d+$/ });
  await expect(receipt).toBeVisible({ timeout: 15_000 });
  await expect(receipt).toContainText(otc.name);
  await expect(receipt).toContainText(otc.strength);
  await expect(receipt).toContainText(otc.batchNumber);
  await expect(receipt).toContainText('2028-06-30');
  // The strip line's own total, matched whole: "50.00" is also inside the pack's "250.00".
  const stripLine = receipt
    .getByRole('listitem')
    .filter({ hasText: `× ${PHARMACY_E2E_EXPECTED.otcStripPrice}` });
  await expect(
    stripLine.getByText(PHARMACY_E2E_EXPECTED.otcTwoStripTotal, { exact: true })
  ).toBeVisible();
  await expect(receipt).toContainText(billTotal);

  // POS-08: Urdu renders the same bill with Urdu field names, right-to-left.
  const localeSelect = page.getByLabel('Language');
  await localeSelect.focus();
  await localeSelect.selectOption('ur');
  const urduReceipt = page.getByRole('region', { name: /رسید/ });
  await expect(urduReceipt).toBeVisible();
  await expect(urduReceipt).toHaveAttribute('dir', 'rtl');
  await expect(urduReceipt).toContainText('بیچ');
  await expect(urduReceipt).toContainText(otc.batchNumber);
});

test('bill 2 — name search and a loose unit on a medicine with no strip level', async ({
  page,
}) => {
  const syrup = PHARMACY_E2E.medicines.syrup;
  await openCounter(page);
  await openDrawer(page);

  await search(page, 'Fathomcof');
  await stageFirstResult(page, syrup.name);

  // POS-03: this presentation genuinely has no strip, so the toggle offers two
  // units rather than inventing a third.
  await expect(page.getByRole('radio')).toHaveCount(2);
  await expect(page.getByRole('radio', { name: /Strip/ })).toHaveCount(0);

  await page.keyboard.press('F5');
  await expect(page.getByRole('radio', { name: /Unit/ })).toHaveAttribute('aria-checked', 'true');
  await setQuantity(page, 10);
  await expect(page.getByText(PHARMACY_E2E_EXPECTED.syrupUnitPrice).first()).toBeVisible();
  await expect(page.getByText(PHARMACY_E2E_EXPECTED.syrupTenUnitTotal).first()).toBeVisible();

  await page.keyboard.press('F6');
  const cart = page.getByRole('table', { name: 'Cart lines' });
  await expect(cart).toContainText(syrup.name, { timeout: 15_000 });
  await expect(cart).toContainText('10 units');

  await tenderCash(page, PHARMACY_E2E_EXPECTED.syrupTenUnitTotal);
  await expect(page.getByRole('region', { name: /^Receipt \d+$/ })).toBeVisible({
    timeout: 15_000,
  });
});

test('bill 3 — Urdu transliteration alias resolves the same medicine and sells a whole pack', async ({
  page,
}) => {
  const otc = PHARMACY_E2E.medicines.otc;
  await openCounter(page);
  await openDrawer(page);

  // POS-02: the alias path (MED-03 transliteration) reaches the same medicine
  // the barcode did.
  await search(page, otc.alias);
  await stageFirstResult(page, otc.name);

  await page.keyboard.press('F3');
  await expect(page.getByRole('radio', { name: /Pack/ })).toHaveAttribute('aria-checked', 'true');
  await setQuantity(page, 1);
  await expect(page.getByText('250.00').first()).toBeVisible();

  await page.keyboard.press('F6');
  const cart = page.getByRole('table', { name: 'Cart lines' });
  await expect(cart).toContainText(otc.name, { timeout: 15_000 });
  await expect(cart).toContainText('100 units');

  await tenderCash(page, '250.00');
  await expect(page.getByRole('region', { name: /^Receipt \d+$/ })).toBeVisible({
    timeout: 15_000,
  });
});

test('POS-09 — a safety block is distinct from advice, refuses tender, and is never acknowledged away', async ({
  page,
}) => {
  const rx = PHARMACY_E2E.medicines.rx;
  await openCounter(page);

  await search(page, 'Fathomcillin');
  await stageFirstResult(page, rx.name);

  const row = page
    .getByRole('list', { name: 'Search results' })
    .getByRole('button')
    .filter({ hasText: rx.name })
    .first();
  await expect(row).toContainText('Prescription only');

  await page.keyboard.press('F4');
  await setQuantity(page, 1);
  await page.keyboard.press('F6');
  await expect(page.getByRole('table', { name: 'Cart lines' })).toContainText(rx.name, {
    timeout: 15_000,
  });

  // Shift+F2 focuses the panel beside the cart — no navigation away from the bill.
  await page.keyboard.press('Shift+F2');
  await expect(page).toHaveURL(/\/pharmacy\/counter$/);

  const blocks = page.getByRole('region', { name: 'Safety blocks' });
  await expect(blocks).toBeVisible();
  const alert = blocks.getByRole('alert').first();
  await expect(alert).toContainText(rx.name);
  await expect(alert).toContainText(/requires a prescription/i);
  await expect(alert).toContainText(/pharmacist/i);
  // "Are you sure?" is explicitly not an approval design.
  await expect(alert).not.toContainText(/are you sure|acknowledge/i);

  // The block is an `alert`; advice and commercial notices are `status`, so the
  // distinction is semantic and not only visual.
  await expect(blocks.getByRole('status')).toHaveCount(0);

  // Return to the bill before invoking its payment shortcut.
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Scan or search')).toBeFocused();
  // Tender is refused while the block stands.
  await page.keyboard.press('F9');
  await expect(page.getByRole('button', { name: 'Take payment' })).toBeDisabled();
  await expect(
    page.getByRole('dialog', { name: 'Payment', exact: true }).getByText(/unresolved safety block/i)
  ).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Scan or search')).toBeFocused();
  // The only way past is to correct the bill. Shift+F4 voids it.
  await page.keyboard.press('Shift+F4');
  await expect(page.getByRole('status').filter({ hasText: /Bill voided/i })).toBeVisible({
    timeout: 15_000,
  });
});

test('keyboard shortcuts are available from help and identify layouts under review', async ({
  page,
}) => {
  await openCounter(page);

  await pressControl(page.getByRole('button', { name: 'Shortcuts' }));
  const help = page.getByRole('dialog', { name: 'Shortcuts' });
  await expect(help.getByText('Focus scan and search', { exact: true })).toBeVisible();
  await expect(help.getByText('Open tender', { exact: true })).toBeVisible();

  const preset = help.getByLabel('Keymap');
  await preset.focus();
  await preset.selectOption('legacySpeed');

  const reviewNotice = help.getByRole('status').filter({ hasText: /under review/i });
  await expect(reviewNotice).toBeVisible({ timeout: 15_000 });
  await expect(reviewNotice).toContainText(/may change/i);

  // Restore the default so a re-run starts from the shipped map.
  await preset.focus();
  await preset.selectOption('devfathom');
  await expect(reviewNotice).toHaveCount(0);
});

/**
 * Call a tRPC mutation as the signed-in operator. `page.request` carries the
 * browser's session cookie, so the call runs through the same auth, tenancy and
 * module checks as the UI. It is an HTTP call, not a pointer.
 */
async function trpcMutation<T>(
  page: Page,
  path: string,
  json: Record<string, unknown>,
  dates: string[] = []
): Promise<T> {
  const response = await page.request.post(`/api/trpc/${path}`, {
    data: {
      json,
      ...(dates.length
        ? { meta: { values: Object.fromEntries(dates.map((k) => [k, ['Date']])) } }
        : {}),
    },
  });
  expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
  return ((await response.json()) as { result: { data: { json: T } } }).result.data.json;
}

test('PH-A4 — two lots on the shelf: the counter sells the earliest-expiring and flags it near expiry', async ({
  page,
}) => {
  const syrup = PHARMACY_E2E.medicines.syrup;
  await openCounter(page);
  await openDrawer(page);

  // A second batch arrives AFTER the seeded one but expires far sooner. FEFO
  // must pick it over the seeded batch (2028-06-30) despite the later receipt.
  // A per-run batch number keeps a re-run from colliding with an earlier one;
  // the bill below sells the whole lot, so an old run's lot is never on hand.
  const batchNumber = `FCF-A4-${Date.now().toString(36).toUpperCase()}`;
  const soon = new Date(Date.now() + 45 * 86_400_000);
  const printedExpiry = new Date(
    Date.UTC(soon.getUTCFullYear(), soon.getUTCMonth(), soon.getUTCDate())
  );
  const batch = await trpcMutation<{ id: string }>(
    page,
    'pharmacyInventory.registerBatch',
    {
      medicineId: syrup.id,
      batchNumber,
      printedExpiry: printedExpiry.toISOString(),
      expiryPrecision: 'DAY',
    },
    ['printedExpiry']
  );
  await trpcMutation(
    page,
    'pharmacyInventory.receiveLot',
    {
      branchId: PHARMACY_E2E.branchId,
      manufacturingBatchId: batch.id,
      packLevelId: syrup.packLevelIds.bottle,
      stockLocationId: PHARMACY_E2E.stockLocationId,
      unitsPerPack: syrup.unitsPerPack,
      supplierName: 'Fathom Distributors E2E',
      supplierInvoiceRef: `INV-${batchNumber}`,
      unitCostMinor: Math.floor(syrup.printedMrpMinor / syrup.unitsPerPack / 2),
      printedMrpMinor: syrup.printedMrpMinor,
      printedExpiry: printedExpiry.toISOString(),
      expiryPrecision: 'DAY',
      quantityUnits: syrup.unitsPerPack,
      idempotencyKey: `pharmacy-counter-e2e-ph-a4-${batchNumber}`,
    },
    ['printedExpiry']
  );

  // Before the line is added, the search row already names the FEFO batch.
  await search(page, 'Fathomcof');
  await stageFirstResult(page, syrup.name);
  const row = page
    .getByRole('list', { name: 'Search results' })
    .getByRole('button')
    .filter({ hasText: syrup.name })
    .first();
  await expect(row).toContainText(batchNumber);

  // One whole bottle: exactly the new lot's contents.
  await page.keyboard.press('F3');
  await expect(page.getByRole('radio', { name: /Pack/ })).toHaveAttribute('aria-checked', 'true');
  await setQuantity(page, 1);
  await page.keyboard.press('F6');
  const cart = page.getByRole('table', { name: 'Cart lines' });
  await expect(cart).toContainText(syrup.name, { timeout: 15_000 });

  const allocation = page.getByRole('list', { name: `Batch allocation for ${syrup.name}` });
  await expect(allocation).toContainText(`Batch ${batchNumber}`);
  await expect(allocation).not.toContainText(`Batch ${syrup.batchNumber}`);
  await expect(allocation).toContainText(`${syrup.unitsPerPack} units`);
  await expect(allocation).toContainText('FEFO');
  await expect(allocation).not.toContainText('Batch override');
  await expect(allocation).toContainText(/Near expiry · 4[4-6] d/);

  await tenderCash(page, '180.00');
  const receipt = page.getByRole('region', { name: /^Receipt \d+$/ });
  await expect(receipt).toBeVisible({ timeout: 15_000 });
  await expect(receipt).toContainText(batchNumber);
});

test('Khata ledger limit, owner override, statement and loyalty regression', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const { Client } = await import('pg');
  const db = new Client({ connectionString: process.env.PHARMACY_E2E_DATABASE_URL! });
  await db.connect();
  const familyId = `khata_e2e_${Date.now()}`;
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let customerId = '';
  let redemptionsBefore = 0;
  const begin = async () => {
    await db.query('BEGIN');
    await db.query(
      "SELECT set_config('app.current_organization_id', $1, true), set_config('app.current_branch_id', $2, true)",
      [PHARMACY_E2E.organizationId, PHARMACY_E2E.branchId]
    );
  };
  try {
    await begin();
    await db.query(
      `INSERT INTO organization_role_permissions (id, "organizationId", "organizationRoleId", capability, effect) VALUES ($1, $2, $3, 'pharmacy:dispense', 'ALLOW') ON CONFLICT ("organizationRoleId", capability) DO UPDATE SET effect='ALLOW'`,
      [familyId + '_permission', PHARMACY_E2E.organizationId, PHARMACY_E2E.roleId]
    );
    await db.query(
      `INSERT INTO pharmacy_patient_consents (id, "organizationId", "patientId", purpose, channel, version, granted, "recordedByUserId") VALUES ($1, $2, $3, 'LOYALTY', 'IN_PERSON', 1, true, $4) ON CONFLICT DO NOTHING`,
      [
        familyId + '_consent',
        PHARMACY_E2E.organizationId,
        PHARMACY_E2E.patientId,
        PHARMACY_E2E.adminId,
      ]
    );
    await db.query(
      `INSERT INTO pharmacy_customers (id, "organizationId", "patientId", "displayName", "updatedAt") VALUES ($1, $2, $3, 'Khata family payer', now()) ON CONFLICT ("organizationId", "patientId") DO NOTHING`,
      [familyId + '_customer', PHARMACY_E2E.organizationId, PHARMACY_E2E.patientId]
    );
    customerId = (
      await db.query('SELECT id FROM pharmacy_customers WHERE "patientId"=$1', [
        PHARMACY_E2E.patientId,
      ])
    ).rows[0].id;
    await db.query(
      `INSERT INTO pharmacy_family_accounts (id, "organizationId", "branchId", "payerCustomerId", "displayName", "creditLimitMinor", "updatedAt") VALUES ($1, $2, $3, $4, 'Counter test family', 1000, now())`,
      [familyId, PHARMACY_E2E.organizationId, PHARMACY_E2E.branchId, customerId]
    );
    await db.query(
      `INSERT INTO pharmacy_family_members (id, "organizationId", "branchId", "familyAccountId", "customerId") VALUES ($1, $2, $3, $4, $5)`,
      [
        familyId + '_member',
        PHARMACY_E2E.organizationId,
        PHARMACY_E2E.branchId,
        familyId,
        customerId,
      ]
    );
    redemptionsBefore = Number(
      (
        await db.query(
          `SELECT count(*) FROM pharmacy_loyalty_points_entries WHERE "customerId"=$1 AND kind='REDEEM'`,
          [customerId]
        )
      ).rows[0].count
    );
    await db.query('COMMIT');
    await signIn(page);
    await page.goto('/pharmacy/counter');
    await expect(page.getByRole('heading', { name: 'Counter', level: 1 })).toBeVisible();
    const makeBill = async () => {
      const scan = page.getByLabel('Scan or search');
      await scan.focus();
      await scan.fill(PHARMACY_E2E.medicines.otc.brandName);
      await scan.press('Enter');
      await stageFirstResult(page, PHARMACY_E2E.medicines.otc.name);
      const strip = page.getByRole('radio', { name: /Strip/ });
      await strip.focus();
      await strip.press('Space');
      await setQuantity(page, 1);
      await pressControl(page.getByRole('button', { name: /Add to cart/ }));
      await expect(page.getByRole('table', { name: 'Cart lines' })).toContainText(
        PHARMACY_E2E.medicines.otc.name
      );
      await page.keyboard.press('Shift+F2');
      const patientSearch = page.getByLabel('Find patient');
      await patientSearch.focus();
      await patientSearch.fill(PHARMACY_E2E.patientName);
      await patientSearch.press('Enter');
      await pressControl(page.getByRole('button', { name: new RegExp(PHARMACY_E2E.patientName) }));
      await page.keyboard.press('Escape');
      await expect(page.getByLabel('Scan or search')).toBeFocused();
      await pressControl(page.getByRole('button', { name: /loyalty/i }));
      await pressControl(page.getByRole('button', { name: 'Link selected patient' }));
      await expect(page.getByText('Loyalty customer linked to this bill.')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByLabel('Scan or search')).toBeFocused();
    };
    await makeBill();
    await page.keyboard.press('F9');
    await page.getByLabel('Tender', { exact: true }).selectOption('KHATA');
    await page.getByLabel('Family Khata account').selectOption(familyId);
    await page.getByLabel('Amount', { exact: true }).fill('1.00');
    await pressControl(page.getByRole('button', { name: 'Take payment' }));
    await expect(page.getByText('Payment recorded.', { exact: true })).toBeVisible();
    await expect(page.getByText(/Ledger balance 1\.00/)).toBeVisible();
    await expect(page.getByText(/This charge exceeds the family credit limit/)).toContainText(
      '25.00'
    );
    await expect(page.getByRole('button', { name: 'Take payment' })).toBeDisabled();
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(
          (value) => document.documentElement.setAttribute('data-theme', value),
          theme
        );
        await page.emulateMedia({ reducedMotion: 'reduce' });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
        ).toBe(true);
        for (const reducedMotion of ['no-preference', 'reduce'] as const) {
          await page.emulateMedia({ reducedMotion });
          await page
            .getByLabel('Family Khata account')
            .locator('..')
            .screenshot({
              path: testInfo.outputPath(`khata-${width}-${theme}-${reducedMotion}.png`),
            });
        }
      }
    }
    const override = page.getByLabel('Owner: authorize limit increase');
    await override.focus();
    await override.press('Space');
    await page
      .getByLabel('Family Khata account')
      .locator('..')
      .screenshot({ path: testInfo.outputPath('khata-owner-auth.png') });
    await page
      .getByLabel('Owner password (current account)')
      .fill(process.env.PHARMACY_E2E_ADMIN_PASSWORD!);
    await pressControl(page.getByRole('button', { name: 'Take payment' }));
    await expect(page.getByRole('region', { name: /^Receipt \d+$/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Scan or search')).toBeFocused();
    await page.keyboard.press('F9');
    await expect(page.getByText('Settled', { exact: true })).toBeVisible();
    const popupPromise = page.waitForEvent('popup');
    await pressControl(page.getByRole('button', { name: 'Print Khata statement' }));
    const popup = await popupPromise;
    await expect(popup.locator('body')).toContainText('Family Khata statement');
    await expect(popup.locator('body')).toContainText('CHARGE');
    await expect(popup.locator('body')).not.toContainText(PHARMACY_E2E.patientName);
    await popup.screenshot({ path: testInfo.outputPath('khata-statement.png') });
    await popup.close();
    await begin();
    expect(
      Number(
        (
          await db.query(
            `SELECT count(*) FROM pharmacy_khata_events WHERE "familyAccountId"=$1 AND kind='CHARGE'`,
            [familyId]
          )
        ).rows[0].count
      )
    ).toBe(2);
    expect(
      Number(
        (
          await db.query(
            'SELECT count(*) FROM pharmacy_khata_limit_decisions WHERE "familyAccountId"=$1',
            [familyId]
          )
        ).rows[0].count
      )
    ).toBe(1);
    expect(
      Number(
        (
          await db.query(
            'SELECT sum(points) AS points FROM pharmacy_loyalty_points_entries WHERE "customerId"=$1',
            [customerId]
          )
        ).rows[0].points
      )
    ).toBeGreaterThan(0);
    await db.query('COMMIT');
    // Loyalty remains the existing redeem path on the next bill.
    await page.goto('/pharmacy/counter');
    await makeBill();
    await pressControl(page.getByRole('button', { name: /loyalty/i }));
    await page.getByLabel('Points to redeem').fill('1');
    await pressControl(page.getByRole('button', { name: 'Redeem', exact: true }));
    await expect(page.getByText(/points added as a loyalty tender/)).toBeVisible();
    await begin();
    expect(
      Number(
        (
          await db.query(
            `SELECT count(*) FROM pharmacy_loyalty_points_entries WHERE "customerId"=$1 AND kind='REDEEM'`,
            [customerId]
          )
        ).rows[0].count
      )
    ).toBe(redemptionsBefore + 1);
    await db.query('COMMIT');
    expect(pageErrors).toEqual([]);
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
});

test('sell → return → refund → reprint from the counter', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await signIn(page);
  await page.goto('/pharmacy/counter');
  await expect(page.getByRole('heading', { name: 'Counter', level: 1 })).toBeVisible();
  await openDrawer(page);
  await search(page, PHARMACY_E2E.medicines.otc.brandName);
  await stageFirstResult(page, PHARMACY_E2E.medicines.otc.name);
  await page.keyboard.press('F4');
  await setQuantity(page, 1);
  await page.keyboard.press('F6');
  await expect(page.getByRole('table', { name: 'Cart lines' })).toContainText(
    PHARMACY_E2E.medicines.otc.name
  );
  await tenderCash(page, PHARMACY_E2E_EXPECTED.otcStripPrice);
  const receipt = page.getByRole('region', { name: /^Receipt \d+$/ });
  await expect(receipt).toBeVisible({ timeout: 15_000 });
  const receiptNumber = (await receipt.getAttribute('aria-label'))!.match(/\d+/)![0];
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Scan or search')).toBeFocused();
  await pressControl(page.getByRole('button', { name: 'Returns & refunds' }));
  const dialog = page.getByRole('dialog', { name: 'Returns & refunds' });
  await dialog.getByLabel('Receipt number', { exact: true }).fill(receiptNumber);
  await pressControl(dialog.getByRole('button', { name: 'Find receipt', exact: true }));
  const device = await page.evaluate(() =>
    localStorage.getItem('devfathom.pharmacy.counter.device')
  );
  const matches = dialog.getByRole('button', {
    name: new RegExp('Receipt ' + receiptNumber + ' ·'),
  });
  // New browser context has its own device sequence; choose its receipt explicitly.
  if (device) await pressControl(matches.filter({ hasText: device }));
  else await pressControl(matches.first());
  await dialog.getByLabel('Sold line').selectOption({ index: 1 });
  await dialog.getByLabel('Returned lot / batch').selectOption({ index: 1 });
  await dialog.getByLabel('Return quantity (base units)').fill('5');
  await dialog.getByLabel('Stock disposition', { exact: true }).selectOption('RESTOCK');
  await dialog
    .getByLabel('Inspection and integrity decision')
    .fill('Intact strip, correct storage verified');
  const confirm = dialog.getByLabel('I confirm the quantity, inspection and stock disposition.');
  await confirm.focus();
  await confirm.press('Space');
  await pressControl(dialog.getByRole('button', { name: 'Record return', exact: true }));
  await expect(dialog.getByRole('status')).toContainText('Return recorded.');
  await dialog.getByLabel('Original tender').selectOption({ index: 1 });
  await dialog
    .getByLabel('Refund amount (PKR)')
    .fill((Number(PHARMACY_E2E_EXPECTED.otcStripPrice) / 2).toFixed(2));
  await pressControl(dialog.getByRole('button', { name: 'Confirm refund', exact: true }));
  await expect(dialog.getByRole('status')).toContainText('Refund recorded.');
  await expect(dialog.getByRole('region', { name: 'Return and refund history' })).toContainText(
    'CASH refund:'
  );
  // The remaining physical units have no verifiable lot. Keep separate quarantine custody.
  await dialog.getByLabel('Returned lot / batch').selectOption('');
  await dialog.getByLabel('Return quantity (base units)').fill('5');
  await dialog.getByLabel('Quarantine location').selectOption({ index: 1 });
  await dialog
    .getByLabel('Inspection and integrity decision')
    .fill('Batch marking unreadable; pharmacist verification required');
  await confirm.focus();
  await confirm.press('Space');
  await pressControl(dialog.getByRole('button', { name: 'Record return', exact: true }));
  await expect(dialog.getByRole('status')).toContainText('Return recorded.');
  await expect(dialog.getByRole('region', { name: 'Return and refund history' })).toContainText(
    'pharmacist verification pending'
  );
  await dialog
    .getByLabel('Refund amount (PKR)')
    .fill((Number(PHARMACY_E2E_EXPECTED.otcStripPrice) / 2).toFixed(2));
  await pressControl(dialog.getByRole('button', { name: 'Confirm refund', exact: true }));
  await expect(dialog.getByRole('status')).toContainText('Refund recorded.');
  const popupPromise = page.waitForEvent('popup');
  await pressControl(dialog.getByRole('button', { name: 'Reprint receipt with refunds' }));
  const popup = await popupPromise;
  await expect(popup.locator('body')).toContainText('RETURNS & REFUNDS');
  await expect(popup.locator('body')).toContainText('WRONG_ITEM');
  await expect(popup.locator('body')).toContainText('pharmacist verification pending');
  await popup.close();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark'] as const) {
      for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        await page.emulateMedia({ reducedMotion, colorScheme: theme });
        await page.evaluate(
          (value) => document.documentElement.setAttribute('data-theme', value),
          theme
        );
        await dialog.evaluate((element) => {
          element.scrollTop = 0;
        });
        await expect(dialog).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true
        );
        await page.screenshot({
          path: `playwright-artifacts/pharmacy-counter/returns-${width}-${theme}-${reducedMotion}.png`,
        });
      }
    }
  }
  const accessibility = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  expect(browserErrors).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Returns & refunds' })).toBeFocused();
});

test('counter layout keeps the cart and payment visible while searching', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await openCounter(page);
  const otc = PHARMACY_E2E.medicines.otc;
  const sale = await trpcMutation<{ id: string }>(page, 'pharmacySales.create', {
    branchId: PHARMACY_E2E.branchId,
    quotation: false,
  });
  for (let line = 0; line < 20; line++) {
    await trpcMutation(page, 'pharmacySales.addLine', {
      branchId: PHARMACY_E2E.branchId,
      saleId: sale.id,
      medicineId: otc.id,
      presentationId: otc.presentationId,
      packLevelId: otc.packLevelIds.unit,
      saleUnit: 'UNIT',
      quantity: 1,
      canonicalUnitsPerSaleUnit: 1,
      idempotencyKey: `layout-${sale.id}-${line}`,
    });
  }
  await page.goto(`/pharmacy/counter?orderSaleId=${sale.id}&branchId=${PHARMACY_E2E.branchId}`);
  await expect(page.getByRole('table', { name: 'Cart lines' }).getByRole('row')).toHaveCount(21);
  await search(page, PHARMACY_E2E.medicines.otc.brandName);
  await stageFirstResult(page, PHARMACY_E2E.medicines.otc.name);
  await page.keyboard.press('F4');
  await setQuantity(page, 2);
  for (const width of [375, 768, 1024, 1280, 1440]) {
    const handoffHeight = width === 375 ? 812 : width === 768 ? 1024 : width === 1024 ? 768 : null;
    for (const height of handoffHeight ? [720, 900, handoffHeight] : [720, 900]) {
      await page.setViewportSize({ width, height });
      for (const theme of ['light', 'dark']) {
        await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
        for (const reducedMotion of ['no-preference', 'reduce'] as const) {
          await page.emulateMedia({ reducedMotion });
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
          ).toBe(true);
          const searchBox = await page.getByLabel('Scan or search').boundingBox();
          expect(searchBox?.height).toBe(56);
          const summary =
            width >= 1024
              ? page.getByRole('complementary', { name: 'Bill total' })
              : page.getByLabel('Phone payment');
          await expect(summary).toContainText(/Rs [0-9]/);
          const pay = page.getByRole('button', { name: /^Take payment/ });
          await expect(pay).toHaveCount(1);
          const payBox = await pay.boundingBox();
          expect(payBox).not.toBeNull();
          expect(payBox!.y + payBox!.height).toBeLessThanOrEqual(height);
          await expect(
            page
              .getByRole('region', { name: 'Next line' })
              .getByText(PHARMACY_E2E_EXPECTED.otcStripPrice, { exact: true })
              .first()
          ).toBeVisible();
          if (width >= 1024) {
            await expect(page.getByLabel('Scan or search')).toBeInViewport();
            const cart = await page.getByRole('table', { name: 'Cart lines' }).boundingBox();
            expect(cart).not.toBeNull();
            expect(cart!.y).toBeLessThan(height);
          }
          if (width >= 1280) {
            const pane = await page
              .getByRole('complementary', { name: 'Bill total' })
              .boundingBox();
            expect(pane).not.toBeNull();
            expect(pane!.y + pane!.height).toBeLessThanOrEqual(height);
            await page.getByLabel('Scan or search').focus();
            await expect(page.getByLabel('Scan or search')).toBeFocused();
          }
          if (reducedMotion === 'reduce' && [375, 768, 1024, 1440].includes(width)) {
            await page.screenshot({
              path: testInfo.outputPath(`counter-${width}-${height}-${theme}.png`),
            });
          }
        }
      }
    }
  }
  // Desktop has one persistent scroll owner; search results may scroll only while open.
  for (const [width, height] of [
    [1024, 720],
    [1024, 768],
    [1280, 720],
    [1440, 900],
  ]) {
    await page.setViewportSize({ width, height });
    const bill = page.getByRole('region', { name: 'Bill workspace' });
    const dimensions = await bill.evaluate((element) => ({
      overflow: getComputedStyle(element).overflowY,
      height: element.clientHeight,
      content: element.scrollHeight,
    }));
    expect(dimensions.overflow).toBe('auto');
    expect(dimensions.content).toBeGreaterThan(dimensions.height);
    for (const region of [
      page.locator('[aria-label="Counter bill"]'),
      page.getByRole('region', { name: 'Next line' }),
    ]) {
      expect(await region.evaluate((element) => getComputedStyle(element).overflowY)).not.toMatch(
        /^(auto|scroll)$/
      );
    }
    await bill.evaluate((element) => (element.scrollTop = 0));
    await bill.focus();
    await expect(bill).toBeFocused();
    await page.keyboard.press('PageDown');
    await expect.poll(() => bill.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: /^Take payment/ })).toBeInViewport();
    const nextLine = page.getByRole('region', { name: 'Next line' });
    await page.getByRole('button', { name: 'Go to next line' }).click();
    await expect(nextLine).toBeFocused();
    await expect(nextLine).toBeInViewport();
    const quantity = nextLine.getByRole('spinbutton', { name: 'Quantity' });
    const before = Number(await quantity.inputValue());
    const increase = nextLine.getByRole('button', { name: 'Increase quantity' });
    await increase.focus();
    await expect(increase).toBeInViewport();
    await page.keyboard.press('Space');
    await expect(quantity).toHaveValue(String(before + 1));
    await expect(page.getByRole('button', { name: /^Take payment/ })).toBeInViewport();
    await page.keyboard.press('F2');
    await expect(page.getByLabel('Scan or search')).toBeFocused();
  }
  for (const width of [375, 768]) {
    await page.setViewportSize({ width, height: 812 });
    const consoleRegion = page.locator('[data-counter-console]');
    await consoleRegion.evaluate((element) => (element.scrollTop = element.scrollHeight));
    await expect(page.getByRole('button', { name: /^Take payment/ })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await pressControl(page.getByText('Bill breakdown', { exact: true }));
  await expect(page.getByText('Gross', { exact: true })).toBeVisible();
  await expect(page.getByText('Discount', { exact: true })).toBeVisible();
  await expect(page.getByText('Tendered', { exact: true })).toBeVisible();
  await trpcMutation(page, 'pharmacySales.transition', {
    branchId: PHARMACY_E2E.branchId,
    saleId: sale.id,
    action: 'void',
    reason: 'Synthetic layout QA complete',
  });
});

test('counter More opens the correct sheet and restores focus', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 375, height: 812 });
  await openCounter(page);
  const header = page.getByRole('banner');
  await expect(header).toContainText('Counter');
  await expect(header).toContainText('Network available');
  expect((await header.boundingBox())?.height).toBe(64);
  for (const [width, height, expectedWidth] of [
    [375, 812, 375],
    [768, 1024, 460],
  ]) {
    await page.setViewportSize({ width, height });
    const menu = page.getByRole('button', { name: 'Open menu' });
    await pressControl(menu);
    const navigation = page.getByRole('dialog', { name: 'Module navigation' });
    await expect(navigation).toBeVisible();
    const bounds = await navigation.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBe(expectedWidth);
    if (width < 768) {
      expect(bounds!.y + bounds!.height).toBe(height);
      await expect(navigation.getByRole('button', { name: 'Search company hub' })).toBeVisible();
      await expect(navigation.getByRole('button', { name: 'Open account menu' })).toBeVisible();
      await expect(navigation.getByRole('button', { name: /Notifications/ })).toBeVisible();
      await expect(
        navigation.getByRole('button', { name: /Use (dark|light) theme/ })
      ).toBeVisible();
      await pressControl(navigation.getByRole('button', { name: 'Open account menu' }));
      await expect(page.getByRole('menuitem', { name: 'Profile' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menuitem', { name: 'Profile' })).not.toBeVisible();
      await expect(navigation).toBeVisible();
    } else {
      expect(bounds!.x).toBe(0);
      expect(bounds!.height).toBe(height);
    }
    await page.keyboard.press('Escape');
    await expect(navigation).not.toBeVisible();
    await expect(menu).toBeFocused();
  }
  for (const [width, height, expectedWidth] of [
    [375, 812, 375],
    [768, 1024, 460],
    [1024, 768, 480],
  ]) {
    await page.setViewportSize({ width, height });
    const more = page.getByRole('button', { name: 'More', exact: true });
    await pressControl(more);
    const sheet = page.getByRole('dialog', { name: 'More', exact: true });
    await expect(sheet).toBeVisible();
    const box = await sheet.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBe(expectedWidth);
    if (width < 768) expect(box!.y + box!.height).toBe(height);
    else {
      expect(box!.x + box!.width).toBe(width);
      expect(box!.height).toBe(height);
    }
    if (width === 375) {
      await expect(sheet.getByLabel('Branch')).toBeVisible();
      await pressControl(sheet.getByRole('button', { name: 'Returns & refunds' }));
      await expect(page.getByRole('dialog', { name: 'Returns & refunds' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Returns & refunds' })).not.toBeVisible();
      await expect(sheet).toBeVisible();
      await pressControl(sheet.getByRole('button', { name: 'Open drawer' }));
      await expect(sheet.getByText('Drawer open', { exact: true })).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await expect(sheet).not.toBeVisible();
    await expect(more).toBeFocused();
  }
});

test('opt-in counter navigation opens and restores focus', async ({ page }) => {
  test.skip(process.env.NEXT_PUBLIC_COUNTER_IMMERSIVE_NAV !== 'true', 'D02 preview is opt-in');
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1024, height: 768 });
  await openCounter(page);
  for (const [width, height, expectedWidth] of [
    [768, 1024, 460],
    [1024, 768, 480],
  ]) {
    await page.setViewportSize({ width, height });
    const menu = page.getByRole('button', { name: 'Menu', exact: true });
    await expect(page.getByRole('button', { name: 'Open menu' })).not.toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).not.toBeVisible();
    await pressControl(menu);
    const navigation = page.getByRole('dialog', { name: 'Module navigation' });
    await expect(navigation).toBeVisible();
    expect((await navigation.boundingBox())?.width).toBe(expectedWidth);
    await page.keyboard.press('Escape');
    await expect(navigation).not.toBeVisible();
    await expect(menu).toBeFocused();
  }
});

test('drawer confirmation overlays the counter and dismisses without moving it', async ({
  page,
}) => {
  await openCounter(page);
  const heading = page.getByRole('heading', { name: 'Counter', level: 1 });
  const before = await heading.boundingBox();
  await openDrawer(page);
  const toast = page
    .getByRole('status')
    .filter({ hasText: 'Cash drawer opened for this counter.' });
  await expect(toast).toHaveCSS('position', 'fixed');
  expect(await heading.boundingBox()).toEqual(before);
  await expect(toast).not.toBeVisible({ timeout: 6_000 });
  expect(await heading.boundingBox()).toEqual(before);
  await expect(page.getByText('Drawer open', { exact: true })).toBeVisible();
});

test('cashier — the seeded cashier sells from the counter and gets the receipt', async ({
  page,
}) => {
  // The seeded cashier holds the canonical pharmacy:counter that #163 leaves real cashiers with,
  // so this bill fails if the counter's receipt guard stops recognising it. It runs before the
  // day close, which refuses tenders for the rest of the business date.
  const otc = PHARMACY_E2E.medicines.otc;
  await openCounter(page, PHARMACY_E2E.cashierEmail);
  await openDrawer(page);
  await search(page, otc.brandName);
  await stageFirstResult(page, otc.name);
  await page.keyboard.press('F4');
  await setQuantity(page, 1);
  await page.keyboard.press('F6');
  await expect(page.getByRole('table', { name: 'Cart lines' })).toContainText(otc.name, {
    timeout: 15_000,
  });
  await tenderCash(page, PHARMACY_E2E_EXPECTED.otcStripPrice);
  const receipt = page.getByRole('region', { name: /^Receipt \d+$/ });
  await expect(receipt).toBeVisible({ timeout: 15_000 });
  await expect(receipt).toContainText(otc.name);
  await expect(receipt).toContainText(otc.batchNumber);
});

test('day close — open sell count lock and print Z-report', async ({ page, context }) => {
  await openCounter(page);
  await openDrawer(page);
  const otc = PHARMACY_E2E.medicines.otc;
  await search(page, otc.brandName);
  await stageFirstResult(page, otc.name);
  await page.keyboard.press('F4');
  await setQuantity(page, 2);
  await page.keyboard.press('F6');
  await expect(page.getByRole('table', { name: 'Cart lines' })).toContainText(otc.name);
  await tenderCash(page, PHARMACY_E2E_EXPECTED.otcTwoStripTotal);
  await expect(page.getByRole('region', { name: /^Receipt \d+$/ })).toBeVisible();
  await page.goto('/pharmacy/counter/close');
  await expect(page.getByRole('heading', { name: 'Day close', exact: true })).toBeVisible();
  const inputs = page.getByLabel(/Counted cash for drawer/);
  await expect(inputs.first()).toBeVisible();
  for (let i = 0; i < (await inputs.count()); i++) {
    const field = inputs.nth(i);
    const row = field.locator('..').locator('..');
    const text = await row.innerText();
    const expected = Number(text.match(/Expected: PKR ([\d,.]+)/)![1].replaceAll(',', ''));
    await field.fill((expected - (i === 0 ? 1 : 0)).toFixed(2));
  }
  await expect(page.getByTestId('Variance')).toHaveText('-1.00');
  await page.getByLabel('Variance note').fill('One rupee short at nightly count');
  await page.getByRole('checkbox').focus();
  await page.getByRole('checkbox').press('Space');
  await pressControl(page.getByRole('button', { name: 'Close and lock day' }));
  await expect(
    page.getByText('Day closed. New tenders and drawer changes for this business date are blocked.')
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText('Variance note: One rupee short at nightly count')).toBeVisible();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (theme) => document.documentElement.setAttribute('data-theme', theme),
        theme
      );
      await page.emulateMedia({ reducedMotion: theme === 'dark' ? 'reduce' : 'no-preference' });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`day-close-${width}-${theme}.png`),
        fullPage: true,
      });
    }
  }
  await context.addInitScript(() => {
    window.print = () => {};
  });
  const popupPromise = page.waitForEvent('popup');
  await pressControl(page.getByRole('button', { name: 'Print Z-report' }));
  const popup = await popupPromise;
  await expect(popup.locator('body')).toContainText('Z-report');
  await expect(popup.locator('body')).toContainText('One rupee short at nightly count');
  await popup.close();
  await page.goto('/pharmacy/counter');
  await pressControl(page.getByRole('button', { name: 'Open drawer' }));
  await expect(
    page.getByRole('alert').filter({ hasText: /This business day is closed/ })
  ).toBeVisible();
  await search(page, otc.brandName);
  await stageFirstResult(page, otc.name);
  await page.keyboard.press('F4');
  await setQuantity(page, 1);
  await page.keyboard.press('F6');
  await expect(page.getByRole('table', { name: 'Cart lines' })).toContainText(otc.name);
  await tenderCash(page, PHARMACY_E2E_EXPECTED.otcStripPrice);
  await expect(page.getByText(/This business day is closed/).first()).toBeVisible();
});

test('this spec drives the counter without a pointer', async () => {
  const source = await readFile(join(process.cwd(), 'tests/e2e/pharmacy-counter.spec.ts'), 'utf8');
  // Strip this assertion's own literals so it cannot match itself.
  const marker = 'this spec drives the counter without a pointer';
  const body = source.slice(0, source.indexOf(marker));
  // Non-vacuous: the slice must actually contain the three bills it is guarding.
  expect(body).toContain('bill 1 —');
  expect(body).toContain('bill 3 —');
  for (const pointerApi of ['.click(', '.dblclick(', '.hover(', '.tap(', '.dragTo(']) {
    expect(body, `pointer API used: ${pointerApi}`).not.toContain(pointerApi);
  }
});
