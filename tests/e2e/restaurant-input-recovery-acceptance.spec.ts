import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import {
  assertTerminalSecretIsBrowserIsolated,
  e2eIdempotencyKey,
  establishTerminalFixture,
  installSeededTerminalCookie,
  restaurantE2eCredentials as fixture,
  type RestaurantTerminalFixture,
} from './restaurant-fixture';

/**
 * WHA-1240 — tablet, touch, keyboard and order-recovery acceptance for POS, KDS and
 * the floor picker.
 *
 * Fixture contract (execution prerequisites — this file FAILS, it never skips, when
 * they are absent):
 *   - the integrated Restaurant lane server (`RESTAURANT_INTEGRATED_E2E=1`,
 *     `bunx next start`) fronted by the seeded database from
 *     `scripts/seed-restaurant-e2e.ts`. Every credential, device, table, menu item and
 *     modifier comes from `restaurantE2eCredentials`; nothing is invented here;
 *   - `baseURL` from the running config — asserted per test, because
 *     `installSeededTerminalCookie` must pin the terminal cookie to the same origin;
 *   - registration in `playwright.restaurant-integrated.config.ts` `testMatch`, which
 *     lists spec files one by one: without the entry
 *     `'restaurant-input-recovery-acceptance.spec.ts'` this file collects ZERO tests in
 *     that lane. That config is shared and is not edited from here.
 *
 * Persistence is read back from the server (`/api/restaurant/orders/detail`) using an
 * independently established terminal session, never from the DOM the surface under
 * test just rendered — so a lost or duplicated order line is detected as a change in
 * the persisted item ids, not as a re-render.
 *
 * Deliberately NOT re-covered here (existing executable coverage, left unchanged):
 *   - offline draft queue + exactly-once replay of `orders/open`:
 *     `restaurant-lifecycles-final.spec.ts` ('POS preserves an offline order …');
 *   - dropped KDS mutation retried under one idempotency key, KDS stale-state/gap
 *     recovery: `restaurant-pos-kds-resilience.spec.ts`;
 *   - axe WCAG sweeps, theme matrix and the mocked viewport matrix:
 *     `restaurant-pos-kds-accessibility.spec.ts` (that matrix runs against
 *     `page.route` mocks; this file runs the same surfaces against real data);
 *   - split tender, refund and daily close: `restaurant-pos-kds.spec.ts`.
 *   Tender retry and a broad WCAG audit are out of scope for this lane.
 *
 * Branch A seeds exactly one POS device, so the "two staff on one order" case is two
 * independent terminal sessions on that device (waiter = operator, cashier = manager)
 * rather than two physical devices — the seeded branch A2 POS belongs to another
 * branch and is 404-isolated from these orders by design.
 */

const TABLET_VIEWPORTS = [
  { name: 'landscape', width: 1024, height: 768 },
  { name: 'portrait', width: 768, height: 1024 },
] as const;

/** Touch target floor in CSS px, measured on the element a finger actually lands on. */
const MIN_TOUCH_TARGET = 44;

type PersistedOrderItem = {
  id: string;
  course: number;
  seatNumber: number | null;
  name: string;
  quantity: number;
  status: string;
  modifiers: Array<{ id: string; modifierOptionId: string; name: string; priceDelta: string }>;
};

type PersistedOrder = {
  id: string;
  orderNumber: number;
  status: string;
  channel: string;
  items: PersistedOrderItem[];
};

type OpenedOrder = { orderId: string; orderNumber: number };

/**
 * Orders opened by a test, cancelled in afterEach so no test leaves a live order on the
 * shared seed.
 *
 * Cancellation is forward-only, not a restoration: `cancelOrder` voids every unresolved
 * line (`status: 'VOIDED'`, `voidedPostPrep`, `voidReason`, and for post-prep lines a
 * `wastageDisposition` plus a persisted manager co-authorization), writes an
 * `item.voided` audit event per line, and leaves the order row behind as `CANCELLED`.
 * The order-number sequence stays consumed. So the seed is left *closed out*, with those
 * VOIDED, audit, wastage and sequence records intentionally preserved — never pristine.
 * Assertions here must therefore be written against live (non-voided) lines and against
 * ids, never against "the seed contains nothing but its own rows".
 */
const openedOrders: Array<{ orderId: string; postPrep: boolean }> = [];

/**
 * Terminal transports run a pre-auth per-IP throttle (`terminal-auth.ts`:
 * `IP_LIMIT = 120` per 60 s fixed window, keyed on the first `x-forwarded-for`
 * hop). `restaurantE2eCredentials.pos` pins ONE synthetic address, so in the
 * serial integrated lane every case in this file — and every sibling spec that
 * drives the same device — spends the same bucket back to back. A single case
 * here issues only ~20-60 requests, well inside the limit; the aggregate is what
 * exceeds it, and the 429 then surfaces as an unrelated-looking assertion
 * failure ("Expected 201, Received 429") partway through whichever case is
 * unlucky.
 *
 * Each case therefore presents its own client address, which is what a room of
 * real tablets would do. The guard itself is untouched — it is a product
 * control and stays at its shipped limit — and the device-level gate
 * (`DEVICE_LIMIT = 240`) still applies unchanged to the shared seeded device.
 *
 * `.65`+ is used so these can never collide with the fixture's own `.10`-`.14`
 * or with the project-bucketed `.1`+ addresses in
 * `restaurant-actor-accessibility.spec.ts`.
 */
const CASE_CLIENT_IP_BASE = 65;
let caseClientIp = `198.51.100.${CASE_CLIENT_IP_BASE}`;
let caseIndex = 0;

test.beforeEach(() => {
  caseClientIp = `198.51.100.${CASE_CLIENT_IP_BASE + caseIndex}`;
  caseIndex += 1;
});

/**
 * The per-case address above is necessary but NOT sufficient, and the aggregate
 * 429 this file used to fail on came from a different guard.
 * `POST /api/restaurant/terminal/unlock` fronts the durable credential lockout
 * with its own burst limit, `terminal:cred:<deviceId>:<staffProfileId>`, 10 per
 * 60 s. That key carries no client address at all, so every case in this file
 * sharing ONE seeded register and ONE operator emptied it partway through the
 * file no matter which address the request came from.
 *
 * Each case therefore drives its own enrolled register — `fixture.caseRegisters`,
 * seeded one per case, which is what a room of real tablets is. Neither guard is
 * touched: both keep their shipped limit, window and key, and each register still
 * gets only its own ten unlock attempts.
 */
function casePosDevice() {
  const register = fixture.caseRegisters[caseIndex - 1];
  if (!register) {
    throw new Error(
      `No seeded per-case register for case index ${caseIndex - 1}; raise RESTAURANT_E2E.caseTerminalCount.`
    );
  }
  return { ...register, clientIp: caseClientIp };
}

/** The seeded KDS device, presented from this case's own client address. */
function caseKdsDevice() {
  return { ...fixture.kds, clientIp: caseClientIp };
}

function establishCasePos(request: APIRequestContext) {
  return establishTerminalFixture(request, casePosDevice());
}

async function readOrder(
  request: APIRequestContext,
  terminal: RestaurantTerminalFixture,
  orderId: string
): Promise<PersistedOrder> {
  const response = await request.get(
    `/api/restaurant/orders/detail?orderId=${encodeURIComponent(orderId)}`,
    { headers: terminal.headers }
  );
  expect(response.status(), `order detail readback: ${await response.text()}`).toBe(200);
  return (await response.json()) as PersistedOrder;
}

/** Live (non-voided) lines for one menu item — the lost/duplicate line detector. */
function liveLines(order: PersistedOrder, name: string): PersistedOrderItem[] {
  return order.items.filter((item) => item.name === name && item.status !== 'VOIDED');
}

function lineIds(order: PersistedOrder, name: string): string[] {
  return liveLines(order, name)
    .map((item) => item.id)
    .sort();
}

/**
 * Tablet layout probe for one surface: document/scope horizontal overflow, touch
 * targets, and text clipped by an ancestor that is not intentionally truncating.
 * A checkbox is measured through its wrapping `<label>`, because that is the box a
 * finger hits and what toggles the control.
 */
async function assertTabletLayout(page: Page, scope: string, label: string) {
  const findings = await page.evaluate(
    ({ rootSelector, minTarget }) => {
      const root = document.querySelector(rootSelector);
      if (!root) return { missingRoot: true } as const;

      const isVisible = (element: Element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return (
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          box.width > 0 &&
          box.height > 0
        );
      };
      const describe = (element: Element) =>
        element.getAttribute('aria-label') ||
        (element.textContent ?? '').trim().slice(0, 60) ||
        element.id ||
        element.tagName;

      const smallTargets = [
        ...root.querySelectorAll('button, input, select, textarea, a[href], [role="button"]'),
      ]
        .filter(isVisible)
        .map((element) => {
          const box = (element.closest('label') ?? element).getBoundingClientRect();
          return {
            name: describe(element),
            width: Math.round(box.width),
            height: Math.round(box.height),
          };
        })
        .filter(({ width, height }) => width < minTarget || height < minTarget);

      const clipped = [...root.querySelectorAll<HTMLElement>('*')]
        .filter((element) => {
          if (!isVisible(element)) return false;
          const ownsText = [...element.childNodes].some(
            (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim().length > 0
          );
          if (!ownsText) return false;
          const style = getComputedStyle(element);
          if (style.textOverflow === 'ellipsis' || style.webkitLineClamp !== 'none') return false;
          const clipsX = style.overflowX === 'hidden' || style.overflowX === 'clip';
          const clipsY = style.overflowY === 'hidden' || style.overflowY === 'clip';
          return (
            (clipsX && element.scrollWidth > element.clientWidth + 1) ||
            (clipsY && element.scrollHeight > element.clientHeight + 1)
          );
        })
        .map((element) => describe(element));

      return {
        missingRoot: false as const,
        documentOverflow:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
        scopeOverflow: root.scrollWidth - root.clientWidth,
        smallTargets,
        clipped,
      };
    },
    { rootSelector: scope, minTarget: MIN_TOUCH_TARGET }
  );

  expect(findings.missingRoot, `${label}: ${scope} was not rendered`).toBe(false);
  if (findings.missingRoot) return;
  expect(findings.documentOverflow, `${label}: document horizontal scroll`).toBeLessThanOrEqual(1);
  expect(findings.scopeOverflow, `${label}: ${scope} horizontal scroll`).toBeLessThanOrEqual(1);
  expect(
    findings.smallTargets,
    `${label}: targets under ${MIN_TOUCH_TARGET}px — ${JSON.stringify(findings.smallTargets)}`
  ).toEqual([]);
  expect(findings.clipped, `${label}: clipped text — ${JSON.stringify(findings.clipped)}`).toEqual(
    []
  );
}

async function unlockPos(
  page: Page,
  staff: { staffProfileId: string; pin: string },
  activate: 'tap' | 'click' = 'click'
) {
  await expect(page.getByRole('heading', { name: 'Terminal locked' })).toBeVisible();
  await page.getByLabel('Operator', { exact: true }).selectOption(staff.staffProfileId);
  await page.getByLabel('Operator PIN', { exact: true }).fill(staff.pin);
  const unlock = page.getByRole('button', { name: 'Unlock terminal' });
  await expect(unlock).toBeEnabled();
  if (activate === 'tap') await unlock.tap();
  else await unlock.click();
  await expect(page.getByRole('heading', { name: 'Order pad' })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(fixture.menuItem.name) })).toBeVisible();
  // The secret checked here must be the one this browser was actually handed —
  // `casePosDevice()`'s, not the shared register's, which would pass vacuously
  // because it was never installed in this context to begin with.
  await assertTerminalSecretIsBrowserIsolated(page, casePosDevice().secret);
}

/**
 * Open a takeaway order from the order pad. Takeaway keeps the single seeded dine-in
 * table free for the sibling specs that need it, and it takes the direct
 * `orders/open` path (a draft line would divert into the offline queue covered
 * elsewhere).
 */
async function openTakeawayOrder(page: Page, activate: 'tap' | 'click' = 'click') {
  await page.getByLabel('Channel').selectOption('TAKEAWAY');
  const openedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/restaurant/orders/open') &&
      response.request().method() === 'POST'
  );
  const open = page.getByRole('button', { name: 'Open order' });
  if (activate === 'tap') await open.tap();
  else await open.click();
  const response = await openedResponse;
  expect(response.status(), `orders/open: ${await response.text()}`).toBe(201);
  const opened = (await response.json()) as OpenedOrder;
  await expect(
    page.getByText(`Order ${opened.orderNumber} opened.`, { exact: true })
  ).toBeVisible();
  openedOrders.push({ orderId: opened.orderId, postPrep: false });
  return opened;
}

/**
 * Add the seeded menu item (its "Heat" group is minSelect 1, so Spicy is required).
 *
 * The tile's accessible name is "<item> <price>" (`menu-grid.tsx` renders the name and
 * the price as two spans in one button), so the item can only be addressed by a partial
 * name match. Page-wide, that partial match is ambiguous the moment a line is on the
 * ticket: `order-ticket-panel.tsx` renders a destructive `Void <item>` button per line,
 * which contains the same text. Every control below is therefore resolved inside the
 * effective-menu card — `MenuGrid`'s `data-tour="pos-order"` root, the only element with
 * that attribute on /pos — which owns the tiles, the modifier checkboxes and the submit
 * button and never renders a ticket line. Strict mode is left intact: a genuinely
 * ambiguous match must fail the test, so this deliberately does not reach for `first()`.
 */
async function addSeededLine(page: Page, activate: 'tap' | 'click' = 'click') {
  const menu = page.locator('[data-tour="pos-order"]');
  const item = menu.getByRole('button', { name: new RegExp(fixture.menuItem.name) });
  const modifier = menu.getByLabel(new RegExp(fixture.modifier.name));
  const submit = menu.getByRole('button', { name: 'Add to order' });
  if (activate === 'tap') {
    await item.tap();
    await modifier.tap();
    await submit.tap();
  } else {
    await item.click();
    await modifier.check();
    await submit.click();
  }
}

function ticketPanel(page: Page, orderNumber: number) {
  return page
    .locator('[data-slot="section-card"]')
    .filter({ has: page.getByRole('heading', { name: `Order ${orderNumber}`, exact: true }) });
}

function openOrderButton(page: Page, orderNumber: number, itemCount: number) {
  const suffix = itemCount === 1 ? 'item' : 'items';
  return page.getByRole('button', {
    name: new RegExp(`^#${orderNumber} · ${itemCount} ${suffix}`),
  });
}

test.afterEach(async ({ request }) => {
  const pending = openedOrders.splice(0);
  if (pending.length === 0) return;
  const terminal = await establishCasePos(request);
  for (const entry of pending) {
    const response = await request.post('/api/restaurant/orders/cancel', {
      headers: {
        ...terminal.headers,
        'Idempotency-Key': e2eIdempotencyKey('input-recovery-cancel', entry.orderId),
      },
      data: {
        orderId: entry.orderId,
        reason: 'WHA-1240 tablet/keyboard acceptance cleanup',
        ...(entry.postPrep
          ? {
              wastageDisposition: 'WASTE',
              approving: {
                staffProfileId: fixture.manager.staffProfileId,
                type: 'PIN',
                secret: fixture.manager.pin,
              },
            }
          : {}),
      },
    });
    expect(response.status(), `cleanup cancel ${entry.orderId}: ${await response.text()}`).toBe(
      200
    );
    expect((await readOrder(request, terminal, entry.orderId)).status).toBe('CANCELLED');
  }
});

for (const viewport of TABLET_VIEWPORTS) {
  test(`POS on a ${viewport.name} tablet takes a touch-only order that persists exactly once`, async ({
    browser,
    baseURL,
    request,
  }) => {
    test.slow();
    expect(baseURL, 'the integrated restaurant lane must supply a baseURL').toBeTruthy();
    const terminal = await establishCasePos(request);
    const context = await browser.newContext({
      baseURL,
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: true,
    });

    try {
      await installSeededTerminalCookie(context, casePosDevice(), baseURL);
      const page = await context.newPage();
      await page.goto('/pos');
      await assertTabletLayout(page, 'main#pos-main', `POS lock screen ${viewport.name}`);

      await unlockPos(page, fixture.operator, 'tap');
      await assertTabletLayout(page, 'main#pos-main', `POS order pad ${viewport.name}`);

      // Floor picker: the seeded dine-in table renders inside its floor fieldset and is
      // reachable by touch. It is read here only — occupying it would strand the single
      // seeded table for the sibling dine-in specs.
      await expect(page.getByLabel('Channel')).toHaveValue('DINE_IN');
      const seededTable = page.locator('label').filter({ hasText: fixture.table.name });
      await expect(seededTable).toHaveCount(1);
      await expect(seededTable).toContainText(/4 seats|Occupied/);
      await expect(page.getByLabel('Floor section')).toBeVisible();

      const opened = await openTakeawayOrder(page, 'tap');
      await addSeededLine(page, 'tap');
      await expect(page.getByText('Item added.')).toBeVisible();
      await expect(page.getByText(`1 × ${fixture.menuItem.name}`)).toBeVisible();
      await assertTabletLayout(page, 'main#pos-main', `POS active order ${viewport.name}`);

      const persisted = await readOrder(request, terminal, opened.orderId);
      const lines = liveLines(persisted, fixture.menuItem.name);
      expect(lines, `one touch-added line, got ${JSON.stringify(persisted.items)}`).toHaveLength(1);
      expect(lines[0].quantity).toBe(1);
      expect(lines[0].modifiers.map((modifier) => modifier.name)).toEqual([fixture.modifier.name]);

      // A destructive modal must stay usable on the narrow edge: inside the viewport,
      // dismissable, and non-mutating when dismissed.
      await ticketPanel(page, opened.orderNumber)
        .getByRole('button', { name: `Void ${fixture.menuItem.name}` })
        .tap();
      const dialog = page.getByRole('dialog', { name: `Void ${fixture.menuItem.name}` });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('Void reason')).toBeVisible();
      const dialogBox = await dialog.boundingBox();
      expect(dialogBox, 'the void dialog must have a measurable box').not.toBeNull();
      expect(dialogBox!.width, `void dialog width at ${viewport.name}`).toBeLessThanOrEqual(
        viewport.width
      );
      expect(dialogBox!.height, `void dialog height at ${viewport.name}`).toBeLessThanOrEqual(
        viewport.height
      );
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);

      const afterDismiss = await readOrder(request, terminal, opened.orderId);
      expect(lineIds(afterDismiss, fixture.menuItem.name)).toEqual(
        lineIds(persisted, fixture.menuItem.name)
      );
    } finally {
      await context.close();
    }
  });
}

for (const viewport of TABLET_VIEWPORTS) {
  test(`KDS on a ${viewport.name} tablet advances a real ticket by touch`, async ({
    browser,
    baseURL,
    request,
  }) => {
    test.slow();
    expect(baseURL, 'the integrated restaurant lane must supply a baseURL').toBeTruthy();
    const terminal = await establishCasePos(request);

    // Build the ticket through the real terminal commands so the KDS surface — not the
    // order pad — is what the touch assertions exercise.
    const menuResponse = await request.get(
      '/api/restaurant/orders/effective-menu?channel=TAKEAWAY',
      { headers: terminal.headers }
    );
    expect(menuResponse.status(), `effective-menu: ${await menuResponse.text()}`).toBe(200);
    const menu = (await menuResponse.json()) as {
      publicationId: string;
      sections: Array<{
        items: Array<{ id: string; displayName: string | null; product: { name: string } }>;
      }>;
    };
    const menuItem = menu.sections
      .flatMap((section) => section.items)
      .find((item) => (item.displayName ?? item.product.name) === fixture.menuItem.name);
    expect(menuItem, `the seeded menu must publish ${fixture.menuItem.name}`).toBeDefined();

    const openResponse = await request.post('/api/restaurant/orders/open', {
      headers: {
        ...terminal.headers,
        'Idempotency-Key': e2eIdempotencyKey(
          `input-recovery-kds-open-${viewport.name}`,
          Date.now()
        ),
      },
      data: { channel: 'TAKEAWAY', publicationId: menu.publicationId },
    });
    expect(openResponse.status(), `orders/open: ${await openResponse.text()}`).toBe(201);
    const opened = (await openResponse.json()) as OpenedOrder;
    const cleanup = { orderId: opened.orderId, postPrep: true };
    openedOrders.push(cleanup);

    const addResponse = await request.post('/api/restaurant/orders/add-item', {
      headers: {
        ...terminal.headers,
        'Idempotency-Key': e2eIdempotencyKey('input-recovery-kds-line', opened.orderId),
      },
      data: {
        orderId: opened.orderId,
        menuItemId: menuItem!.id,
        quantity: 1,
        course: 1,
        modifierOptionIds: [fixture.modifier.optionId],
      },
    });
    expect(addResponse.status(), `orders/add-item: ${await addResponse.text()}`).toBe(201);
    const fireResponse = await request.post('/api/restaurant/orders/fire', {
      headers: {
        ...terminal.headers,
        'Idempotency-Key': e2eIdempotencyKey('input-recovery-kds-fire', opened.orderId),
      },
      data: { orderId: opened.orderId },
    });
    expect(fireResponse.status(), `orders/fire: ${await fireResponse.text()}`).toBe(200);

    const context = await browser.newContext({
      baseURL,
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: true,
    });
    try {
      await installSeededTerminalCookie(context, caseKdsDevice(), baseURL);
      const page = await context.newPage();
      await page.goto('/kds');
      await assertTabletLayout(page, 'main#kds-main', `KDS lock screen ${viewport.name}`);

      await page.getByLabel('Acting operator').selectOption(fixture.operator.staffProfileId);
      await page.getByLabel('Operator PIN', { exact: true }).fill(fixture.operator.pin);
      await page.getByRole('button', { name: 'Verify PIN and unlock' }).tap();
      await expect(page.getByRole('heading', { name: 'Kitchen floor' })).toBeVisible();
      await assertTerminalSecretIsBrowserIsolated(page, fixture.kds.secret);

      await expect(page.getByText(`Order #${opened.orderNumber}`)).toBeVisible();
      await assertTabletLayout(page, 'main#kds-main', `KDS queue ${viewport.name}`);

      await page
        .getByRole('button', {
          name: `Start ${fixture.menuItem.name} for order ${opened.orderNumber}`,
        })
        .tap();
      await expect(page.getByText('Item started.')).toBeVisible();
      await page
        .getByRole('button', {
          name: `Mark ready ${fixture.menuItem.name} for order ${opened.orderNumber}`,
        })
        .tap();
      await expect(page.getByText('Item marked ready.')).toBeVisible();

      const persisted = await readOrder(request, terminal, opened.orderId);
      const lines = liveLines(persisted, fixture.menuItem.name);
      expect(
        lines,
        `touch bumps must not fan out the line: ${JSON.stringify(persisted.items)}`
      ).toHaveLength(1);
      expect(lines[0].status).toBe('PREPARED');
    } finally {
      await context.close();
    }
  });
}

test('a keyboard-only operator opens an order and adds a line with no pointer input', async ({
  page,
  baseURL,
  request,
}) => {
  test.slow();
  expect(baseURL, 'the integrated restaurant lane must supply a baseURL').toBeTruthy();
  const terminal = await establishCasePos(request);
  await installSeededTerminalCookie(page.context(), casePosDevice(), baseURL);
  await page.goto('/pos');
  await unlockPos(page, fixture.operator);

  await page.getByLabel('Channel').selectOption('TAKEAWAY');

  // From here the order is driven by the keyboard alone; any pointer event would mean
  // the assertion below is measuring a mouse, not keyboard operability.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __wha1240Pointer: string[] }).__wha1240Pointer = seen;
    for (const type of ['mousedown', 'pointerdown', 'touchstart']) {
      window.addEventListener(
        type,
        (event) => seen.push(`${type}:${(event.target as Element | null)?.tagName ?? 'unknown'}`),
        true
      );
    }
  });

  /** Tab until `locator` holds focus; fails clearly when it is not tab-reachable. */
  async function tabTo(locator: Locator, label: string, maxTabs = 80) {
    const focused = async () => locator.evaluate((element) => element === document.activeElement);
    for (let pressed = 0; pressed < maxTabs; pressed += 1) {
      if (await focused()) {
        expect(
          await page.evaluate(() => document.activeElement?.matches(':focus-visible') ?? false),
          `${label} must show a visible keyboard focus state`
        ).toBe(true);
        return;
      }
      await page.keyboard.press('Tab');
    }
    expect(await focused(), `${label} was not reachable within ${maxTabs} Tab presses`).toBe(true);
  }

  await page.getByLabel('Channel').selectOption('TAKEAWAY');
  const openedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/restaurant/orders/open') &&
      response.request().method() === 'POST'
  );
  await tabTo(page.getByRole('button', { name: 'Open order' }), 'Open order');
  await page.keyboard.press('Enter');
  const response = await openedResponse;
  expect(response.status(), `orders/open: ${await response.text()}`).toBe(201);
  const opened = (await response.json()) as OpenedOrder;
  await expect(
    page.getByText(`Order ${opened.orderNumber} opened.`, { exact: true })
  ).toBeVisible();
  openedOrders.push({ orderId: opened.orderId, postPrep: false });

  await tabTo(
    page.getByRole('button', { name: new RegExp(fixture.menuItem.name) }),
    fixture.menuItem.name
  );
  await page.keyboard.press('Enter');
  await tabTo(page.getByLabel(new RegExp(fixture.modifier.name)), fixture.modifier.name);
  await page.keyboard.press('Space');
  await expect(page.getByLabel(new RegExp(fixture.modifier.name))).toBeChecked();
  await tabTo(page.getByRole('button', { name: 'Add to order' }), 'Add to order');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Item added.')).toBeVisible();

  const pointerEvents = await page.evaluate(
    () => (window as unknown as { __wha1240Pointer: string[] }).__wha1240Pointer
  );
  expect(pointerEvents, 'the keyboard path must not depend on pointer input').toEqual([]);

  const persisted = await readOrder(request, terminal, opened.orderId);
  const lines = liveLines(persisted, fixture.menuItem.name);
  expect(lines, `one keyboard-added line, got ${JSON.stringify(persisted.items)}`).toHaveLength(1);
  expect(lines[0].modifiers.map((modifier) => modifier.name)).toEqual([fixture.modifier.name]);
});

test('a waiter and a cashier working the same order never duplicate or drop a line', async ({
  browser,
  baseURL,
  request,
}) => {
  test.slow();
  expect(baseURL, 'the integrated restaurant lane must supply a baseURL').toBeTruthy();
  const terminal = await establishCasePos(request);
  const waiterContext = await browser.newContext({ baseURL });
  const cashierContext = await browser.newContext({ baseURL });

  try {
    await installSeededTerminalCookie(waiterContext, casePosDevice(), baseURL);
    await installSeededTerminalCookie(cashierContext, casePosDevice(), baseURL);
    const waiter = await waiterContext.newPage();
    const cashier = await cashierContext.newPage();

    await waiter.goto('/pos');
    await unlockPos(waiter, fixture.operator);
    const opened = await openTakeawayOrder(waiter);
    await addSeededLine(waiter);
    await expect(waiter.getByText('Item added.')).toBeVisible();

    // The cashier is a second, independently unlocked session bound to the manager.
    await cashier.goto('/pos');
    await unlockPos(cashier, fixture.manager);
    await expect(openOrderButton(cashier, opened.orderNumber, 1)).toBeVisible();
    await openOrderButton(cashier, opened.orderNumber, 1).click();
    const cashierTicket = ticketPanel(cashier, opened.orderNumber);
    await expect(cashierTicket.getByRole('listitem')).toHaveCount(1);
    await expect(cashierTicket.getByRole('listitem')).toContainText(`1 × ${fixture.menuItem.name}`);

    // The cashier adds the second line; the waiter must converge on two lines, not three.
    await addSeededLine(cashier);
    await expect(cashier.getByText('Item added.')).toBeVisible();
    await expect(cashierTicket.getByRole('listitem')).toHaveCount(2);

    await waiter.getByRole('button', { name: 'Refresh' }).click();
    await expect(openOrderButton(waiter, opened.orderNumber, 2)).toBeVisible();
    await openOrderButton(waiter, opened.orderNumber, 2).click();
    const waiterTicket = ticketPanel(waiter, opened.orderNumber);
    await expect(waiterTicket.getByRole('listitem')).toHaveCount(2);

    const persisted = await readOrder(request, terminal, opened.orderId);
    const lines = liveLines(persisted, fixture.menuItem.name);
    expect(
      lines,
      `two sessions must persist exactly two lines: ${JSON.stringify(persisted.items)}`
    ).toHaveLength(2);
    expect(new Set(lines.map((line) => line.id)).size).toBe(2);
  } finally {
    await waiterContext.close();
    await cashierContext.close();
  }
});

test('reloading mid-order relocks the terminal and resumes the same persisted lines', async ({
  page,
  baseURL,
  request,
}) => {
  test.slow();
  expect(baseURL, 'the integrated restaurant lane must supply a baseURL').toBeTruthy();
  const terminal = await establishCasePos(request);
  await installSeededTerminalCookie(page.context(), casePosDevice(), baseURL);
  await page.goto('/pos');
  await unlockPos(page, fixture.operator);

  const opened = await openTakeawayOrder(page);
  await addSeededLine(page);
  await expect(page.getByText('Item added.')).toBeVisible();
  const before = await readOrder(request, terminal, opened.orderId);
  expect(liveLines(before, fixture.menuItem.name)).toHaveLength(1);

  await page.reload();

  // The session token lives only in memory, so a reload legitimately returns to the
  // lock screen — what must survive is the order, not the unlock.
  await unlockPos(page, fixture.operator);
  await expect(openOrderButton(page, opened.orderNumber, 1)).toBeVisible();
  await openOrderButton(page, opened.orderNumber, 1).click();
  const ticket = ticketPanel(page, opened.orderNumber);
  await expect(ticket.getByRole('listitem')).toHaveCount(1);
  await expect(ticket.getByRole('listitem')).toContainText(`1 × ${fixture.menuItem.name}`);
  await expect(ticket).toContainText(fixture.modifier.name);

  const after = await readOrder(request, terminal, opened.orderId);
  expect(
    lineIds(after, fixture.menuItem.name),
    `reload must neither drop nor duplicate lines: ${JSON.stringify(after.items)}`
  ).toEqual(lineIds(before, fixture.menuItem.name));
});

test('an add-item dropped after it committed is retried under one key and stays one line', async ({
  page,
  baseURL,
  request,
}) => {
  test.slow();
  expect(baseURL, 'the integrated restaurant lane must supply a baseURL').toBeTruthy();
  const terminal = await establishCasePos(request);
  await installSeededTerminalCookie(page.context(), casePosDevice(), baseURL);
  await page.goto('/pos');
  await unlockPos(page, fixture.operator);
  const opened = await openTakeawayOrder(page);

  // The server commits the first add and the response never arrives — the blip the
  // operator sees as "did that go through?".
  const addItemKeys: string[] = [];
  let dropCommittedResponse = true;
  await page.route('**/api/restaurant/orders/add-item', async (route) => {
    addItemKeys.push((await route.request().allHeaders())['idempotency-key'] ?? '');
    if (dropCommittedResponse) {
      dropCommittedResponse = false;
      const committed = await route.fetch();
      expect(committed.status(), `dropped add-item: ${await committed.text()}`).toBe(201);
      return route.abort('connectionfailed');
    }
    return route.continue();
  });

  await addSeededLine(page);
  await expect(page.getByText('Network request failed. Retry this action.')).toBeVisible();

  await page.getByRole('button', { name: 'Add to order' }).click();
  await expect(page.getByText('Item added.')).toBeVisible();

  expect(addItemKeys).toHaveLength(2);
  expect(addItemKeys[0]).toBeTruthy();
  expect(addItemKeys[1], 'the retry must replay the first key, not mint a new one').toBe(
    addItemKeys[0]
  );

  const persisted = await readOrder(request, terminal, opened.orderId);
  const lines = liveLines(persisted, fixture.menuItem.name);
  expect(
    lines,
    `the dropped-then-retried add must leave one line: ${JSON.stringify(persisted.items)}`
  ).toHaveLength(1);
  await expect(ticketPanel(page, opened.orderNumber).getByRole('listitem')).toHaveCount(1);
});
