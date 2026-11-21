import { chooseSelectField, selectFieldNative } from './fixtures/select-field';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

import { TOUR_STEPS, tourTargetSelector } from '../../src/lib/demo/tour';

const REFUND_REASON = 'Demo sales E2E guest adjustment';
const STUDIO_VIEWPORTS = [
  { name: 'mobile-375', width: 375, height: 812 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'laptop-1024', width: 1024, height: 768 },
  { name: 'desktop-1440', width: 1440, height: 900 },
] as const;
const DEMO_E2E_SEAT = process.env.DEMO_E2E_SEAT?.trim() ?? '';
if (!/^[1-9]\d*$/.test(DEMO_E2E_SEAT) || !Number.isSafeInteger(Number(DEMO_E2E_SEAT))) {
  throw new Error('DEMO_E2E_SEAT is required and must be a positive safe integer.');
}

function requiredEnv(name: 'DEMO_ACCESS_CODE') {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the restaurant sales demo E2E.`);
  return value;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalized(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

async function tableHeaders(table: Locator) {
  return (await table.locator('thead th').allTextContents()).map(normalized);
}

async function mixedRecipeTable(scope: Locator) {
  const labels = scope.locator('p').filter({ hasText: /^Recipe lines$/ });
  for (let labelIndex = 0; labelIndex < (await labels.count()); labelIndex += 1) {
    const card = labels.nth(labelIndex).locator('xpath=ancestor::*[@data-slot="section-card"][1]');
    const tables = card.locator('table');
    for (let tableIndex = 0; tableIndex < (await tables.count()); tableIndex += 1) {
      const table = tables.nth(tableIndex);
      const headers = await tableHeaders(table);
      if (headers.slice(0, 4).join('|') !== 'source|quantity|unit|order') continue;
      const units = normalized(
        (await table.locator('tbody tr td:nth-child(3)').allTextContents()).join(' ')
      );
      if (
        /\b(?:g|gm|gram|grams)\b/.test(units) &&
        /\b(?:ml|millilitre|millilitres|milliliter|milliliters)\b/.test(units) &&
        /\b(?:pc|pcs|piece|pieces)\b/.test(units)
      ) {
        return table;
      }
    }
  }
  return null;
}

async function assertTourEvidence(stepId: (typeof TOUR_STEPS)[number]['id'], target: Locator) {
  await expect(target).toContainText(/\S/);
  if (stepId === 'pos-modifiers') {
    await expect(target.locator('[data-demo-modifier-group]').first()).toBeVisible();
  } else if (stepId === 'kds-ticket') {
    await expect(target).toContainText(/Order\s*#/i);
  } else if (stepId === 'floor-table') {
    await expect(target).toContainText(/table|seat|capacity|available|occupied/i);
  } else if (stepId === 'bill-settlement') {
    await expect(target).toContainText(/bill|balance|tender|receipt/i);
  } else if (stepId === 'daily-close' || stepId === 'inventory-low-stock') {
    await expect(target.locator('tbody tr').first()).toBeVisible();
  } else if (stepId === 'recipe-lines') {
    expect(
      await mixedRecipeTable(target),
      'Tour recipe must use a real mixed-unit table.'
    ).not.toBeNull();
  } else if (stepId === 'purchase-receipt') {
    await expect(target.getByRole('heading', { name: 'Receipt history' })).toBeVisible();
    await expect(target.locator('article').first()).toBeVisible();
  } else if (stepId === 'reports-overview') {
    for (const section of ['Overview', 'Inventory', 'Purchasing']) {
      await expect(target.getByText(section, { exact: true }).first()).toBeVisible();
    }
  }
}

async function enterDemo(page: Page, accessCode: string) {
  const response = await page.goto('/demo/restaurants');
  expect(response?.status(), 'Public demo entry route must be enabled.').toBe(200);
  await expect(page.getByRole('heading', { name: 'Restaurant demo' })).toBeVisible();

  const readySeats = page.locator('input[name="seat"]:not(:disabled)');
  await expect(
    readySeats.first(),
    'Fresh demo seed must expose at least one ready seat.'
  ).toBeEnabled();

  const selectedSeat = page.locator(`input[name="seat"][value="${DEMO_E2E_SEAT}"]`);
  await expect(selectedSeat, `Demo seat ${DEMO_E2E_SEAT} must be enabled.`).toBeEnabled();
  await selectedSeat.check();

  const code = page.getByLabel('Access code');
  await page.keyboard.press('Shift+Tab');
  await expect(
    code,
    'Access code must follow the selected seat in reverse tab order.'
  ).toBeFocused();
  expect(await code.evaluate((input) => getComputedStyle(input).boxShadow)).not.toBe('none');

  const rejected = page.waitForResponse(
    (response) =>
      response.url().endsWith('/demo/restaurants/access') && response.request().method() === 'POST'
  );
  await page.keyboard.type('__invalid_demo_access_code__');
  await page.keyboard.press('Enter');
  expect((await rejected).status()).toBe(401);
  await expect(page.locator('#demo-entry-error')).toContainText(/\S/);
  await expect(code).toHaveAttribute('aria-invalid', 'true');
  await expect(code).toHaveValue('__invalid_demo_access_code__');
  await expect(page.getByRole('button', { name: 'Enter restaurant demo' })).toBeEnabled();

  await code.fill(accessCode);
  await code.press('Enter');
  await page.waitForURL(/\/dashboard(?:[/?#]|$)/);
  await expect(page.getByRole('button', { name: 'Start tour' })).toBeVisible();
}

async function assertStudioVisualMatrix(page: Page, testInfo: TestInfo) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    true
  );

  for (const theme of ['light', 'dark'] as const) {
    await page.setViewportSize({ width: 1440, height: 900 });
    const html = page.locator('html');
    if ((await html.getAttribute('data-theme')) !== theme) {
      await page.goto('/dashboard');
      await page
        .getByRole('button', { name: theme === 'dark' ? 'Use dark theme' : 'Use light theme' })
        .click();
      await expect(html).toHaveAttribute('data-theme', theme);
      await page.goto('/pos');
      await expect(page.getByRole('heading', { name: 'Order pad' })).toBeVisible();
    }
    await expect(html).toHaveAttribute('data-theme', theme);

    for (const viewport of STUDIO_VIEWPORTS) {
      await page.setViewportSize(viewport);
      await expect(page.locator('main')).toBeVisible();
      const overflow = await page.evaluate(() => ({
        body: document.body.scrollWidth - document.body.clientWidth,
        document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      expect(
        overflow,
        `${viewport.width}px ${theme} Studio surface must not overflow the document.`
      ).toEqual({ body: 0, document: 0 });
      await page.screenshot({
        path: testInfo.outputPath(`studio-${viewport.name}-${theme}-reduced-motion.png`),
        animations: 'disabled',
      });
    }
  }
}

async function runTenStepTour(page: Page) {
  await page.getByRole('button', { name: 'Start tour' }).click();
  const visited: string[] = [];

  for (let index = 0; index < TOUR_STEPS.length; index += 1) {
    const step = TOUR_STEPS[index]!;
    const guide = page.getByRole('dialog', { name: step.title });
    await expect(guide).toBeVisible();
    const target = page.locator(tourTargetSelector(step));
    await expect(target, `Missing live tour target for ${step.id}.`).toBeVisible();
    await assertTourEvidence(step.id, target);
    visited.push(step.id);

    if (index === 1) {
      await guide.getByRole('button', { name: 'Collapse guide' }).click();
      await expect(guide.getByRole('button', { name: 'Show guide' })).toBeVisible();
      await expect(guide.getByRole('button', { name: 'End tour' })).toBeVisible();
    }

    await guide
      .getByRole('button', {
        name: index === TOUR_STEPS.length - 1 ? 'Finish' : 'Next',
        exact: true,
      })
      .click();
  }

  expect(visited).toEqual(TOUR_STEPS.map(({ id }) => id));
  await expect(page.getByRole('dialog', { name: TOUR_STEPS.at(-1)!.title })).toHaveCount(0);
}

async function openOrder(page: Page) {
  await page.goto('/pos');
  await expect(page.getByLabel('Channel')).toHaveValue('DINE_IN');
  const table = page.locator('input[type="checkbox"]:enabled').first();
  await expect(table, 'Fresh demo seed must expose a selectable floor table.').toBeVisible();
  await table.check();
  await page.getByLabel('Covers').fill('2');

  const openedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/restaurant/orders/open') &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Open order' }).click();
  const response = await openedResponse;
  expect(response.status()).toBe(201);
  const opened = (await response.json()) as { orderId?: unknown; orderNumber?: unknown };
  if (typeof opened.orderId !== 'string' || !Number.isInteger(opened.orderNumber)) {
    throw new Error('Order-open response did not include a real order id and number.');
  }
  await expect(
    page.getByText(`Order ${opened.orderNumber} opened.`, { exact: true })
  ).toBeVisible();
  return { orderId: opened.orderId, orderNumber: Number(opened.orderNumber) };
}

async function addModifiedItem(page: Page) {
  const menu = page.locator('[data-tour="pos-order"]');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-demo-modifier-item="false"]')).toHaveCount(0);
  const items = menu.locator('button[data-demo-modifier-item="true"]');
  expect(await items.count(), 'Fresh demo menu must expose enabled items.').toBeGreaterThan(0);

  let itemName = '';
  let modifierName = '';
  for (let itemIndex = 0; itemIndex < (await items.count()); itemIndex += 1) {
    const item = items.nth(itemIndex);
    if (!(await item.isEnabled())) continue;
    await item.click();
    const groups = menu.locator('fieldset');
    if ((await groups.count()) === 0) continue;

    itemName = (await item.locator('span').first().innerText()).trim();
    for (let groupIndex = 0; groupIndex < (await groups.count()); groupIndex += 1) {
      const group = groups.nth(groupIndex);
      const options = group.locator('input[type="checkbox"], input[type="radio"]');
      const minimum = Number(
        /required\s*·\s*choose\s+(\d+)/i.exec(await group.innerText())?.[1] ?? 1
      );
      expect(
        await options.count(),
        `Modifier group ${groupIndex + 1} must expose selectable options.`
      ).toBeGreaterThanOrEqual(minimum);
      for (let optionIndex = 0; optionIndex < Math.max(1, minimum); optionIndex += 1) {
        const option = options.nth(optionIndex);
        if (optionIndex === 0 && !modifierName) {
          modifierName = (await option.locator('xpath=ancestor::label[1]').innerText())
            .replace(/\+\s*[\d,.]+.*$/, '')
            .trim();
        }
        await option.check();
      }
    }
    break;
  }

  if (!itemName || !modifierName) {
    throw new Error('Fresh demo menu has no enabled item with real modifier controls.');
  }
  await page.getByLabel('Quantity').fill('2');
  await page.getByLabel('Seat', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Add to order' }).click();
  const line = page.getByRole('listitem').filter({ hasText: itemName });
  await expect(line).toContainText(`2 × ${itemName}`);
  await expect(line).toContainText(modifierName);
  await page.getByRole('button', { name: 'Send whole order' }).click();
  await expect(page.getByText('Order sent to kitchen.')).toBeVisible();
  return { itemName, modifierName };
}

async function prepareInKds(
  page: Page,
  orderNumber: number,
  itemName: string,
  modifierName: string
) {
  await page.goto('/kds');
  const ticket = page.getByRole('article').filter({ hasText: `Order #${orderNumber}` });
  await expect(ticket, 'KDS must receive the exact submitted POS order.').toBeVisible();
  await expect(ticket).toContainText(itemName);
  await expect(ticket).toContainText(modifierName);
  await ticket
    .getByRole('button', {
      name: new RegExp(`Start ${escapeRegExp(itemName)} for order ${orderNumber}`),
    })
    .click();
  await expect(page.getByText('Item started.')).toBeVisible();
  await ticket
    .getByRole('button', {
      name: new RegExp(`Mark ready ${escapeRegExp(itemName)} for order ${orderNumber}`),
    })
    .click();
  await expect(page.getByText('Item marked ready.')).toBeVisible();
}

async function settleSplitCardBills(page: Page, orderNumber: number) {
  await page.goto('/pos');
  await page.getByRole('button', { name: new RegExp(`^#${orderNumber} ·`) }).click();
  const order = page
    .getByText(`Order ${orderNumber}`, { exact: true })
    .locator('xpath=ancestor::*[@data-slot="section-card"][1]');
  await expect(order.getByText('PREPARED', { exact: true })).toBeVisible();
  await order.getByRole('button', { name: 'Mark served' }).click();
  await order.getByRole('button', { name: 'Close order' }).click();

  const checkout = page.getByRole('dialog', { name: 'Collect payment' });
  await expect(checkout).toBeVisible();
  await checkout.getByRole('button', { name: 'Split bill' }).click();
  await page.getByLabel('Split method').selectOption('FRACTIONAL');
  await page.getByLabel('Fractional weights').fill('1,1');
  await page.getByRole('button', { name: 'Create split bills' }).click();
  await expect(checkout.getByText('FRACTIONAL')).toHaveCount(2);

  const receipts = checkout.getByRole('region', { name: /^Receipt \d+$/ });
  let cardAmount = '';
  for (let settled = 1; settled <= 2; settled += 1) {
    const bill = checkout
      .getByText('FRACTIONAL', { exact: true })
      .first()
      .locator('xpath=ancestor::*[@data-slot="section-card"][1]');
    await expect(bill.getByText('OPEN', { exact: true })).toBeVisible();
    await bill.getByLabel('Tender type').selectOption('CARD');
    const amount = bill.getByLabel('Amount');
    const value = await bill
      .locator('dt', { hasText: /^Bill total$/ })
      .locator('xpath=following-sibling::dd[1]')
      .innerText();
    expect(Number(value), 'Each split bill must have a positive displayed total.').toBeGreaterThan(
      0
    );
    await amount.fill(value);
    if (!cardAmount) cardAmount = value;
    const tenderResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/restaurant/checkout/tender') &&
        response.request().method() === 'POST'
    );
    await bill.getByRole('button', { name: 'Apply tender' }).click();
    expect((await tenderResponse).status()).toBe(200);
    await expect(receipts).toHaveCount(settled);
  }
  await checkout.getByRole('button', { name: 'Close checkout' }).click();
  await expect(checkout).toHaveCount(0);
  return cardAmount;
}

async function refundCardTender(page: Page, orderNumber: number, cardAmount: string) {
  const refundableResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/restaurant/checkout/refund') &&
      response.request().method() === 'GET'
  );
  await page.getByRole('button', { name: 'Refund' }).click();
  const response = await refundableResponse;
  expect(response.status()).toBe(200);
  const payload = (await response.json()) as {
    tenders?: Array<{ tenderId?: unknown; orderNumber?: unknown; type?: unknown }>;
  };
  const tender = payload.tenders?.find(
    (candidate) => candidate.orderNumber === orderNumber && candidate.type === 'CARD'
  );
  if (!tender || typeof tender.tenderId !== 'string') {
    throw new Error(`Refund list did not contain a CARD tender for order ${orderNumber}.`);
  }

  const dialog = page.getByRole('dialog', { name: 'Refund settled payment' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Settled receipt').selectOption(tender.tenderId);
  await dialog.getByLabel('Refund amount').fill(Math.min(1, Number(cardAmount)).toFixed(2));
  await dialog.getByLabel('Reason').fill(REFUND_REASON);
  const demoApprover = dialog.getByRole('combobox', {
    name: 'Demo approving manager',
    exact: true,
  });
  await expect(demoApprover).toBeVisible();
  const approvingStaffProfileId = await demoApprover.inputValue();
  expect(
    approvingStaffProfileId,
    'Demo refund must auto-select a distinct approving manager.'
  ).not.toBe('');
  await expect(dialog.getByLabel('Manager PIN', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Review refund' }).click();
  await expect(dialog.getByText('Confirm destructive refund')).toBeVisible();

  const posted = page.waitForResponse(
    (refundResponse) =>
      refundResponse.url().endsWith('/api/restaurant/checkout/refund') &&
      refundResponse.request().method() === 'POST'
  );
  await dialog.getByRole('button', { name: 'Confirm refund' }).click();
  const refundResponse = await posted;
  expect(refundResponse.status()).toBe(200);
  const refundRequest = refundResponse.request().postDataJSON() as {
    approving?: { staffProfileId?: unknown; type?: unknown; secret?: unknown };
  };
  expect(refundRequest.approving).toEqual({
    staffProfileId: approvingStaffProfileId,
    type: 'DEMO',
  });
  expect(refundRequest.approving).not.toHaveProperty('secret');
  await expect(dialog.getByText('refund recorded', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  return tender.tenderId;
}

async function assertMockPaymentAndRefund(page: Page, tenderId: string) {
  await page.goto('/restaurant/money');
  const branch = page
    .getByRole('combobox', { name: 'Branch', exact: true })
    .and(page.locator(':enabled'));
  const branchId = await (
    await selectFieldNative(branch)
  )
    .locator('option:enabled:not([value=""])')
    .first()
    .getAttribute('value');
  expect(branchId, 'Money must expose an enabled branch.').toBeTruthy();
  await chooseSelectField(branch, branchId!);
  await page.getByRole('tab', { name: 'Payments' }).click();
  const tenderRow = page
    .getByRole('region', { name: 'Payment tenders table' })
    .getByRole('row')
    .filter({ hasText: tenderId });
  await expect(tenderRow).toBeVisible();
  await tenderRow.getByRole('button', { name: /View payment/ }).click();
  await expect(page.getByText('MOCK', { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'Payment refunds table' })
      .getByRole('row')
      .filter({ hasText: tenderId })
      .filter({ hasText: REFUND_REASON })
  ).toBeVisible();
}

async function assertCatalogAndRecipe(page: Page) {
  await page.goto('/restaurant/catalog');
  await page.getByRole('tab', { name: /^Units \(\d+\)$/ }).click();
  const conversionCard = page
    .getByRole('heading', { name: /^\d+ conversions?$/i })
    .locator('xpath=ancestor::*[@data-slot="section-card"][1]');
  await expect(conversionCard).toBeVisible();
  const conversionRows = conversionCard.locator('tbody tr');
  let conversionFound = false;
  for (let index = 0; index < (await conversionRows.count()); index += 1) {
    const cells = (await conversionRows.nth(index).locator('td').allTextContents()).map(normalized);
    if (
      /^(?:g|gm|gram|grams)$/.test(cells[0] ?? '') &&
      /^(?:kg|kilogram|kilograms)$/.test(cells[1] ?? '') &&
      /^0\.001(?:0+)?$/.test(cells[2] ?? '')
    ) {
      conversionFound = true;
      break;
    }
  }
  expect(conversionFound, 'Units must contain a real gram-to-kilogram 0.001 row.').toBe(true);

  await page.getByRole('tab', { name: /^Recipes \(\d+\)$/ }).click();
  const recipes = page
    .getByRole('heading', { name: /^\d+ recipes?$/i })
    .locator('xpath=ancestor::*[@data-slot="section-card"][1]');
  const actions = recipes.getByRole('button', { name: 'Manage versions' });
  expect(await actions.count(), 'Fresh demo seed must expose versioned recipes.').toBeGreaterThan(
    0
  );

  let proof: Locator | null = null;
  for (let index = 0; index < (await actions.count()); index += 1) {
    await actions.nth(index).click();
    proof = await mixedRecipeTable(page.locator('body'));
    if (proof) break;
  }
  expect(proof, 'No managed recipe exposed gram, millilitre, and piece Unit cells.').not.toBeNull();
  await expect(proof!).toBeVisible();
}

async function receivePurchaseOrder(page: Page) {
  await page.goto('/restaurant/purchasing');
  const status = /^(?:APPROVED|PARTIALLY[ _]RECEIVED)$/i;
  const receivableRows = page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: status }) });
  await expect(
    receivableRows.first(),
    'Fresh demo seed must expose an approved or partially received purchase order.'
  ).toBeVisible();
  await receivableRows
    .first()
    .getByRole('link', { name: /Review|Selected/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Receive stock' })).toBeVisible();

  const reference = `DEMO-E2E-${Date.now()}`;
  await page.getByLabel('Received quantity').first().fill('1');
  await page.getByLabel('Receipt reference').fill(reference);
  await page.getByRole('button', { name: 'Receive purchase order' }).click();
  await expect(page.getByRole('status')).toContainText('Receipt posted.');
  const history = page.getByRole('heading', { name: 'Receipt history' }).locator('..');
  await expect(history).toContainText(reference);
}

async function assertReports(page: Page) {
  await page.goto('/restaurant/reports');
  const reports = page.locator('[data-tour="reports-overview"]:visible');
  await expect(reports).toBeVisible();
  for (const section of ['Overview', 'Inventory', 'Purchasing']) {
    await expect(reports.getByText(section, { exact: true }).first()).toBeVisible();
  }
  await expect(reports).toContainText(/\d/);
}

test('public restaurant demo completes its ten-stop sales workflow with real operations', async ({
  page,
}, testInfo) => {
  const accessCode = requiredEnv('DEMO_ACCESS_CODE');
  const clientErrors: string[] = [];
  page.on('console', (message) => {
    const expectedAccessRejection =
      message.location().url.endsWith('/demo/restaurants/access') && /\b401\b/.test(message.text());
    if (message.type() === 'error' && !expectedAccessRejection) {
      clientErrors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => clientErrors.push(`runtime: ${error.message}`));

  await enterDemo(page, accessCode);
  await runTenStepTour(page);

  const opened = await openOrder(page);
  const item = await addModifiedItem(page);
  await prepareInKds(page, opened.orderNumber, item.itemName, item.modifierName);
  const cardAmount = await settleSplitCardBills(page, opened.orderNumber);
  const refundedTender = await refundCardTender(page, opened.orderNumber, cardAmount);
  await assertMockPaymentAndRefund(page, refundedTender);
  await assertCatalogAndRecipe(page);
  await receivePurchaseOrder(page);
  await assertReports(page);
  await page.goto('/pos');
  await expect(page.getByRole('heading', { name: 'Order pad' })).toBeVisible();
  await assertStudioVisualMatrix(page, testInfo);
  expect(clientErrors, 'Workflow and Studio matrix must emit no console/runtime errors.').toEqual(
    []
  );
});
