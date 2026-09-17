import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  actorFixture,
  assertNoRawDatabaseIds,
  signInAs,
} from './fixtures/restaurant-actor-accessibility';

/**
 * Back-office browser-to-persisted-state acceptance for the restaurant catalog,
 * supplier registry, purchase-order receiving, and stock-count reconciliation.
 *
 * Why this file exists — the gap it closes. The integrated lane already proves
 * that `/restaurant/inventory` and `/restaurant/purchasing` render their `h1`
 * (`restaurant-integrated.spec.ts` route matrix) and that `/restaurant/catalog`
 * is axe-clean (`restaurant-actor-accessibility.spec.ts`). The only browser
 * receiving flow in the repository lives in `restaurant-sales-demo.spec.ts`
 * (`receivePurchaseOrder`), which runs against the separate demo seed/config,
 * receives an *already approved* order, and stops at "Receipt posted." plus the
 * reference appearing in receipt history — it never reads the stock effect back.
 * Nothing anywhere drives supplier creation, the DRAFT → SUBMITTED → APPROVED
 * purchase-order lifecycle, or the physical-count freeze/post lifecycle from a
 * browser and then reconciles the result against the persisted stock ledger.
 * Those readbacks are what this file adds; existing coverage is left untouched.
 *
 * Out of scope by assignment: recipe and report arithmetic, catering, daily
 * close, and any receiving *correction*. The correction path is held under
 * WHA-1503 at its recorded 21 passed / 1 failed — this file neither retries nor
 * overwrites it.
 *
 * Assertion design note (deliberate, not an oversight). Both server-action
 * surfaces here (`purchasing/page.tsx`, `inventory/page.tsx`) end their actions
 * in `redirect()`. On this app's Next version that redirect is dropped by the
 * client router roughly half the time: the row is written, `revalidatePath`
 * still runs on the success path, but the URL never changes and the notice
 * banner never renders. Asserting the banner would therefore author a coin
 * flip. Every server-action step below instead waits for the action POST to
 * answer, then re-requests the page and asserts the *persisted* row — which is
 * both deterministic and the stronger claim. The banner's own reliability is a
 * product defect tracked outside this file, not something a test can assert
 * into existence.
 *
 * Two further contract notes, both corrected against the real markup rather
 * than assumed:
 *
 *  1. Every `<select>` on these two pages is *wrapped* by its `<label>` with no
 *     `htmlFor`. Playwright folds the whole label subtree — including every
 *     `<option>` — into the computed label text, so the name of the location
 *     control is `"LocationSelect locationMain store"`, never `"Location"`, and
 *     `getByLabel(…, { exact: true })` can never match it. These controls are
 *     addressed by the form field name the server action itself reads, which is
 *     the stable contract; the visible caption is asserted separately so that
 *     coverage is kept rather than dropped. Inputs are unaffected — an
 *     `<input>` contributes no text — so their exact label locators stand.
 *
 *  2. The movement ledger is a *global* newest-first window of 25 rows
 *     (`listStockMovements({ limit: 25 })`) and renders no reference, receipt id
 *     or count id. "One row more than before" is therefore not a claim this UI
 *     can support: past 25 movements for the organization, appending one evicts
 *     the oldest and the visible count never moves. Each posting below instead
 *     uses an amount unique to the run, exact at the ledger's `Decimal(18, 6)`
 *     scale, and asserts that exactly one movement carries it — a window-size
 *     independent identification of the row that was just written. The stock and
 *     quantity conservation assertions are unchanged.
 */

const ROUTES = {
  catalog: '/restaurant/catalog',
  purchasing: '/restaurant/purchasing',
  inventory: '/restaurant/inventory',
} as const;

if (process.env.RESTAURANT_INTEGRATED_E2E !== '1') {
  throw new Error('RESTAURANT_INTEGRATED_E2E=1 is required.');
}

test.describe.configure({ mode: 'serial' });

/**
 * Fixture contract, asserted per test so a missing prerequisite fails that test
 * loudly instead of skipping it or quietly registering zero assertions.
 */
function requireAdminActor() {
  const { email, password } = actorFixture.restaurantAdmin;
  if (!email || !password) {
    throw new Error(
      'RESTAURANT_ACTOR_ADMIN_EMAIL and RESTAURANT_ACTOR_ADMIN_PASSWORD must name the seeded ' +
        'restaurant owner (the fixture user holding the `*` capability role). Back-office ' +
        'lifecycle acceptance cannot run against an anonymous or read-only actor.'
    );
  }
}

const unique = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

/**
 * An amount no other ledger row is carrying, exact at the `Decimal(18, 6)` scale
 * of `restaurant_stock_movements.quantity`, so the value written is the value
 * read back with no rounding. `text` is what the form receives; `value` is what
 * the numeric assertions compare against.
 */
function uniqueAmount(whole: number) {
  const fraction = crypto.randomUUID().replace(/\D/g, '').padEnd(6, '1').slice(0, 6);
  const text = `${whole}.${fraction}`;
  return { text, value: Number(text) };
}

function card(page: Page, heading: string) {
  return page
    .locator('[data-slot="section-card"]')
    .filter({ has: page.getByRole('heading', { name: heading, exact: true }) });
}

/** Parse a rendered Decimal cell. Scale varies by column; the value does not. */
async function decimalOf(cell: Locator, what: string) {
  const raw = (await cell.innerText()).trim();
  const parsed = Number(raw);
  expect(Number.isFinite(parsed), `${what} must render a numeric value, got "${raw}".`).toBe(true);
  return parsed;
}

/**
 * Server actions on these pages POST to their own pathname. Waiting for that
 * response is the only deterministic "the write has landed" signal available,
 * because the follow-up redirect is unreliable (see the file header).
 */
async function settleServerAction(page: Page, pathname: string, act: () => Promise<void>) {
  const answered = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === pathname
  );
  await act();
  const response = await answered;
  expect(response.status(), `${pathname} server action must not error`).toBeLessThan(400);
}

/**
 * A wrapped `<select>`, addressed by the field name its server action reads
 * (`supplierId`, `locationId`, `stockItemId`). See note 1 in the file header for
 * why the label cannot address it.
 */
function selectField(scope: Locator, name: string) {
  return scope.locator(`select[name="${name}"]`);
}

/**
 * The visible caption of that control, which is the half of the label contract a
 * name-based locator would otherwise stop covering. Substring, not exact: the
 * label element legitimately contains its own options' text as well.
 */
async function expectFieldCaption(scope: Locator, name: string, caption: string) {
  await expect(
    scope.locator(`label:has(select[name="${name}"])`),
    `the ${name} control must stay labelled "${caption}"`
  ).toContainText(caption);
}

async function selectableValues(select: Locator) {
  return select.locator('option:not([value=""])').evaluateAll((options) =>
    options.map((option) => ({
      value: (option as HTMLOptionElement).value,
      label: (option.textContent ?? '').trim(),
    }))
  );
}

async function requireFirstOption(select: Locator, requirement: string) {
  const options = await selectableValues(select);
  if (!options.length) throw new Error(requirement);
  return options[0];
}

/** On-hand for one item/location, or null when no position exists yet. */
async function onHandFor(page: Page, itemName: string, locationName: string) {
  const row = card(page, 'Stock on hand')
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: itemName, exact: true }) })
    .filter({ has: page.getByRole('cell', { name: locationName, exact: true }) });
  if ((await row.count()) === 0) return null;
  return decimalOf(row.first().getByRole('cell').nth(2), `on hand for ${itemName}`);
}

/** The same lookup where the position is a precondition rather than optional. */
async function requireOnHand(page: Page, itemName: string, locationName: string, why: string) {
  const position = await onHandFor(page, itemName, locationName);
  if (position === null) {
    throw new Error(`${itemName} must hold a stock position at ${locationName} ${why}.`);
  }
  return position;
}

function movementRows(page: Page, itemName: string, locationName: string, reason: string) {
  return card(page, 'Movement ledger')
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: itemName, exact: true }) })
    .filter({ has: page.getByRole('cell', { name: locationName, exact: true }) })
    .filter({ hasText: reason });
}

/**
 * Every visible ledger quantity for one item/location/reason, newest first.
 * Read numerically rather than matched as text: the column renders a Prisma
 * `Decimal`, whose `toString()` drops trailing zeros, so `"5.123450"` comes back
 * as `"5.12345"` and an exact text match would be a format assertion rather than
 * a value one.
 */
async function movementQuantities(
  page: Page,
  itemName: string,
  locationName: string,
  reason: string
) {
  const rows = movementRows(page, itemName, locationName, reason);
  const total = await rows.count();
  const quantities: number[] = [];
  for (let index = 0; index < total; index += 1) {
    // When | Item | Location | Reason | Quantity.
    quantities.push(
      await decimalOf(rows.nth(index).getByRole('cell').nth(4), `${reason} movement quantity`)
    );
  }
  return quantities;
}

const carries = (quantities: number[], amount: number) =>
  quantities.filter((quantity) => Math.abs(quantity - amount) < 1e-6);

test('a modifier group and its priced option survive a full catalog reload', async ({ page }) => {
  requireAdminActor();
  const origin = await signInAs(page, 'restaurantAdmin');
  await page.goto(new URL(ROUTES.catalog, origin).href);

  const modifiersTab = page.getByRole('tab', { name: /^Modifiers \(\d+\)$/ });
  await modifiersTab.click();
  const groupsBefore = Number(
    /\((\d+)\)/.exec((await modifiersTab.innerText()).trim())?.[1] ?? 'NaN'
  );
  expect(Number.isInteger(groupsBefore), 'Modifiers tab must publish a group count.').toBe(true);

  const groupName = unique('QA heat level');
  const optionName = unique('QA extra hot');
  const priceDelta = '2.25';

  await card(page, `${groupsBefore} modifier group${groupsBefore === 1 ? '' : 's'}`)
    .getByRole('button', { name: 'Add group', exact: true })
    .click();
  const groupDialog = page.getByRole('dialog');
  await groupDialog.getByLabel('Group name').fill(groupName);
  await groupDialog.getByLabel('Minimum selections').fill('0');
  await groupDialog.getByLabel('Maximum selections').fill('1');
  await groupDialog.getByRole('button', { name: 'Add modifier group', exact: true }).click();
  await expect(page.getByText('Modifier group created.', { exact: true })).toBeVisible();

  const groupRow = page.getByRole('row').filter({ hasText: groupName });
  await expect(groupRow).toHaveCount(1);
  await groupRow.getByRole('button', { name: 'Options', exact: true }).click();

  const optionsCard = card(page, groupName);
  await optionsCard.getByRole('button', { name: 'Add option', exact: true }).click();
  const optionDialog = page.getByRole('dialog');
  await optionDialog.getByLabel('Option name').fill(optionName);
  await optionDialog.getByLabel('Price delta').fill(priceDelta);
  await optionDialog.getByLabel('Sort order').fill('0');
  await optionDialog.getByRole('button', { name: 'Add modifier option', exact: true }).click();
  await expect(page.getByText('Modifier option created.', { exact: true })).toBeVisible();

  // The console renders from a server snapshot, so a fresh request is the only
  // proof that the write reached the database rather than a client cache.
  await page.goto(new URL(ROUTES.catalog, origin).href);
  await page.getByRole('tab', { name: `Modifiers (${groupsBefore + 1})` }).click();

  const reloadedGroupRow = page.getByRole('row').filter({ hasText: groupName });
  await expect(reloadedGroupRow).toHaveCount(1);
  // Group | Selection | Options | Actions — the selection window and the option
  // tally both come back from the persisted group.
  await expect(reloadedGroupRow.getByRole('cell').nth(1)).toHaveText('0 to 1');
  await expect(reloadedGroupRow.getByRole('cell').nth(2)).toHaveText('1');

  await reloadedGroupRow.getByRole('button', { name: 'Options', exact: true }).click();
  const reloadedOption = card(page, groupName).getByRole('row').filter({ hasText: optionName });
  await expect(reloadedOption).toHaveCount(1);
  expect(await decimalOf(reloadedOption.getByRole('cell').nth(1), 'price delta')).toBeCloseTo(
    Number(priceDelta),
    2
  );

  await assertNoRawDatabaseIds(page);
});

test('a supplier created in the registry persists and becomes orderable', async ({ page }) => {
  requireAdminActor();
  const origin = await signInAs(page, 'restaurantAdmin');
  const purchasing = new URL(ROUTES.purchasing, origin).href;
  await page.goto(purchasing);

  const registry = card(page, 'Supplier registry');
  const supplierName = unique('QA Provisions');
  const supplierCode = unique('QAP').toUpperCase();
  const contactEmail = `${supplierCode.toLowerCase()}@suppliers.invalid`;

  await settleServerAction(page, ROUTES.purchasing, async () => {
    await registry.getByLabel('Name', { exact: true }).fill(supplierName);
    await registry.getByLabel('Code', { exact: true }).fill(supplierCode);
    await registry.getByLabel('Contact name', { exact: true }).fill('QA Buyer');
    await registry.getByLabel('Contact email', { exact: true }).fill(contactEmail);
    await registry.getByLabel('Contact phone', { exact: true }).fill('+92 300 0000000');
    await registry.getByRole('button', { name: 'Create supplier', exact: true }).click();
  });

  await page.goto(purchasing);
  const persisted = card(page, 'Supplier registry').locator('div', { hasText: supplierName });
  await expect(persisted.first()).toBeVisible();
  await expect(card(page, 'Supplier registry')).toContainText(supplierCode);
  await expect(card(page, 'Supplier registry')).toContainText(contactEmail);

  // Persisted is not enough — the registry entry must reach the ordering form.
  const orderForm = card(page, 'New purchase order');
  await expectFieldCaption(orderForm, 'supplierId', 'Supplier');
  const supplierSelect = selectField(orderForm, 'supplierId');
  await expect(supplierSelect.locator('option').filter({ hasText: supplierName })).toHaveCount(1);

  await assertNoRawDatabaseIds(page);
});

test('an approved purchase order receipt reaches the stock ledger and on-hand position', async ({
  page,
}) => {
  requireAdminActor();
  const origin = await signInAs(page, 'restaurantAdmin');
  const purchasing = new URL(ROUTES.purchasing, origin).href;
  const inventory = new URL(ROUTES.inventory, origin).href;

  await page.goto(purchasing);
  const orderForm = card(page, 'New purchase order');
  await expectFieldCaption(orderForm, 'locationId', 'Location');
  await expectFieldCaption(orderForm, 'stockItemId', 'Stock item');

  const location = await requireFirstOption(
    selectField(orderForm, 'locationId'),
    'The restaurant fixture must seed at least one active restaurantStockLocation for this ' +
      'organization; without it the purchase-order form cannot derive a branch and its submit ' +
      'button stays disabled.'
  );
  const stockItem = await requireFirstOption(
    selectField(orderForm, 'stockItemId'),
    'The restaurant fixture must seed at least one active restaurantStockItem (ingredient plus ' +
      'canonical unit) for this organization; without it no purchase-order line can be built.'
  );
  // The option label is "<ingredient> · <unit>"; the inventory tables key on the
  // ingredient name alone.
  const itemName = stockItem.label.split('·')[0].trim();

  const orderedQuantity = 12;
  const received = uniqueAmount(5);

  await page.goto(inventory);
  const onHandBefore = (await onHandFor(page, itemName, location.label)) ?? 0;
  // The identification below is only meaningful if nothing already visible
  // carries this amount, so establish that first.
  expect(
    carries(
      await movementQuantities(page, itemName, location.label, 'PURCHASE_RECEIPT'),
      received.value
    ),
    `no existing receipt movement may already carry the run-unique quantity ${received.text}`
  ).toHaveLength(0);

  await page.goto(purchasing);
  const supplierName = unique('QA Receiving Supplier');
  await settleServerAction(page, ROUTES.purchasing, async () => {
    const registry = card(page, 'Supplier registry');
    await registry.getByLabel('Name', { exact: true }).fill(supplierName);
    await registry.getByRole('button', { name: 'Create supplier', exact: true }).click();
  });

  const orderReference = unique('QA-PO');

  await page.goto(purchasing);
  await settleServerAction(page, ROUTES.purchasing, async () => {
    const form = card(page, 'New purchase order');
    await selectField(form, 'supplierId').selectOption({ label: supplierName });
    await selectField(form, 'locationId').selectOption(location.value);
    await selectField(form, 'stockItemId').selectOption(stockItem.value);
    await form.getByLabel('Ordered quantity', { exact: true }).fill(String(orderedQuantity));
    await form.getByLabel('Unit cost', { exact: true }).fill('3.00');
    await form.getByLabel('Reference', { exact: true }).fill(orderReference);
    await form.getByRole('button', { name: 'Create purchase order', exact: true }).click();
  });

  // Locate the order by its own reference rather than the action's `?selected=`
  // parameter, which the dropped-redirect defect can withhold.
  const openOrder = async () => {
    await page.goto(purchasing);
    const queueRow = card(page, 'Purchase-order queue')
      .getByRole('row')
      .filter({ hasText: orderReference });
    await expect(queueRow, 'the created purchase order must appear in the queue').toHaveCount(1);
    await queueRow.getByRole('link', { name: /^(?:Review|Selected)$/ }).click();
    await expect(page.getByRole('heading', { name: orderReference, exact: true })).toBeVisible();
  };

  await openOrder();
  const detail = card(page, orderReference);
  await expect(detail.locator('[data-slot="status-pill"]').first()).toHaveText('DRAFT');
  await expect(detail.getByRole('row').filter({ hasText: itemName })).toHaveCount(1);

  await settleServerAction(page, ROUTES.purchasing, async () => {
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
  });
  await openOrder();
  await expect(card(page, orderReference).locator('[data-slot="status-pill"]').first()).toHaveText(
    'SUBMITTED'
  );

  await settleServerAction(page, ROUTES.purchasing, async () => {
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
  });
  await openOrder();
  await expect(card(page, orderReference).locator('[data-slot="status-pill"]').first()).toHaveText(
    'APPROVED'
  );

  const receiptReference = unique('QA-GRN');
  const receiveForm = page.getByRole('form', { name: 'Receive stock' });
  await expect(
    receiveForm,
    'an APPROVED order must offer the receiving form to a purchasing:create actor'
  ).toBeVisible();
  await receiveForm.getByLabel('Received quantity', { exact: true }).fill(received.text);
  await receiveForm.getByLabel('Receipt reference', { exact: true }).fill(receiptReference);
  await receiveForm.getByRole('button', { name: 'Receive purchase order', exact: true }).click();
  // `receivePurchaseOrder` is a useActionState function that returns its result
  // in place, so this confirmation is not subject to the redirect defect.
  await expect(receiveForm.getByRole('status')).toContainText('Receipt posted.');

  await openOrder();
  const reloaded = card(page, orderReference);
  await expect(reloaded.locator('[data-slot="status-pill"]').first()).toHaveText(
    'PARTIALLY_RECEIVED'
  );
  const orderLine = reloaded
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: itemName, exact: true }) })
    .first();
  // Item | Ordered | Received | Unit cost.
  expect(await decimalOf(orderLine.getByRole('cell').nth(2), 'received quantity')).toBeCloseTo(
    received.value,
    6
  );
  await expect(page.locator('#receipt-history')).toContainText(receiptReference);

  await page.goto(inventory);
  const receiptQuantities = await movementQuantities(
    page,
    itemName,
    location.label,
    'PURCHASE_RECEIPT'
  );
  expect(
    carries(receiptQuantities, received.value),
    'receiving must append exactly one PURCHASE_RECEIPT movement for the received quantity'
  ).toHaveLength(1);
  // The ledger is newest-first, so the movement just written is also the top
  // receipt row for this item and location.
  expect(
    receiptQuantities[0],
    'the newest receipt movement must be the one this test posted'
  ).toBeCloseTo(received.value, 6);

  const onHandAfter = await requireOnHand(page, itemName, location.label, 'after receiving');
  expect(
    onHandAfter,
    'a posted receipt must raise derived stock by exactly the received quantity'
  ).toBeCloseTo(onHandBefore + received.value, 6);
});

test('a physical count freezes its snapshot and posts the variance to the stock ledger', async ({
  page,
}) => {
  requireAdminActor();
  const origin = await signInAs(page, 'restaurantAdmin');
  const inventory = new URL(ROUTES.inventory, origin).href;
  await page.goto(inventory);

  const startCard = card(page, 'Start a physical count');
  await expectFieldCaption(startCard, 'locationId', 'Location');
  const location = await requireFirstOption(
    selectField(startCard, 'locationId'),
    'The restaurant fixture must seed at least one active restaurantStockLocation; the ' +
      '"Create count" control stays disabled without one.'
  );

  const countLineForm = page.locator('form').filter({ hasText: 'Add count line' });
  const countReference = unique('QA-COUNT');

  await settleServerAction(page, ROUTES.inventory, async () => {
    await selectField(startCard, 'locationId').selectOption(location.value);
    await startCard.getByLabel('Reference (optional)', { exact: true }).fill(countReference);
    await startCard.getByRole('button', { name: 'Create count', exact: true }).click();
  });

  const openCount = async () => {
    await page.goto(inventory);
    const countRow = card(page, 'Physical counts')
      .getByRole('row')
      .filter({ hasText: countReference });
    await expect(countRow, 'the created count must appear in the counts list').toHaveCount(1);
    await countRow.getByRole('link', { name: /^(?:Review|Selected)$/ }).click();
    await expect(page.getByRole('heading', { name: countReference, exact: true })).toBeVisible();
  };

  await openCount();
  const detail = card(page, countReference);
  await expect(detail.locator('[data-slot="status-pill"]').first()).toHaveText('DRAFT');

  await expectFieldCaption(countLineForm, 'stockItemId', 'Stock item');
  const stockItem = await requireFirstOption(
    selectField(countLineForm, 'stockItemId'),
    'The restaurant fixture must seed at least one active restaurantStockItem; a count cannot ' +
      'take a line without one.'
  );
  const itemName = stockItem.label.trim();
  const expectedSnapshot = (await onHandFor(page, itemName, location.label)) ?? 0;
  // A run-unique variance, so the adjustment movement it posts can be picked out
  // of the shared ledger window by value alone.
  const variance = uniqueAmount(3);
  const countedText = (expectedSnapshot + variance.value).toFixed(6);
  const counted = Number(countedText);
  expect(
    counted,
    'the console only accepts a non-negative counted quantity; this item must not be holding a ' +
      'derived position below the chosen variance at this location'
  ).toBeGreaterThanOrEqual(0);
  expect(
    carries(
      await movementQuantities(page, itemName, location.label, 'PHYSICAL_COUNT_ADJUSTMENT'),
      variance.value
    ),
    `no existing adjustment movement may already carry the run-unique variance ${variance.text}`
  ).toHaveLength(0);

  await settleServerAction(page, ROUTES.inventory, async () => {
    await selectField(countLineForm, 'stockItemId').selectOption(stockItem.value);
    await countLineForm.getByLabel('Counted quantity', { exact: true }).fill(countedText);
    await countLineForm.getByRole('button', { name: 'Add count line', exact: true }).click();
  });

  await openCount();
  const draftLine = card(page, countReference)
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: itemName, exact: true }) })
    .first();
  // Item | Expected | Counted | Variance. A DRAFT count must not pretend to know
  // its snapshot — both derived columns stay explicitly unfrozen.
  await expect(draftLine.getByRole('cell').nth(1)).toHaveText('Pending freeze');
  await expect(draftLine.getByRole('cell').nth(3)).toHaveText('Pending freeze');
  expect(await decimalOf(draftLine.getByRole('cell').nth(2), 'counted quantity')).toBeCloseTo(
    counted,
    6
  );

  await settleServerAction(page, ROUTES.inventory, async () => {
    await page.getByRole('button', { name: 'Submit and freeze count', exact: true }).click();
  });

  await openCount();
  const frozen = card(page, countReference);
  await expect(frozen.locator('[data-slot="status-pill"]').first()).toHaveText('SUBMITTED');
  const frozenLine = frozen
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: itemName, exact: true }) })
    .first();
  expect(
    await decimalOf(frozenLine.getByRole('cell').nth(1), 'frozen expected quantity'),
    'freezing must snapshot the on-hand position the console showed before the count'
  ).toBeCloseTo(expectedSnapshot, 6);
  expect(await decimalOf(frozenLine.getByRole('cell').nth(3), 'variance')).toBeCloseTo(
    variance.value,
    6
  );
  await expect(
    page.getByRole('button', { name: 'Submit and freeze count', exact: true })
  ).toHaveCount(0);

  await settleServerAction(page, ROUTES.inventory, async () => {
    await page.getByRole('button', { name: 'Post reconciliation', exact: true }).click();
  });

  await openCount();
  const posted = card(page, countReference);
  await expect(posted.locator('[data-slot="status-pill"]').first()).toHaveText('POSTED');
  await expect(posted).toContainText('This count is read-only.');
  await expect(page.getByRole('button', { name: 'Post reconciliation', exact: true })).toHaveCount(
    0
  );

  const adjustments = await movementQuantities(
    page,
    itemName,
    location.label,
    'PHYSICAL_COUNT_ADJUSTMENT'
  );
  expect(
    carries(adjustments, variance.value),
    'posting a non-zero variance must append exactly one PHYSICAL_COUNT_ADJUSTMENT movement ' +
      'carrying that variance'
  ).toHaveLength(1);
  expect(
    adjustments[0],
    'the newest adjustment movement must be the one this count posted'
  ).toBeCloseTo(variance.value, 6);

  const reconciled = await requireOnHand(page, itemName, location.label, 'after posting');
  expect(reconciled, 'a posted count makes derived stock equal the counted quantity').toBeCloseTo(
    counted,
    6
  );
});

/**
 * Scope, stated honestly. Every figure and every row on this page is projected
 * from one server snapshot, so nothing here re-proves stock arithmetic — that is
 * what the receipt and physical-count tests above do against the ledger. What
 * this case covers is the presentation contract: the headline figures agree with
 * the rows rendered beneath them, and each *derived* flag agrees with the number
 * it is derived from (`isNegative` ⇔ on hand < 0, `isTriggered` ⇔ on hand <
 * threshold). Those flags are computed separately from the amounts they describe,
 * so the comparison is a real one rather than a field against itself.
 *
 * It also refuses to pass on an empty organization. Against a seed with no
 * derived positions every figure is zero, every table is its empty state, and
 * each equality below holds trivially — a green result that proves nothing. The
 * prerequisite is asserted, not skipped.
 */
test('inventory summary figures agree with the rows and derived flags rendered beneath them', async ({
  page,
}) => {
  requireAdminActor();
  const origin = await signInAs(page, 'restaurantAdmin');
  await page.goto(new URL(ROUTES.inventory, origin).href);

  const summary = page.getByRole('region', { name: 'Inventory summary' });
  const statValue = async (label: string) => {
    const figure = summary
      .locator('[data-slot="stat"]')
      .filter({ hasText: label })
      .locator('.stat-figure');
    const raw = (await figure.innerText()).trim();
    const value = Number(raw);
    if (!Number.isInteger(value)) {
      throw new Error(`The "${label}" stat must publish a whole number, got "${raw}".`);
    }
    return value;
  };

  const stockOnHand = card(page, 'Stock on hand');
  const onHandRows = stockOnHand.locator('tbody tr');
  const trackedPositions = await statValue('Tracked positions');
  if (trackedPositions < 1) {
    throw new Error(
      'This organization renders no derived stock position, so the summary agreement below ' +
        'would hold vacuously. The fixture must supply at least one active ' +
        'restaurantStockLocation, at least one active restaurantStockItem (ingredient plus ' +
        'canonical unit), and at least one restaurantStockMovement against that item/location ' +
        'pair — a position is derived from the ledger, so seeding the item and location alone ' +
        'is not enough.'
    );
  }
  await expect(onHandRows).toHaveCount(trackedPositions);

  // Item | Location | On hand | Flag.
  for (let index = 0; index < trackedPositions; index += 1) {
    const row = onHandRows.nth(index);
    const onHand = await decimalOf(row.getByRole('cell').nth(2), 'on-hand position');
    await expect(
      row.locator('[data-slot="status-pill"]'),
      `the Negative flag must be set exactly when the position (${onHand}) is below zero`
    ).toHaveCount(onHand < 0 ? 1 : 0);
  }

  await expect(
    stockOnHand.locator('[data-slot="status-pill"]', { hasText: 'Negative' })
  ).toHaveCount(await statValue('Negative stock'));

  const lowStock = card(page, 'Low-stock rules');
  await expect(lowStock.locator('[data-slot="status-pill"]', { hasText: 'Low' })).toHaveCount(
    await statValue('Low-stock alerts')
  );

  // Low-stock rules are their own fixture row and this file may not seed one, so
  // the per-rule invariant is claimed only over the rules that exist. The count
  // agreement just above holds either way.
  if (!(await lowStock.getByText('No low-stock rules configured.', { exact: true }).count())) {
    const ruleRows = lowStock.locator('tbody tr');
    const ruleCount = await ruleRows.count();
    // Item | Location | Threshold | On hand | Status.
    for (let index = 0; index < ruleCount; index += 1) {
      const row = ruleRows.nth(index);
      const threshold = await decimalOf(row.getByRole('cell').nth(2), 'low-stock threshold');
      const onHand = await decimalOf(row.getByRole('cell').nth(3), 'rule on-hand position');
      await expect(
        row.locator('[data-slot="status-pill"]'),
        `a rule must read Low exactly when on hand (${onHand}) is under its threshold (${threshold})`
      ).toHaveText(onHand < threshold ? 'Low' : 'OK');
    }
  }

  // Transfers and wastage have no back-office creation surface — the console
  // only reads them — so the strongest browser claim available is that the
  // headline figure agrees with the persisted rows underneath it.
  const transfers = card(page, 'Stock transfers');
  const inFlight = transfers.getByRole('row').filter({
    has: page.locator('[data-slot="status-pill"]', { hasText: /^(?:DRAFT|DISPATCHED)$/ }),
  });
  await expect(inFlight).toHaveCount(await statValue('In-flight transfers'));

  await assertNoRawDatabaseIds(page);
});
