import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

import { PHARMACY_E2E } from './pharmacy-counter-fixture';

/**
 * DEV-957 phase 1 — an enrolled counter opens with no network after the browser
 * was closed. One persistent browser profile plays "this computer": the owner
 * enrols it and prepares it for offline, the counter page stores its offline
 * shell, the browser is closed, and it is opened again with the network cut.
 * The counter then shows the Offline banner and the last verified price list,
 * and the prescription-only medicine is never offered offline.
 */

const baseURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? 4331}`;
const otc = PHARMACY_E2E.medicines.otc;
const rx = PHARMACY_E2E.medicines.rx;

let profile = '';
test.beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), 'pharmacy-counter-offline-'));
});
test.afterAll(async () => {
  if (profile) await rm(profile, { recursive: true, force: true });
});

function open(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profile, {
    baseURL,
    viewport: { width: 1440, height: 900 },
    // Optional: a preinstalled Chromium when the lane's own browser is not downloaded.
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

test('an enrolled, prepared counter opens offline after the browser was closed', async () => {
  test.setTimeout(240_000);
  let context = await open();
  let page = context.pages()[0] ?? (await context.newPage());
  await signIn(page);

  await page.goto('/pharmacy/settings/counters');
  await expect(page.getByRole('heading', { name: 'Counter computers', level: 1 })).toBeVisible();
  await page.getByLabel('Counter name').fill('Front counter E2E');
  await page.getByRole('button', { name: 'Enrol this computer' }).click();
  await expect(page.getByText(/This computer is now the counter Front counter E2E/)).toBeVisible({
    timeout: 30_000,
  });
  // The device secret is in no script-readable storage after enrolment.
  const readable = await page.evaluate(() => JSON.stringify({ ...window.localStorage }));
  expect(readable).not.toMatch(/pcd_/);
  expect(await page.evaluate(() => document.cookie)).not.toMatch(/df_pharmacy_counter_device/);

  await page.getByRole('button', { name: 'Prepare this counter for offline' }).click();
  await expect(page.getByText(/This counter now holds 200 receipt numbers/)).toBeVisible({
    timeout: 60_000,
  });

  await page.goto(`/pharmacy/counter?branchId=${PHARMACY_E2E.branchId}`);
  await expect(page.getByRole('heading', { name: 'Counter', level: 1 })).toBeVisible();
  // The counter stores its offline shell once it has verified the snapshots.
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

  // Close the browser, then open it again with no network at all.
  await context.close();
  context = await open();
  await context.setOffline(true);
  page = context.pages()[0] ?? (await context.newPage());
  await page.goto('/pharmacy/counter');

  const banner = page.locator('[data-counter-offline]').first();
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(banner.getByText('Offline', { exact: true })).toBeVisible();
  await expect(banner.getByText('Offline — this counter cannot reach the server.')).toBeVisible();
  await expect(banner.getByText(/Still works:/)).toBeVisible();
  await expect(banner.getByText(/Receipt numbers left/)).toBeVisible();

  const priceCheck = page.getByRole('searchbox', { name: 'Offline price check' });
  await priceCheck.fill(otc.name.slice(0, 6));
  const results = page.getByRole('list', { name: 'Offline price check results' });
  await expect(results.getByText(otc.name)).toBeVisible();
  await expect(results.getByText(/Rs 250\.00 a pack/)).toBeVisible();
  await priceCheck.fill(rx.name.slice(0, 9));
  await expect(page.getByText(/No medicine this counter holds offline matches/)).toBeVisible();
  await expect(page.getByText(rx.name)).toHaveCount(0);
  await priceCheck.press('Escape');
  await expect(priceCheck).toHaveValue('');

  await context.close();
});
