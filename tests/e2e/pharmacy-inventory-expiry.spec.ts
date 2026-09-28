import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { EXPIRY_FIXTURE } from './pharmacy-inventory-expiry-fixture';
import { FIXTURE } from './pharmacy-purchasing-fixture';

/**
 * WHA-1602 (PH-A5) — the expiry board, walked through the surface: each of the
 * three actions must leave a draft or a movement the operator can SEE, and the
 * near-expiry list must be printable and shareable.
 *
 * Runs in the PH-PUR lane (same tenant, same signed-in receiver) after
 * `pharmacy-purchasing-seed.ts` and `pharmacy-inventory-expiry-seed.ts`. The
 * cases share two seeded lots and run in file order on one worker, because the
 * return draft and the quarantine each change what the next case sees.
 */

const ROUTE = '/pharmacy/inventory/expiry';

function seededBatches(): { nearBatch: string; expiredBatch: string } {
  const handle = path.join(
    'playwright-artifacts',
    'pharmacy-purchasing-fixture',
    'expiry-handle.json'
  );
  try {
    return JSON.parse(readFileSync(handle, 'utf8'));
  } catch {
    throw new Error(
      `Run tests/e2e/pharmacy-inventory-expiry-seed.ts before this lane — ${handle} is missing.`
    );
  }
}

/** See `pharmacy-purchasing.spec.ts`: the page transition briefly duplicates the route. */
function lotCard(page: Page, batch: string) {
  return page
    .getByRole('article', { name: new RegExp(`batch ${batch} · ${FIXTURE.shelf.name}`) })
    .first();
}

function notice(page: Page, text: string | RegExp) {
  return page.getByRole('status').filter({ hasText: text }).first();
}

test.describe.configure({ mode: 'serial' });

test('the inventory near-expiry card opens the expiry board', async ({ page }) => {
  const { nearBatch, expiredBatch } = seededBatches();
  await page.goto('/pharmacy/inventory');
  await page.getByRole('link', { name: 'Act on expiring stock' }).first().click();

  await expect(page.getByRole('heading', { level: 1, name: 'Expiry board' }).first()).toBeVisible();
  await expect(lotCard(page, nearBatch)).toBeVisible();
  await expect(lotCard(page, nearBatch)).toContainText('45 days left');
  // Already-expired stock still on the shelf is on the board, flagged as such.
  await expect(lotCard(page, expiredBatch)).toContainText('Expired 3 days ago');
});

test('mark-down produces a visible price draft without touching the counter price', async ({
  page,
}) => {
  const { nearBatch, expiredBatch } = seededBatches();
  await page.goto(ROUTE);

  // Expired stock is never offered a mark-down.
  await expect(
    lotCard(page, expiredBatch).getByRole('button', { name: 'Draft mark-down' })
  ).toHaveCount(0);

  const card = lotCard(page, nearBatch);
  await card.getByLabel('Mark-down %').selectOption('25');
  await card.getByRole('button', { name: 'Draft mark-down' }).click();

  const done = notice(page, 'Mark-down draft recorded');
  await expect(done).toBeVisible({ timeout: 20_000 });
  await expect(done).toContainText('PKR 320.00 → PKR 240.00 per pack (25% off)');
  await expect(done).toContainText('still sells at the printed MRP');
  await expect(lotCard(page, nearBatch).getByRole('note').first()).toContainText(
    'PKR 320.00 → PKR 240.00'
  );

  // Submitting the same mark-down again replays it rather than stacking one.
  await lotCard(page, nearBatch).getByLabel('Mark-down %').selectOption('25');
  await lotCard(page, nearBatch).getByRole('button', { name: 'Draft mark-down' }).click();
  await expect(notice(page, 'already exists')).toBeVisible({ timeout: 20_000 });
});

test('return-to-supplier produces a DRAFT expiry claim in Purchasing → Returns', async ({
  page,
}) => {
  const { nearBatch } = seededBatches();
  await page.goto(ROUTE);

  const card = lotCard(page, nearBatch);
  await expect(card.getByLabel('Return supplier')).toHaveValue(/.+/);
  await card.getByLabel('Return supplier').selectOption({ label: FIXTURE.supplier.name });
  await card.getByLabel('Return units').fill('30');
  await card.getByRole('button', { name: 'Draft supplier return' }).click();

  const done = notice(page, 'Supplier return draft');
  await expect(done).toBeVisible({ timeout: 20_000 });
  await expect(done).toContainText('reserves nothing');
  const reference = /(EXP-\S+)/.exec((await done.textContent()) ?? '')?.[1];
  expect(reference).toBeTruthy();

  await lotCard(page, nearBatch)
    .getByRole('link', { name: 'Open in Purchasing → Returns' })
    .click();
  const panel = page.getByRole('heading', { level: 2, name: reference! }).first();
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Expiry claim · raised/).first()).toBeVisible();
});

test('quarantine posts a ledger movement that takes the units out of sale', async ({ page }) => {
  const { expiredBatch } = seededBatches();
  await page.goto(ROUTE);

  const card = lotCard(page, expiredBatch);
  await card.getByLabel('Quarantine units').fill('10');
  await card.getByRole('button', { name: 'Quarantine units' }).click();

  const done = notice(page, 'Quarantined 10 units');
  await expect(done).toBeVisible({ timeout: 20_000 });
  await expect(done).toContainText('out of sale');
  // Half the lot is now held in QUARANTINE; the other half is still on the board.
  await expect(lotCard(page, expiredBatch)).toContainText(
    `${EXPIRY_FIXTURE.expiredUnits - 10} units`
  );
  await expect(lotCard(page, expiredBatch)).toContainText('10 units of this lot in quarantine');
});

test('the near-expiry list is printable and downloadable to share', async ({ page }) => {
  const { nearBatch, expiredBatch } = seededBatches();
  await page.goto(ROUTE);
  await page.getByRole('link', { name: 'Printable / shareable list' }).first().click();

  const list = page.getByRole('table', { name: 'Near-expiry list' }).first();
  await expect(list).toBeVisible({ timeout: 20_000 });
  await expect(list.getByRole('row', { name: new RegExp(nearBatch) })).toContainText(
    'Mark-down 25%'
  );
  await expect(list.getByRole('row', { name: new RegExp(expiredBatch) })).toBeVisible();
  // The shareable URL is the list itself.
  expect(new URL(page.url()).searchParams.get('view')).toBe('print');
  await expect(page.getByRole('button', { name: 'Print list' }).first()).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download CSV' }).first().click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^near-expiry-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync((await file.path())!, 'utf8');
  expect(csv).toContain(nearBatch);
  expect(csv).toContain('25% off (240.00 per pack)');
});
