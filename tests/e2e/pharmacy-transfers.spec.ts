import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

import { TRANSFERS_ARTIFACTS, TRANSFERS_FIXTURE as F } from './pharmacy-transfers-fixture';
import { APPROVER_STATE, DISPATCHER_STATE } from './pharmacy-transfers-global-setup';

/**
 * WHA-1603 — INV-07 across two branches, walked through the transfers console:
 * allocate at Saddar → approve by a second person → print the packing slip →
 * dispatch → receive short at Clifton with a witnessed variance. The ledger is
 * then read back directly, because "the page says written off" is only true if
 * the units actually left IN_TRANSIT and the received units actually landed.
 *
 * Serial, one worker: the fixture is one run-unique lot, and a second worker
 * allocating from it would be testing the seed rather than the surface.
 */

const ROUTE = '/pharmacy/inventory/transfers';

type Handle = {
  organizationId: string;
  batchNumber: string;
  sourceBranchId: string;
  destinationBranchId: string;
};

function seeded(): Handle {
  const file = path.join(TRANSFERS_ARTIFACTS, 'fixture-handle.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Handle;
  } catch {
    throw new Error(
      `Run tests/e2e/pharmacy-transfers-seed.ts before this lane — ${file} is missing.`
    );
  }
}

const at = (branchId: string) => `${ROUTE}?${new URLSearchParams({ branch: branchId })}`;

/** PageTransition briefly mounts an aria-hidden copy of the route; read the first. */
function notice(page: Page, text: string | RegExp) {
  return page.getByRole('status').filter({ hasText: text }).first();
}

function card(page: Page, batchNumber: string): Locator {
  return page
    .getByTestId('transfer-card')
    .filter({ hasText: `Batch ${batchNumber}` })
    .first();
}

/** The print dialog is the OS's; count the request instead of opening one. */
async function stubPrint(context: BrowserContext) {
  await context.addInitScript(() => {
    const counted = window as unknown as { __printRequests?: number };
    window.print = () => {
      counted.__printRequests = (counted.__printRequests ?? 0) + 1;
    };
  });
}

async function ledger<T extends pg.QueryResultRow>(
  organizationId: string,
  sql: string,
  values: unknown[]
): Promise<T[]> {
  const url = process.env.PHARMACY_TRANSFERS_DATABASE_URL;
  if (!url) throw new Error('PHARMACY_TRANSFERS_DATABASE_URL is required to read the ledger back.');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [
      organizationId,
    ]);
    return (await client.query<T>(sql, values)).rows;
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
}

test('INV-07 across two branches: allocate → approve → slip → dispatch → receive with variance', async ({
  browser,
}) => {
  const handle = seeded();
  const { batchNumber } = handle;
  const dispatcherContext = await browser.newContext({ storageState: DISPATCHER_STATE });
  const approverContext = await browser.newContext({ storageState: APPROVER_STATE });
  await stubPrint(dispatcherContext);
  const page = await dispatcherContext.newPage();
  const approver = await approverContext.newPage();

  // ── 1. allocate at the source branch ────────────────────────────────────
  await page.goto(at(handle.sourceBranchId));
  await expect(
    page.getByRole('heading', { level: 1, name: 'Stock transfers' }).first()
  ).toBeVisible();
  const allocate = page.getByRole('form', { name: 'Allocate a transfer' }).first();
  await allocate
    .getByLabel('Destination branch and receiving location')
    .selectOption({ label: `${F.destination.name} · ${F.destination.location.name}` });
  await allocate.getByLabel('Stock line 1').selectOption({
    label: `${F.medicine.productName} · batch ${batchNumber} · ${F.source.location.name} · ${F.openingUnits} units`,
  });
  await allocate.getByLabel('Units', { exact: true }).first().fill(String(F.transfer.units));
  await allocate.getByRole('button', { name: 'Allocate transfer' }).click();
  await expect(notice(page, 'Transfer allocated')).toBeVisible({ timeout: 20_000 });

  const outbound = card(page, batchNumber);
  await expect(outbound).toContainText('Awaiting approval');
  const reference = (await outbound.textContent())?.match(/TR-[A-Z0-9]{8}/)?.[0];
  expect(reference, 'the card names its transfer reference').toBeTruthy();
  // Segregation of duties is visible, not just enforced.
  await expect(outbound).toContainText('Waiting for a colleague to approve');
  await expect(outbound.getByRole('button', { name: `Approve ${reference}` })).toHaveCount(0);

  // ── 2. a second person approves ─────────────────────────────────────────
  await approver.goto(at(handle.sourceBranchId));
  await card(approver, batchNumber)
    .getByRole('button', { name: `Approve ${reference}` })
    .click();
  await expect(notice(approver, 'Transfer approved')).toBeVisible({ timeout: 20_000 });

  // ── 3. the packing slip prints from an isolated window ──────────────────
  await page.reload();
  await expect(card(page, batchNumber)).toContainText('Ready to dispatch');
  const [slip] = await Promise.all([
    page.waitForEvent('popup'),
    card(page, batchNumber).getByRole('button', { name: 'Print packing slip' }).click(),
  ]);
  await expect(slip.locator('pre')).toContainText('PACKING SLIP — INTER-BRANCH TRANSFER');
  await expect(slip.locator('pre')).toContainText(`Transfer ${reference}`);
  await expect(slip.locator('pre')).toContainText(`From: ${F.source.name} · ${F.source.city}`);
  await expect(slip.locator('pre')).toContainText(
    `To:   ${F.destination.name} · ${F.destination.city}`
  );
  await expect(slip.locator('pre')).toContainText(`Batch ${batchNumber}`);
  await expect(slip.locator('pre')).toContainText('30 units = 3 sealed × 10 + 0 loose');
  await expect(slip.locator('pre')).toContainText(`Approved by:  ${F.approver.name}`);
  expect(await slip.evaluate(() => window.opener)).toBeNull();
  expect(
    await slip.evaluate(() => (window as unknown as { __printRequests?: number }).__printRequests)
  ).toBe(1);
  await slip.close();

  // ── 4. dispatch puts the units in transit ───────────────────────────────
  await card(page, batchNumber)
    .getByRole('button', { name: `Dispatch ${reference}` })
    .click();
  await expect(notice(page, 'Transfer dispatched')).toBeVisible({ timeout: 20_000 });
  await expect(card(page, batchNumber)).toContainText('In transit');

  // ── 5. the destination refuses a shortfall without witnessed evidence ───
  await page.goto(at(handle.destinationBranchId));
  const inbound = card(page, batchNumber);
  await expect(inbound).toContainText('Inbound');
  const received = inbound.getByLabel(
    `Received units — ${F.medicine.productName} · batch ${batchNumber}`
  );
  await expect(received).toHaveValue(String(F.transfer.units));
  await received.fill(String(F.transfer.receivedUnits));
  await inbound.getByRole('button', { name: `Receive ${reference}` }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'witness' }).first()).toBeVisible({
    timeout: 20_000,
  });

  // ── 6. …and closes it with the shortfall written off ────────────────────
  const retry = card(page, batchNumber);
  await retry
    .getByLabel(`Received units — ${F.medicine.productName} · batch ${batchNumber}`)
    .fill(String(F.transfer.receivedUnits));
  await retry.getByLabel('Variance reason').fill('One strip carton crushed in the van');
  await retry.getByLabel('Witness').selectOption({ label: `${F.approver.name} · Branch manager` });
  await retry.getByLabel('Evidence reference').fill('VAN-SEAL-0042');
  await retry.getByRole('button', { name: `Receive ${reference}` }).click();
  await expect(notice(page, 'Transfer received and closed')).toBeVisible({ timeout: 20_000 });
  const closed = card(page, batchNumber);
  await expect(closed).toContainText('Received with variance');
  await expect(closed).toContainText('−10 written off');

  // ── 7. the ledger says what the page says ───────────────────────────────
  const suffix = reference!.slice(3).toLowerCase();
  const variance = await ledger<{
    quantityUnits: number;
    branchId: string;
    disposition: string;
    witnessId: string | null;
  }>(
    handle.organizationId,
    `SELECT m."quantityUnits", m."branchId", m.disposition::text AS disposition, c."witnessId"
       FROM pharmacy_stock_movements m
       LEFT JOIN pharmacy_custody_records c ON c."movementId" = m.id
      WHERE m."organizationId" = $1 AND m.kind = 'WRITE_OFF'
        AND split_part(m."idempotencyKey", ':', 1) = 'transfer-variance'
        AND split_part(m."idempotencyKey", ':', 2) LIKE '%' || $2`,
    [handle.organizationId, suffix]
  );
  expect(variance).toHaveLength(1);
  expect(variance[0]).toMatchObject({
    quantityUnits: -(F.transfer.units - F.transfer.receivedUnits),
    branchId: handle.sourceBranchId,
    disposition: 'IN_TRANSIT',
  });
  expect(variance[0]!.witnessId).toBeTruthy();

  const onHand = await ledger<{ branchId: string; disposition: string; units: number }>(
    handle.organizationId,
    `SELECT b."branchId", b.disposition::text AS disposition, SUM(b."onHandUnits")::int AS units
       FROM pharmacy_stock_balances b
       JOIN pharmacy_inventory_lots l ON l.id = b."inventoryLotId"
       JOIN pharmacy_manufacturing_batches mb ON mb.id = l."manufacturingBatchId"
      WHERE b."organizationId" = $1 AND mb."batchNumber" = $2
      GROUP BY 1, 2`,
    [handle.organizationId, batchNumber]
  );
  const units = (branchId: string, disposition: string) =>
    onHand.find((row) => row.branchId === branchId && row.disposition === disposition)?.units ?? 0;
  expect(units(handle.sourceBranchId, 'AVAILABLE')).toBe(F.openingUnits - F.transfer.units);
  expect(units(handle.sourceBranchId, 'IN_TRANSIT')).toBe(0);
  expect(units(handle.destinationBranchId, 'AVAILABLE')).toBe(F.transfer.receivedUnits);

  // ── 8. the source branch sees the same closed, short transfer ───────────
  await page.goto(at(handle.sourceBranchId));
  await expect(card(page, batchNumber)).toContainText('Received with variance');

  await dispatcherContext.close();
  await approverContext.close();
});
