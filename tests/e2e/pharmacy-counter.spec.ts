import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PHARMACY_E2E, PHARMACY_E2E_EXPECTED } from './pharmacy-counter-fixture';
import { resolvePharmacyE2eDatabaseUrl } from '../../scripts/pharmacy-e2e-environment';
import { workspaceToday } from '../../src/lib/timezone';
import { counterLabel } from '../../src/lib/pharmacy/counter-label';

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

let otcLotId: string;

test.beforeAll(async () => {
  // The disposable counter corpus needs a licensed branch, just as a real sale does.
  // These synthetic records never alter a live jurisdiction or regulatory profile.
  const { Client } = await import('pg');
  const db = new Client({ connectionString: resolvePharmacyE2eDatabaseUrl() });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query(
      "SELECT set_config('app.is_platform_admin', 'true', true), set_config('app.current_organization_id', $1, true)",
      [PHARMACY_E2E.organizationId]
    );
    await db.query(`INSERT INTO pharmacy_jurisdiction_rule_sets
      (id,code,version,"effectiveFrom","licenceCategories","permittedSchedules","prescriptionOnlyClasses","prescriptionRetentionDays","controlledRegisterFlags","pharmacistCoverageRule","recordRetentionByClass")
      VALUES ('jurisdiction_pharmacy_counter_e2e','PHARMACY-COUNTER-E2E',1,'2026-09-01',
        '{"provisional":false,"values":["PHARMACY"]}', '{"provisional":false,"values":["RX"]}',
        '{"provisional":false,"values":[]}', '{"provisional":false,"values":{}}',
        '{"provisional":false,"values":{}}',
        '{"provisional":false,"values":{"presenceHours":{"timeZone":"Asia/Karachi","windows":[{"days":[0,1,2,3,4,5,6],"start":"00:00","end":"24:00"}]}}}',
        '{"provisional":false,"values":{}}') ON CONFLICT (id) DO NOTHING`);
    await db.query(
      `INSERT INTO pharmacy_branch_regulatory_profiles
      (id,"organizationId","branchId",version,"effectiveFrom","provinceCode","jurisdictionRuleSetId",premises,
       "licenceCategory","licenceNumber","licenceValidFrom","licenceValidTo","licenceEvidenceFileRef","permittedSchedules",
       "qualifiedPersonRegistration","qualifiedPersonValidFrom","qualifiedPersonValidTo","qualifiedPersonCoverageRosterRef","fiscalStatus","retentionPolicy")
      SELECT 'regulatory_pharmacy_counter_e2e',"organizationId",id,1,'2026-09-01',"provinceCode",'jurisdiction_pharmacy_counter_e2e',
        jsonb_build_object('addressLine',"addressLine",'city',city),'PHARMACY','SYNTHETIC-E2E-ONLY','2026-09-01','2040-01-01',
        'evidence://pharmacy-counter-e2e/licence',ARRAY['RX'],'QP-E2E-ONLY','2026-09-01','2040-01-01',
        'evidence://pharmacy-counter-e2e/roster','REGISTERED','{}'
      FROM pharmacy_branches WHERE "organizationId"=$1 AND id=$2 ON CONFLICT (id) DO NOTHING`,
      [PHARMACY_E2E.organizationId, PHARMACY_E2E.branchId]
    );
    const lots = await db.query<{ id: string }>(
      `SELECT id FROM pharmacy_inventory_lots WHERE "organizationId"=$1 AND "branchId"=$2 AND "manufacturingBatchId"=$3`,
      [PHARMACY_E2E.organizationId, PHARMACY_E2E.branchId, PHARMACY_E2E.medicines.otc.batchId]
    );
    expect(lots.rows).toHaveLength(1);
    otcLotId = lots.rows[0]!.id;
    await db.query('COMMIT');
  } finally {
    await db.end();
  }
});

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
  // Exact: the Settings menu also holds "Counters" (the counter computers page).
  await expect(navigation.getByRole('link', { name: 'Counter', exact: true })).toBeVisible();
  await pressControl(navigation.getByRole('button', { name: 'Settings', exact: true }));
  await expect(navigation.getByRole('link', { name: 'Counter', exact: true })).toBeHidden();
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
  const openingCash = page.getByLabel('Opening cash', { exact: true });
  if ((await openingCash.getAttribute('readonly')) !== null) {
    // Cashiers open empty tills; only managers can edit the opening float.
    await expect(openingCash).toHaveValue('0');
  } else {
    await openingCash.fill('0');
  }
  await pressControl(page.getByRole('button', { name: 'Open drawer' }));
  await expect(
    page.getByRole('status').filter({ hasText: /Cash drawer opened for this counter/i })
  ).toBeVisible();
  await expect(page.getByText(/DRAWER_NOT_OPEN/)).toHaveCount(0);
  // POS-01: focus then rests in the scan field for the whole bill.
  await expect(page.getByLabel('Scan or search')).toBeFocused();
}

/** Checkbox/radio labels are part of their native activation target. */
async function expectCounterTargets(page: Page) {
  const undersized = await page.locator('main, [role="dialog"]').evaluateAll((roots) => {
    const controls = new Set(
      roots.flatMap((root) =>
        Array.from(
          root.querySelectorAll<HTMLElement>(
            'button, input:not([type="hidden"]), select, textarea, a[href], [role="radio"], [role="combobox"]'
          )
        )
      )
    );
    return [...controls].flatMap((control) => {
      if (!control.checkVisibility() || control.closest('[inert]')) return [];
      const usesLabel =
        (control instanceof HTMLInputElement && /^(checkbox|radio)$/.test(control.type)) ||
        ['checkbox', 'radio', 'switch'].includes(control.getAttribute('role') ?? '');
      const label = usesLabel
        ? [...document.querySelectorAll('label')].find(
            (label) =>
              label.contains(control) || Boolean(control.id && label.htmlFor === control.id)
          )
        : null;
      const rect = (label ?? control).getBoundingClientRect();
      return rect.width >= 44 && rect.height >= 44
        ? []
        : [
            {
              control:
                control.getAttribute('aria-label') || control.id || control.textContent?.trim(),
              width: rect.width,
              height: rect.height,
            },
          ];
    });
  });
  expect(undersized).toEqual([]);
  for (const control of await page.locator('main, [role="dialog"]').getByRole('button').all()) {
    await expect(control).toHaveAccessibleName(/\S/);
  }
}

test('a11y — counter targets, names, skip destinations and full-page axe across the Studio matrix', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signIn(page);
  await page.goto('/pharmacy/counter');
  await expect(page.getByRole('heading', { name: 'Counter', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Opening cash', { exact: true })).toBeEnabled();
  await expectCounterTargets(page);
  await openDrawer(page);
  await search(page, PHARMACY_E2E.medicines.otc.brandName);
  await stageFirstResult(page, PHARMACY_E2E.medicines.otc.name);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark'] as const) {
      for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        await page.emulateMedia({ colorScheme: theme, reducedMotion });
        await page.evaluate(
          (value) => document.documentElement.setAttribute('data-theme', value),
          theme
        );
        await expect(page.getByRole('main')).toHaveCount(1);
        await expectCounterTargets(page);
        const tinyText = await page
          .locator('.pharmacy-workspace *')
          .evaluateAll((elements) =>
            elements
              .filter(
                (element) =>
                  element.checkVisibility() &&
                  [...element.childNodes].some(
                    (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
                  ) &&
                  parseFloat(getComputedStyle(element).fontSize) < 12
              )
              .map((element) => element.textContent?.trim())
          );
        expect(tinyText).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true
        );
        const axe = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze();
        expect(
          axe.violations.filter((violation) =>
            ['serious', 'critical'].includes(violation.impact ?? '')
          )
        ).toEqual([]);
        await page.screenshot({
          path: `playwright-artifacts/pharmacy-counter/a11y-${width}-${theme}-${reducedMotion}.png`,
        });
      }
    }
  }
  const scanLink = page.getByRole('link', { name: 'Skip to scan or search' });
  await pressControl(scanLink);
  await expect(page.getByLabel('Scan or search')).toBeFocused();
  await pressControl(page.getByRole('link', { name: 'Skip to bill total' }));
  await expect(page.getByRole('complementary', { name: 'Bill total' })).toBeFocused();
  await page.setViewportSize({ width: 375, height: 900 });
  // DEV-977 (Counter v2): every action below 1280px sits in the action row's More menu.
  await pressControl(page.getByRole('button', { name: 'More', exact: true }));
  await pressControl(page.getByRole('button', { name: 'Shortcuts', exact: true }));
  await expectCounterTargets(page);
  await page.keyboard.press('Escape');
  await pressControl(page.getByRole('button', { name: 'Open bills', exact: true }));
  await expectCounterTargets(page);
  await page.keyboard.press('Escape');
});

async function search(page: Page, term: string) {
  // F2 is the POS-01 chord for the scan field; using it here proves the chord
  // works rather than merely that the field exists.
  await page.keyboard.press('F2');
  const field = page.getByLabel('Scan or search');
  await expect(field).toBeFocused();
  await field.fill(term);
  // DEV-977B (Counter v2, A6): results drop over the bill as the term is typed, and Enter
  // ADDS the highlighted result at once. A search therefore waits for its results and does
  // not press Enter; `addFirstResult` and `scan` are the two ways Enter is used.
  await expect(
    page.getByRole('list', { name: 'Search results' }).getByRole('listitem').first()
  ).toBeVisible({ timeout: 15_000 });
}

/** A barcode typed or scanned into the field: Enter adds the one medicine it resolves to. */
async function scan(page: Page, code: string) {
  await page.keyboard.press('F2');
  const field = page.getByLabel('Scan or search');
  await expect(field).toBeFocused();
  await field.fill(code);
  await field.press('Enter');
}

async function stageFirstResult(page: Page, medicineName: string) {
  const row = page
    .getByRole('list', { name: 'Search results' })
    .getByRole('button')
    .filter({ hasText: medicineName })
    .first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  // DEV-977B (Counter v2): a press on a result adds it in one step; the line form (quantity,
  // unit or batch before adding) opens from the result's own "Quantity or batch first" button.
  // The chosen result carries the mark: it is the highlighted one Enter would add.
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  const options = row.locator('xpath=following-sibling::button[1]');
  await expect(options).toHaveAccessibleName(/^Quantity or batch first: /);
  await pressControl(options);
  // The results close once the line form opens over the bill; the form names the medicine.
  const nextLine = page.getByRole('region', { name: 'Next line' });
  await expect(nextLine).toBeVisible();
  await expect(nextLine).toContainText(medicineName);
  await expect(page.getByRole('list', { name: 'Search results' })).toHaveCount(0);
}

/** The line form (DEV-977B: opened by Shift+Enter or "Quantity or batch first"). */
function nextLine(page: Page) {
  return page.getByRole('region', { name: 'Next line' });
}

/**
 * The line form's unit choice. DEV-977B: the counter's "Adds as" toggle (the unit Enter adds)
 * also offers Pack, Strip and Unit, so unit lookups are scoped to the line form.
 */
function saleUnits(page: Page) {
  return nextLine(page).getByRole('radiogroup', { name: 'Sale unit' });
}

/** The first result row for a medicine, read before anything is added or staged. */
function resultRow(page: Page, medicineName: string) {
  return page
    .getByRole('list', { name: 'Search results' })
    .getByRole('button')
    .filter({ hasText: medicineName })
    .first();
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
  await expect(page.getByLabel('Scan or search')).toBeEnabled();
  await page.keyboard.press('F9');
  const panel = page
    .getByRole('dialog', { name: /^Take payment/ })
    .locator('div[tabindex="-1"]')
    .filter({ has: page.getByRole('group', { name: 'Payment method', exact: true }) });
  await expect(panel).toBeFocused();
  await expect(page.getByLabel('Cash received')).toHaveValue(amount);
  await expect(page.getByText('Change', { exact: true }).locator('..')).toContainText('0.00');
  await expect(page.getByRole('button', { name: 'Take payment', exact: true })).toBeEnabled();
  await page.keyboard.press('Enter');
}

/**
 * DEV-977B (Counter v2, A6): Enter in the search field adds the highlighted result, the first
 * one until the arrows move, as one unit of the "Adds as" unit, in one step.
 */
async function addFirstResult(page: Page, medicineName: string) {
  const row = resultRow(page, medicineName);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  const field = page.getByLabel('Scan or search');
  await expect(field).toBeFocused();
  await field.press('Enter');
}

/** A bill line on the cart table (DEV-977B: quantity, unit and remove live on it). */
function billLine(page: Page, medicineName: string) {
  return page
    .getByRole('table', { name: 'Cart lines' })
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: new RegExp(`^${medicineName}`) }) });
}

/** The payment sheet (Counter v2 A2): F9 opens it with the panel focused. */
async function openPayment(page: Page) {
  await page.keyboard.press('F9');
  const sheet = page.getByRole('dialog', { name: /^Take payment/ });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('group', { name: 'Payment method', exact: true })).toBeVisible();
  return sheet;
}

/** A method card in the payment sheet, chosen from the keyboard. */
async function choosePaymentMethod(page: Page, name: string) {
  const method = page
    .getByRole('dialog', { name: /^Take payment/ })
    .getByRole('button', { name, exact: true });
  await pressControl(method);
  await expect(method).toHaveAttribute('aria-pressed', 'true');
}

/** Ticks an unticked checkbox from the keyboard: Space on the focused control. */
async function tickWithSpace(control: Locator) {
  await expect(control).not.toBeChecked();
  await control.focus();
  await expect(control).toBeFocused();
  await control.press('Space');
  await expect(control).toBeChecked();
}

/** A tRPC query as the signed-in operator (HTTP, through the same auth and tenancy). */
async function trpcQuery<T>(page: Page, path: string, json: Record<string, unknown>): Promise<T> {
  const response = await page.request.get(
    `/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify({ json }))}`
  );
  expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
  return ((await response.json()) as { result: { data: { json: T } } }).result.data.json;
}

/** DEV-713: the branch's manual wallet merchants, saved the way Finance saves them. */
async function saveWalletMerchants(
  page: Page,
  settings: Record<string, { destination: string; allowReferenceSkip?: boolean }>
) {
  const current = await trpcQuery<{ revision: number }>(
    page,
    'pharmacySales.manualPaymentSettings',
    { branchId: PHARMACY_E2E.branchId }
  );
  await trpcMutation(page, 'pharmacySales.saveManualPaymentSettings', {
    branchId: PHARMACY_E2E.branchId,
    revision: current.revision,
    settings,
  });
}

/**
 * DEV-1005: the phase 2B visual QA evidence, taken from the running app. Each panel is shot at
 * 1366 and 375, light and dark, with reduced motion, while a control inside it holds a visible
 * keyboard focus; the five missing design states add 1440, 1024 and 768. No shot may scroll
 * the document sideways. Files go to playwright-artifacts/pharmacy-counter-qa-phase-2b/ (outside
 * the run's output folder, which Playwright empties at the start of every run) and are composed
 * into docs/design-system/reference/counter-v2/qa-phase-2b/.
 */
const QA_DIR = 'playwright-artifacts/pharmacy-counter-qa-phase-2b';
/** DEV-977 phase 3: the shots of the surfaces phase 3 adds, kept apart from phase 2B's. */
const QA3_DIR = 'playwright-artifacts/pharmacy-counter-qa-phase-3';
const QA_KEYBOARD_WIDTHS = [1366, 375] as const;
const QA_STATE_WIDTHS = [1440, 1366, 1024, 768, 375] as const;

async function qaShots(
  page: Page,
  name: string,
  {
    focus,
    widths = QA_KEYBOARD_WIDTHS,
    dir = QA_DIR,
    reducedMotion = 'reduce',
  }: {
    /** A control inside the panel: it takes the keyboard focus for the shot. */
    focus: Locator;
    widths?: readonly number[];
    dir?: string;
    reducedMotion?: 'reduce' | 'no-preference';
  }
) {
  const original = page.viewportSize();
  for (const width of widths) {
    await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion });
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme
      );
      // Focus arrives from the keyboard (Shift+Tab, Tab), so :focus-visible draws its ring.
      await focus.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(focus).toBeFocused();
      expect(
        await focus.evaluate((element) => element.matches(':focus-visible')),
        `${name}: the focused control shows its focus ring`
      ).toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${name} ${width} ${theme}: no sideways scroll`
      ).toBe(true);
      await page.screenshot({ path: `${dir}/${name}-${width}-${theme}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  if (original) await page.setViewportSize(original);
}

test('DEV-498 keeps cart and payment visible while searching across the Studio viewport matrix', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCounter(page);
  await openDrawer(page);
  const scan = page.getByLabel('Scan or search');
  const beforeDismiss = await scan.boundingBox();
  await expect(page.getByText('Cash drawer opened for this counter.')).toHaveCount(0, {
    timeout: 7000,
  });
  expect(await scan.boundingBox()).toEqual(beforeDismiss);
  await expect(page.getByLabel('Bill status')).toContainText('Drawer open');
  await pressControl(page.getByRole('button', { name: /^Patient/ }));
  await expect(page.getByLabel('Pharmacist PIN')).toHaveCount(0);
  await page.keyboard.press('Escape');

  const otc = PHARMACY_E2E.medicines.otc;
  await trpcMutation(page, 'pharmacyInventory.breakPack', {
    branchId: PHARMACY_E2E.branchId,
    inventoryLotId: otcLotId,
    stockLocationId: PHARMACY_E2E.stockLocationId,
    requiredLooseUnits: otc.onHandUnits,
    idempotencyKey: 'pharmacy-counter-layout-open-stock',
  });
  await search(page, otc.brandName);
  await stageFirstResult(page, otc.name);
  await page.keyboard.press('F5');
  await setQuantity(page, 1);
  for (let line = 1; line <= 20; line++) {
    await setQuantity(page, line);
    await page.keyboard.press('F6');
    await expect(page.getByLabel('Bill status')).toContainText(
      `Bill open · ${line} ${line === 1 ? 'line' : 'lines'}`
    );
  }

  for (const width of [375, 768, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme
      );
      for (const reducedMotion of ['no-preference', 'reduce'] as const) {
        await page.emulateMedia({ reducedMotion });
        await page.keyboard.press('F2');
        await expect(scan).toBeFocused();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
        ).toBe(true);
        await expect(page.locator('[data-counter-console]')).not.toContainText(
          /(?:POS|CRM)-\d|Phase 0|D01/
        );
        if (width >= 1280) {
          // DEV-977 (Counter v2, owner-approved): the bill sits under the search in its own
          // scrolling column (search results drop over it), and the totals rail with Take
          // payment sits beside the search, never covered. So the cart is measured as the
          // bill column it scrolls in, and payment as the rail beside the search.
          const geometry = await page.evaluate(() => {
            const bill = document.querySelector('[data-counter-bill-column]')!;
            const cart = bill.querySelector('section[aria-label="Cart"]')!;
            const rail = document.querySelector('aside[aria-label="Bill total"]')!;
            const pay = Array.from(rail.querySelectorAll('button')).find((button) =>
              button.textContent?.startsWith('Take payment')
            )!;
            const search = document.querySelector('#counter-search')!;
            return {
              bill: bill.getBoundingClientRect().toJSON(),
              cart: cart.getBoundingClientRect().toJSON(),
              rail: rail.getBoundingClientRect().toJSON(),
              pay: pay.getBoundingClientRect().toJSON(),
              search: search.getBoundingClientRect().toJSON(),
              scrollable: bill.scrollHeight > bill.clientHeight,
              height: window.innerHeight,
            };
          });
          expect(geometry.bill.height).toBeGreaterThan(140);
          expect(geometry.bill.top).toBeGreaterThanOrEqual(geometry.search.bottom);
          expect(geometry.cart.top).toBeLessThan(geometry.height);
          expect(geometry.rail.left).toBeGreaterThanOrEqual(geometry.search.right);
          expect(geometry.pay.top).toBeGreaterThanOrEqual(0);
          expect(geometry.pay.bottom).toBeLessThanOrEqual(geometry.height);
          expect(geometry.scrollable).toBe(true);
        }
        await page.screenshot({
          path: testInfo.outputPath(`counter-${width}-${theme}-${reducedMotion}.png`),
        });
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press('Shift+F4');
  const dialog = page.getByRole('dialog', { name: 'Void this bill?' });
  const reason = dialog.getByRole('radio', { name: 'Duplicate bill' });
  await reason.focus();
  await reason.press('Space');
  await pressControl(dialog.getByRole('button', { name: 'Void bill' }));
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: /Bill voided/i })).toBeVisible();
});

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

  // Read before staging: the results close once the line form opens.
  const row = resultRow(page, otc.name);
  // Every field POS-02 requires on the row.
  await expect(row).toContainText(otc.strength);
  await expect(row).toContainText(otc.presentation);
  await expect(row).toContainText(`${otc.onHandUnits} tabs`);
  await expect(row).toContainText(otc.batchNumber);
  await expect(row).toContainText('2028-06-30');
  await expect(row).toContainText('250.00');
  await expect(row).toContainText('Over the counter');
  await expect(row).toContainText('Store');
  await stageFirstResult(page, otc.name);

  // POS-03: F4 selects the strip; the preview quotes the derived strip price.
  await page.keyboard.press('F4');
  await expect(saleUnits(page).getByRole('radio', { name: /Strip/ })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await setQuantity(page, 2);
  await expect(
    nextLine(page).getByText(PHARMACY_E2E_EXPECTED.otcStripPrice, { exact: true }).first()
  ).toBeVisible();
  await expect(
    nextLine(page).getByText(PHARMACY_E2E_EXPECTED.otcTwoStripTotal, { exact: true }).first()
  ).toBeVisible();

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
  await expect(allocation).toContainText('Earliest expiry');
  await expect(allocation).not.toContainText('Batch override');

  // POS-02: a scanned barcode resolves to exactly one presentation, and Enter on a barcode
  // with a single match adds one of its first sale unit (scan-to-add, 699d5c1d; pinned by
  // counter-console.test.tsx "adds a barcode on Enter only when the search returns that
  // single medicine"). Nothing is added unless the scan matched exactly this medicine.
  await scan(page, otc.barcode);
  await expect(page.getByText(`1 × ${otc.name} added.`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Bill open · 2 lines')).toBeVisible();
  await expect(cart.getByRole('row').filter({ hasText: otc.name }).last()).toContainText(
    '1 × pack'
  );
  await expect(cart).toContainText(`pack · ${otc.unitsPerPack} tablets @ ${packPrice}`);

  await tenderCash(page, billTotal);

  // POS-08: a settled bill renders a receipt carrying medicine, strength,
  // batch and expiry, and a receipt number the tender issued.
  const receipt = page.getByRole('region', { name: /^Receipt \d+ · Counter [A-Z0-9]{4}$/ });
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
  await localeSelect.selectOption('en');
  await expect(receipt).toBeVisible();
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
  await expect(saleUnits(page).getByRole('radio')).toHaveCount(2);
  await expect(saleUnits(page).getByRole('radio', { name: /Strip/ })).toHaveCount(0);

  await page.keyboard.press('F5');
  await expect(saleUnits(page).getByRole('radio', { name: /Unit/ })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await setQuantity(page, 10);
  await expect(
    nextLine(page).getByText(PHARMACY_E2E_EXPECTED.syrupUnitPrice, { exact: true }).first()
  ).toBeVisible();
  await expect(
    nextLine(page).getByText(PHARMACY_E2E_EXPECTED.syrupTenUnitTotal, { exact: true }).first()
  ).toBeVisible();

  await page.keyboard.press('F6');
  const cart = page.getByRole('table', { name: 'Cart lines' });
  await expect(cart).toContainText(syrup.name, { timeout: 15_000 });
  await expect(cart).toContainText('10 units');

  await tenderCash(page, PHARMACY_E2E_EXPECTED.syrupTenUnitTotal);
  await expect(
    page.getByRole('region', { name: /^Receipt \d+ · Counter [A-Z0-9]{4}$/ })
  ).toBeVisible({
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
  await expect(
    saleUnits(page).getByRole('radio', { name: new RegExp(`^Box of ${otc.unitsPerPack} `) })
  ).toHaveAttribute('aria-checked', 'true');
  await setQuantity(page, 1);
  await expect(nextLine(page).getByText('250.00', { exact: true }).first()).toBeVisible();

  await page.keyboard.press('F6');
  const cart = page.getByRole('table', { name: 'Cart lines' });
  await expect(cart).toContainText(otc.name, { timeout: 15_000 });
  await expect(cart).toContainText('100 units');

  await tenderCash(page, '250.00');
  await expect(
    page.getByRole('region', { name: /^Receipt \d+ · Counter [A-Z0-9]{4}$/ })
  ).toBeVisible({
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
  await expect(resultRow(page, rx.name)).toContainText('Prescription only');
  await stageFirstResult(page, rx.name);

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

  // Tender is refused while the block stands.
  await page.keyboard.press('Escape');
  await page.keyboard.press('F9');
  await expect(page.getByRole('button', { name: 'Take payment' })).toBeDisabled();
  await expect(page.getByText(/unresolved safety block/i)).toBeVisible();

  // The only way past is to correct the bill. Shift+F4 voids it.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+F4');
  const voidDialog = page.getByRole('dialog', { name: 'Void this bill?' });
  await expect(voidDialog).toBeVisible();
  await voidDialog.getByRole('radio', { name: 'Duplicate bill' }).focus();
  await voidDialog.getByRole('radio', { name: 'Duplicate bill' }).press('Space');
  await pressControl(voidDialog.getByRole('button', { name: 'Void bill' }));
  await expect(page.getByRole('status').filter({ hasText: /Bill voided/i })).toBeVisible({
    timeout: 15_000,
  });
});

test('POS-01 — the workflow map is on screen and the Legacy Speed preset is an honest placeholder', async ({
  page,
}) => {
  await openCounter(page);
  await openDrawer(page);

  // DEV-977 (Counter v2): Shortcuts is in the action row's More menu at every width.
  await pressControl(page.getByRole('button', { name: 'More', exact: true }));
  await pressControl(page.getByRole('button', { name: 'Shortcuts', exact: true }));
  const legend = page.getByRole('dialog', { name: 'Shortcuts', exact: true });
  await expect(legend).toBeVisible();
  // Help keeps the workflow map and its configuration together.
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

  // The preview keeps a visible warning without exposing internal planning codes.
  const placeholderNotice = legend
    .getByRole('status')
    .filter({ hasText: /Confirm them with your team/i });
  await expect(placeholderNotice).toBeVisible({ timeout: 15_000 });
  await expect(placeholderNotice).not.toContainText(/D01|Phase 0/);
  await expect(placeholderNotice).toContainText(/Unconfirmed/i);

  // Restore the default so a re-run starts from the shipped map.
  await preset.focus();
  await preset.selectOption('devfathom');
  await expect(placeholderNotice).toHaveCount(0);
});

/**
 * DEV-973: the print window prints itself and closes when its print dialog closes. Headless
 * Chromium's dialog closes at once, so the window would be gone before it is read. With
 * `print()` held (the dialog "still open"), the window stays, as it does at a real till while
 * the cashier picks a printer, and the test can read it and prove the counter keeps working.
 */
async function holdPrintDialogsOpen(page: Page) {
  await page.context().addInitScript(() => {
    window.print = () => {
      const root = document.documentElement;
      root.dataset.printRequests = String(Number(root.dataset.printRequests ?? 0) + 1);
    };
  });
}

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
  await expect(resultRow(page, syrup.name)).toContainText(batchNumber);
  await stageFirstResult(page, syrup.name);

  // One whole bottle: exactly the new lot's contents.
  await page.keyboard.press('F3');
  await expect(
    saleUnits(page).getByRole('radio', { name: new RegExp(`^Box of ${syrup.unitsPerPack} `) })
  ).toHaveAttribute('aria-checked', 'true');
  await setQuantity(page, 1);
  await page.keyboard.press('F6');
  const cart = page.getByRole('table', { name: 'Cart lines' });
  await expect(cart).toContainText(syrup.name, { timeout: 15_000 });

  const allocation = page.getByRole('list', { name: `Batch allocation for ${syrup.name}` });
  await expect(allocation).toContainText(`Batch ${batchNumber}`);
  await expect(allocation).not.toContainText(`Batch ${syrup.batchNumber}`);
  await expect(allocation).toContainText(`${syrup.unitsPerPack} units`);
  await expect(allocation).toContainText('Earliest expiry');
  await expect(allocation).not.toContainText('Batch override');
  await expect(allocation).toContainText(/Near expiry · 4[4-6] d/);

  await tenderCash(page, '180.00');
  const receipt = page.getByRole('region', { name: /^Receipt \d+ · Counter [A-Z0-9]{4}$/ });
  await expect(receipt).toBeVisible({ timeout: 15_000 });
  await expect(receipt).toContainText(batchNumber);
});

test('Khata ledger limit, owner override, statement and loyalty regression', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await holdPrintDialogsOpen(page);
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
      `INSERT INTO pharmacy_loyalty_program_versions
       (id,"organizationId",version,"earnMode","earnPoints","perSpendMinor","redemptionValueMinor","khataEarns","effectiveFrom","actorId")
       VALUES ('program_pharmacy_counter_e2e',$1,1,'PERCENT_OF_SPEND',500,1000000,100,true,'2026-09-01',$2)
       ON CONFLICT (id) DO NOTHING`,
      [PHARMACY_E2E.organizationId, PHARMACY_E2E.adminId]
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
      await stageFirstResult(page, PHARMACY_E2E.medicines.otc.name);
      const strip = saleUnits(page).getByRole('radio', { name: /Strip/ });
      await strip.focus();
      await strip.press('Space');
      await setQuantity(page, 1);
      await pressControl(page.getByRole('button', { name: /Add to cart/ }));
      await expect(page.getByRole('table', { name: 'Cart lines' })).toContainText(
        PHARMACY_E2E.medicines.otc.name
      );
      await pressControl(page.getByRole('button', { name: /^Patient/ }));
      const patientSearch = page.getByLabel('Find patient');
      await patientSearch.focus();
      await patientSearch.fill(PHARMACY_E2E.patientName);
      await patientSearch.press('Enter');
      await pressControl(page.getByRole('button', { name: new RegExp(PHARMACY_E2E.patientName) }));
      await page.keyboard.press('Escape');
      await expect(scan).toBeFocused();
      await pressControl(page.getByRole('button', { name: /^Loyalty/ }));
      await pressControl(page.getByRole('button', { name: 'Link selected patient' }));
      await expect(page.getByText('Loyalty customer linked to this bill.')).toBeVisible();
    };
    await makeBill();
    await page.keyboard.press('Escape');
    await page.keyboard.press('F9');
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
    // Counter v2 B1: the limit meter draws the same ledger figures and marks the overrun.
    const meter = page.locator('[data-counter-khata-limit]');
    await expect(
      meter.getByRole('img', { name: '25.00 of 10.00 limit used, over the limit' })
    ).toBeVisible();
    await expect(meter.getByRole('img')).toHaveAttribute('data-over', 'true');
    await expect(meter).toContainText(/Limit\s*10\.00/);
    await expect(meter).toContainText(/Used\s*1\.00/);
    await expect(meter).toContainText(/Available\s*9\.00/);
    const overrideBox = page.getByLabel('Owner or manager: authorize limit increase');
    await qaShots(page, 'payment-khata-over-limit', {
      focus: overrideBox,
      widths: QA_STATE_WIDTHS,
    });
    await qaShots(page, 'payment-khata', { focus: overrideBox });
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
    await expect(
      page.getByRole('region', { name: /^Receipt \d+ · Counter [A-Z0-9]{4}$/ })
    ).toBeVisible();
    await page.keyboard.press('Escape');
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
    // Khata earns under the owner's configured rule when money is collected, not on debt.
    const deviceId = await page.evaluate(() =>
      localStorage.getItem('devfathom.pharmacy.counter.device')
    );
    expect(deviceId).toMatch(/^counter-/);
    await trpcMutation(
      page,
      'pharmacySales.recordKhataPayment',
      {
        branchId: PHARMACY_E2E.branchId,
        familyAccountId: familyId,
        amountMinor: 2500,
        tender: 'CASH',
        deviceId,
        businessDate: new Date(`${workspaceToday('Asia/Karachi')}T00:00:00.000Z`).toISOString(),
        idempotencyKey: `counter-e2e-collection-${familyId}`,
      },
      ['businessDate']
    );
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
  await holdPrintDialogsOpen(page);
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
  const receipt = page.getByRole('region', { name: /^Receipt \d+ · Counter [A-Z0-9]{4}$/ });
  await expect(receipt).toBeVisible({ timeout: 15_000 });
  const receiptNumber = (await receipt.getAttribute('aria-label'))!.match(/\d+/)![0];
  await page.keyboard.press('Escape');
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
  if (device) {
    const label = counterLabel(device);
    expect(label).not.toBeNull();
    await pressControl(matches.filter({ hasText: label! }));
  } else await pressControl(matches.first());
  // DEV-501: a one-line return and refund is one form and one confirm. The only line and
  // the only (cash) tender are preselected; quantity is in the unit sold (strips) plus loose
  // units, and the refund is prefilled from the returned quantity.
  const half = (Number(PHARMACY_E2E_EXPECTED.otcStripPrice) / 2).toFixed(2);
  await expect(dialog.getByLabel('Sold line')).not.toHaveValue('');
  await dialog.getByLabel('Returned lot / batch').selectOption({ index: 1 });
  await dialog.getByLabel('Return quantity (strips)').fill('0');
  await dialog.getByLabel('Plus loose units').fill('5');
  await expect(
    dialog.getByRole('button', { name: /^Keep aside.*Confirm return & refund$/ })
  ).toBeDisabled();
  await pressControl(
    dialog
      .getByRole('group', { name: 'Reason', exact: true })
      .getByRole('button', { name: 'Wrong item / strip', exact: true })
  );
  await dialog
    .getByLabel('Inspection and integrity decision (optional)')
    .fill('Intact strip, correct storage verified');
  await expect(dialog.getByLabel('Refund to')).not.toHaveValue('');
  await expect(dialog.getByLabel('Refund for this return (PKR)')).toHaveValue(half);
  await qaShots(page, 'returns', { focus: dialog.getByLabel('Your manager or owner PIN') });
  await dialog.getByLabel('Your manager or owner PIN').fill(PHARMACY_E2E.adminPin);
  await pressControl(dialog.getByRole('button', { name: /^Restock.*Confirm return & refund$/ }));
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
  await expect(
    dialog
      .getByRole('group', { name: 'Reason', exact: true })
      .getByRole('button', { name: 'Wrong item / strip', exact: true })
  ).toHaveAttribute('aria-pressed', 'false');
  await expect(dialog.getByRole('button', { name: /^Keep aside — don't resell/ })).toHaveAttribute(
    'aria-pressed',
    'false'
  );
  await pressControl(
    dialog
      .getByRole('group', { name: 'Reason', exact: true })
      .getByRole('button', { name: 'Wrong item / strip', exact: true })
  );
  await dialog.getByLabel('Keep-aside (quarantine) location').selectOption({ index: 1 });
  await dialog
    .getByLabel('Inspection and integrity decision (optional)')
    .fill('Batch marking unreadable; pharmacist verification required');
  await expect(dialog.getByLabel('Refund for this return (PKR)')).toHaveValue(
    (Number(PHARMACY_E2E_EXPECTED.otcStripPrice) - Number(half)).toFixed(2)
  );
  await dialog.getByLabel('Your manager or owner PIN').fill(PHARMACY_E2E.adminPin);
  await pressControl(dialog.getByRole('button', { name: /^Keep aside.*Confirm return & refund$/ }));
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

/**
 * DEV-1005 — Counter v2 end to end. Every panel the phase 2B review found untested in a real
 * browser: the one-step add and the bill line (quantity, unit, remove and its refusals), cash
 * with change, the paid bill and receipt (and a print window that leaves the counter usable),
 * a split cash and wallet payment with payer and reference, a payment not confirmed, a wallet
 * not set up, a discount approved by a manager's PIN, controlled-medicine authorisation, the
 * cashier's no-permission card and the offline price check.
 */
test('Counter v2 — Enter adds one unit; quantity, unit and remove on the bill line; a part-paid bill refuses changes', async ({
  page,
}) => {
  const otc = PHARMACY_E2E.medicines.otc;
  await openCounter(page);
  await openDrawer(page);
  await qaShots(page, 'drawer-open', { focus: page.getByLabel('Scan or search') });

  await search(page, otc.brandName);
  await addFirstResult(page, otc.name);
  await expect(page.getByText(`1 × ${otc.name} (unit) added.`)).toBeVisible({ timeout: 15_000 });
  // The next item is typed straight away: focus never leaves the search field.
  await expect(page.getByLabel('Scan or search')).toBeFocused();
  await expect(page.getByRole('list', { name: 'Search results' })).toHaveCount(0);
  const line = billLine(page, otc.name);
  const quantity = line.getByRole('textbox', { name: `Quantity: ${otc.name}` });
  await expect(quantity).toHaveValue('1');
  await expect(line).toContainText('1 × tablet');
  await expect(line).toContainText('2.50');

  // Quantity on the bill line: the stepper, then a typed quantity committed with Enter.
  await pressControl(line.getByRole('button', { name: `+ ${otc.name}`, exact: true }));
  await expect(page.getByText(`${otc.name}: 2 × tablet.`)).toBeVisible();
  await expect(quantity).toHaveValue('2');
  await expect(line).toContainText('5.00');
  await quantity.focus();
  await quantity.fill('4');
  await quantity.press('Enter');
  await expect(page.getByText(`${otc.name}: 4 × tablet.`)).toBeVisible();
  await expect(quantity).toHaveValue('4');
  await expect(line).toContainText('10.00');
  await pressControl(line.getByRole('button', { name: `− ${otc.name}`, exact: true }));
  await expect(page.getByText(`${otc.name}: 3 × tablet.`)).toBeVisible();
  await expect(line).toContainText('7.50');

  // The unit on the bill line: 3 strips of 10 tablets at 25.00 each.
  const soldAs = line.getByRole('radiogroup', { name: `Sold as: ${otc.name}` });
  await pressControl(soldAs.getByRole('radio', { name: 'Strip', exact: true }));
  await expect(page.getByText(`${otc.name}: 3 × strip.`)).toBeVisible();
  await expect(soldAs.getByRole('radio', { name: 'Strip', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await expect(line).toContainText('75.00');
  const totals = page.getByRole('complementary', { name: 'Bill total' });
  await expect(totals).toContainText('75.00');
  await qaShots(page, 'bill', { focus: quantity });

  // Remove takes the line off the bill on the server and gives its stock back.
  await pressControl(line.getByRole('button', { name: `Remove ${otc.name}`, exact: true }));
  await expect(page.getByText(`${otc.name} removed from the bill.`)).toBeVisible();
  await expect(billLine(page, otc.name)).toHaveCount(0);
  await expect(page.getByLabel('Scan or search')).toBeFocused();

  // A part-paid bill: its lines are read-only on the counter, and the server refuses a change.
  await search(page, otc.brandName);
  await addFirstResult(page, otc.name);
  const paidLine = billLine(page, otc.name);
  await expect(paidLine).toContainText('2.50');
  await pressControl(paidLine.getByRole('button', { name: `+ ${otc.name}`, exact: true }));
  await expect(paidLine.getByRole('textbox', { name: `Quantity: ${otc.name}` })).toHaveValue('2');
  const sheet = await openPayment(page);
  const amount = sheet.getByLabel('Amount', { exact: true });
  await amount.focus();
  await amount.fill('2.00');
  const received = sheet.getByLabel('Cash received');
  await received.focus();
  await received.fill('2.00');
  await pressControl(sheet.getByRole('button', { name: 'Take payment', exact: true }));
  await expect(sheet.getByRole('status').filter({ hasText: 'Payment recorded.' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(sheet.getByRole('region', { name: 'Payment summary' })).toContainText('3.00');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  for (const control of [
    paidLine.getByRole('button', { name: `+ ${otc.name}`, exact: true }),
    paidLine.getByRole('button', { name: `− ${otc.name}`, exact: true }),
    paidLine.getByRole('textbox', { name: `Quantity: ${otc.name}` }),
    paidLine.getByRole('button', { name: `Remove ${otc.name}`, exact: true }),
  ])
    await expect(control).toBeDisabled();
  const { Client } = await import('pg');
  const db = new Client({ connectionString: resolvePharmacyE2eDatabaseUrl() });
  await db.connect();
  let saleLine: { id: string; saleId: string };
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.current_organization_id', $1, true)", [
      PHARMACY_E2E.organizationId,
    ]);
    const lines = await db.query<{ id: string; saleId: string }>(
      `SELECT l.id, l."saleId" FROM pharmacy_sale_lines l JOIN pharmacy_sales s ON s.id = l."saleId"
       WHERE s."branchId" = $1 AND s.status = 'OPEN' AND l."medicineId" = $2
       ORDER BY l."createdAt" DESC LIMIT 1`,
      [PHARMACY_E2E.branchId, otc.id]
    );
    await db.query('COMMIT');
    expect(lines.rows).toHaveLength(1);
    saleLine = lines.rows[0]!;
  } finally {
    await db.end();
  }
  const deviceId = await page.evaluate(() =>
    localStorage.getItem('devfathom.pharmacy.counter.device')
  );
  const refused = await page.request.post('/api/trpc/pharmacySales.removeLine', {
    data: {
      json: {
        branchId: PHARMACY_E2E.branchId,
        saleId: saleLine.saleId,
        saleLineId: saleLine.id,
        idempotencyKey: `pharmacy-counter-e2e-part-paid-${saleLine.id}`,
        ...(deviceId ? { deviceId } : {}),
      },
    },
  });
  expect(refused.ok()).toBe(false);
  expect(await refused.text()).toContain('LINE_LOCKED_BY_PAYMENT');
  await expect(paidLine).toContainText('2 × tablet');

  // The rest in cash settles the bill.
  await tenderCash(page, '3.00');
  await expect(
    page.getByRole('region', { name: /^Receipt \d+ · Counter [A-Z0-9]{4}$/ })
  ).toBeVisible({ timeout: 15_000 });
});

test('Counter v2 — cash with change, the paid bill and its receipt, and a print window that leaves the counter working', async ({
  page,
}) => {
  test.setTimeout(test.info().timeout + 30_000);
  const otc = PHARMACY_E2E.medicines.otc;
  await holdPrintDialogsOpen(page);
  await openCounter(page);
  await openDrawer(page);
  await search(page, otc.brandName);
  await addFirstResult(page, otc.name);
  await expect(billLine(page, otc.name)).toContainText('2.50', { timeout: 15_000 });

  const sheet = await openPayment(page);
  await expect(sheet).toHaveAccessibleName('Take payment · 2.50');
  const received = sheet.getByLabel('Cash received');
  await expect(received).toHaveValue('2.50');
  // Quick cash: the customer hands over 500.
  const quick = sheet.getByRole('group', { name: 'Quick cash' });
  await pressControl(quick.getByRole('button', { name: '500', exact: true }));
  await expect(received).toHaveValue('500.00');
  const change = sheet.getByText('Change', { exact: true }).locator('..');
  await expect(change).toContainText('497.50');
  await qaShots(page, 'payment-cash', { focus: received });
  await pressControl(sheet.getByRole('button', { name: 'Take payment', exact: true }));

  // Counter v2 A3: the receipt sheet opens on the paid bill; change is shown on both.
  const receiptSheet = page.getByRole('dialog', { name: /Receipt preview/ });
  await expect(receiptSheet).toBeVisible({ timeout: 15_000 });
  const receipt = receiptSheet.getByRole('region', {
    name: /^Receipt \d+ · Counter [A-Z0-9]{4}$/,
  });
  await expect(receipt).toBeVisible();
  const receiptNumber = (await receipt.getAttribute('aria-label'))!.match(/\d+/)![0];
  await expect(receipt).toContainText(otc.name);
  await expect(receipt).toContainText(otc.batchNumber);
  await expect(receiptSheet).toContainText('497.50');
  const print = receiptSheet.getByRole('button', { name: 'Print receipt', exact: true });
  await qaShots(page, 'receipt', { focus: print });

  const notice = page.getByText(/Finish or cancel printing in the print window/);

  // DEV-973: the print window is its own browsing context. While its print dialog is open
  // (held open here), the counter keeps working: the next search runs at once.
  const popupPromise = page.waitForEvent('popup');
  await pressControl(print);
  const popup = await popupPromise;
  await expect(popup.locator('html')).toHaveAttribute('data-print-requests', '1');
  await expect(notice).toBeVisible();
  await expect(popup.locator('body')).not.toContainText('Reprint — not a new sale');
  await expect(popup.locator('body')).toContainText(otc.name);
  await expect(popup.locator('body')).toContainText(receiptNumber);
  await page.keyboard.press('Escape');
  await expect(receiptSheet).toBeHidden();
  const totals = page.getByRole('complementary', { name: 'Bill total' });
  await expect(totals).toContainText(`Paid · receipt ${receiptNumber}`);
  await expect(totals).toContainText('497.50');
  await qaShots(page, 'paid', {
    focus: totals.getByRole('button', { name: 'Start next bill', exact: true }),
  });
  await page.keyboard.press('F2');
  await expect(page.getByLabel('Scan or search')).toBeFocused();
  await page.getByLabel('Scan or search').fill(PHARMACY_E2E.medicines.syrup.name.slice(0, 8));
  await expect(resultRow(page, PHARMACY_E2E.medicines.syrup.name)).toBeVisible({
    timeout: 5_000,
  });
  expect(popup.isClosed()).toBe(false);
  const cancelled = popup.waitForEvent('close');
  await popup.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await cancelled;
  await expect(notice).toHaveCount(0);
  expect(page.context().pages()).toEqual([page]);

  await page.keyboard.press('Alt+r');
  await expect(receiptSheet).toBeVisible();
  const blocked = receiptSheet.getByText('Allow pop-ups for this site, then retry Print receipt.', {
    exact: true,
  });
  // Simulate a browser blocking the first reprint attempt. No
  // document may be sent and the cashier must explicitly retry.
  await page.evaluate(() => {
    const open = window.open;
    window.open = (...args) => {
      if (!String(args[0]).startsWith('/pharmacy/counter/print-window.html#'))
        return open.apply(window, args);
      window.open = open;
      return null;
    };
  });
  await pressControl(print);
  await expect(blocked).toBeVisible({ timeout: 2_000 });
  await expect(print).toBeEnabled();
  await expect(notice).toHaveCount(0);
  expect(page.context().pages()).toEqual([page]);

  const slowPrintPage = '**/pharmacy/counter/print-window.html';
  await page.context().route(slowPrintPage, async (route) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 8_000));
    await route.continue();
  });

  const reprintPromise = page.waitForEvent('popup');
  await pressControl(print);
  const busyPrint = receiptSheet.getByRole('button', { name: 'Printing receipt…' });
  await expect(busyPrint).toBeVisible();
  await expect(busyPrint).toHaveAttribute('aria-busy', 'true');
  await expect(busyPrint).toBeDisabled();
  await expect(notice).toHaveCount(0);
  await page.keyboard.press('F10');
  const reprint = await reprintPromise;
  await page.context().unroute(slowPrintPage);
  await expect(blocked).toBeHidden();
  await expect(notice).toBeVisible();
  await expect(reprint.locator('html')).toHaveAttribute('data-print-requests', '1');
  expect(page.context().pages()).toHaveLength(2);
  await expect(reprint.locator('body')).toContainText(receiptNumber);
  await expect(reprint.locator('body')).toContainText('Reprint — not a new sale');
  const close = reprint.getByRole('button', { name: 'Close', exact: true });
  await expect(close).toBeEnabled();
  await close.focus();
  await expect(close).toBeFocused();
  await Promise.all([
    reprint.waitForEvent('close'),
    reprint.keyboard.press('Enter').catch((error: unknown) => {
      // The Close button can dismiss the window before Playwright receives the key command's reply.
      if (
        !reprint.isClosed() ||
        !String(error).includes('Target page, context or browser has been closed')
      )
        throw error;
    }),
  ]);
  await expect(notice).toHaveCount(0);
  expect(page.context().pages()).toEqual([page]);
});

test('Counter v2 — a wallet not set up, a payment not confirmed, then cash plus JazzCash with payer and reference', async ({
  page,
}) => {
  const otc = PHARMACY_E2E.medicines.otc;
  await openCounter(page);
  await openDrawer(page);
  // DEV-713: the owner sets JazzCash up for this branch in Finance.
  await saveWalletMerchants(page, { JAZZCASH: { destination: 'JazzCash 0300 0000000 E2E' } });
  await page.reload();
  await expect(page.getByLabel('Scan or search')).toBeVisible();
  await search(page, otc.brandName);
  await addFirstResult(page, otc.name);
  const line = billLine(page, otc.name);
  const quantity = line.getByRole('textbox', { name: `Quantity: ${otc.name}` });
  await quantity.focus();
  await quantity.fill('4');
  await quantity.press('Enter');
  await expect(line).toContainText('10.00');

  // Part in cash.
  let sheet = await openPayment(page);
  const amount = sheet.getByLabel('Amount', { exact: true });
  await amount.focus();
  await amount.fill('4.00');
  const received = sheet.getByLabel('Cash received');
  await received.focus();
  await received.fill('4.00');
  await pressControl(sheet.getByRole('button', { name: 'Take payment', exact: true }));
  await expect(sheet.getByRole('status').filter({ hasText: 'Payment recorded.' })).toBeVisible({
    timeout: 15_000,
  });
  const summary = sheet.getByRole('region', { name: 'Payment summary' });
  await expect(summary).toContainText('6.00');
  // DEV-977 phase 3 (A2): "Paid so far" adds up what the server recorded.
  const paidSoFar = summary.getByRole('group', { name: 'Paid so far' });
  await expect(paidSoFar).toContainText(/Paid so far\s*4\.00/);
  await expect(paidSoFar.getByRole('list', { name: 'Recorded payments' })).toContainText(
    /1\. Cash · Recorded\s*4\.00/
  );

  // The rest by JazzCash: the payer's name and the transaction ID, then Enter.
  const wallets = sheet.getByRole('group', { name: 'Wallet' });
  await expect(wallets.getByRole('button', { name: 'Easypaisa' })).toHaveCount(0);
  await choosePaymentMethod(page, 'JazzCash');
  await expect(sheet).toContainText('JazzCash 0300 0000000 E2E');
  const payer = sheet.getByLabel('Payer’s name');
  await expect(payer).toBeFocused();
  await payer.fill('Ali Raza E2E');
  const reference = sheet.getByLabel('Transaction ID (last 4–6 digits)');
  await reference.focus();
  await reference.fill('4501');
  await qaShots(page, 'payment-wallet-split', { focus: reference, widths: QA_STATE_WIDTHS });
  await qaShots(page, 'payment-paid-so-far', {
    focus: reference,
    widths: QA_STATE_WIDTHS,
    dir: QA3_DIR,
  });

  // B8: the owner switches JazzCash off while the sheet is open. Reloading the merchant
  // details says so in plain words and payment by it is refused.
  await saveWalletMerchants(page, {});
  await pressControl(sheet.getByRole('button', { name: 'Reload merchant details' }));
  await expect(
    sheet.getByRole('alert').filter({ hasText: 'not enabled at this branch' })
  ).toContainText(
    'JAZZCASH is not enabled at this branch. Ask an administrator to enable it in Finance.'
  );
  await expect(sheet.getByRole('button', { name: 'Take payment', exact: true })).toBeDisabled();
  await qaShots(page, 'payment-method-not-set-up', {
    focus: sheet.getByRole('button', { name: 'Reload merchant details' }),
    widths: QA_STATE_WIDTHS,
  });
  await saveWalletMerchants(page, { JAZZCASH: { destination: 'JazzCash 0300 0000000 E2E' } });
  await pressControl(sheet.getByRole('button', { name: 'Reload merchant details' }));
  await expect(
    sheet.getByRole('alert').filter({ hasText: 'not enabled at this branch' })
  ).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'Take payment', exact: true })).toBeEnabled();

  // A7: the payment reaches the server but its answer is lost. The sheet locks as "Payment
  // not confirmed" until the outcome is checked; checking it sends no second payment.
  let tenders = 0;
  await page.route('**/api/trpc/**', async (route) => {
    const names = new URL(route.request().url()).pathname.split('/api/trpc/')[1]?.split(',') ?? [];
    if (route.request().method() !== 'POST' || !names.includes('pharmacySales.tender'))
      return route.continue();
    tenders += 1;
    await route.fetch();
    await route.abort('connectionreset');
  });
  await page.getByLabel('Transaction ID (last 4–6 digits)').focus();
  await page.keyboard.press('Enter');
  sheet = page.getByRole('dialog', { name: /^Take payment/ });
  await expect(sheet.getByRole('heading', { name: 'Payment not confirmed' })).toBeVisible({
    timeout: 15_000,
  });
  const check = sheet.getByRole('button', { name: 'Check payment outcome' });
  await expect(check).toBeEnabled();
  await expect(sheet.getByRole('button', { name: 'Take payment', exact: true })).toBeDisabled();
  await qaShots(page, 'payment-not-confirmed', { focus: check, widths: QA_STATE_WIDTHS });
  await page.unroute('**/api/trpc/**');
  expect(tenders).toBe(1);
  await pressControl(check);

  // The check finds the JazzCash payment recorded once: the bill is paid in two tenders.
  const receipt = page.getByRole('region', { name: /^Receipt \d+ · Counter [A-Z0-9]{4}$/ });
  await expect(receipt).toBeVisible({ timeout: 15_000 });
  await expect(receipt).toContainText('10.00');
  await expect(receipt).toContainText(/JAZZCASH|JazzCash/);
  await expect(receipt).toContainText(/CASH|Cash/);
});

test('Counter v2 — a discount on the next item, approved by a manager PIN for the cashier', async ({
  page,
}) => {
  const otc = PHARMACY_E2E.medicines.otc;
  await openCounter(page, PHARMACY_E2E.cashierEmail);
  await openDrawer(page);
  const totals = page.getByRole('complementary', { name: 'Bill total' });
  await pressControl(totals.getByRole('button', { name: 'Discount', exact: true }));
  const discount = page.getByRole('dialog', { name: /Discount on the next item/ });
  await expect(discount).toBeVisible();
  const value = discount.getByLabel('Discount (%)');
  await expect(value).toBeFocused();
  await value.fill('10');
  await qaShots(page, 'discount', { focus: value });
  await pressControl(discount.getByRole('button', { name: 'Apply to next item' }));
  await expect(discount).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: '10% off the next item' })).toBeVisible();

  // The cashier cannot discount alone: adding the item asks for a manager's or owner's PIN.
  await search(page, otc.brandName);
  await addFirstResult(page, otc.name);
  const approval = page.getByRole('dialog', { name: 'Approve this discount?' });
  await expect(approval).toBeVisible({ timeout: 15_000 });
  await expect(approval).toContainText(`a discount of Rs 0.25`);
  const approver = approval.getByRole('combobox', { name: 'Approving manager or owner' });
  await approver.focus();
  await approver.selectOption({ label: 'Pharmacy Administrator' });
  // Either label: a PIN today, or the approval code when approvals use an authenticator.
  const pin = approval.getByLabel(/^(Approver PIN|Approval code)$/);
  await pin.focus();
  await pin.fill(PHARMACY_E2E.adminPin);
  await qaShots(page, 'discount-approval', { focus: pin });
  await pressControl(approval.getByRole('button', { name: 'Approve discount' }));
  await expect(approval).toBeHidden();
  const line = billLine(page, otc.name);
  await expect(line).toContainText('2.25', { timeout: 15_000 });
  await expect(totals).toContainText('0.25');
  // A discounted line keeps its approved quantity: it can be removed, not stepped.
  await expect(line.getByRole('button', { name: `+ ${otc.name}`, exact: true })).toHaveCount(0);
  await expect(line.getByRole('button', { name: `Remove ${otc.name}`, exact: true })).toBeEnabled();
  await tenderCash(page, '2.25');
  await expect(
    page.getByRole('region', { name: /^Receipt \d+ · Counter [A-Z0-9]{4}$/ })
  ).toBeVisible({ timeout: 15_000 });
});

test('Counter v2 — Enter on a controlled medicine opens the authorisation it asks for; a scanned pack waits there; the status strip', async ({
  page,
}) => {
  const controlled = PHARMACY_E2E.medicines.controlled;
  await openCounter(page);
  await openDrawer(page);
  await search(page, 'Fathomadol');
  await expect(resultRow(page, controlled.name)).toContainText('Controlled');
  await addFirstResult(page, controlled.name);
  await expect(page.getByText(/complete the authorization panel/).first()).toBeVisible({
    timeout: 15_000,
  });
  // DEV-977 phase 3 (A5): the authorisation has its own sheet.
  const sheet = page.getByRole('dialog', { name: /^Authorise Fathomadol/ });
  await expect(sheet).toBeVisible();
  // The notice sends the cashier to the authorisation panel, so the panel must be there.
  await expect(
    sheet.getByRole('region', { name: 'Controlled medicine authorization' })
  ).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Authorise line' })).toBeDisabled();

  // DEV-977 phase 3: a serialised pack of the same medicine, in this test so the lane signs in no
  // more often than before (the login rate limit). A GS1 pack scan of a controlled medicine is not staged (that would drop
  // the pack's own lot): it waits in the "Authorise" sheet, and nothing is on the bill.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  const serial = `E2E977${Date.now().toString(36).toUpperCase()}`;
  await scan(page, `(01)${controlled.gtin}(10)${controlled.batchNumber}(21)${serial}`);
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await expect(sheet).toContainText(
    'One scanned pack. Its own batch is kept; nothing is on the bill until it is authorised.'
  );
  await expect(
    page.getByText(/complete the authorization panel, then press Authorise line\./).first()
  ).toBeVisible();
  await expect(
    sheet.getByRole('region', { name: 'Controlled medicine authorization' })
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Next line' })).toHaveCount(0);
  await expect(billLine(page, controlled.name)).toHaveCount(0);
  const authorisePack = sheet.getByRole('button', { name: 'Authorise line' });
  await expect(authorisePack).toBeDisabled();
  await qaShots(page, 'controlled-pack-waiting', {
    focus: sheet.getByRole('button', { name: 'Find the patient' }),
    widths: QA_STATE_WIDTHS,
    dir: QA3_DIR,
  });
  // Closed without adding, the pack is let go and the cashier is told to scan it again.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(
    page.getByText(
      new RegExp(
        `The scanned pack of Fathomadol.* was not added\\. Scan it again to authorise it\\.`
      )
    )
  ).toBeVisible();
  await expect(billLine(page, controlled.name)).toHaveCount(0);

  // DEV-977 phase 3: the "Counter status" strip is a tab stop only while it scrolls.
  const strip = page.getByRole('group', { name: 'Counter status' });
  for (const width of [1440, 1366, 1024, 768, 375]) {
    await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
    await expect(strip).toBeVisible();
    // Let the strip measure itself at this width.
    await expect
      .poll(async () => {
        const scrolls = await strip.evaluate(
          (element) => element.scrollWidth > element.clientWidth + 1
        );
        const tabStop = (await strip.getAttribute('tabindex')) === '0';
        return scrolls === tabStop;
      })
      .toBe(true);
    const scrolls = await strip.evaluate(
      (element) => element.scrollWidth > element.clientWidth + 1
    );
    if (scrolls) {
      // It scrolls: the keyboard reaches it, with the Studio focus ring.
      await strip.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(strip).toBeFocused();
      expect(await strip.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
    } else {
      await expect(strip).not.toHaveAttribute('tabindex');
    }
  }
  // At the phone width the pills do not fit, so the strip is reachable there.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(strip).toHaveAttribute('tabindex', '0');
  await qaShots(page, 'status-strip-375', { focus: strip, widths: [375], dir: QA3_DIR });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(strip).not.toHaveAttribute('tabindex');
  await expect
    .poll(() =>
      strip.evaluate((element) => {
        const edge = element.getBoundingClientRect().right;
        const lastPillEdge = Math.max(
          ...Array.from(element.children, (child) => child.getBoundingClientRect().right)
        );
        return edge - lastPillEdge;
      })
    )
    .toBeGreaterThanOrEqual(8);
});

test('Counter v2 — controlled medicine: patient, prescription or emergency supply, approving pharmacist; then the line is locked', async ({
  page,
}) => {
  const controlled = PHARMACY_E2E.medicines.controlled;
  await openCounter(page);
  await openDrawer(page);
  await search(page, 'Fathomadol');
  await stageFirstResult(page, controlled.name);
  // DEV-977 phase 3 (A5): adding it opens its own "Authorise" sheet; nothing is added yet.
  await page.keyboard.press('F6');
  const sheet = page.getByRole('dialog', { name: /^Authorise Fathomadol/ });
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await expect(sheet).toContainText('Controlled medicine · online only');
  await expect(billLine(page, controlled.name)).toHaveCount(0);
  const authorise = sheet.getByRole('button', { name: 'Authorise line' });
  await expect(authorise).toBeDisabled();
  await expect(sheet).toContainText(/Still needed: the patient/);
  const auth = sheet.getByRole('region', { name: 'Controlled medicine authorization' });
  await expect(auth).toBeVisible();
  const steps = auth.getByRole('list', { name: 'Authorization steps' });
  await expect(steps.getByRole('listitem')).toHaveText([
    /Patient\s*, to do/,
    /Prescription\s*, to do/,
    /Pharmacist\s*, to do/,
  ]);

  // 1 · Patient: chosen in the checks sheet, then back to the authorisation.
  await pressControl(sheet.getByRole('button', { name: 'Find the patient' }));
  const checks = page.getByRole('dialog', { name: 'Patient, prescription and checks' });
  await expect(checks).toBeVisible();
  const find = checks.getByLabel('Find patient');
  await find.focus();
  await find.fill(PHARMACY_E2E.patientName);
  await find.press('Enter');
  await pressControl(checks.getByRole('button', { name: new RegExp(PHARMACY_E2E.patientName) }));
  await pressControl(checks.getByRole('button', { name: /^Authorise Fathomadol/ }));
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(PHARMACY_E2E.patientName);
  const address = auth.getByLabel('Patient address');
  await address.focus();
  await address.fill('House 12, Street 4, Gulberg, Lahore');
  await expect(steps.getByRole('listitem').first()).toHaveText(/Patient\s*, done/);
  await qaShots(page, 'controlled-step-1-patient', { focus: address, widths: QA_STATE_WIDTHS });

  // 2 · Prescription: an emergency supply names its prescriber.
  await tickWithSpace(auth.getByLabel('Emergency supply, no prescription'));
  const prescriber = auth.getByLabel('Prescriber name');
  await prescriber.focus();
  await prescriber.fill('Dr Imran Shah E2E');
  await expect(steps.getByRole('listitem').nth(1)).toHaveText(/Prescription\s*, done/);
  await qaShots(page, 'controlled-step-2-prescription', {
    focus: prescriber,
    widths: QA_STATE_WIDTHS,
  });

  // 3 · Approving pharmacist: a second pharmacist with their own PIN.
  const pharmacist = auth.getByRole('combobox', { name: 'Approving pharmacist' });
  await pharmacist.focus();
  await pharmacist.selectOption({ label: PHARMACY_E2E.pharmacistName });
  const pin = auth.getByLabel(/^(Pharmacist PIN|Approval code)$/);
  await pin.focus();
  await pin.fill(PHARMACY_E2E.pharmacistPin);
  await expect(steps.getByRole('listitem').nth(2)).toHaveText(/Pharmacist\s*, done/);
  await qaShots(page, 'controlled-step-3-pharmacist', { focus: pin, widths: QA_STATE_WIDTHS });
  await expect(authorise).toBeEnabled();
  await qaShots(page, 'controlled-sheet-ready', {
    focus: authorise,
    widths: QA_STATE_WIDTHS,
    dir: QA3_DIR,
  });

  // DEV-977 phase 3 review: a wrong PIN is refused by the server, and the refusal is said inside
  // the open sheet; the PIN is cleared and takes the focus, and nothing is added.
  await pin.fill('0000');
  await pressControl(authorise);
  const refusal = sheet.getByRole('alert');
  await expect(refusal).toBeVisible({ timeout: 15_000 });
  await expect(refusal).not.toContainText('0000');
  await expect(pin).toHaveValue('');
  await expect(pin).toBeFocused();
  // The refusal stays on screen while the cleared PIN has the focus.
  await expect(refusal).toBeInViewport();
  await expect(billLine(page, controlled.name)).toHaveCount(0);
  await qaShots(page, 'controlled-sheet-refused', {
    focus: pin,
    widths: QA_STATE_WIDTHS,
    dir: QA3_DIR,
  });
  await pin.fill(PHARMACY_E2E.pharmacistPin);
  await expect(refusal).toBeHidden();

  await pressControl(authorise);
  await expect(page.getByText(`1 × ${controlled.name} added.`)).toBeVisible({ timeout: 15_000 });
  await expect(sheet).toBeHidden();
  const line = billLine(page, controlled.name);
  await expect(line).toContainText('Controlled');
  await expect(line).toContainText(controlled.batchNumber);
  // A controlled line is never changed on the bill: no quantity, unit or remove control.
  await expect(line.getByRole('textbox', { name: `Quantity: ${controlled.name}` })).toHaveCount(0);
  await expect(line.getByRole('radiogroup', { name: `Sold as: ${controlled.name}` })).toHaveCount(
    0
  );
  await expect(line.getByRole('button', { name: `Remove ${controlled.name}` })).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Cart lines' })).toContainText(
    'supplied as an emergency without a prescription'
  );
  await page.keyboard.press('Shift+F4');
  const voidDialog = page.getByRole('dialog', { name: 'Void this bill?' });
  const reason = voidDialog.getByRole('radio', { name: 'Duplicate bill' });
  await reason.focus();
  await reason.press('Space');
  await pressControl(voidDialog.getByRole('button', { name: 'Void bill' }));
  const restore = page.getByRole('dialog', { name: 'Confirm this controlled stock restoration' });
  await restore.getByLabel('Approving pharmacist').selectOption(PHARMACY_E2E.adminStaffProfileId);
  await restore.locator('input[type=password]').fill(PHARMACY_E2E.adminPin);
  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    await qaShots(page, 'controlled-void-' + reducedMotion, {
      focus: restore.getByLabel('Approving pharmacist'),
      widths: QA_STATE_WIDTHS,
      reducedMotion,
    });
  }
  await pressControl(restore.getByRole('button', { name: 'Confirm void' }));
  await expect(page.getByRole('status').filter({ hasText: /Bill voided/i })).toBeVisible({
    timeout: 15_000,
  });
});

test('DEV-1011 — an approved controlled sale records the saved address without sending it to the browser', async ({
  page,
}) => {
  const { Client } = await import('pg');
  const db = new Client({ connectionString: resolvePharmacyE2eDatabaseUrl() });
  const patientId = randomUUID();
  const patientName = `Synthetic Patient ${patientId.slice(0, 8)}`;
  const savedAddress = `24 Synthetic Sentinel Street ${patientId}`;
  const { organizationId, branchId, adminId, pharmacistId, medicines } = PHARMACY_E2E;
  const controlled = medicines.controlled;
  await db.connect();
  try {
    await db.query(
      "SELECT set_config('app.current_organization_id', $1, false), set_config('app.current_branch_id', $2, false)",
      [organizationId, branchId]
    );
    await db.query(
      `WITH patient AS (
         INSERT INTO pharmacy_patients (id, "organizationId", "displayName", cnic, address, "updatedAt")
         VALUES ($1, $2, $3, '0000000000001', $4, now()) RETURNING id
       )
       INSERT INTO pharmacy_patient_consents
         (id, "organizationId", "patientId", purpose, channel, version, granted, "recordedByUserId")
       SELECT $1 || '-consent', $2, id, 'DISPENSING', 'IN_PERSON', 1, true, $5 FROM patient`,
      [patientId, organizationId, patientName, savedAddress, adminId]
    );

    await openCounter(page);
    await openDrawer(page);
    const requests: Request[] = [];
    const observe = (request: Request) => requests.push(request);
    page.on('request', observe);
    await search(page, 'Fathomadol');
    await stageFirstResult(page, controlled.name);
    await page.keyboard.press('F6');
    const sheet = page.getByRole('dialog', { name: /^Authorise Fathomadol/ });
    await pressControl(sheet.getByRole('button', { name: 'Find the patient' }));
    const checks = page.getByRole('dialog', { name: 'Patient, prescription and checks' });
    const find = checks.getByLabel('Find patient');
    await find.fill(patientName);
    await find.press('Enter');
    await pressControl(checks.getByRole('button', { name: new RegExp(patientName) }));
    await pressControl(checks.getByRole('button', { name: /^Authorise Fathomadol/ }));
    const address = sheet.getByLabel('Patient address');
    await address.fill('92 Temporary Test Road');
    await address.fill('');
    await expect(address).toHaveAttribute('placeholder', 'Use the address on file');
    await tickWithSpace(sheet.getByLabel('Emergency supply, no prescription'));
    await sheet.getByLabel('Prescriber name').fill('Synthetic E2E Prescriber');
    await sheet.getByRole('combobox', { name: 'Approving pharmacist' }).selectOption({
      label: PHARMACY_E2E.pharmacistName,
    });
    await sheet.getByLabel(/^(Pharmacist PIN|Approval code)$/).fill(PHARMACY_E2E.pharmacistPin);
    await pressControl(sheet.getByRole('button', { name: 'Authorise line' }));
    await expect(page.getByText(`1 × ${controlled.name} added.`)).toBeVisible({ timeout: 15_000 });
    await expect(billLine(page, controlled.name)).toContainText('Controlled');
    page.off('request', observe);

    const procedures = new Set<string>();
    for (const request of requests) {
      const response = await request.response();
      if (!response) continue; // A cancelled request delivered no response.
      const path = new URL(response.url()).pathname;
      expect((await response.body()).includes(savedAddress), path).toBe(false);
      if (response.ok() && path.startsWith('/api/trpc/')) {
        for (const procedure of path.slice('/api/trpc/'.length).split(','))
          procedures.add(procedure);
      }
    }
    expect([...procedures]).toEqual(
      expect.arrayContaining([
        'pharmacyPrescriptions.counterPatients',
        'pharmacyPrescriptions.counterPatientPanel',
        'pharmacySales.addLine',
        'pharmacySales.counterCart',
      ])
    );

    const entry = await db.query(
      `SELECT "patientAddress", "recordedByUserId", "witnessedByUserId"
       FROM pharmacy_controlled_register_entries
       WHERE "organizationId"=$1 AND "branchId"=$2 AND "patientId"=$3 AND "medicineId"=$4 AND "entryKind"='SALE'`,
      [organizationId, branchId, patientId, controlled.id]
    );
    expect(entry.rows).toEqual([
      {
        patientAddress: savedAddress,
        recordedByUserId: adminId,
        witnessedByUserId: pharmacistId,
      },
    ]);
  } finally {
    await db.end();
  }
});

test('Counter v2 — the discount sheet: whole bill or next item, and who can approve', async ({
  page,
}) => {
  const otc = PHARMACY_E2E.medicines.otc;
  // The owner's whole-bill switch, on for this test only (the disposable lane's own row).
  const setBillDiscount = async (enabled: boolean) => {
    const { Client } = await import('pg');
    const db = new Client({ connectionString: resolvePharmacyE2eDatabaseUrl() });
    await db.connect();
    try {
      await db.query('BEGIN');
      await db.query(
        "SELECT set_config('app.is_platform_admin', 'true', true), set_config('app.current_organization_id', $1, true)",
        [PHARMACY_E2E.organizationId]
      );
      await db.query('UPDATE organizations SET "pharmacyBillDiscountEnabled" = $2 WHERE id = $1', [
        PHARMACY_E2E.organizationId,
        enabled,
      ]);
      await db.query('COMMIT');
    } finally {
      await db.end();
    }
  };
  await setBillDiscount(true);
  try {
    await openCounter(page, PHARMACY_E2E.cashierEmail);
    await openDrawer(page);
    await search(page, otc.brandName);
    await addFirstResult(page, otc.name);
    await expect(billLine(page, otc.name)).toBeVisible({ timeout: 15_000 });
    const totals = page.getByRole('complementary', { name: 'Bill total' });
    await pressControl(totals.getByRole('button', { name: 'Discount', exact: true }));
    const sheet = page.getByRole('dialog', { name: /^Discount on the / });
    await expect(sheet).toHaveAccessibleName('Discount on the next item');
    // A4: the supervisor block names who can approve; the PIN is asked for later, if needed.
    const supervisor = sheet.getByRole('region', { name: 'Supervisor approval' });
    await expect(supervisor).toContainText(
      'A manager or owner must approve a discount you cannot give on your own.'
    );
    await expect(supervisor.getByRole('list', { name: 'Who can approve' })).toContainText(
      'Pharmacy Administrator'
    );
    await expect(supervisor.getByLabel(/PIN/)).toHaveCount(0);
    // A4: "Apply to": the next item, or the whole bill.
    const applyTo = sheet.getByRole('group', { name: 'Apply to' });
    await expect(applyTo.getByRole('button', { name: 'Next item' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await pressControl(applyTo.getByRole('button', { name: 'Whole bill' }));
    await expect(sheet).toHaveAccessibleName('Discount on the whole bill');
    await expect(supervisor).toContainText('when you apply it to the bill');
    const value = sheet.getByLabel('Discount (%)');
    await value.focus();
    await value.fill('10');
    await qaShots(page, 'discount-whole-bill', {
      focus: value,
      widths: QA_STATE_WIDTHS,
      dir: QA3_DIR,
    });
    await pressControl(sheet.getByRole('button', { name: 'Apply to bill' }));
    // The whole-bill procedure's own approval dialog, unchanged.
    const approval = page.getByRole('dialog', { name: 'Approve this discount?' });
    await expect(approval).toBeVisible({ timeout: 15_000 });
    await expect(approval).toContainText('Whole bill: a discount of 10% off the bill.');
    const approver = approval.getByRole('combobox', { name: 'Approving manager or owner' });
    await approver.focus();
    await approver.selectOption({ label: 'Pharmacy Administrator' });
    const pin = approval.getByLabel(/^(Approver PIN|Approval code)$/);
    await pin.focus();
    await pin.fill(PHARMACY_E2E.adminPin);
    await pressControl(approval.getByRole('button', { name: 'Approve discount' }));
    await expect(approval).toBeHidden();
    await expect(
      page.getByText(/A whole-bill discount of Rs 0\.25 is on the bill, shared over 1 item\./)
    ).toBeVisible({ timeout: 15_000 });
    await expect(totals).toContainText('2.25');
    await tenderCash(page, '2.25');
    await expect(
      page.getByRole('region', { name: /^Receipt \d+ · Counter [A-Z0-9]{4}$/ })
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await setBillDiscount(false);
  }
});

const SERVER_FEATURE_QA = 'playwright-artifacts/pharmacy-counter-server-features';
async function featureShots(page: Page, name: string, focus: Locator) {
  const widths = [375, 768, 1024, 1440];
  const original = page.viewportSize();
  for (const width of widths) {
    await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' });
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme
      );
      await focus.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(focus).toBeFocused();
      expect(await focus.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true);
    }
  }
  if (original) await page.setViewportSize(original);
  await qaShots(page, name, { focus, widths, dir: SERVER_FEATURE_QA });
}
test.describe('Counter server features', () => {
  const browserErrors = new WeakMap<Page, string[]>();
  test.beforeEach(({ page }) => {
    const errors: string[] = [];
    browserErrors.set(page, errors);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
  });
  test.afterEach(({ page }) => {
    expect(browserErrors.get(page)).toEqual([]);
  });
  test('B3 returns and refunds two receipt lines in one confirmation', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCounter(page);
    await openDrawer(page);
    const { otc, syrup } = PHARMACY_E2E.medicines;
    for (const med of [otc, syrup]) {
      await search(page, med.name);
      await addFirstResult(page, med.name);
      await expect(billLine(page, med.name)).toBeVisible();
    }
    // Sell the full bottle, then return just one of its 60 units along with the tablet.
    await tenderCash(page, '182.50');
    const receipt = page.getByRole('region', { name: /^Receipt \d+ · Counter [A-Z0-9]{4}$/ });
    await expect(receipt).toBeVisible();
    const number = (await receipt.getAttribute('aria-label'))!.match(/\d+/)![0];
    await page.keyboard.press('Escape');
    await pressControl(page.getByRole('button', { name: 'Returns & refunds' }));
    const sheet = page.getByRole('dialog', { name: 'Returns & refunds' });
    await sheet.getByLabel('Receipt number', { exact: true }).fill(number);
    await pressControl(sheet.getByRole('button', { name: 'Find receipt', exact: true }));
    const device = await page.evaluate(() =>
      localStorage.getItem('devfathom.pharmacy.counter.device')
    );
    await pressControl(
      sheet
        .getByRole('button', { name: new RegExp('Receipt ' + number + ' ·') })
        .filter({ hasText: counterLabel(device)! })
    );
    await pressControl(sheet.getByRole('button', { name: 'Return several lines' }));
    for (const med of [otc, syrup]) {
      const check = sheet.getByRole('checkbox', { name: new RegExp(med.name) });
      await check.focus();
      await page.keyboard.press('Space');
      await pressControl(sheet.getByRole('combobox', { name: 'Batch of ' + med.name }));
      await pressControl(page.getByRole('option', { name: new RegExp(med.batchNumber) }));
      await pressControl(sheet.getByRole('combobox', { name: 'Stock outcome for ' + med.name }));
      await pressControl(page.getByRole('option', { name: 'Restock inspected pack' }));
    }
    await sheet.getByLabel('Reason for return').fill('Wrong items, packaging intact');
    await pressControl(sheet.getByRole('combobox', { name: 'Refund to' }));
    await pressControl(page.getByRole('option', { name: /CASH/ }));
    await pressControl(sheet.getByRole('button', { name: 'Review selected lines' }));
    const pin = sheet.getByLabel(/Your manager or owner PIN|Your approval code/);
    await featureShots(page, 'multi-line-return', pin);
    await pin.fill(PHARMACY_E2E.adminPin);
    await pressControl(sheet.getByRole('button', { name: 'Confirm selected returns' }));
    await expect(sheet.getByRole('status')).toContainText(
      'Selected returns recorded and refunded: PKR 5.50'
    );
  });

  test('A4 approves a discount on the selected existing line inside the discount sheet', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openCounter(page, PHARMACY_E2E.cashierEmail);
    await openDrawer(page);
    const otc = PHARMACY_E2E.medicines.otc;
    await search(page, otc.brandName);
    await addFirstResult(page, otc.name);
    await expect(billLine(page, otc.name)).toBeVisible();
    const totals = page.getByRole('complementary', { name: 'Bill total' });
    await pressControl(totals.getByRole('button', { name: 'Discount', exact: true }));
    const sheet = page.getByRole('dialog');
    await pressControl(sheet.getByRole('button', { name: 'Bill line', exact: true }));
    await sheet.getByLabel('Discount (%)', { exact: true }).fill('10');
    await pressControl(sheet.getByRole('combobox', { name: 'Approving manager or owner' }));
    await pressControl(page.getByRole('option', { name: 'Pharmacy Administrator' }));
    await featureShots(
      page,
      'bill-line-discount',
      sheet.getByLabel(/^(Approver PIN|Approval code)$/)
    );
    await sheet.getByLabel(/^(Approver PIN|Approval code)$/).fill(PHARMACY_E2E.adminPin);
    await pressControl(sheet.getByRole('button', { name: 'Apply to selected line' }));
    await expect(sheet).toBeHidden();
    await expect(billLine(page, otc.name)).toContainText('2.25');
  });

  test('DEV-988 an unmatched pack holds its line even after reopening the counter', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    test.setTimeout(120_000);
    await openCounter(page);
    await openDrawer(page);
    const otc = PHARMACY_E2E.medicines.otc;
    await scan(page, otc.barcode);
    await expect(billLine(page, otc.name)).toBeVisible();
    await pressControl(page.getByRole('button', { name: 'More', exact: true }));
    await pressControl(page.getByRole('button', { name: 'Pack check', exact: true }));
    const sheet = page.getByRole('dialog', { name: 'Check a pack against this bill' });
    await sheet.getByLabel('Pack code').fill('unmatched-test-pack');
    await pressControl(sheet.getByRole('button', { name: 'Check pack', exact: true }));
    await expect(sheet.getByRole('alert')).toContainText('doesn’t match');
    await featureShots(page, 'pack-mismatch', sheet.getByLabel('Pack code'));
    await page.reload();
    await expect(billLine(page, otc.name)).toBeVisible();
    await expect(page.getByRole('button', { name: /Take payment/i }).first()).toBeDisabled();

    // Use a registered synthetic GTIN with no encoded batch and no barcode pack level.
    const gtin = '01234567890128';
    const { Client } = await import('pg');
    const db = new Client({ connectionString: resolvePharmacyE2eDatabaseUrl() });
    await db.connect();
    try {
      await db.query('BEGIN');
      await db.query("SELECT set_config('app.current_organization_id', $1, true)", [
        PHARMACY_E2E.organizationId,
      ]);
      await db.query(
        `INSERT INTO pharmacy_medicine_barcodes
          (id, "organizationId", "presentationId", type, code, "normalizedCode")
          VALUES ($1, $2, $3, 'GTIN', $4, $4) ON CONFLICT (id) DO NOTHING`,
        ['barcode_counter_e2e_no_batch', PHARMACY_E2E.organizationId, otc.presentationId, gtin]
      );
      await db.query('COMMIT');
    } finally {
      await db.end();
    }
    await pressControl(page.getByRole('button', { name: 'More', exact: true }));
    await pressControl(page.getByRole('button', { name: 'Pack check', exact: true }));
    await sheet.getByLabel('Pack code').fill(`(01)${gtin}`);
    await pressControl(sheet.getByRole('button', { name: 'Check pack', exact: true }));
    await expect(sheet.getByRole('status')).toHaveText(
      'Product matched. Batch not checked: confirm the batch on the pack.'
    );
    await expect(sheet.getByRole('alert')).toHaveCount(0);
    await featureShots(page, 'pack-batch-not-checked', sheet.getByLabel('Pack code'));
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(page.getByRole('button', { name: /Take payment/i }).first()).toBeEnabled();
  });

  test('DEV-991 records an unlisted medicine request without opening a bill', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    test.setTimeout(120_000);
    await openCounter(page, PHARMACY_E2E.cashierEmail);
    await openDrawer(page);
    await pressControl(page.getByRole('button', { name: 'More', exact: true }));
    await pressControl(page.getByRole('button', { name: 'Customer asked for it' }));
    const sheet = page.getByRole('dialog', { name: 'Customer asked for it' });
    await sheet.getByLabel('Requested medicine').fill('Synthetic unlisted medicine');
    await sheet.getByLabel('How many units they wanted').fill('3');
    await featureShots(page, 'customer-demand', sheet.getByLabel('Requested medicine'));
    await pressControl(sheet.getByRole('button', { name: 'Save request' }));
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Recorded 3 units of Synthetic unlisted medicine' })
    ).toBeVisible();
    await expect(page.getByText('No open bill', { exact: true }).first()).toBeVisible();
  });
});

test('Counter v2 — offline: a price check only, no offline bill, and "Sign-in not checked"', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const otc = PHARMACY_E2E.medicines.otc;
  const rx = PHARMACY_E2E.medicines.rx;
  await signIn(page);
  // DEV-957: the owner enrols this computer and prepares it for offline (keyboard only).
  await page.goto('/pharmacy/settings/counters');
  await expect(page.getByRole('heading', { name: 'Counter computers', level: 1 })).toBeVisible();
  const counterName = page.getByLabel('Counter name');
  await counterName.focus();
  await counterName.fill('Counter lane E2E');
  await pressControl(page.getByRole('button', { name: 'Enrol this computer' }));
  await expect(page.getByText(/This computer is now the counter Counter lane E2E/)).toBeVisible({
    timeout: 30_000,
  });
  await pressControl(page.getByRole('button', { name: 'Prepare this counter for offline' }));
  await expect(page.getByText(/This counter now holds \d+ receipt numbers/)).toBeVisible({
    timeout: 60_000,
  });
  await page.goto(`/pharmacy/counter?branchId=${PHARMACY_E2E.branchId}`);
  await expect(page.getByRole('heading', { name: 'Counter', level: 1 })).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const shell = await caches.open('devfathom-pharmacy-counter-shell-v1');
          return Boolean(await shell.match('/pharmacy/counter'));
        }),
      { timeout: 60_000 }
    )
    .toBe(true);

  await context.setOffline(true);
  const banner = page.locator('[data-counter-offline]').first();
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(banner.getByText('Offline — this counter cannot reach the server.')).toBeVisible();
  // Offline cash selling is off: the counter is a price check, and nothing offers a bill.
  await expect(banner.locator('[data-counter-offline-selling="off"]')).toContainText(
    'Offline cash selling is off'
  );
  await expect(page.getByRole('button', { name: /Take cash/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /offline bill/i })).toHaveCount(0);
  // The till cannot check who is signed in, so it never names the last person.
  const topBar = page.locator('[data-counter-top-bar]');
  await expect(topBar.getByText('Offline', { exact: true })).toBeVisible();
  await expect(topBar.getByText('Sign-in not checked', { exact: true })).toBeVisible();
  await expect(topBar).not.toContainText('Counter Gate Admin');

  const priceCheck = page.getByRole('searchbox', { name: 'Offline price check' });
  await priceCheck.focus();
  await priceCheck.fill(otc.name.slice(0, 6));
  const results = page.getByRole('list', { name: 'Offline price check results' });
  await expect(results.getByText(otc.name)).toBeVisible();
  await expect(results.getByText(/Rs 250\.00 a pack/)).toBeVisible();
  await expect(results.getByRole('button')).toHaveCount(0);
  await qaShots(page, 'offline', { focus: priceCheck });
  await priceCheck.fill(rx.name.slice(0, 9));
  await expect(page.getByText(/No medicine this counter holds offline matches/)).toBeVisible();
  await priceCheck.press('Escape');
  await expect(priceCheck).toHaveValue('');
  await context.setOffline(false);
});

test('[DEF-13] cashier float guidance and refusal preserve empty-drawer access', async ({
  page,
}) => {
  await openCounter(page, PHARMACY_E2E.cashierEmail);
  const openingCash = page.getByLabel('Opening cash', { exact: true });
  // DEV-933: the count is always typed, a cashier's too (a typed 0 is allowed); it is
  // never prefilled. The server still refuses a cashier's float, as below.
  await expect(openingCash).toBeEditable();
  await expect(openingCash).toHaveValue('');
  await expect(page.getByRole('group', { name: 'Quick amounts' })).toHaveCount(0);
  await expect(page.getByText(/Count the cash in the drawer/)).toHaveCount(0);
  await expect(page.getByText(/Ask a manager or owner to declare any opening float/)).toBeVisible();

  // Simulate stale presentation data after a permission change. The real cashier
  // session and database grants remain unchanged: the server must refuse the float.
  await page.route('**/api/trpc/**', async (route) => {
    const names = new URL(route.request().url()).pathname.split('/api/trpc/')[1]?.split(',') ?? [];
    const index = names.indexOf('pharmacySales.refundAccess');
    if (index < 0) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const result = Array.isArray(body) ? body[index] : body;
    if (result?.result?.data?.json) result.result.data.json.authorized = true;
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await expect(openingCash).toBeEditable();
  await openingCash.fill('5000');
  await pressControl(page.getByRole('button', { name: 'Open drawer' }));
  await expect(
    page.getByRole('alert').filter({ hasText: 'Only a manager or owner can open with a float.' })
  ).toContainText(
    'Only a manager or owner can open with a float. Open with 0 if the drawer is empty, or ask a manager.'
  );
  await expect(page.getByText(/Your role does not take payments/)).toHaveCount(0);
  await expect(openingCash).toHaveValue('5000');
  await expect(page.getByLabel('Scan or search')).toHaveCount(0);
  await openDrawer(page);
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
  const receipt = page.getByRole('region', { name: /^Receipt \d+ · Counter [A-Z0-9]{4}$/ });
  await expect(receipt).toBeVisible({ timeout: 15_000 });
  await expect(receipt).toContainText(otc.name);
  await expect(receipt).toContainText(otc.batchNumber);

  // Counter v2 C6: a cashier finds their own receipt under Returns & refunds and is told,
  // plainly, who can refund it. No return form and no confirm is offered; the server refuses
  // a cashier's refund whatever the screen shows ([DEF-13] above).
  const receiptNumber = (await receipt.getAttribute('aria-label'))!.match(/\d+/)![0];
  await page.keyboard.press('Escape');
  // Without refund access the action is "Returns", not "Returns & refunds".
  await expect(page.getByRole('button', { name: 'Returns & refunds' })).toHaveCount(0);
  await pressControl(page.getByRole('button', { name: 'Returns', exact: true }));
  const dialog = page.getByRole('dialog', { name: 'Returns', exact: true });
  const receiptField = dialog.getByLabel('Receipt number', { exact: true });
  await receiptField.focus();
  await receiptField.fill(receiptNumber);
  await pressControl(dialog.getByRole('button', { name: 'Find receipt', exact: true }));
  const device = await page.evaluate(() =>
    localStorage.getItem('devfathom.pharmacy.counter.device')
  );
  expect(device).toMatch(/^counter-/);
  const label = counterLabel(device!);
  expect(label).not.toBeNull();
  await pressControl(
    dialog
      .getByRole('button', { name: new RegExp('Receipt ' + receiptNumber + ' ·') })
      .filter({ hasText: label! })
  );
  const card = dialog.locator('[data-counter-no-permission]');
  await expect(
    card.getByRole('heading', { name: 'Ask a manager or owner to record this return' })
  ).toBeVisible({ timeout: 15_000 });
  await expect(card.getByRole('note')).toContainText(
    'Returns and refunds need a manager or owner.'
  );
  await expect(card).toContainText(/Who can\s*Managers and the owner/);
  await expect(dialog.getByRole('form', { name: 'Return and refund' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /Confirm return & refund/ })).toHaveCount(0);
  await qaShots(page, 'no-permission', {
    focus: dialog.getByRole('button', { name: 'Find receipt', exact: true }),
  });
  // DEV-977 phase 3 (C6): the design's "Got it" sits below the card, never inside it.
  const gotIt = dialog.getByRole('button', { name: 'Got it' });
  await expect(card.getByRole('button')).toHaveCount(0);
  await expect(gotIt).toBeVisible();
  await qaShots(page, 'no-permission-got-it', {
    focus: gotIt,
    widths: QA_STATE_WIDTHS,
    dir: QA3_DIR,
  });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // Opened again, "Got it" closes it from the keyboard.
  await pressControl(page.getByRole('button', { name: 'Returns', exact: true }));
  await receiptField.focus();
  await receiptField.fill(receiptNumber);
  await pressControl(dialog.getByRole('button', { name: 'Find receipt', exact: true }));
  await pressControl(
    dialog
      .getByRole('button', { name: new RegExp('Receipt ' + receiptNumber + ' ·') })
      .filter({ hasText: label! })
  );
  await expect(card).toBeVisible({ timeout: 15_000 });
  await pressControl(gotIt);
  await expect(dialog).toBeHidden();
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
  await expect(
    page.getByRole('region', { name: /^Receipt \d+ · Counter [A-Z0-9]{4}$/ })
  ).toBeVisible();
  await page.goto('/pharmacy/counter/close');
  await expect(page.getByRole('heading', { name: 'Day close', exact: true })).toBeVisible();
  const inputs = page.getByLabel(/Counted cash for drawer/);
  await expect(inputs.first()).toBeVisible();
  let shortageAssigned = false;
  for (let i = 0; i < (await inputs.count()); i++) {
    const field = inputs.nth(i);
    const row = field.locator('..').locator('..');
    const text = await row.innerText();
    const expected = Number(text.match(/Expected: PKR ([\d,.]+)/)![1].replaceAll(',', ''));
    const shortage = !shortageAssigned && expected >= 1 ? 1 : 0;
    if (shortage) shortageAssigned = true;
    await field.fill((expected - shortage).toFixed(2));
  }
  expect(shortageAssigned).toBe(true);
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
  // DEV-631: the counter says the day is closed before a bill is built; no drawer
  // step or scan/search is offered, so nothing is added that payment would refuse.
  await expect(page.getByRole('status', { name: 'Business day closed' })).toContainText(
    'The owner or a manager can reopen today for trading on Day close'
  );
  await expect(page.getByLabel('Opening cash', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Scan or search', { exact: true })).toHaveCount(0);
  // The owner's reopen for trading needs their own staff PIN, which this fixture does
  // not seed; it is covered by the day-close console and router tests.
  await page.goto('/pharmacy/counter/close');
  await expect(page.getByRole('form', { name: 'Reopen today for trading' })).toBeVisible();
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

test('DEV-1043 — a dispensing pharmacist confirms a prescribed controlled sale alone and takes payment', async ({
  page,
}) => {
  const { Client } = await import('pg');
  const db = new Client({ connectionString: resolvePharmacyE2eDatabaseUrl() });
  const {
    organizationId,
    branchId,
    adminId,
    prescriberId,
    medicines,
    adminPinCredentialId,
    adminPin,
    adminStaffProfileId,
  } = PHARMACY_E2E;
  const med = medicines.controlled;
  const rx = randomUUID();
  const patientId = randomUUID();
  const patientName = 'Synthetic solo ' + patientId.slice(0, 8);
  const address = '103 Synthetic Test Street';
  await db.connect();
  try {
    await db.query(
      "SELECT set_config('app.current_organization_id',$1,false), set_config('app.current_branch_id',$2,false)",
      [organizationId, branchId]
    );
    await db.query(
      'INSERT INTO pharmacy_patients(id,"organizationId","displayName",cnic,"updatedAt") VALUES ($1,$2,$3,$4,now())',
      [patientId, organizationId, patientName, '0000000000000']
    );
    await db.query(
      `INSERT INTO pharmacy_patient_consents(id,"organizationId","patientId",purpose,channel,version,granted,"recordedByUserId") VALUES ($1,$2,$3,'DISPENSING','IN_PERSON',1,true,$4)`,
      [randomUUID(), organizationId, patientId, adminId]
    );
    await db.query(
      `INSERT INTO pharmacy_prescriptions(id,"organizationId","patientId","prescriberId","sourceKind","sourceFileRef","validFrom","validUntil","capturedByUserId")
      VALUES ($1,$2,$3,$4,'PAPER_IMAGE','synthetic://dev1043',now()-interval '1 day',now()+interval '1 day',$5)`,
      [rx, organizationId, patientId, prescriberId, adminId]
    );
    await db.query(
      `INSERT INTO pharmacy_prescription_lines(id,"organizationId","prescriptionId","lineNumber","medicineId","presentationId","authorizedCanonicalUnits",directions)
      VALUES ($1,$2,$3,1,$4,$5,100,'Synthetic directions')`,
      [rx + '-line', organizationId, rx, med.id, med.presentationId]
    );
    await openCounter(page);
    await openDrawer(page);
    await search(page, 'Fathomadol');
    await stageFirstResult(page, med.name);
    await page.keyboard.press('F6');
    const sheet = page.getByRole('dialog', { name: /^Authorise Fathomadol/ });
    await pressControl(sheet.getByRole('button', { name: 'Find the patient' }));
    const checks = page.getByRole('dialog', { name: 'Patient, prescription and checks' });
    const find = checks.getByLabel('Find patient');
    await find.fill(patientName);
    await find.press('Enter');
    await pressControl(checks.getByRole('button', { name: new RegExp(patientName) }));
    await pressControl(checks.getByRole('button', { name: /^Authorise Fathomadol/ }));
    await sheet.getByLabel('Patient address').fill(address);
    await sheet.getByLabel('Prescription line', { exact: true }).selectOption(rx + '-line');
    await sheet
      .getByRole('combobox', { name: 'Approving pharmacist' })
      .selectOption(adminStaffProfileId);
    const pin = sheet.getByLabel(/^(Pharmacist PIN|Approval code)$/);
    const submit = sheet.getByRole('button', { name: 'Authorise line' });
    const strikes = async () =>
      Number(
        (
          await db.query(
            'SELECT "failedAttempts" FROM restaurant_operator_credentials WHERE id=$1',
            [adminPinCredentialId]
          )
        ).rows[0].failedAttempts
      );
    for (const reducedMotion of ['no-preference', 'reduce'] as const) {
      await qaShots(page, 'controlled-own-confirmation-' + reducedMotion, {
        focus: pin,
        widths: QA_STATE_WIDTHS,
        reducedMotion,
      });
    }
    const before = await strikes();
    await pin.fill('0000');
    await pressControl(submit);
    await expect(sheet.getByRole('alert')).toBeVisible();
    await expect(pin).toHaveValue('');
    expect(await strikes()).toBe(before + 1);
    await expect(billLine(page, med.name)).toHaveCount(0);
    await pin.fill(adminPin);
    await pressControl(submit);
    await expect(billLine(page, med.name)).toBeVisible({ timeout: 15000 });
    expect(await strikes()).toBe(0);
    await page.keyboard.press('F9');
    await pressControl(page.getByRole('button', { name: 'Take payment', exact: true }));
    await expect(page.getByRole('region', { name: /^Receipt \d+/ })).toContainText(med.name, {
      timeout: 15000,
    });
    const records = await db.query(
      `SELECT r.*,d."actorUserId",a.metadata,s.status FROM pharmacy_controlled_register_entries r
      JOIN pharmacy_pharmacist_review_decisions d ON d.id=r."signatureRef" AND d."organizationId"=r."organizationId"
      JOIN audit_logs a ON a.id=d."selfApprovalAuditId" AND a."organizationId"=r."organizationId"
      JOIN pharmacy_sales s ON s.id=a.metadata->>'saleId' AND s."organizationId"=r."organizationId"
      WHERE r."organizationId"=$1 AND r."prescriptionLineId"=$2`,
      [organizationId, rx + '-line']
    );
    expect(records.rows).toHaveLength(1);
    expect(records.rows[0]).toMatchObject({
      status: 'COMPLETED',
      entryKind: 'SALE',
      branchId,
      patientId,
      patientAddress: address,
      prescriberId,
      prescriptionId: rx,
      medicineId: med.id,
      batchNumber: med.batchNumber,
      recordedByUserId: adminId,
      witnessedByUserId: null,
      actorUserId: adminId,
      witnessStatement: 'No witness: dispensed by one pharmacist',
      metadata: expect.objectContaining({
        selfApproved: true,
        pinVerified: true,
        approvalMethod: 'PIN',
        branchId,
      }),
    });
    expect(records.rows[0].quantityCanonicalUnits).toBeGreaterThan(0);
    expect(records.rows[0].runningBalance).toBeGreaterThanOrEqual(0);

    const guard = await db.query(
      `SELECT tgdeferrable, tginitdeferred FROM pg_trigger WHERE tgname='pharmacy_require_controlled_sale_register'
       AND tgrelid='pharmacy_sale_lines'::regclass AND tgenabled='O'`
    );
    expect(guard.rows).toEqual([{ tgdeferrable: true, tginitdeferred: true }]);

    // Verify the deferred line rule independently of the register-insert guard.
    await db.query('BEGIN');
    try {
      await db.query(
        `INSERT INTO pharmacy_sale_lines
           SELECT (jsonb_populate_record(NULL::pharmacy_sale_lines, to_jsonb(l) ||
             jsonb_build_object('id',$2::text,'idempotencyKey',$2::text))).*
           FROM pharmacy_sale_lines l WHERE l.id=$1`,
        [records.rows[0].metadata.saleLineId, randomUUID()]
      );
      await expect(
        db.query('SET CONSTRAINTS pharmacy_require_controlled_sale_register IMMEDIATE')
      ).rejects.toMatchObject({
        code: '23514',
        message: 'controlled sale line requires its approved register entries',
      });
    } finally {
      await db.query('ROLLBACK');
    }

    // Reuse the synthetic row's otherwise valid clinical and stock details. The database
    // must refuse a new solo row specifically for a missing or reused approval.
    for (const decisionId of [null, records.rows[0].signatureRef]) {
      await db.query('BEGIN');
      try {
        await expect(
          db.query(
            `INSERT INTO pharmacy_controlled_register_entries
          SELECT (jsonb_populate_record(NULL::pharmacy_controlled_register_entries,
            to_jsonb(r) || jsonb_build_object('id',$2::text,'serial',r.serial+1,'signatureRef',$3::text))).*
          FROM pharmacy_controlled_register_entries r WHERE r.id=$1`,
            [records.rows[0].id, randomUUID(), decisionId]
          )
        ).rejects.toMatchObject({
          code: '23514',
          message: 'controlled register requires its verified self-approval',
        });
      } finally {
        await db.query('ROLLBACK');
      }
    }
  } finally {
    await db.end();
  }
});
