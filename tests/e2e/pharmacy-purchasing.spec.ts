import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fixtureTotp } from '../fixtures/restaurant-totp';
import { FIXTURE } from './pharmacy-purchasing-fixture';

/**
 * WHA-1196 — the PH-PUR browser acceptance: PO → receive → exception → resolve
 * → stock visible, walked through the surface rather than through the router.
 *
 * The point of doing this in a browser at all is that every previous UI defect
 * on this product was *correct data presented misleadingly* — a working button
 * that looked dead, a detail rendered below the fold, a selection silently
 * reassigned. None of those are visible to a unit test that renders a component
 * and asserts on its props, so this spec operates the console the way the
 * goods-in bench does: it reads what the page says, clicks what a person would
 * click, and checks that the number it was shown is the number that landed.
 *
 * Serial and single-worker by config: the fixture is one purchase order, and a
 * second worker receiving against it concurrently would be testing the seed
 * rather than the surface.
 */

const ROUTE = '/pharmacy/purchasing';

/**
 * The seed writes a run-unique purchase order and leaves its reference here.
 * Reading it beats hard-coding one: receiving is cumulative, so a reused order
 * would show a different outstanding balance on every run.
 */
function seededPurchaseOrder(): string {
  const handle = path.join(
    'playwright-artifacts',
    'pharmacy-purchasing-fixture',
    'fixture-handle.json'
  );
  try {
    return JSON.parse(readFileSync(handle, 'utf8')).purchaseOrderReference as string;
  } catch {
    throw new Error(
      `Run tests/e2e/pharmacy-purchasing-seed.ts before this lane — ${handle} is missing.`
    );
  }
}

/**
 * A reference unique to this run. References identify one document per
 * organization, so the run stamp the seed already generated is reused rather
 * than invented again — that keeps the receipt, its invoice and its batch
 * traceable back to the purchase order they belong to.
 */
function reference(prefix: string, testInfo: { workerIndex: number }): string {
  const stamp = seededPurchaseOrder().split('-').pop() ?? 'local';
  return `${prefix}-${testInfo.workerIndex}-${stamp}`;
}

/**
 * The tenant shell wraps every page in `PageTransition`, a Motion component
 * that briefly mounts a second, `aria-hidden` copy of the route while the enter
 * animation runs. That copy is invisible to assistive technology and settles on
 * its own, but Playwright's strict mode counts DOM nodes rather than
 * accessibility-tree nodes and fails instantly on the transient pair. Reading
 * the first match asserts on what the operator sees without waiting on an
 * animation frame — and the duplicate is chrome, not a defect in these surfaces.
 */
function shellText(page: Page, text: string | RegExp) {
  return page.getByText(text).first();
}

test('the overview reports a workspace that is ready to receive', async ({ page }) => {
  await page.goto(ROUTE);

  await expect(
    page.getByRole('heading', { level: 1, name: 'Purchasing & receiving' }).first()
  ).toBeVisible();
  // Every PUR gate is satisfied by the fixture, so the setup checklist is
  // absent rather than showing four green rows nobody needs to read.
  await expect(page.getByText(/still to set up/)).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Goods in/ }).first()).toBeVisible();
});

test('PO → receive → exception → resolve → stock visible', async ({ page }, testInfo) => {
  const purchaseOrderReference = seededPurchaseOrder();
  const receiptReference = reference(FIXTURE.receipt.reference, testInfo);
  const invoiceReference = reference(FIXTURE.receipt.invoiceRef, testInfo);
  const batchNumber = reference(FIXTURE.delivery.batchNumber, testInfo);

  // ── 1. the bench opens on the branch, without being asked for an id ──────
  await page.goto(`${ROUTE}/receiving`);
  await expect(page.getByRole('heading', { level: 1, name: 'Goods in' }).first()).toBeVisible();
  await expect(shellText(page, `Receiving into ${FIXTURE.branch.name}`)).toBeVisible();

  // ── 2. pick the sent purchase order ─────────────────────────────────────
  await page
    .getByLabel('Purchase order')
    .first()
    .selectOption({ label: `${purchaseOrderReference} — ${FIXTURE.supplier.name} (1 lines)` });
  await page.getByRole('button', { name: 'Open order', exact: true }).first().click();

  const capture = page
    .getByRole('group', { name: new RegExp(FIXTURE.medicine.productName) })
    .first();
  await expect(capture).toBeVisible();
  // UX rule 1: the pack conversion is stated, never asked for.
  await expect(
    capture.getByText(`1 pack = ${FIXTURE.purchaseOrder.unitsPerPack} units`)
  ).toBeVisible();
  // The outstanding balance is worked out for the operator, not by them.
  await expect(capture.getByText(/outstanding 100 units/)).toBeVisible();

  // ── 3. capture what actually arrived: 7 packs against 10 ordered ────────
  await page.getByLabel('Receipt reference').first().fill(receiptReference);
  await page.getByLabel('Supplier invoice number').first().fill(invoiceReference);
  await page.getByLabel('Warranty / source evidence').first().fill(FIXTURE.receipt.warrantyRef);

  await capture.getByLabel('Batch number').fill(batchNumber);
  await capture.getByLabel('Printed expiry').fill('2028-06-30');
  await capture.getByLabel('Expiry precision').selectOption('MONTH');
  await capture.getByLabel('Printed MRP (PKR)').fill('320.00');
  await capture.getByLabel('Packs received').fill(String(FIXTURE.delivery.receivedPacks));
  await capture.getByLabel('Invoiced price / pack (PKR)').fill('250.00');
  await capture.getByLabel('Receive into').selectOption({ label: `${FIXTURE.shelf.name} (STORE)` });

  await page.getByRole('button', { name: 'File receipt (draft)' }).first().click();

  // UX rule 9 and rule 2: the outcome is stated at the top of the surface, in
  // words, inside the viewport — not implied by a silent re-render.
  const filed = page.getByRole('status').filter({ hasText: 'drafted' }).first();
  await expect(filed).toBeVisible({ timeout: 20_000 });
  await expect(filed).toContainText('Nothing is in stock until you post it');
  await page.getByRole('link', { name: 'View saved record', exact: true }).click();

  // ── 4. the draft is selected and posts into the ledger ──────────────────
  const receiptPanel = page.getByRole('heading', { level: 2, name: receiptReference }).first();
  await expect(receiptPanel).toBeVisible();
  await page.getByRole('button', { name: 'Post into stock' }).first().click();

  const posted = page.getByRole('status').filter({ hasText: 'Receipt posted' }).first();
  await expect(posted).toBeVisible({ timeout: 20_000 });
  // PUR-04: the shortage is announced at the moment it is raised.
  await expect(posted).toContainText('match exception');
  await page.getByRole('link', { name: 'View saved record', exact: true }).click();

  // ── 5. the exception is in the queue, quantified, and stays there ────────
  const queue = page.getByRole('heading', { level: 2, name: /Match exceptions — open/ }).first();
  await expect(queue).toBeVisible();
  const exception = page
    .getByRole('listitem')
    .filter({ hasText: `batch ${batchNumber}` })
    .first();
  await expect(exception).toContainText('SHORTAGE');
  // 10 packs ordered × 10 units, 7 packs × 10 units received.
  await expect(exception).toContainText('expected 100 units, observed 70');

  // ── 6. resolving it needs a note, and records one ───────────────────────
  await exception
    .getByLabel('How was this settled?')
    .fill('Supplier confirmed a short ship; balance cancelled.');
  await exception.getByRole('button', { name: 'Resolve' }).click();

  const resolved = page.getByRole('status').filter({ hasText: 'Exception resolved' }).first();
  // A Server Function that redirects re-renders the whole surface, which is
  // slower than an assertion default on a route being hit for the first time.
  await expect(resolved).toBeVisible({ timeout: 20_000 });
  await expect(resolved).toContainText('quantities it recorded are unchanged');
  await page.getByRole('link', { name: 'View saved record', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 2, name: /Match exceptions — open \(0\)/ }).first()
  ).toBeVisible();

  // ── 7. the stock is visible, read back from the batch ledger ────────────
  await expect(
    page.getByRole('heading', { level: 2, name: receiptReference }).first()
  ).toBeVisible();
  await expect(shellText(page, 'Stock produced')).toBeVisible();
  await expect(
    shellText(
      page,
      new RegExp(`${FIXTURE.medicine.productName}.*batch ${batchNumber}.*batch ledger`)
    )
  ).toBeVisible();
  // The accepted units landed on the shelf, at the pack conversion the picker stated.
  await expect(shellText(page, `Accepted 70 units into ${FIXTURE.shelf.name}`)).toBeVisible();
});

test('the resolved exception is kept with the note that closed it', async ({ page }) => {
  await page.goto(`${ROUTE}/receiving`);
  await page.getByRole('link', { name: 'Show resolved' }).first().click();

  await expect(
    page.getByRole('heading', { level: 2, name: /Match exceptions — resolved/ }).first()
  ).toBeVisible();
  await expect(
    shellText(page, 'Supplier confirmed a short ship; balance cancelled.')
  ).toBeVisible();
});

test('PUR-01 offers an unauthorized supplier as an explained, unselectable option', async ({
  page,
}, testInfo) => {
  // A throwaway supplier rather than the fixture's: a test that mutates the
  // fixture and then fails halfway leaves the next run starting from a state
  // nobody chose, which is how a suite starts "failing" for reasons that are
  // not the product's.
  const name = `Lapsed Distributors ${testInfo.workerIndex}-${Date.now()}`;
  await page.goto(`${ROUTE}/suppliers`);
  await page.getByLabel('Trading name').first().fill(name);
  await page.getByRole('button', { name: 'Add supplier' }).first().click();

  // A new supplier starts unauthorized and unlicensed, which is the PUR-01 gate
  // and not a missing step — the surface says exactly that.
  const added = page.getByRole('status').filter({ hasText: 'added' }).first();
  await expect(added).toBeVisible({ timeout: 20_000 });
  await expect(added).toContainText('Record a verified licence before ordering from it');
  await page.getByRole('link', { name: 'View saved record', exact: true }).click();
  await expect(shellText(page, 'Trade with this supplier is not authorized')).toBeVisible();

  await page.goto(`${ROUTE}/orders`);
  const option = page.getByRole('option', { name: `${name} — not authorized` }).first();
  await expect(option).toHaveCount(1);
  await expect(option).toBeDisabled();
  // The licensed fixture supplier is still selectable beside it, so this is the
  // eligibility rule and not an empty picker.
  await expect(page.getByRole('option', { name: FIXTURE.supplier.name }).first()).toBeEnabled();
});

test('PUR-05 never offers the receiver as their own bypass approver', async ({ page }) => {
  await page.goto(`${ROUTE}/receiving`);

  const approver = page.getByLabel('Approved by').first();
  await expect(approver).toBeVisible();
  await expect(
    approver.getByRole('option', { name: new RegExp(FIXTURE.approver.email) })
  ).toHaveCount(1);
  await expect(
    approver.getByRole('option', { name: new RegExp(FIXTURE.receiver.email) })
  ).toHaveCount(0);
  await expect(
    shellText(
      page,
      'A second approver is required unless you are the sole active owner at this branch.'
    )
  ).toBeVisible();
  await expect(page.getByLabel('Approver PIN', { exact: true })).toHaveAttribute(
    'type',
    'password'
  );
});

test('a validation failure names its field, focuses it, and keeps the rest valid', async ({
  page,
}) => {
  await page.goto(`${ROUTE}/suppliers?supplier=${await firstSupplierId(page)}`);

  // A licence that expires before it was issued passes every client-side
  // constraint the form can express and is refused by the schema. UX rule 11:
  // the operator has to be told which field and what the fix is, beside the
  // field — not in a network response.
  await page.getByLabel('Licence type').first().fill('Drug sale licence');
  await page.getByLabel('Licence number').first().fill('DSL-INVALID-1');
  await page.getByLabel('Issuing authority').first().fill('DRAP');
  await page.getByLabel('Issued on').first().fill('2027-01-01');
  await page.getByLabel('Expires on').first().fill('2026-01-01');
  await page.getByRole('button', { name: 'File licence' }).first().click();

  // The refusal arrives as a Server Function redirect, so wait for the notice
  // before reading the field it names.
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'A licence must expire after it was issued.' })
      .first()
  ).toBeVisible({ timeout: 20_000 });

  const expires = page.getByLabel('Expires on').first();
  await expect(expires).toHaveAttribute('aria-invalid', 'true');
  const errorIds = (await expires.getAttribute('aria-describedby'))?.split(/\s+/) ?? [];
  expect(errorIds.length).toBeGreaterThan(0);
  await expect(page.locator(`[id="${errorIds.at(-1)}"]`)).toContainText(
    'Expires at: A licence must expire after it was issued.'
  );
  await expect(expires).toBeFocused();
  // One failure does not paint the whole form red.
  await expect(page.getByLabel('Licence number').first()).toHaveAttribute('aria-invalid', 'false');
});

/** The fixture supplier's id, read off the register rather than hard-coded. */
async function firstSupplierId(page: Page): Promise<string> {
  await page.goto(`${ROUTE}/suppliers`);
  const href = await page
    .getByRole('link', { name: new RegExp(FIXTURE.supplier.name) })
    .first()
    .getAttribute('href');
  const id = new URL(href ?? '', 'http://placeholder').searchParams.get('supplier');
  if (!id) throw new Error('The supplier register did not link to the fixture supplier.');
  return id;
}

test('an outside supplier confirms one order, proposes a date and attaches a PDF', async ({
  page,
  browser,
  baseURL,
}) => {
  const fixture = JSON.parse(
    readFileSync(
      path.join('playwright-artifacts', 'pharmacy-purchasing-fixture', 'fixture-handle.json'),
      'utf8'
    )
  );
  const status = await page.request.get('/api/trpc/approvalAuthenticator.getStatus');
  expect(status.status()).toBe(200);
  if ((await status.json()).result.data.json.setupRequired) {
    const begin = await page.request.post('/api/trpc/approvalAuthenticator.beginEnrollment', {
      data: { json: { currentPassword: FIXTURE.receiver.password } },
    });
    expect(begin.status()).toBe(200);
    const secret = (await begin.json()).result.data.json.secret;
    const confirmed = await page.request.post('/api/trpc/approvalAuthenticator.confirmEnrollment', {
      data: { json: { token: fixtureTotp(secret) } },
    });
    expect(confirmed.status()).toBe(200);
  }
  const issue = await page.request.post('/api/trpc/pharmacySupplierLinks.issue', {
    data: {
      json: { ...fixture.supplierOrder, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
      meta: { values: { expiresAt: ['Date'] } },
    },
  });
  expect(issue.status()).toBe(200);
  const token = (await issue.json()).result.data.json.token;
  const shortExpiry = new Date(Date.now() + 10_000);
  const shortLink = await page.request.post('/api/trpc/pharmacySupplierLinks.issue', {
    data: {
      json: { ...fixture.supplierOrder, expiresAt: shortExpiry.toISOString() },
      meta: { values: { expiresAt: ['Date'] } },
    },
  });
  expect(shortLink.status()).toBe(200);
  const expiringToken = (await shortLink.json()).result.data.json.token;
  const guest = await browser.newContext({ baseURL, viewport: { width: 375, height: 812 } });
  try {
    const supplier = await guest.newPage();
    const errors: string[] = [];
    supplier.on('pageerror', (error) => errors.push(error.name));
    supplier.on('console', (entry) => {
      if (entry.type() === 'error') errors.push('console error');
    });
    await supplier.goto('/supplier/po/' + token);
    await expect(supplier.getByRole('heading', { level: 1 })).toHaveText(
      'Purchase order ' + fixture.purchaseOrderReference
    );
    await expect(supplier.getByText(FIXTURE.medicine.productName, { exact: false })).toBeVisible();
    for (const theme of ['light', 'dark']) {
      await supplier.evaluate((value) => {
        localStorage.setItem('theme', value);
        window.dispatchEvent(new Event('storage'));
      }, theme);
      await expect(supplier.locator('html')).toHaveAttribute('data-theme', theme);
      for (const width of [375, 768, 1024, 1440]) {
        await supplier.setViewportSize({ width, height: 812 });
        for (const reducedMotion of ['reduce', 'no-preference'] as const) {
          await supplier.emulateMedia({ reducedMotion });
          expect(
            await supplier.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
          ).toBe(true);
        }
      }
    }
    await supplier.setViewportSize({ width: 375, height: 812 });
    const confirm = supplier.getByRole('button', { name: 'Confirm order', exact: true });
    await supplier.getByRole('spinbutton').focus();
    await supplier.keyboard.press('Tab');
    await expect(confirm).toBeFocused();
    await expect(supplier.getByRole('button', { name: 'Send delivery date' })).toBeDisabled();
    await supplier.getByRole('button', { name: 'Decline order', exact: true }).click();
    const cancel = supplier.getByRole('button', { name: 'Cancel', exact: true });
    await cancel.focus();
    await supplier.keyboard.press('Escape');
    await expect(cancel).toHaveCount(0);
    await confirm.click();
    await expect(supplier.getByRole('status')).toHaveText(
      'Response sent. The pharmacy will review it.'
    );
    await supplier.getByLabel('Estimated arrival').fill('2030-06-18T15:30');
    const saved = supplier.waitForResponse(
      (res) =>
        res.url().includes('pharmacySupplierLinks.submit') && res.request().method() === 'POST'
    );
    await supplier.getByRole('button', { name: 'Send delivery date' }).click();
    expect((await saved).status()).toBe(200);
    await supplier.getByLabel('Supporting document').setInputFiles({
      name: 'invoice.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7\n%%EOF'),
    });
    await expect(supplier.getByRole('status')).toHaveText('Document sent to the pharmacy.');
    await expect(supplier.getByRole('link', { name: /download/i })).toHaveCount(0);
    expect(errors).toEqual([]);
    const revoke = await page.request.post('/api/trpc/pharmacySupplierLinks.revoke', {
      data: { json: { linkId: token.split('.')[0] } },
    });
    expect(revoke.status()).toBe(200);
    await supplier.reload();
    await expect(supplier.getByRole('heading', { level: 1 })).toHaveText('This link is not valid');
    expect(await supplier.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );

    await expect.poll(() => Date.now()).toBeGreaterThanOrEqual(shortExpiry.getTime());
    const invalidPages: string[] = [];
    for (const invalidToken of [expiringToken, 'synthetic-unknown-supplier-link']) {
      const lookup = supplier.waitForResponse((res) =>
        res.url().includes('/api/trpc/pharmacySupplierLinks.get')
      );
      await supplier.goto('/supplier/po/' + invalidToken);
      expect((await lookup).status()).toBe(404);
      await expect(supplier.getByRole('heading', { level: 1 })).toHaveText(
        'This link is not valid'
      );
      invalidPages.push(await supplier.locator('main').innerText());
    }
    expect(invalidPages[0]).toBe(invalidPages[1]);
  } finally {
    await guest.close();
  }
});
