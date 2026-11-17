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
  await expect(page.getByRole('heading', { name: 'Counter', level: 1 })).toBeVisible();
  // The module is licensed by the seed, so the shell must render the counter
  // itself rather than the honest not-enabled panel.
  await expect(page.getByRole('heading', { name: 'This module is not enabled' })).toHaveCount(0);
  // DEV-725: a fresh context is a new counter device with no drawer, so the shift
  // starts at the opening-cash step; scan/search follows once the drawer is open.
  await expect(page.getByLabel('Opening cash', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Scan or search')).toHaveCount(0);
}

test('pharmacy-only navigation exposes pharmacy destinations and excludes Restaurant routes', async ({
  page,
}) => {
  await signIn(page);
  const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
  // DEV-497: pharmacy destinations sit in task menus, opened from the keyboard.
  // Capability-gated entries follow the rail's server read; Purchasing, alone
  // in its menu, is the bar's own sign that the answer has arrived.
  await expect(navigation.getByRole('link', { name: 'Purchasing' })).toBeVisible({
    timeout: 30_000,
  });
  await pressControl(navigation.getByRole('button', { name: 'Sell', exact: true }));
  await expect(navigation.getByRole('link', { name: 'Counter' })).toBeVisible();
  await pressControl(navigation.getByRole('button', { name: 'Settings', exact: true }));
  await expect(navigation.getByRole('link', { name: 'Counter' })).toBeHidden();
  await expect(navigation.getByRole('link', { name: 'Onboarding' })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Regulatory profile' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(navigation.getByRole('link', { name: 'Onboarding' })).toBeHidden();
  await expect(navigation.getByRole('link', { name: 'Point of sale' })).toHaveCount(0);
  await expect(navigation.getByRole('link', { name: 'Kitchen display' })).toHaveCount(0);
  await expect(navigation.getByRole('link', { name: 'Restaurant staff' })).toHaveCount(0);
});

/**
 * DEV-497: every role lands on a page it can work from after sign-in, and the
 * `/pharmacy` front door sends a member who cannot run onboarding to their own
 * work instead of a dead end.
 */
const LANDINGS = [
  {
    role: 'owner',
    email: () => process.env.PHARMACY_E2E_ADMIN_EMAIL!,
    signIn: /\/dashboard/,
    signInHeading: 'Owner command centre',
    pharmacy: /\/pharmacy$/,
    pharmacyHeading: 'Onboarding',
  },
  {
    role: 'pharmacist',
    email: () => PHARMACY_E2E.pharmacistEmail,
    signIn: /\/pharmacy\/pharmacist-queue$/,
    signInHeading: 'Pharmacist queue',
    pharmacy: /\/pharmacy\/pharmacist-queue$/,
    pharmacyHeading: 'Pharmacist queue',
  },
  {
    role: 'cashier',
    email: () => PHARMACY_E2E.cashierEmail,
    signIn: /\/dashboard/,
    signInHeading: 'Your work today',
    pharmacy: /\/pharmacy\/counter$/,
    pharmacyHeading: 'Counter',
  },
] as const;

for (const landing of LANDINGS) {
  test(`the ${landing.role} lands on a usable page, never a dead end (DEV-497)`, async ({
    page,
  }) => {
    await signIn(page, landing.email());
    await expect(page).toHaveURL(landing.signIn);
    await expect(
      page.getByRole('heading', { name: landing.signInHeading, level: 1 })
    ).toBeVisible();

    await page.goto('/pharmacy');
    await expect(page).toHaveURL(landing.pharmacy);
    await expect(
      page.getByRole('heading', { name: landing.pharmacyHeading, level: 1 })
    ).toBeVisible();
    await expect(page.getByText('Onboarding is not available to you')).toHaveCount(0);
  });
}

test('the cashier is offered only destinations a cashier can open (DEV-497)', async ({ page }) => {
  await signIn(page, PHARMACY_E2E.cashierEmail);
  const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
  // Counter is gated on the rail's server read, so it marks the answer's arrival.
  await expect(navigation.getByRole('link', { name: 'Counter' })).toBeVisible({ timeout: 30_000 });
  for (const name of ['Day close', 'Purchasing', 'Inventory', 'Finance', 'Onboarding'])
    await expect(navigation.getByRole('link', { name })).toHaveCount(0);
  // No numeric prefixes anywhere in the bar.
  await expect(navigation).not.toContainText(/\d/);
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
  // DEV-725: opening the drawer is the shift's first step and records the counted cash.
  await page.getByLabel('Opening cash', { exact: true }).fill('0');
  await pressControl(page.getByRole('button', { name: 'Open drawer' }));
  await expect(
    page.getByRole('status').filter({ hasText: /Cash drawer opened for this counter/i })
  ).toBeVisible();
  await expect(page.getByText(/DRAWER_NOT_OPEN/)).toHaveCount(0);
  // POS-01: focus then rests in the scan field for the whole bill.
  await expect(page.getByLabel('Scan or search')).toBeFocused();
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

/**
 * DEV-499: exact cash is two steps. F9 opens payment with Cash received already
 * set to the balance due and focus on the panel; Enter takes the payment.
 */
async function tenderCash(page: Page, amount: string) {
  await page.keyboard.press('F9');
  await expect(page.getByLabel('Cash received')).toHaveValue(amount);
  await expect(page.getByText('Change', { exact: true }).locator('..')).toContainText('0.00');
  await page.keyboard.press('Enter');
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
  const cart = page.getByRole('list', { name: 'Cart lines' });
  await expect(cart).toContainText(otc.name, { timeout: 15_000 });
  await expect(cart).toContainText('2 ×');
  await expect(page.getByText('Bill open · 1 line')).toBeVisible();

  // POS-03: the cart shows the FEFO allocation, batch and expiry included.
  const allocation = page.getByRole('list', { name: `FEFO allocation for ${otc.name}` });
  await expect(allocation).toContainText(`Batch ${otc.batchNumber}`);
  await expect(allocation).toContainText('Exp 2028-06-30');
  await expect(allocation).toContainText('20 units');
  await expect(allocation).toContainText('Earliest expiry');
  await expect(allocation).not.toContainText('Batch override');

  // POS-02: a scanned barcode resolves to exactly one presentation, and Enter on a barcode
  // with a single match adds one of its first sale unit (scan-to-add, 699d5c1d; pinned by
  // counter-console.test.tsx "adds a barcode on Enter only when the search returns that
  // single medicine"). Nothing is added unless the scan matched exactly this medicine.
  await search(page, otc.barcode);
  await expect(page.getByText(`1 × ${otc.name} added.`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Bill open · 2 lines')).toBeVisible();
  await expect(cart).toContainText(`1 × ${otc.name}`);
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
  const cart = page.getByRole('list', { name: 'Cart lines' });
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
  const aliasResult = page
    .getByRole('list', { name: 'Search results' })
    .getByRole('button')
    .first();
  await expect(aliasResult).toContainText(otc.brandName);
  await expect(aliasResult).toContainText(`Strength: ${otc.strength}`);
  await expect(aliasResult).toContainText('Form:');
  await expect(aliasResult).toContainText('Stock:');
  await stageFirstResult(page, otc.name);

  await page.keyboard.press('F3');
  await expect(page.getByRole('radio', { name: /Pack/ })).toHaveAttribute('aria-checked', 'true');
  await setQuantity(page, 1);
  await expect(page.getByText('250.00').first()).toBeVisible();

  await page.keyboard.press('F6');
  const cart = page.getByRole('list', { name: 'Cart lines' });
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
  await openDrawer(page);

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
  await expect(page.getByRole('list', { name: 'Cart lines' })).toContainText(rx.name, {
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

  // Tender is refused while the block stands.
  await page.keyboard.press('F9');
  await expect(page.getByRole('button', { name: 'Take payment' })).toBeDisabled();
  await expect(page.getByText(/unresolved safety block/i)).toBeVisible();

  // The only way past is to correct the bill. Shift+F4 voids it.
  await page.keyboard.press('Shift+F4');
  await expect(page.getByRole('status').filter({ hasText: /Bill voided/i })).toBeVisible({
    timeout: 15_000,
  });
});

test('POS-01 — the workflow map is on screen and the Legacy Speed preset is an honest placeholder', async ({
  page,
}) => {
  await openCounter(page);
  await openDrawer(page);

  const legend = page.getByRole('heading', { name: 'Workflow map' });
  await expect(legend).toBeVisible();
  // The chords a cashier needs are readable without opening help.
  //
  // `exact` matters: each action also has an `sr-only` live-region announcement
  // ("Focus scan and search: F2") for screen-reader users, so a loose text match
  // resolves to two nodes and fails strict mode. Matching the visible term
  // exactly asserts the printed map rather than the announcement.
  await expect(page.getByText('Focus scan and search', { exact: true })).toBeVisible();
  await expect(page.getByText('Open tender', { exact: true })).toBeVisible();

  const preset = page.getByLabel('Keymap');
  await preset.focus();
  await preset.selectOption('legacySpeed');

  // The honest-placeholder claim is about the WARNING the counter raises, not
  // about the preset's prose description — both mention Phase 0, so the
  // assertion is scoped to the live status region that carries the caveat.
  const placeholderNotice = page.getByRole('status').filter({ hasText: /to confirm in Phase 0/i });
  await expect(placeholderNotice).toBeVisible({ timeout: 15_000 });
  // Named against the PRD §12 open decision, so the caveat is falsifiable.
  await expect(placeholderNotice).toContainText('D01');
  await expect(placeholderNotice).toContainText(/Placeholder/i);

  // Restore the default so a re-run starts from the shipped map.
  await preset.focus();
  await preset.selectOption('devfathom');
  await expect(placeholderNotice).toHaveCount(0);
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
  const cart = page.getByRole('list', { name: 'Cart lines' });
  await expect(cart).toContainText(syrup.name, { timeout: 15_000 });

  const allocation = page.getByRole('list', { name: `FEFO allocation for ${syrup.name}` });
  await expect(allocation).toContainText(`Batch ${batchNumber}`);
  await expect(allocation).not.toContainText(`Batch ${syrup.batchNumber}`);
  await expect(allocation).toContainText(`${syrup.unitsPerPack} units`);
  await expect(allocation).toContainText('Earliest expiry');
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
    await openDrawer(page);
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
      await expect(page.getByRole('list', { name: 'Cart lines' })).toContainText(
        PHARMACY_E2E.medicines.otc.name
      );
      const patientSearch = page.getByLabel('Find patient');
      await patientSearch.focus();
      await patientSearch.fill(PHARMACY_E2E.patientName);
      await patientSearch.press('Enter');
      await pressControl(page.getByRole('button', { name: new RegExp(PHARMACY_E2E.patientName) }));
      await pressControl(page.getByRole('button', { name: 'Link selected patient' }));
      await expect(page.getByText('Loyalty customer linked to this bill.')).toBeVisible();
    };
    await makeBill();
    await pressControl(
      page
        .getByRole('group', { name: 'Payment method', exact: true })
        .getByRole('button', { name: 'Khata', exact: true })
    );
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
    const override = page.getByLabel('Owner or manager: authorize limit increase');
    await override.focus();
    await override.press('Space');
    await page
      .getByLabel('Family Khata account')
      .locator('..')
      .screenshot({ path: testInfo.outputPath('khata-owner-auth.png') });
    // The signed-in admin approves as themselves with a fresh password re-entry.
    await page.getByLabel('I am the only owner or manager: re-enter my password').check();
    await page.getByLabel('Reason for exceeding the limit').fill('Regular family, paying Friday');
    await page
      .getByLabel('Your password (current account)')
      .fill(process.env.PHARMACY_E2E_ADMIN_PASSWORD!);
    await pressControl(page.getByRole('button', { name: 'Take payment' }));
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
  await expect(page.getByRole('list', { name: 'Cart lines' })).toContainText(
    PHARMACY_E2E.medicines.otc.name
  );
  await tenderCash(page, PHARMACY_E2E_EXPECTED.otcStripPrice);
  const receipt = page.getByRole('region', { name: /^Receipt \d+$/ });
  await expect(receipt).toBeVisible({ timeout: 15_000 });
  const receiptNumber = (await receipt.getAttribute('aria-label'))!.match(/\d+/)![0];
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
  // DEV-501: a one-line return and refund is one form and one confirm. The only line and
  // the only (cash) tender are preselected; quantity is in the unit sold (strips) plus loose
  // units, and the refund is prefilled from the returned quantity.
  const half = (Number(PHARMACY_E2E_EXPECTED.otcStripPrice) / 2).toFixed(2);
  await expect(dialog.getByLabel('Sold line')).not.toHaveValue('');
  await dialog.getByLabel('Returned lot / batch').selectOption({ index: 1 });
  await dialog.getByLabel('Return quantity (strips)').fill('0');
  await dialog.getByLabel('Plus loose units').fill('5');
  await dialog.getByLabel('Stock disposition', { exact: true }).selectOption('RESTOCK');
  await dialog
    .getByLabel('Inspection and integrity decision (optional)')
    .fill('Intact strip, correct storage verified');
  await expect(dialog.getByLabel('Refund to')).not.toHaveValue('');
  await expect(dialog.getByLabel('Refund for this return (PKR)')).toHaveValue(half);
  await dialog.getByLabel('Your manager or owner PIN').fill(PHARMACY_E2E.adminPin);
  await pressControl(dialog.getByRole('button', { name: 'Confirm return & refund', exact: true }));
  await expect(dialog.getByRole('status')).toContainText(
    `Return recorded and refunded: PKR ${half}`
  );
  await expect(dialog.getByRole('region', { name: 'Return and refund history' })).toContainText(
    'CASH refund:'
  );
  // The remaining physical units have no verifiable lot. Keep separate quarantine custody.
  await dialog.getByLabel('Returned lot / batch').selectOption('');
  await dialog.getByLabel('Return quantity (strips)').fill('0');
  await dialog.getByLabel('Plus loose units').fill('5');
  await dialog.getByLabel('Quarantine location').selectOption({ index: 1 });
  await dialog
    .getByLabel('Inspection and integrity decision (optional)')
    .fill('Batch marking unreadable; pharmacist verification required');
  await expect(dialog.getByLabel('Refund for this return (PKR)')).toHaveValue(
    (Number(PHARMACY_E2E_EXPECTED.otcStripPrice) - Number(half)).toFixed(2)
  );
  await dialog.getByLabel('Your manager or owner PIN').fill(PHARMACY_E2E.adminPin);
  await pressControl(dialog.getByRole('button', { name: 'Confirm return & refund', exact: true }));
  await expect(dialog.getByRole('status')).toContainText('Return recorded and refunded');
  await expect(dialog.getByRole('region', { name: 'Return and refund history' })).toContainText(
    'pharmacist verification pending'
  );
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
  await expect(page.getByRole('list', { name: 'Cart lines' })).toContainText(otc.name, {
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
  await expect(page.getByRole('list', { name: 'Cart lines' })).toContainText(otc.name);
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
  await page.getByLabel('Opening cash', { exact: true }).fill('0');
  await pressControl(page.getByRole('button', { name: 'Open drawer' }));
  await expect(
    page.getByRole('alert').filter({ hasText: /This business day is closed/ })
  ).toBeVisible();
  // DEV-725: with the day closed no drawer opens, so no bill can be started that
  // payment would then refuse: the opening step stays and scan/search is not offered.
  await expect(page.getByLabel('Opening cash', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Scan or search', { exact: true })).toHaveCount(0);
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
