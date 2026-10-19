# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: pharmacy-counter.spec.ts >> bill 1 — barcode scan, strip unit, cash tender and a bilingual receipt
- Location: tests/e2e/pharmacy-counter.spec.ts:140:5

# Error details

```
Error: expect(page).toHaveURL(expected) failed

Expected pattern: /\/(dashboard|pharmacy)/
Received string:  "http://127.0.0.1:4331/login"
Timeout: 30000ms

Call log:
  - Expect "toHaveURL" with timeout 30000ms
    64 × locator resolved to <html lang="en" data-theme="light" data-layout="rail" data-type="default" data-accent="quiet" data-icons="numeric" data-density="default" class="instrument_sans_b020fca9-module__XAVg4G__variable ibm_plex_mono_87f81fa4-module__sL176q__variable h-full">…</html>
       - unexpected value "http://127.0.0.1:4331/login"

```

```yaml
- text: DevFathom Fieldbook / 01
- paragraph: The delivery desk
- paragraph: Projects, finance, clients, and people — each moving part visible before it becomes a decision.
- text: All systems operational DevFathom · Company hub
- paragraph: Secure workspace access
- heading "Welcome back" [level=1]
- paragraph: Sign in to pick up the work your team is moving forward.
- text: Email
- textbox "Email":
  - /placeholder: you@company.com
- text: Password
- link "Forgot password?":
  - /url: /forgot-password
- textbox "Password":
  - /placeholder: Enter your password
- button "Show password"
- button "Sign in"
- paragraph: Need access? Contact your workspace admin.
```

# Test source

```ts
  1   | import { expect, test, type Locator, type Page } from '@playwright/test';
  2   | import { readFile } from 'node:fs/promises';
  3   | import { join } from 'node:path';
  4   | 
  5   | import { PHARMACY_E2E, PHARMACY_E2E_EXPECTED } from './pharmacy-counter-fixture';
  6   | 
  7   | /**
  8   |  * PH-POS counter browser acceptance — POS-01, POS-02, POS-03, POS-08, POS-09.
  9   |  *
  10  |  * NO MOUSE. This file never calls `click`, `hover`, `tap`, `dblclick`, or
  11  |  * `dragTo`. Every interaction is `focus()` plus a key press, or a bare key
  12  |  * press against the document — which is exactly how a counter cashier works and
  13  |  * is what POS-01's "top-10 bills completed without a mouse" means. The final
  14  |  * test asserts that property against this file's own source, so a later edit
  15  |  * cannot quietly reintroduce a pointer.
  16  |  *
  17  |  * Three bills are completed from the counter corpus:
  18  |  *   1. Barcode scan → strip → cash → receipt (POS-02 scan, POS-03, POS-08)
  19  |  *   2. Name search → loose unit on a medicine with no strip level (POS-03)
  20  |  *   3. Urdu transliteration alias → whole pack (POS-02 alias path)
  21  |  *
  22  |  * A fourth test covers POS-09: a prescription-only line raises a safety block
  23  |  * that is visually and semantically distinct from advice and commercial
  24  |  * notices, refuses tender, and is cleared only by voiding — never by an
  25  |  * acknowledgement.
  26  |  */
  27  | 
  28  | test.describe.configure({ mode: 'serial' });
  29  | 
  30  | if (process.env.PHARMACY_E2E !== '1') throw new Error('PHARMACY_E2E=1 is required.');
  31  | 
  32  | /** Focus a control and activate it with the keyboard. Never a pointer. */
  33  | async function pressControl(target: Locator) {
  34  |   await target.focus();
  35  |   await expect(target).toBeFocused();
  36  |   await target.press('Enter');
  37  | }
  38  | 
  39  | async function signIn(page: Page) {
  40  |   await page.goto('/login');
  41  |   const email = page.getByLabel('Email');
  42  |   await email.focus();
  43  |   await email.fill(process.env.PHARMACY_E2E_ADMIN_EMAIL!);
  44  |   const password = page.getByRole('textbox', { name: 'Password' });
  45  |   await password.focus();
  46  |   await password.fill(process.env.PHARMACY_E2E_ADMIN_PASSWORD!);
  47  |   await pressControl(page.getByRole('button', { name: 'Sign in' }));
  48  | 
  49  |   // On a shared host the sign-in may land on the workspace chooser first.
  50  |   const chooser = page.getByText('Choose a workspace', { exact: true });
  51  |   const landed = page.locator('body');
  52  |   await expect(landed).toBeVisible();
  53  |   if (await chooser.isVisible({ timeout: 10_000 }).catch(() => false)) {
  54  |     await pressControl(page.getByRole('button', { name: /Fathom Pharmacy E2E/i }));
  55  |   }
> 56  |   await expect(page).toHaveURL(/\/(dashboard|pharmacy)/, { timeout: 30_000 });
      |                      ^ Error: expect(page).toHaveURL(expected) failed
  57  | }
  58  | 
  59  | async function openCounter(page: Page) {
  60  |   await signIn(page);
  61  |   await page.goto('/pharmacy/counter');
  62  |   await expect(page.getByRole('heading', { name: 'Counter', level: 1 })).toBeVisible();
  63  |   // The module is licensed by the seed, so the shell must render the counter
  64  |   // itself rather than the honest not-enabled panel.
  65  |   await expect(page.getByRole('heading', { name: 'This module is not enabled' })).toHaveCount(0);
  66  |   await expect(page.getByLabel('Scan or search')).toBeFocused();
  67  | }
  68  | 
  69  | test('pharmacy-only navigation exposes pharmacy destinations and excludes Restaurant routes', async ({
  70  |   page,
  71  | }) => {
  72  |   await signIn(page);
  73  |   const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
  74  |   await expect(navigation.getByRole('link', { name: 'Onboarding' })).toBeVisible();
  75  |   await expect(navigation.getByRole('link', { name: 'Counter' })).toBeVisible();
  76  |   await expect(navigation.getByRole('link', { name: 'Regulatory profile' })).toBeVisible();
  77  |   await expect(navigation.getByRole('link', { name: 'Point of sale' })).toHaveCount(0);
  78  |   await expect(navigation.getByRole('link', { name: 'Kitchen display' })).toHaveCount(0);
  79  |   await expect(navigation.getByRole('link', { name: 'Restaurant staff' })).toHaveCount(0);
  80  | });
  81  | 
  82  | /**
  83  |  * Cash tenders need an open drawer (POS-07), and every test that takes one must
  84  |  * open its own.
  85  |  *
  86  |  * The counter identifies its device by a `localStorage` key, so each test's
  87  |  * fresh browser context is a NEW counter device with no drawer session — the
  88  |  * drawer deliberately does not carry over from the previous bill's context.
  89  |  * Asserting the operator sentence rather than the reason code is the point: the
  90  |  * raw `DRAWER_NOT_OPEN` symbol must never reach the counter.
  91  |  */
  92  | async function openDrawer(page: Page) {
  93  |   await pressControl(page.getByRole('button', { name: 'Open drawer' }));
  94  |   await expect(
  95  |     page.getByRole('status').filter({ hasText: /Cash drawer opened for this counter/i })
  96  |   ).toBeVisible();
  97  |   await expect(page.getByText(/DRAWER_NOT_OPEN/)).toHaveCount(0);
  98  | }
  99  | 
  100 | async function search(page: Page, term: string) {
  101 |   // F2 is the POS-01 chord for the scan field; using it here proves the chord
  102 |   // works rather than merely that the field exists.
  103 |   await page.keyboard.press('F2');
  104 |   const field = page.getByLabel('Scan or search');
  105 |   await expect(field).toBeFocused();
  106 |   await field.fill(term);
  107 |   await field.press('Enter');
  108 | }
  109 | 
  110 | async function stageFirstResult(page: Page, medicineName: string) {
  111 |   const row = page
  112 |     .getByRole('list', { name: 'Search results' })
  113 |     .getByRole('button')
  114 |     .filter({ hasText: medicineName })
  115 |     .first();
  116 |   await expect(row).toBeVisible({ timeout: 15_000 });
  117 |   await pressControl(row);
  118 |   await expect(row).toHaveAttribute('aria-pressed', 'true');
  119 | }
  120 | 
  121 | async function setQuantity(page: Page, quantity: number) {
  122 |   const field = page.getByLabel('Quantity');
  123 |   await field.focus();
  124 |   await field.fill(String(quantity));
  125 |   // Blur via the keyboard so React commits the controlled value.
  126 |   await field.press('Tab');
  127 | }
  128 | 
  129 | async function tenderCash(page: Page, amount: string) {
  130 |   await page.keyboard.press('F9');
  131 |   const amountField = page.getByLabel('Amount');
  132 |   await amountField.focus();
  133 |   await amountField.fill(amount);
  134 |   const received = page.getByLabel('Cash received');
  135 |   await received.focus();
  136 |   await received.fill(amount);
  137 |   await pressControl(page.getByRole('button', { name: 'Take payment' }));
  138 | }
  139 | 
  140 | test('bill 1 — barcode scan, strip unit, cash tender and a bilingual receipt', async ({ page }) => {
  141 |   const otc = PHARMACY_E2E.medicines.otc;
  142 |   await openCounter(page);
  143 |   await openDrawer(page);
  144 | 
  145 |   // POS-02: a scanned barcode resolves to exactly one presentation.
  146 |   await search(page, otc.barcode);
  147 |   await stageFirstResult(page, otc.name);
  148 | 
  149 |   const row = page
  150 |     .getByRole('list', { name: 'Search results' })
  151 |     .getByRole('button')
  152 |     .filter({ hasText: otc.name })
  153 |     .first();
  154 |   // Every field POS-02 requires on the row.
  155 |   await expect(row).toContainText(otc.strength);
  156 |   await expect(row).toContainText(otc.presentation);
```