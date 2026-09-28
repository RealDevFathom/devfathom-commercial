import { expect, test, type Locator, type Page } from '@playwright/test';
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
  await target.focus();
  await expect(target).toBeFocused();
  await target.press('Enter');
}

async function signIn(page: Page) {
  await page.goto('/login');
  const email = page.getByLabel('Email');
  await email.focus();
  await email.fill(process.env.PHARMACY_E2E_ADMIN_EMAIL!);
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

async function openCounter(page: Page) {
  await signIn(page);
  await page.goto('/pharmacy/counter');
  await expect(page.getByRole('heading', { name: 'Counter', level: 1 })).toBeVisible();
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
  const field = page.getByLabel('Quantity');
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
  await openCounter(page);
  await openDrawer(page);

  // POS-02: a scanned barcode resolves to exactly one presentation.
  await search(page, otc.barcode);
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

  // POS-03: the cart shows the FEFO allocation, batch and expiry included.
  const allocation = page.getByRole('list', { name: `FEFO allocation for ${otc.name}` });
  await expect(allocation).toContainText(`Batch ${otc.batchNumber}`);
  await expect(allocation).toContainText('Exp 2028-06-30');
  await expect(allocation).toContainText('20 units');
  await expect(allocation).toContainText('FEFO');
  await expect(allocation).not.toContainText('Batch override');

  await tenderCash(page, PHARMACY_E2E_EXPECTED.otcTwoStripTotal);

  // POS-08: a settled bill renders a receipt carrying medicine, strength,
  // batch and expiry, and a receipt number the tender issued.
  const receipt = page.getByRole('region', { name: /^Receipt \d+$/ });
  await expect(receipt).toBeVisible({ timeout: 15_000 });
  await expect(receipt).toContainText(otc.name);
  await expect(receipt).toContainText(otc.strength);
  await expect(receipt).toContainText(otc.batchNumber);
  await expect(receipt).toContainText('2028-06-30');
  await expect(receipt).toContainText(PHARMACY_E2E_EXPECTED.otcTwoStripTotal);

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

test('controlled interlock requires Rx patient ID and pharmacist PIN; register prints', async ({
  page,
}) => {
  const { prepareControlledFixture, staffId, pharmacistPin, controlledClient } =
    await import('./pharmacy-controlled-fixture');
  await prepareControlledFixture();
  await openCounter(page);
  const search = page.getByLabel('Scan or search');
  await search.fill(PHARMACY_E2E.medicines.rx.name);
  await search.press('Enter');
  await stageFirstResult(page, PHARMACY_E2E.medicines.rx.name);
  await pressControl(page.getByRole('radio', { name: /Unit/ }));
  await setQuantity(page, 1);
  // Use the same keyboard add action as the other counter acceptance cases.
  await pressControl(page.getByRole('button', { name: /Add to (cart|bill)/i }));
  await expect(page.getByText(/Controlled medicine needs a patient with ID/)).toBeVisible();
  await page.getByLabel('Find patient').fill(PHARMACY_E2E.patientName);
  await page.getByLabel('Find patient').press('Enter');
  await pressControl(page.getByRole('button', { name: new RegExp(PHARMACY_E2E.patientName) }));
  await page
    .getByLabel('Prescription line', { exact: true })
    .selectOption(PHARMACY_E2E.medicines.rx.prescriptionLineId);
  await page.getByLabel('Approving pharmacist').selectOption(staffId);
  await page.getByLabel('Pharmacist PIN', { exact: true }).fill('111111');
  await pressControl(page.getByRole('button', { name: /Add to (cart|bill)/i }));
  await expect(page.getByText(/Controlled medicine requires a valid prescription/)).toBeVisible();
  await expect(page.getByLabel('Pharmacist PIN', { exact: true })).toHaveValue('');
  await page.getByLabel('Pharmacist PIN', { exact: true }).fill(pharmacistPin);
  await pressControl(page.getByRole('button', { name: /Add to (cart|bill)/i }));
  await expect(page.getByRole('status').filter({ hasText: /added/ })).toBeVisible();
  const db = await controlledClient();
  try {
    const entries = await db.query(
      `SELECT e."runningBalance", (SELECT sum(b."onHandUnits")::int FROM pharmacy_stock_balances b WHERE b."inventoryLotId"=e."inventoryLotId" AND b."branchId"=e."branchId") AS actual FROM pharmacy_controlled_register_entries e WHERE e."prescriptionLineId"=$1`,
      [PHARMACY_E2E.medicines.rx.prescriptionLineId]
    );
    expect(entries.rows.length).toBeGreaterThan(0);
    for (const entry of entries.rows) expect(entry.runningBalance).toBe(entry.actual);
  } finally {
    await db.end();
  }
  await page.goto('/pharmacy/controlled-register');
  await expect(
    page.getByRole('heading', { name: 'Controlled register', exact: true })
  ).toBeVisible();
  const popupPromise = page.waitForEvent('popup');
  await pressControl(page.getByRole('button', { name: 'Print register', exact: true }));
  const popup = await popupPromise;
  await expect(popup.getByRole('heading', { name: 'Controlled medicine register' })).toBeVisible();
  await expect(popup.getByRole('table')).toContainText(PHARMACY_E2E.patientName);
});
