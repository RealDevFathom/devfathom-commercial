import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

import {
  assertTerminalSecretIsBrowserIsolated,
  e2eIdempotencyKey,
  establishDeliveryPosFixture,
  establishPosFixture,
  installSeededTerminalCookie,
  restaurantE2eCredentials as fixture,
  terminalBrowserBaseUrl,
  type RestaurantTerminalFixture,
} from './restaurant-fixture';

/**
 * WHA-1235 — front-of-house lifecycle acceptance, integrated Restaurant lane.
 *
 * SCOPE: dine-in / takeaway / delivery order composition, modifiers, send-to-kitchen,
 * the KDS transitions this candidate has no browser evidence for, and the board's
 * history edge (a ticket leaving the queue). Every scenario STOPS at the unpaid
 * check. Payment, printing and offline behaviour are deliberately out of scope.
 *
 * DELIBERATE REUSE — these flows are already proven and are NOT re-asserted here:
 *   - dine-in open → modifier → send → KDS Start/Mark ready → Mark served → split
 *     tender → refund → drawer/day close: `restaurant-pos-kds.spec.ts` lines 115-221
 *     (KDS Start/ready) and 222-241 (split + tender).
 *   - delivery COD/PREPAID dispatch, fee snapshot and fee reporting:
 *     `restaurant-delivery.spec.ts` (`openVisibleDelivery`, `readyVisible`,
 *     `handoffVisible`, `refreshDeliveryBoard`).
 *   - KDS offline/stale queue, dropped-mutation idempotency and gap reconciliation:
 *     `restaurant-pos-kds-resilience.spec.ts`.
 *   - seven-persona login handoff and capability denials:
 *     `restaurant-demo-perspectives.spec.ts` (different, demo-seat fixture).
 *   - POS offline queue replay: `restaurant-lifecycles-final.spec.ts` lines 147-231.
 *
 * NEW COVERAGE (each one has no executable assertion anywhere in tests/):
 *   1. Course HOLD after a send: the line returns to HELD and is no longer workable
 *      from the kitchen, then FIRE makes it workable again (`orders/hold`,
 *      `orders/fire` with a course; `KDS_DISPLAY_BY_ITEM_STATUS.HELD`).
 *   2. KDS recall: PREPARED → FIRING → PREPARED. `kds/recall` targets `FIRING`
 *      (`KDS_ACTION_TRANSITIONS.RECALL`, `src/lib/restaurant/kds.ts`), which
 *      `KDS_DISPLAY_BY_ITEM_STATUS` shows as COOKING — so a recalled line returns
 *      to the COOKING lane and is bumped ready again from there. The board's
 *      RECALLED lane maps only from `REMAKE_REQUESTED`, which is reachable solely
 *      through the POS `orders/remake` clone workflow; that separate path is NOT
 *      this scenario and is not asserted here.
 *   3. The board's history edge: a served ticket and a cancelled ticket both leave
 *      the station queue, and the kitchen ticket survives on the order record.
 *   4. The unpaid-check terminus: SERVED → "Close order" PARKS the order at
 *      PAYMENT_PENDING with `blocker = NO_BILLS` instead of closing it.
 *   5. Dine-in table occupancy is taken by the open check and released on cancel.
 *   6. Delivery composition stays local until guest + address + zone are chosen —
 *      no order request is issued while the guard is unsatisfied — and the submit
 *      then issues the real three-call sequence: `orders/open`, one
 *      `orders/add-item` per composed line, then `orders/delivery/attach`.
 *
 * WHY NO BILL IS CUT: `assertReadyToClose` in `src/lib/restaurant/daily-close.ts`
 * refuses a daily close while any bill for the date is OPEN. Cutting an unpaid bill
 * here would break the day-close assertions in `restaurant-pos-kds.spec.ts` and
 * `restaurant-delivery.spec.ts`, which share this lane's database. The unpaid check
 * is therefore proven at the state the register actually parks it in: order
 * PAYMENT_PENDING, zero bills, the item still unbilled. Every scenario that can be
 * reversed (no post-prep item) cancels its own order, so those three leave the
 * shared seed as they found it.
 *
 * SCENARIO 2 IS NOT CLEANED UP — it deliberately persists as operational unbilled
 * demand: a non-CANCELLED order at PAYMENT_PENDING with one live SERVED item and no
 * bill. It leaves no table link, no bill and no drawer session, so `assertReadyToClose`
 * (which gates only on open bills and open drawers) and the close aggregate are both
 * unaffected. But `close-readiness.ts` counts exactly this shape — non-CANCELLED, a
 * non-VOIDED item, no live bill — as `UNBILLED_ORDERS`, so branch A1's operational
 * handover evidence for that business date gains exactly +1 per run of this file.
 * That is intended residue, not a leak: no spec under `tests/e2e/` asserts that
 * reader today, and the check is genuinely unpaid work the floor still owes.
 *
 * FIXTURE CONTRACT (all of it pre-existing; this spec creates no fixture):
 *   - `RESTAURANT_INTEGRATED_E2E=1`, a seeded `DATABASE_URL`, and the app served by
 *     `playwright.restaurant-integrated.config.ts` (globalSetup enrols the KDS).
 *   - `scripts/seed-restaurant-e2e.ts`: org `org_chai_chowk`; branch A1 with POS +
 *     KDS devices, floor `Table 12`, menu item "Chicken Tikka Bun" (12.50) and the
 *     "Spicy" modifier (+1.50); operator PIN role with `orders:take` +
 *     `payments:collect`; branch A2 with the delivery POS/KDS devices, the
 *     `E2E Guest` customer, its saved address and the isolated delivery zone.
 *   - The seed's `expected.twoItemTotal` (28.00) proves the seeded branch applies no
 *     tax or service uplift, so one modified unit is exactly 14.00 — derived below
 *     rather than hard-coded.
 *
 * EXECUTION REQUIREMENT (not yet satisfied — do not assume these tests have run):
 * `playwright.restaurant-integrated.config.ts` matches an explicit per-file list.
 * This file must be added to that `testMatch` array as
 * `'restaurant-foh-lifecycle-acceptance.spec.ts'` before it can execute. That config
 * is shared with other active lanes and is NOT edited here.
 */

if (process.env.RESTAURANT_INTEGRATED_E2E !== '1') {
  throw new Error(
    'RESTAURANT_INTEGRATED_E2E=1 is required; run this file through playwright.restaurant-integrated.config.ts.'
  );
}

test.describe.configure({ mode: 'serial' });

/** One modified unit of the seeded menu item, derived from the seeded money. */
const SINGLE_UNIT_TOTAL = (
  Number(fixture.menuItem.unitPrice) + Number(fixture.modifier.delta)
).toFixed(2);

type QueueItem = { orderItemId: string; name: string; displayStatus: string };
type QueueTicket = {
  ticketId: string;
  ticketNumber: number;
  orderId: string;
  orderNumber: number;
  displayStatus: string;
  items: QueueItem[];
};
type QueuePayload = { tickets: QueueTicket[] };
type OpenedOrder = { orderId: string; orderNumber: number };

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function unlockPos(
  page: Page,
  device: { deviceId: string; secret: string; clientIp: string } = fixture.pos,
  staff: { staffProfileId: string; pin: string } = fixture.operator
) {
  const origin = terminalBrowserBaseUrl();
  await installSeededTerminalCookie(page.context(), device, origin);
  await page.goto(new URL('/pos', origin).href);
  await expect(page.getByRole('heading', { name: 'Terminal locked' })).toBeVisible();
  await page.getByLabel('Operator', { exact: true }).selectOption(staff.staffProfileId);
  await page.getByLabel('Operator PIN', { exact: true }).fill(staff.pin);
  const unlocked = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/restaurant/terminal/unlock') &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Unlock terminal' }).click();
  expect((await unlocked).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Order pad' })).toBeVisible();
  await assertTerminalSecretIsBrowserIsolated(page, device.secret);
}

async function connectKds(
  browser: Browser,
  contexts: BrowserContext[],
  device: { deviceId: string; secret: string; clientIp: string } = fixture.kds,
  staff: { staffProfileId: string; pin: string } = fixture.operator
) {
  const origin = terminalBrowserBaseUrl();
  const context = await browser.newContext({ baseURL: origin });
  contexts.push(context);
  await installSeededTerminalCookie(context, device, origin);
  const page = await context.newPage();
  await page.goto(new URL('/kds', origin).href);
  await page.getByLabel('Acting operator').selectOption(staff.staffProfileId);
  await page.getByLabel('Operator PIN', { exact: true }).fill(staff.pin);
  const unlocked = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/restaurant/terminal/unlock') &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Verify PIN and unlock' }).click();
  expect((await unlocked).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Kitchen floor' })).toBeVisible();
  await assertTerminalSecretIsBrowserIsolated(page, device.secret);
  return page;
}

/**
 * Wait for a real station-queue response that satisfies `matches`, nudging the
 * board's own bounded poll with the `online` event it already listens for. No
 * request is intercepted, stubbed or replayed: the payload asserted here is the
 * server's, read through the console's own transport.
 */
async function queueThatSatisfies(
  kdsPage: Page,
  matches: (queue: QueuePayload) => boolean,
  description: string
) {
  const pending = kdsPage.waitForResponse(
    async (response) => {
      if (
        !response.url().includes('/api/restaurant/kds/queue') ||
        response.request().method() !== 'GET' ||
        response.status() !== 200
      ) {
        return false;
      }
      return matches((await response.json()) as QueuePayload);
    },
    { timeout: 40_000 }
  );
  await kdsPage.evaluate(() => window.dispatchEvent(new Event('online')));
  const queue = (await (await pending).json()) as QueuePayload;
  expect(matches(queue), description).toBe(true);
  return queue;
}

function ticketFor(queue: QueuePayload, orderNumber: number) {
  return queue.tickets.filter((ticket) => ticket.orderNumber === orderNumber);
}

function itemStatuses(queue: QueuePayload, orderNumber: number) {
  return ticketFor(queue, orderNumber).flatMap((ticket) =>
    ticket.items.map((item) => item.displayStatus)
  );
}

/** Submit the already-composed "Open order" form. The caller owns the channel. */
async function openOrder(page: Page) {
  const openedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/restaurant/orders/open') &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Open order' }).click();
  const response = await openedResponse;
  expect(response.status()).toBe(201);
  const opened = (await response.json()) as OpenedOrder;
  await expect(
    page.getByText(`Order ${opened.orderNumber} opened.`, { exact: true })
  ).toBeVisible();
  return opened;
}

/** Add one modified unit to the OPEN order and send the whole order to the kitchen. */
async function addModifiedUnitAndSend(page: Page, seat?: string) {
  await page.getByRole('button', { name: new RegExp(escapeRegExp(fixture.menuItem.name)) }).click();
  await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).fill('1');
  await page.getByLabel('Course', { exact: true }).fill('1');
  if (seat) await page.getByLabel('Seat', { exact: true }).fill(seat);
  await page.getByLabel(new RegExp(escapeRegExp(fixture.modifier.name))).check();
  await page.getByRole('button', { name: 'Add to order' }).click();
  const line = page.getByRole('listitem').filter({ hasText: `1 × ${fixture.menuItem.name}` });
  await expect(line).toBeVisible();
  await expect(line.getByText(fixture.modifier.name, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Send whole order' }).click();
  await expect(page.getByText('Order sent to kitchen.', { exact: true })).toBeVisible();
}

async function orderDetail(
  request: APIRequestContext,
  terminal: RestaurantTerminalFixture,
  orderId: string
) {
  const response = await request.get(
    `/api/restaurant/orders/detail?orderId=${encodeURIComponent(orderId)}`,
    { headers: terminal.headers }
  );
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as {
    id: string;
    status: string;
    channel: string;
    items: Array<{ id: string; status: string; modifiers: Array<{ name: string }> }>;
    kitchenTickets: Array<{ id: string; ticketNumber: number }>;
    tables: Array<{ tableId: string; active: boolean }>;
  };
}

async function cancelOrder(
  request: APIRequestContext,
  terminal: RestaurantTerminalFixture,
  order: OpenedOrder,
  reason: string
) {
  const response = await request.post('/api/restaurant/orders/cancel', {
    headers: {
      ...terminal.headers,
      'Idempotency-Key': e2eIdempotencyKey('foh-acceptance-cancel', order.orderNumber),
    },
    data: { orderId: order.orderId, reason },
  });
  expect(response.status(), await response.text()).toBe(200);
}

test('a held course leaves the kitchen queue unworkable until it is fired again', async ({
  page,
  browser,
  request,
}) => {
  test.slow();
  const contexts: BrowserContext[] = [];
  const terminal = await establishPosFixture(request);
  let opened: OpenedOrder | null = null;
  try {
    await unlockPos(page);
    // Takeaway is a first-class channel: it must not demand the dine-in floor controls.
    await page.getByLabel('Channel').selectOption('TAKEAWAY');
    await expect(page.getByLabel('Floor section')).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: /Table 12/ })).toHaveCount(0);

    opened = await openOrder(page);
    await addModifiedUnitAndSend(page);

    const kdsPage = await connectKds(browser, contexts);
    const orderNumber = opened.orderNumber;
    const startButton = kdsPage
      .getByRole('button', {
        name: new RegExp(
          `^Start ${escapeRegExp(fixture.menuItem.name)} for order ${orderNumber}\\b`
        ),
      })
      .first();

    const sent = await queueThatSatisfies(
      kdsPage,
      (queue) => itemStatuses(queue, orderNumber).includes('NEW'),
      `order ${orderNumber} must reach the station queue as NEW`
    );
    expect(ticketFor(sent, orderNumber).length).toBeGreaterThan(0);
    await expect(startButton).toBeVisible();

    // HOLD: the sent course is pulled back before the kitchen starts it.
    await page.getByRole('button', { name: 'Hold', exact: true }).first().click();
    await expect(page.getByText('Course 1 held.', { exact: true })).toBeVisible();
    const held = await queueThatSatisfies(
      kdsPage,
      (queue) =>
        itemStatuses(queue, orderNumber).length > 0 &&
        itemStatuses(queue, orderNumber).every((status) => status === 'HELD'),
      `order ${orderNumber} must project as HELD once the course is held`
    );
    expect(ticketFor(held, orderNumber).length).toBeGreaterThan(0);
    // A held line must not be startable from the kitchen, in any lane.
    await expect(
      kdsPage.getByRole('button', {
        name: new RegExp(
          `^Start ${escapeRegExp(fixture.menuItem.name)} for order ${orderNumber}\\b`
        ),
      })
    ).toHaveCount(0);

    // FIRE: the same course becomes workable again.
    await page.getByRole('button', { name: 'Fire', exact: true }).first().click();
    await expect(page.getByText('Course 1 fired.', { exact: true })).toBeVisible();
    await queueThatSatisfies(
      kdsPage,
      (queue) => itemStatuses(queue, orderNumber).includes('NEW'),
      `order ${orderNumber} must return to NEW once the course is fired`
    );
    await expect(startButton).toBeVisible();

    const beforeCancel = await orderDetail(request, terminal, opened.orderId);
    expect(beforeCancel.channel).toBe('TAKEAWAY');
    expect(beforeCancel.items).toHaveLength(1);
    expect(beforeCancel.items[0]!.status).toBe('QUEUED');
    expect(beforeCancel.kitchenTickets.length).toBeGreaterThan(0);

    // History edge: an abandoned check is cancelled and its work leaves the board.
    await cancelOrder(request, terminal, opened, 'FOH acceptance: abandoned takeaway check');
    opened = null;
    const afterCancel = await orderDetail(request, terminal, beforeCancel.id);
    expect(afterCancel.status).toBe('CANCELLED');
    expect(afterCancel.items[0]!.status).toBe('VOIDED');
    // The ticket itself survives on the order record; only the live queue clears.
    expect(afterCancel.kitchenTickets.length).toBeGreaterThan(0);
    await queueThatSatisfies(
      kdsPage,
      (queue) => ticketFor(queue, orderNumber).length === 0,
      `cancelled order ${orderNumber} must leave the station queue`
    );
  } finally {
    if (opened) {
      await cancelOrder(
        request,
        terminal,
        opened,
        'FOH acceptance cleanup: unfinished hold/fire check'
      ).catch(() => undefined);
    }
    await Promise.allSettled(contexts.map((context) => context.close()));
  }
});

test('a recalled ready item returns to the kitchen and the served check parks unpaid', async ({
  page,
  browser,
  request,
}) => {
  test.slow();
  const contexts: BrowserContext[] = [];
  const terminal = await establishPosFixture(request);
  try {
    await unlockPos(page);
    await page.getByLabel('Channel').selectOption('TAKEAWAY');
    const opened = await openOrder(page);
    const orderNumber = opened.orderNumber;
    await addModifiedUnitAndSend(page);

    const kdsPage = await connectKds(browser, contexts);
    const kdsButton = (label: 'Start' | 'Mark ready' | 'Recall') =>
      kdsPage
        .getByRole('button', {
          name: new RegExp(
            `^${label} ${escapeRegExp(fixture.menuItem.name)} for order ${orderNumber}\\b`
          ),
        })
        .first();

    await queueThatSatisfies(
      kdsPage,
      (queue) => itemStatuses(queue, orderNumber).includes('NEW'),
      `order ${orderNumber} must reach the station queue as NEW`
    );
    await kdsButton('Start').click();
    await expect(kdsPage.getByText('Item started.', { exact: true })).toBeVisible();
    await kdsButton('Mark ready').click();
    await expect(kdsPage.getByText('Item marked ready.', { exact: true })).toBeVisible();
    expect(
      itemStatuses(
        await queueThatSatisfies(
          kdsPage,
          (queue) => itemStatuses(queue, orderNumber).includes('READY'),
          `order ${orderNumber} must project as READY after the bump`
        ),
        orderNumber
      )
    ).toEqual(['READY']);

    // RECALL: the kitchen pulls a ready line back to the range. The recall targets
    // FIRING, so the line leaves the READY lane and reappears under COOKING — the
    // same lane an acknowledged line occupies. The board's RECALLED lane is not
    // entered: that display belongs to REMAKE_REQUESTED, which only the POS remake
    // path produces.
    await kdsButton('Recall').click();
    await expect(kdsPage.getByText('Item recalled.', { exact: true })).toBeVisible();
    const recalled = await queueThatSatisfies(
      kdsPage,
      (queue) => itemStatuses(queue, orderNumber).includes('COOKING'),
      `order ${orderNumber} must project back as COOKING after the recall`
    );
    expect(ticketFor(recalled, orderNumber).map((ticket) => ticket.displayStatus)).toEqual([
      'COOKING',
    ]);
    const duringRecall = await orderDetail(request, terminal, opened.orderId);
    expect(duringRecall.items[0]!.status).toBe('FIRING');

    // The recalled line is workable again and bumps ready through the COOKING action.
    // The intervening "Item recalled." notice above proves this confirmation is the
    // second bump's, not the first one's still on screen.
    await kdsButton('Mark ready').click();
    await expect(kdsPage.getByText('Item marked ready.', { exact: true })).toBeVisible();
    await queueThatSatisfies(
      kdsPage,
      (queue) => itemStatuses(queue, orderNumber).includes('READY'),
      `order ${orderNumber} must return to READY once the recall is resolved`
    );

    await page.bringToFront();
    // The resume button also carries the running subtotal, so the name is not anchored.
    await page.getByRole('button', { name: new RegExp(`#${orderNumber} · 1 item\\b`) }).click();
    await expect(page.getByText('PREPARED', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Mark served', exact: true }).click();
    await expect(page.getByText('Item marked served.', { exact: true })).toBeVisible();

    // History edge: a fully served ticket leaves the live board.
    await queueThatSatisfies(
      kdsPage,
      (queue) => ticketFor(queue, orderNumber).length === 0,
      `served order ${orderNumber} must leave the station queue`
    );

    // Terminus: the unpaid check. "Close order" parks, it does not close.
    await page.getByRole('button', { name: 'Close order', exact: true }).click();
    await expect(page.getByText('Order ready for payment.', { exact: true })).toBeVisible();
    const checkout = page.getByRole('dialog', { name: 'Collect payment' });
    await expect(checkout).toBeVisible();
    await expect(checkout.getByText('No bills have been cut.', { exact: true })).toBeVisible();
    await expect(checkout.getByText('1 unbilled item', { exact: true })).toBeVisible();
    await expect(checkout.getByRole('button', { name: 'Cut single bill' })).toBeEnabled();
    // Nothing is paid: no receipt exists and no tender control is reachable yet.
    await expect(checkout.getByRole('region', { name: /^Receipt \d+$/ })).toHaveCount(0);
    await expect(checkout.getByLabel('Tender type')).toHaveCount(0);

    const parked = await orderDetail(request, terminal, opened.orderId);
    expect(parked.status).toBe('PAYMENT_PENDING');
    expect(parked.items[0]!.status).toBe('SERVED');
    expect(parked.kitchenTickets.length).toBeGreaterThan(0);

    const summaryResponse = await request.get(
      `/api/restaurant/checkout/summary?orderId=${encodeURIComponent(opened.orderId)}`,
      { headers: terminal.headers }
    );
    expect(summaryResponse.status()).toBe(200);
    const summary = (await summaryResponse.json()) as {
      settled: boolean;
      blocker: string | null;
      derivedOrderTotal: string;
      bills: unknown[];
      unbilledItemIds: string[];
    };
    expect(summary.settled).toBe(false);
    expect(summary.blocker).toBe('NO_BILLS');
    expect(summary.bills).toEqual([]);
    expect(summary.unbilledItemIds).toEqual([parked.items[0]!.id]);
    expect(summary.derivedOrderTotal).toBe(SINGLE_UNIT_TOTAL);

    // Stop here: tendering is restaurant-pos-kds.spec.ts's proof, not this lane's.
    await page.getByRole('button', { name: 'Close checkout' }).click();
    await expect(page.getByRole('dialog', { name: 'Collect payment' })).toHaveCount(0);
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()));
  }
});

test('a dine-in table is held by its open check and released when the check is cancelled', async ({
  page,
  request,
}) => {
  const terminal = await establishPosFixture(request);
  let opened: OpenedOrder | null = null;
  try {
    await unlockPos(page);
    await page.getByLabel('Channel').selectOption('DINE_IN');
    const table = page.getByRole('checkbox', { name: /Table 12/ });
    await expect(table).toBeEnabled();
    await table.check();
    await page.getByLabel('Covers').fill('2');
    opened = await openOrder(page);

    // The floor refreshes off the server, so the table reads occupied to the next server.
    await expect(page.getByRole('checkbox', { name: /Table 12/ })).toBeDisabled();
    await expect(page.getByText('Occupied', { exact: true }).first()).toBeVisible();

    const held = await orderDetail(request, terminal, opened.orderId);
    expect(held.channel).toBe('DINE_IN');
    expect(held.tables.map(({ tableId, active }) => ({ tableId, active }))).toEqual([
      { tableId: fixture.table.id, active: true },
    ]);
    expect(held.items).toEqual([]);

    await cancelOrder(request, terminal, opened, 'FOH acceptance: mis-opened dine-in check');
    const released = await orderDetail(request, terminal, opened.orderId);
    opened = null;
    expect(released.status).toBe('CANCELLED');
    expect(released.tables.every((link) => link.active === false)).toBe(true);

    // The server sees the table free again without reseating anything by hand.
    await unlockPos(page);
    await page.getByLabel('Channel').selectOption('DINE_IN');
    await expect(page.getByRole('checkbox', { name: /Table 12/ })).toBeEnabled();
  } finally {
    if (opened) {
      await cancelOrder(
        request,
        terminal,
        opened,
        'FOH acceptance cleanup: unfinished dine-in check'
      ).catch(() => undefined);
    }
  }
});

test('delivery composition stays local until the guest, address and zone are chosen', async ({
  page,
  browser,
  request,
}) => {
  test.slow();
  const contexts: BrowserContext[] = [];
  const terminal = await establishDeliveryPosFixture(request);
  const orderRequests: string[] = [];
  let opened: OpenedOrder | null = null;
  try {
    page.on('request', (outgoing) => {
      const path = new URL(outgoing.url()).pathname;
      if (outgoing.method() === 'POST' && path.startsWith('/api/restaurant/orders/')) {
        orderRequests.push(path);
      }
    });
    await unlockPos(page, fixture.delivery.pos, fixture.deliveryOperator);
    await page.getByLabel('Channel').selectOption('DELIVERY');
    const submit = page.getByRole('button', { name: 'Open order' });
    await expect(submit).toBeDisabled();

    // Composing a line before a guest is chosen must stay entirely local.
    await page
      .getByRole('button', { name: new RegExp(escapeRegExp(fixture.menuItem.name)) })
      .click();
    await page.getByLabel(new RegExp(escapeRegExp(fixture.modifier.name))).check();
    await page.getByRole('button', { name: 'Add to order' }).click();
    await expect(page.getByText(/added locally\. No request was sent\./)).toBeVisible();
    await expect(submit).toBeDisabled();
    expect(orderRequests).toEqual([]);

    await page.getByLabel('Customer name').fill(fixture.customer.name);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page
      .getByRole('button', { name: new RegExp(escapeRegExp(fixture.customer.name)) })
      .click();
    await expect(page.getByLabel('Saved address')).toHaveValue(fixture.delivery.addressId);
    await expect(page.getByLabel('Delivery zone')).toHaveValue(fixture.delivery.zoneId);
    await expect(submit).toBeEnabled();

    const openedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/restaurant/orders/open') &&
        response.request().method() === 'POST'
    );
    await submit.click();
    expect((await openedResponse).status()).toBe(201);
    opened = (await (await openedResponse).json()) as OpenedOrder;
    await expect(
      page.getByText(`Delivery order ${opened.orderNumber} opened and fulfillment attached.`, {
        exact: true,
      })
    ).toBeVisible();
    // The delivery submit is a three-call server sequence, not one call: open the
    // order, push each locally composed line, then attach the fulfillment. All three
    // complete before the notice above is set, and the reads that follow them are
    // GETs, so the recorder holds exactly the sequence — one add-item for one line.
    expect(orderRequests).toEqual([
      '/api/restaurant/orders/open',
      '/api/restaurant/orders/add-item',
      '/api/restaurant/orders/delivery/attach',
    ]);

    await page.getByRole('button', { name: 'Send whole order' }).click();
    await expect(page.getByText('Order sent to kitchen.', { exact: true })).toBeVisible();

    const kdsPage = await connectKds(
      browser,
      contexts,
      fixture.delivery.kds,
      fixture.deliveryOperator
    );
    const orderNumber = opened.orderNumber;
    const queued = await queueThatSatisfies(
      kdsPage,
      (queue) => itemStatuses(queue, orderNumber).includes('NEW'),
      `delivery order ${orderNumber} must reach the delivery station queue as NEW`
    );
    expect(ticketFor(queued, orderNumber).length).toBeGreaterThan(0);
    const ticket = kdsPage
      .getByRole('article')
      .filter({ hasText: new RegExp(`Order #${orderNumber}\\b`) })
      .first();
    await expect(ticket).toContainText(fixture.menuItem.name);
    await expect(ticket).toContainText(fixture.modifier.name);

    const detail = await orderDetail(request, terminal, opened.orderId);
    expect(detail.channel).toBe('DELIVERY');
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]!.modifiers.map((modifier) => modifier.name)).toEqual([
      fixture.modifier.name,
    ]);

    // Dispatch, delivery and settlement are restaurant-delivery.spec.ts's proof.
    await cancelOrder(request, terminal, opened, 'FOH acceptance: delivery composition proof');
    const cancelled = await orderDetail(request, terminal, opened.orderId);
    opened = null;
    expect(cancelled.status).toBe('CANCELLED');
    await queueThatSatisfies(
      kdsPage,
      (queue) => ticketFor(queue, orderNumber).length === 0,
      `cancelled delivery order ${orderNumber} must leave the station queue`
    );
  } finally {
    if (opened) {
      await cancelOrder(
        request,
        terminal,
        opened,
        'FOH acceptance cleanup: unfinished delivery check'
      ).catch(() => undefined);
    }
    await Promise.allSettled(contexts.map((context) => context.close()));
  }
});
