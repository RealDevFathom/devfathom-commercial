import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

import { PHARMACY_E2E } from './pharmacy-counter-fixture';

/**
 * DEV-957 phase 2 — offline cash selling is OFF in the product until sending offline sales
 * to the server is ready (review B1), and nobody can switch it on. One persistent profile
 * plays "this computer": the owner enrols and prepares it online and sees the switch off
 * (and not available), the browser is closed and opened again with the network cut, and
 * the counter works as a price check only, exactly as after phase 1: it lists what it holds
 * offline stock for, never a prescription-only medicine, and offers no offline bill and no
 * "Take cash". Closed and reopened offline it is still a price check. The selling code
 * itself is tested with the switch forced on (counter-offline-sale.test.ts,
 * use-counter-offline-sale.test.tsx, pharmacy-offline-phase2.db.test.ts). Screenshots for
 * the Studio visual QA matrix are written to qa-evidence/dev-957-phase-2/.
 */

const baseURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? 4331}`;
const otc = PHARMACY_E2E.medicines.otc;
const rx = PHARMACY_E2E.medicines.rx;
const EVIDENCE = 'qa-evidence/dev-957-phase-2';

let profile = '';
test.beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), 'pharmacy-counter-offline-sale-'));
  await mkdir(EVIDENCE, { recursive: true });
});
test.afterAll(async () => {
  if (profile) await rm(profile, { recursive: true, force: true });
});

function open(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profile, {
    baseURL,
    viewport: { width: 1440, height: 900 },
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
}

async function signIn(page: Page) {
  await page.goto('/login');
  await expect(async () => {
    const password = page.getByRole('textbox', { name: 'Password' });
    if ((await password.getAttribute('type')) === 'password')
      await page.getByRole('button', { name: 'Show password' }).click();
    await expect(password).toHaveAttribute('type', 'text');
  }).toPass({ timeout: 15_000 });
  await page.getByLabel('Email').fill(process.env.PHARMACY_E2E_ADMIN_EMAIL!);
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.PHARMACY_E2E_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const chooser = page.getByText('Choose a workspace', { exact: true });
  if (await chooser.isVisible({ timeout: 10_000 }).catch(() => false))
    await page.getByRole('button', { name: /Fathom Pharmacy E2E/i }).click();
  await expect(page).toHaveURL(/\/(dashboard|pharmacy)/, { timeout: 30_000 });
}

async function openOffline(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await open();
  // Cut the network for every page and the counter's service worker: offline emulation
  // alone does not reach a persistent profile's first page or service-worker fetches.
  await context.route('**/*', (route) => route.abort('internetdisconnected'));
  await context.setOffline(true);
  const page = await context.newPage();
  for (const other of context.pages()) if (other !== page) await other.close();
  await page.goto('/pharmacy/counter');
  await expect(page.locator('[data-counter-offline-mode="ready"]')).toBeVisible({ timeout: 30_000 });
  return { context, page };
}

async function noDocumentOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
}

test('with offline cash selling off, a prepared counter checks prices offline and takes no cash', async () => {
  test.setTimeout(300_000);
  let context = await open();
  let page = context.pages()[0] ?? (await context.newPage());
  await signIn(page);

  await page.goto('/pharmacy/settings/counters');
  await page.getByLabel('Counter name').fill('Front counter E2E phase 2');
  await page.getByRole('button', { name: 'Enrol this computer' }).click();
  await expect(page.getByText(/This computer is now the counter Front counter E2E phase 2/)).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Prepare this counter for offline' }).click();
  await expect(page.getByText(/This counter now holds 200 receipt numbers/)).toBeVisible({
    timeout: 60_000,
  });
  // What is set aside for this counter is safe from every online path; the page says so.
  await expect(
    page.getByText(/online sales at any counter, transfers to another branch, supplier claims and/)
  ).toBeVisible();
  await expect(page.locator('[data-counter-revoke-rule]')).toContainText('Sales to reconcile');
  // The owner's switch: off, and it cannot be switched on in this version.
  const selling = page.locator('[data-counter-offline-selling]');
  await expect(selling.getByRole('switch', { name: 'Offline cash selling' })).toBeDisabled();
  await expect(selling.getByRole('switch', { name: 'Offline cash selling' })).not.toBeChecked();
  await expect(selling).toContainText('Available when sending offline sales is ready.');
  await page.screenshot({ path: `${EVIDENCE}/settings-counters-1440-light.png`, fullPage: true });
  await selling.screenshot({ path: `${EVIDENCE}/settings-offline-selling-switch-1440-light.png` });

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
  // Nothing waits on this computer, so neither list is shown online.
  await expect(page.locator('[data-counter-sales-to-reconcile]')).toHaveCount(0);
  await expect(page.locator('[data-counter-offline-waiting-online]')).toHaveCount(0);
  await context.close();

  // Closed, then opened with no network at all.
  ({ context, page } = await openOffline());
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  // The last person is never presented as the one signed in now.
  await expect(page.getByText('Sign-in not checked')).toBeVisible();
  const panel = page.locator('[data-counter-offline-mode="ready"]');
  await expect(panel).toContainText('price check of the');
  await expect(panel.locator('[data-counter-offline-selling="off"]')).toContainText(
    'Offline cash selling is off:'
  );
  // No offline bill, no cash.
  await expect(page.locator('[data-counter-offline-sale]')).toHaveCount(0);
  await expect(page.getByRole('searchbox', { name: 'Add a medicine to the offline bill' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Take cash/ })).toHaveCount(0);

  // The price check lists what this counter holds, never a prescription-only medicine.
  const check = page.getByRole('searchbox', { name: 'Offline price check' });
  await check.fill(rx.name.slice(0, 9));
  await expect(page.getByText(/Prescription-only,\s+controlled and restricted medicines are never listed offline/)).toBeVisible();
  await check.press('Escape');
  await expect(check).toHaveValue('');
  await check.fill(otc.name.slice(0, 6));
  const results = page.getByRole('list', { name: 'Offline price check results' });
  await expect(results.getByText(otc.name)).toBeVisible();
  await noDocumentOverflow(page);

  // The Studio visual QA matrix, on the offline price-check state.
  for (const [width, height] of [
    [375, 812],
    [768, 1024],
    [1024, 768],
    [1440, 900],
  ] as const) {
    for (const theme of ['light', 'dark'] as const) {
      const reduce = width === 375 || width === 1024;
      await page.emulateMedia({ reducedMotion: reduce ? 'reduce' : 'no-preference' });
      await page.setViewportSize({ width, height });
      await page.evaluate((value) => {
        window.localStorage.setItem('theme', value);
        document.documentElement.setAttribute('data-theme', value);
      }, theme);
      await noDocumentOverflow(page);
      await page.screenshot({
        path: `${EVIDENCE}/counter-offline-selling-off-${width}-${theme}${reduce ? '-reduced' : ''}.png`,
        fullPage: true,
      });
      await page.locator('[data-counter-offline]').screenshot({
        path: `${EVIDENCE}/counter-offline-banner-${width}-${theme}${reduce ? '-reduced' : ''}.png`,
      });
    }
  }
  await page.evaluate(() => {
    window.localStorage.setItem('theme', 'light');
    document.documentElement.setAttribute('data-theme', 'light');
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // Keyboard: the price check is reachable, with a visible focus ring.
  await check.focus();
  await page.screenshot({ path: `${EVIDENCE}/counter-offline-keyboard-focus-1440-light.png` });

  // Errors logged by the page itself (requests refused by the cut network are the browser's).
  expect(
    consoleErrors.filter((text) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource|Failed to fetch/i.test(text))
  ).toEqual([]);
  await context.close();

  // Closed again, reopened still offline: still a price check, still no cash.
  ({ context, page } = await openOffline());
  await expect(page.getByRole('searchbox', { name: 'Offline price check' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Take cash/ })).toHaveCount(0);
  await context.close();

  // Sales to reconcile (review B2): the unsent sale a revoked counter kept on this computer,
  // written exactly as the runtime keeps it, is listed online, read-only, and exported; a
  // record for a counter the server does not know is refused and the sale stays.
  context = await open();
  page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`/pharmacy/counter?branchId=${PHARMACY_E2E.branchId}`);
  await expect(page.getByRole('heading', { name: 'Counter', level: 1 })).toBeVisible();
  await page.evaluate(async (branchId) => {
    const enrolment = JSON.parse(
      window.localStorage.getItem('devfathom.pharmacy.counter.enrolled') ?? '{}'
    ) as { organizationId: string };
    const scope = { organizationId: enrolment.organizationId, branchId, deviceId: 'retired_e2e_counter' };
    const recordKey = `${scope.organizationId}::${scope.branchId}::${scope.deviceId}::reconcile`;
    const soldAt = new Date(Date.now() - 3_600_000).toISOString();
    const record = {
      kind: 'pharmacy-counter-reconcile',
      version: 1,
      scope,
      counterName: 'Old till',
      retiredAt: new Date().toISOString(),
      reason: 'REVOKED',
      sales: [
        {
          commandId: 'kept_e2e_sale',
          idempotencyKey: 'kept_e2e_sale',
          sequence: 1,
          action: 'CASH_OTC_SALE',
          payload: {
            amountMinor: 500,
            cashReceivedMinor: 1_000,
            lines: [{ medicineId: 'med_e2e', saleUnit: 'UNIT', quantity: 2 }],
            snapshots: [],
            seal: { previousHash: null, lineTotalsMinor: [500], signature: '0'.repeat(64) },
          },
          clientOriginAt: soldAt,
          receiptNumber: 9_001,
          status: 'PENDING',
          attempts: 0,
          serverRef: null,
          rejection: null,
          sealHash: 'a'.repeat(64),
        },
      ],
      snapshotArchive: [],
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('devfathom-pharmacy-counter', 2);
      request.onupgradeneeded = () => request.result.createObjectStore('scope-state');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('scope-state', 'readwrite');
      tx.objectStore('scope-state').put(record, recordKey);
      tx.objectStore('scope-state').put(
        {
          kind: 'pharmacy-counter-reconcile-index',
          entries: [{ recordKey, ...scope, counterName: 'Old till', retiredAt: record.retiredAt }],
        },
        'pharmacy-counter-reconcile-index'
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, PHARMACY_E2E.branchId);
  await page.reload();
  const reconcile = page.locator('[data-counter-sales-to-reconcile]');
  await expect(reconcile.getByRole('heading', { name: 'Sales to reconcile (1)' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(reconcile).toContainText('Receipt 9001');
  await expect(reconcile).toContainText('Counter Old till');
  await expect(reconcile.getByText('Not booked').first()).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    reconcile.getByRole('button', { name: 'Export (CSV)' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('offline-sales-to-reconcile-receipts-9001-9001.csv');
  for (const [width, height] of [
    [375, 812],
    [1440, 900],
  ] as const) {
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate((value) => {
        window.localStorage.setItem('theme', value);
        document.documentElement.setAttribute('data-theme', value);
      }, theme);
      await noDocumentOverflow(page);
      await reconcile.screenshot({ path: `${EVIDENCE}/counter-sales-to-reconcile-${width}-${theme}.png` });
    }
  }
  await page.evaluate(() => {
    window.localStorage.setItem('theme', 'light');
    document.documentElement.setAttribute('data-theme', 'light');
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await reconcile.getByRole('button', { name: 'Record what was done' }).click();
  await reconcile.getByLabel('Note').fill('Entered as bill 4512');
  await reconcile.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(reconcile.getByRole('alert')).toContainText(
    'The server does not know this counter at this branch.'
  );
  await expect(reconcile).toContainText('Receipt 9001');
  await reconcile.screenshot({ path: `${EVIDENCE}/counter-sales-to-reconcile-record-1440-light.png` });
  await context.close();
});
