import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

import { PHARMACY_E2E } from './pharmacy-counter-fixture';

/**
 * DEV-957 phase 2 — an enrolled, prepared counter sells over-the-counter medicine for
 * cash with no network, and the sale survives the browser being closed. One persistent
 * profile plays "this computer": the owner enrols and prepares it online, the browser is
 * closed and opened again with the network cut, a cash sale is taken offline ("Paid" and
 * the leased receipt number appear only once it is saved), the browser is closed again,
 * and on reopening offline the sale is still queued with the same number and the next
 * sale takes the next one. Screenshots for the Studio visual QA matrix are written to
 * qa-evidence/dev-957-phase-2/.
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
  await expect(page.locator('[data-counter-offline-sale]')).toBeVisible({ timeout: 30_000 });
  return { context, page };
}

async function addTablets(page: Page, count: number) {
  const search = page.getByRole('searchbox', { name: 'Add a medicine to the offline bill' });
  await search.fill(otc.name.slice(0, 6));
  const results = page.getByRole('list', { name: 'Offline search results' });
  await expect(results.getByText(otc.name)).toBeVisible();
  for (let index = 0; index < count; index += 1)
    await results.getByRole('button', { name: 'Add tablet' }).click();
}

async function noDocumentOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
}

test('an offline cash sale is saved, survives closing the browser and takes the next number', async () => {
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
  // Online sales can no longer sell what was set aside for this counter; the page says so.
  await expect(page.getByText(/online sales at any counter cannot sell them either/)).toBeVisible();
  await expect(page.locator('[data-counter-revoke-rule]')).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/settings-counters-1440-light.png`, fullPage: true });

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
  await context.close();

  // Closed, then opened with no network at all.
  ({ context, page } = await openOffline());
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  // The last person is never presented as the one signed in now.
  await expect(page.getByText('Sign-in not checked')).toBeVisible();
  await expect(page.locator('[data-counter-offline-operator]')).toContainText(
    'who was signed in when this counter last connected'
  );
  await page.screenshot({ path: `${EVIDENCE}/counter-offline-empty-bill-1440-light.png`, fullPage: true });

  // A prescription-only medicine can never be added offline.
  const search = page.getByRole('searchbox', { name: 'Add a medicine to the offline bill' });
  await search.fill(rx.name.slice(0, 9));
  await expect(page.getByText(/never sold offline/)).toBeVisible();
  await search.press('Escape');
  await expect(search).toHaveValue('');

  await addTablets(page, 2);
  const bill = page.getByRole('list', { name: 'Offline bill lines' });
  await expect(bill.getByText(otc.name)).toBeVisible();
  // Two tablets of a 250.00 box of 100.
  await expect(page.getByRole('button', { name: 'Take cash Rs 5.00' })).toBeDisabled();
  const cash = page.getByLabel(/Cash received/);
  await cash.fill('5.005');
  await expect(page.getByText('Use at most 2 decimal places, for example 125.50.')).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/counter-offline-cash-error-1440-light.png`, fullPage: true });
  await cash.fill('10');
  await expect(page.getByText('Rs 5.00').last()).toBeVisible();

  // The bill being built survives a reload.
  await page.reload();
  await expect(page.getByRole('list', { name: 'Offline bill lines' }).getByText(otc.name)).toBeVisible({
    timeout: 30_000,
  });
  await page.getByLabel(/Cash received/).fill('10');
  await page.screenshot({ path: `${EVIDENCE}/counter-offline-bill-1440-light.png`, fullPage: true });

  await page.getByRole('button', { name: 'Take cash Rs 5.00' }).click();
  const paid = page.locator('[data-counter-offline-paid]');
  await expect(paid.getByText('Paid', { exact: true })).toBeVisible({ timeout: 30_000 });
  const receiptText = (await paid.getByText(/^Receipt \d+/).textContent()) ?? '';
  const receiptNumber = Number(/Receipt (\d+)/.exec(receiptText)?.[1]);
  expect(Number.isSafeInteger(receiptNumber)).toBe(true);
  const queue = page.locator('[data-counter-offline-queue]');
  await expect(queue.getByRole('cell', { name: String(receiptNumber), exact: true })).toBeVisible();
  await expect(queue.getByText('Waiting to send').first()).toBeVisible();
  await noDocumentOverflow(page);

  // The Studio visual QA matrix, on the paid state.
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
        path: `${EVIDENCE}/counter-offline-paid-${width}-${theme}${reduce ? '-reduced' : ''}.png`,
        fullPage: true,
      });
      // The app canvas scrolls inside its shell, so the sale panel is captured on its own too.
      await page.locator('[data-counter-offline-sale]').screenshot({
        path: `${EVIDENCE}/counter-offline-sale-panel-${width}-${theme}${reduce ? '-reduced' : ''}.png`,
      });
    }
  }
  await page.evaluate(() => {
    window.localStorage.setItem('theme', 'light');
    document.documentElement.setAttribute('data-theme', 'light');
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // Keyboard: the next customer, then the search, are reachable with a visible focus ring.
  await page.getByRole('button', { name: 'Next customer' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('searchbox', { name: 'Add a medicine to the offline bill' }).focus();
  await page.screenshot({ path: `${EVIDENCE}/counter-offline-keyboard-focus-1440-light.png` });

  // Errors logged by the page itself (requests refused by the cut network are the browser's).
  expect(
    consoleErrors.filter((text) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource|Failed to fetch/i.test(text))
  ).toEqual([]);
  await context.close();

  // Closed again, reopened still offline: the sale is still queued with its number.
  ({ context, page } = await openOffline());
  const reopenedQueue = page.locator('[data-counter-offline-queue]');
  await expect(
    reopenedQueue.getByRole('cell', { name: String(receiptNumber), exact: true })
  ).toBeVisible();
  await addTablets(page, 1);
  await page.getByLabel(/Cash received/).fill('2.50');
  await page.getByRole('button', { name: 'Take cash Rs 2.50' }).click();
  const next = page.locator('[data-counter-offline-paid]');
  await expect(next.getByText(`Receipt ${receiptNumber + 1}`, { exact: false })).toBeVisible({
    timeout: 30_000,
  });
  await expect(reopenedQueue.getByRole('row')).toHaveCount(3);
  await page.screenshot({ path: `${EVIDENCE}/counter-offline-two-queued-1440-light.png`, fullPage: true });
  await context.close();
});
