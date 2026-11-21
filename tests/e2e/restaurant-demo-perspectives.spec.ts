import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

// Same form, terminal response, modifier, KDS and checkout patterns as
// restaurant-sales-demo.spec.ts. Its helpers are private; importing that spec
// would also register its destructive sales workflow.
// Run only against a dedicated, freshly seeded local demo application. No setup,
// seed, reset, authentication stubs or database client runs from this spec.
const PERSPECTIVES = [
  { key: 'owner', landing: '/dashboard', heading: 'Restaurant dashboard', kind: 'POS' },
  { key: 'manager', landing: '/dashboard', heading: 'Restaurant dashboard', kind: 'POS' },
  { key: 'cashier', landing: '/pos', heading: 'Order pad', kind: 'POS' },
  { key: 'waiter', landing: '/pos', heading: 'Order pad', kind: 'POS' },
  { key: 'kitchen', landing: '/kds', heading: 'Kitchen floor', kind: 'KDS' },
  { key: 'inventory', landing: '/restaurant/inventory', heading: 'Inventory', kind: null },
  { key: 'finance', landing: '/restaurant/money', heading: 'Restaurant Finance', kind: null },
] as const;
type Perspective = (typeof PERSPECTIVES)[number];
type Terminal = {
  ready: boolean;
  branchId: string;
  sessionToken: string;
  session: { id: string; state: string; activeStaffProfileId: string };
  device: { id: string; organizationId: string; branchId: string; kind: string };
  operator: { staffProfileId: string };
};

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for isolated demo perspective acceptance.`);
  return value;
}

function seatFromEnv(name: string) {
  const value = requiredEnv(name);
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 25) {
    throw new Error(`${name} must be an integer from 1 to 25.`);
  }
  return Number(value);
}

// An explicit origin disables playwright.config.ts's automatic webServer.
// These checks are pure and safe during --list; access code is needed only at run time.
const baseURL = requiredEnv('PLAYWRIGHT_BASE_URL');
const origin = new URL(baseURL);
if (
  origin.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
  !origin.port ||
  origin.username ||
  origin.password ||
  origin.search ||
  origin.hash ||
  origin.pathname !== '/'
) {
  throw new Error(
    'PLAYWRIGHT_BASE_URL must be an explicit loopback HTTP origin with a dedicated port.'
  );
}
const seat = seatFromEnv('DEMO_E2E_SEAT');
const organizationId = `org_demo_restaurant_seat_${seat}`;

test.describe.configure({ mode: 'serial', retries: 0, timeout: 180_000 });
test.beforeAll(() => {
  expect(
    process.env.DEMO_PERSPECTIVES_E2E,
    'Coordinated isolated execution must be explicit.'
  ).toBe('1');
  requiredEnv('DEMO_ACCESS_CODE');
  const reserved = [
    seat,
    ...[
      'DEMO_E2E_OTHER_SEAT',
      'DEMO_E2E_INACTIVE_USER_SEAT',
      'DEMO_E2E_INACTIVE_STAFF_SEAT',
      'DEMO_E2E_NON_DEMO_SEAT',
    ].map(seatFromEnv),
  ];
  expect(new Set(reserved).size, 'Positive and rejection fixtures must use separate seats.').toBe(
    5
  );
});

async function sessionUser(page: Page, perspective: Perspective, selectedSeat = seat) {
  const response = await page.request.get('/api/auth/session');
  expect(response.status()).toBe(200);
  const { user } = await response.json();
  expect(user).toMatchObject({
    id: `user_demo_restaurant_seat_${selectedSeat}_${perspective.key}`,
    email: `${perspective.key}.seat${selectedSeat}@demo.devfathom.invalid`,
    organizationId: `org_demo_restaurant_seat_${selectedSeat}`,
    organizationStatus: 'ACTIVE',
    role: ['owner', 'manager'].includes(perspective.key) ? 'ADMIN' : 'EMPLOYEE',
    status: 'ACTIVE',
    sessionRevoked: false,
  });
  expect(user.demoAccessExpiresAt).toBeGreaterThan(Date.now());
  return user;
}

async function enterDemo(page: Page, perspective: Perspective, selectedSeat = seat) {
  await page.goto('/demo/restaurants');
  await expect(page.getByRole('heading', { name: 'Restaurant demo', exact: true })).toBeVisible();
  await page.locator(`input[name="seat"][value="${selectedSeat}"]`).check();
  await expect(page.locator('input[name="persona"]')).toHaveCount(PERSPECTIVES.length);
  await page.locator(`input[name="persona"][value="${perspective.key}"]`).check();
  await page.getByLabel('Access code').fill(requiredEnv('DEMO_ACCESS_CODE'));
  const accessPending = page.waitForResponse(
    (response) =>
      response.url().endsWith('/demo/restaurants/access') && response.request().method() === 'POST'
  );
  const devicePending = perspective.kind
    ? page.waitForResponse(
        (response) =>
          response.url().endsWith('/demo/restaurants/device-session') &&
          response.request().method() === 'POST'
      )
    : null;
  await page.getByRole('button', { name: 'Enter restaurant demo', exact: true }).click();
  const access = await accessPending;
  expect(access.status()).toBe(200);
  // Assert only non-secret fields; never attach the access-code request body.
  const submitted = access.request().postDataJSON();
  expect({ seat: submitted.seat, persona: submitted.persona }).toEqual({
    seat: selectedSeat,
    persona: perspective.key,
  });
  expect(await access.json()).toMatchObject({
    organizationId: `org_demo_restaurant_seat_${selectedSeat}`,
    persona: perspective.key,
    callbackUrl: perspective.landing,
    deviceKind: perspective.kind,
  });
  await page.waitForURL(
    (url) => url.origin === origin.origin && url.pathname === perspective.landing
  );
  await expect(page.getByRole('heading', { name: perspective.heading, exact: true })).toBeVisible();
  const user = await sessionUser(page, perspective, selectedSeat);
  let terminal: Terminal | null = null;
  if (devicePending) {
    const response = await devicePending;
    expect(response.status()).toBe(200);
    terminal = (await response.json()) as Terminal;
    // Tokens remain in memory and are reused only with their own real browser cookies.
    expect(Boolean(terminal.sessionToken)).toBe(true);
    expect(terminal.ready).toBe(true);
    expect(terminal.device).toMatchObject({
      organizationId: user.organizationId,
      kind: perspective.kind,
    });
    expect(terminal.session.state).toBe('UNLOCKED');
    expect(terminal.operator.staffProfileId).toBeTruthy();
    expect(terminal.session.activeStaffProfileId).toBe(terminal.operator.staffProfileId);
  }
  if (perspective.landing === '/dashboard') {
    await expect(page.locator('[data-tour="dashboard-overview"]')).toContainText(/\d/);
  } else if (perspective.key === 'inventory') {
    await expect(page.locator('[data-tour="inventory-low-stock"] tbody tr').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create count', exact: true })).toBeEnabled();
  } else if (perspective.key === 'finance') {
    await expect(page.getByRole('heading', { name: 'Finance unavailable' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Payments', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Branch', exact: true })).toBeEnabled();
  }
  return { page, user, terminal };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function addModifiedItem(page: Page) {
  const menu = page.locator('[data-tour="pos-order"]');
  const item = menu.locator('button[data-demo-modifier-item="true"]:enabled').first();
  await expect(item).toBeVisible();
  const itemName = (await item.locator('span').first().innerText()).trim();
  await item.click();
  const groups = menu.locator('fieldset');
  expect(await groups.count(), 'Seeded item must have real modifier controls.').toBeGreaterThan(0);
  let modifierName = '';
  for (const group of await groups.all()) {
    const options = group.locator('input[type="checkbox"], input[type="radio"]');
    const minimum = Number(
      /required\s*·\s*choose\s+(\d+)/i.exec(await group.innerText())?.[1] ?? 1
    );
    expect(await options.count()).toBeGreaterThanOrEqual(Math.max(1, minimum));
    for (let index = 0; index < Math.max(1, minimum); index += 1) {
      const option = options.nth(index);
      if (!modifierName) {
        modifierName = (await option.locator('xpath=ancestor::label[1]').innerText())
          .replace(/\+\s*[\d,.]+.*$/, '')
          .trim();
      }
      await option.check();
    }
  }
  await page.getByLabel('Quantity').fill('2');
  await page.getByLabel('Seat', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Add to order', exact: true }).click();
  const line = page.getByRole('listitem').filter({ hasText: itemName });
  await expect(line).toContainText(`2 × ${itemName}`);
  await expect(line).toContainText(modifierName);
  await page.getByRole('button', { name: 'Send whole order', exact: true }).click();
  await expect(page.getByText('Order sent to kitchen.', { exact: true })).toBeVisible();
  return { itemName, modifierName };
}

async function rejectedAccess(
  page: Page,
  data: Record<string, unknown>,
  status: number,
  error: string
) {
  const response = await page.request.post('/demo/restaurants/access', {
    headers: { Origin: origin.origin },
    data,
  });
  expect(response.status()).toBe(status);
  expect(await response.json()).toEqual({ error });
  expect(response.headers()['set-cookie']).toBeUndefined();
}

async function terminalRequest(
  page: Page,
  path: string,
  options: { headers: Record<string, string>; data?: unknown }
) {
  // Use the UI's browser cookie transport for real terminal enrollment.
  const response = await page.evaluate(
    async ({ path, headers, data }) => {
      const response = await fetch(path, {
        method: data === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers: {
          ...headers,
          ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      return { status: response.status, body: await response.text() };
    },
    { path, ...options }
  );
  return { status: () => response.status, json: async () => JSON.parse(response.body) };
}

test('seven real logins share a waiter, kitchen and cashier handoff with enforced permissions', async ({
  browser,
}, testInfo) => {
  const contexts: BrowserContext[] = [];
  const actors = new Map<Perspective['key'], Awaited<ReturnType<typeof enterDemo>>>();
  const runtimeErrors: string[] = [];
  const authCookies: string[] = [];
  try {
    for (const perspective of PERSPECTIVES) {
      await test.step(`Log in as ${perspective.key}`, async () => {
        const context = await browser.newContext({
          baseURL,
          viewport: { width: 1440, height: 900 },
        });
        contexts.push(context);
        const page = await context.newPage();
        page.on('pageerror', (error) => runtimeErrors.push(`${perspective.key}: ${error.message}`));
        const actor = await enterDemo(page, perspective);
        actors.set(perspective.key, actor);
        const cookies = (await context.cookies()).filter(({ name }) =>
          /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/.test(name)
        );
        expect(cookies.length).toBeGreaterThan(0);
        expect(cookies.every(({ httpOnly }) => httpOnly)).toBe(true);
        authCookies.push(
          cookies
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(({ value }) => value)
            .join('')
        );
        await page.screenshot({ path: testInfo.outputPath(`${perspective.key}-landing.png`) });
      });
    }
    expect(new Set([...actors.values()].map(({ user }) => user.id)).size).toBe(7);
    expect(new Set(authCookies).size, 'Each browser must carry its own real Auth.js session.').toBe(
      7
    );
    const terminals = [...actors.values()].flatMap(({ terminal }) => (terminal ? [terminal] : []));
    for (const ids of [
      terminals.map((t) => t.device.id),
      terminals.map((t) => t.session.id),
      terminals.map((t) => t.operator.staffProfileId),
    ]) {
      expect(
        new Set(ids).size,
        'Persona devices, terminal sessions and operators must be distinct.'
      ).toBe(5);
    }
    expect(
      new Set(terminals.map((t) => t.branchId)).size,
      'Same seat must share a working branch.'
    ).toBe(1);
    const waiter = actors.get('waiter')!;
    const kitchen = actors.get('kitchen')!;
    const cashier = actors.get('cashier')!;
    const owner = actors.get('owner')!;

    await waiter.page.getByRole('checkbox', { name: /^A1-03\b/ }).check();
    await waiter.page.getByLabel('Covers').fill('2');
    const openedPending = waiter.page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/restaurant/orders/open') &&
        response.request().method() === 'POST'
    );
    await waiter.page.getByRole('button', { name: 'Open order', exact: true }).click();
    const openedResponse = await openedPending;
    expect(openedResponse.status()).toBe(201);
    const opened = (await openedResponse.json()) as { orderId: string; orderNumber: number };
    expect(typeof opened.orderId).toBe('string');
    expect(opened.orderId.length).toBeGreaterThan(0);
    expect(Number.isInteger(opened.orderNumber)).toBe(true);
    await expect(
      waiter.page.getByText(`Order ${opened.orderNumber} opened.`, { exact: true })
    ).toBeVisible();
    const { itemName, modifierName } = await addModifiedItem(waiter.page);

    const ticket = kitchen.page
      .getByRole('article')
      .filter({ hasText: new RegExp(`Order #${opened.orderNumber}\\b`) });
    await expect(ticket).toBeVisible();
    await expect(ticket).toContainText(itemName);
    await expect(ticket).toContainText(modifierName);
    await ticket
      .getByRole('button', {
        name: new RegExp(`Start ${escapeRegExp(itemName)} for order ${opened.orderNumber}\\b`),
      })
      .click();
    await expect(kitchen.page.getByText('Item started.', { exact: true })).toBeVisible();
    await ticket
      .getByRole('button', {
        name: new RegExp(`Mark ready ${escapeRegExp(itemName)} for order ${opened.orderNumber}\\b`),
      })
      .click();
    await expect(kitchen.page.getByText('Item marked ready.', { exact: true })).toBeVisible();

    await cashier.page.reload();
    await cashier.page
      .getByRole('button', { name: new RegExp(`^#${opened.orderNumber} ·`) })
      .click();
    const order = cashier.page
      .getByText(`Order ${opened.orderNumber}`, { exact: true })
      .locator('xpath=ancestor::*[@data-slot="section-card"][1]');
    await expect(order).toContainText(itemName);
    await expect(order).toContainText(modifierName);
    await expect(order.getByText('PREPARED', { exact: true })).toBeVisible();
    await order.getByRole('button', { name: 'Mark served', exact: true }).click();
    await order.getByRole('button', { name: 'Close order', exact: true }).click();
    const checkout = cashier.page.getByRole('dialog', { name: 'Collect payment', exact: true });
    await expect(checkout).toBeVisible();
    await checkout.getByRole('button', { name: 'Cut single bill', exact: true }).click();
    await expect(checkout.getByLabel('Tender type')).toBeVisible();
    const summaryPath = `/api/restaurant/checkout/summary?orderId=${encodeURIComponent(opened.orderId)}`;
    const cashierHeaders = {
      Origin: origin.origin,
      'X-Terminal-Session': cashier.terminal!.sessionToken,
    };
    const beforeResponse = await terminalRequest(cashier.page, summaryPath, {
      headers: cashierHeaders,
    });
    expect(beforeResponse.status()).toBe(200);
    const before = await beforeResponse.json();
    expect(before.orderId).toBe(opened.orderId);
    expect(before.settled).toBe(false);
    expect(before.bills).toHaveLength(1);
    const bill = before.bills[0];
    expect(bill.status).toBe('OPEN');
    expect(Number(bill.grandTotal)).toBeGreaterThan(0);

    const denied = await terminalRequest(kitchen.page, '/api/restaurant/checkout/tender', {
      headers: {
        Origin: origin.origin,
        'X-Terminal-Session': kitchen.terminal!.sessionToken,
        'Idempotency-Key': randomUUID(),
      },
      data: { billId: bill.id, tender: { type: 'CARD', amount: bill.grandTotal } },
    });
    expect(
      denied.status(),
      'Authenticated kitchen must fail at the payment capability boundary.'
    ).toBe(403);
    expect(await denied.json()).toEqual({
      error: 'This operator lacks the "payments:collect" capability.',
    });
    const unchanged = await terminalRequest(cashier.page, summaryPath, { headers: cashierHeaders });
    expect(unchanged.status()).toBe(200);
    expect(await unchanged.json()).toEqual(before);

    await checkout.getByLabel('Tender type').selectOption('CARD');
    await checkout.getByLabel('Amount', { exact: true }).fill(bill.grandTotal);
    const paidPending = cashier.page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/restaurant/checkout/tender') &&
        response.request().method() === 'POST'
    );
    await checkout.getByRole('button', { name: 'Apply tender', exact: true }).click();
    expect((await paidPending).status()).toBe(200);
    await expect(checkout.getByRole('region', { name: /^Receipt \d+$/ })).toBeVisible();
    const finalResponse = await terminalRequest(cashier.page, summaryPath, {
      headers: cashierHeaders,
    });
    expect(finalResponse.status()).toBe(200);
    const final = await finalResponse.json();
    expect(final).toMatchObject({ orderId: opened.orderId, settled: true, blocker: null });
    expect(final.bills).toHaveLength(1);
    expect(final.bills[0]).toMatchObject({
      id: bill.id,
      status: 'SETTLED',
      grandTotal: bill.grandTotal,
    });
    expect(Number.isInteger(final.bills[0].receiptNumber)).toBe(true);

    // These are real capability gates, not demo-global blocked mutations.
    for (const response of [
      await cashier.page.request.post('/api/trpc/restaurantPurchasing.createSupplier', {
        headers: { Origin: origin.origin },
        data: { json: { name: `Denied cashier supplier ${randomUUID()}` } },
      }),
      await cashier.page.request.get('/api/trpc/restaurantStaff.listEligibleUsers'),
    ]) {
      expect(response.status()).toBe(403);
      expect(await response.json()).toMatchObject({
        error: {
          json: {
            message: 'You do not have permission for this action.',
            data: { code: 'FORBIDDEN' },
          },
        },
      });
    }
    await cashier.page.goto('/restaurant/purchasing');
    await expect(
      cashier.page.getByRole('heading', { name: 'Permission denied', exact: true })
    ).toBeVisible();

    const otherSeat = seatFromEnv('DEMO_E2E_OTHER_SEAT');
    await rejectedAccess(
      owner.page,
      { seat: otherSeat, persona: 'cashier' },
      401,
      'Invalid access code.'
    );
    const otherContext = await browser.newContext({ baseURL });
    contexts.push(otherContext);
    const other = await enterDemo(await otherContext.newPage(), PERSPECTIVES[2], otherSeat);
    const crossSeat = await terminalRequest(other.page, summaryPath, {
      headers: {
        Origin: origin.origin,
        'X-Terminal-Session': other.terminal!.sessionToken,
      },
    });
    expect(crossSeat.status()).toBe(404);
    expect(await crossSeat.json()).toEqual({ error: 'The order does not exist.' });
    // Later logins must not silently replace or invalidate any earlier persona.
    for (const perspective of PERSPECTIVES)
      await sessionUser(actors.get(perspective.key)!.page, perspective);
    expect(runtimeErrors).toEqual([]);
    await testInfo.attach('perspective-handoff.json', {
      contentType: 'application/json',
      body: JSON.stringify(
        {
          organizationId,
          orderId: opened.orderId,
          orderNumber: opened.orderNumber,
          itemName,
          modifierName,
          billId: bill.id,
          receiptNumber: final.bills[0].receiptNumber,
          actors: [...actors.entries()].map(([persona, actor]) => ({
            persona,
            userId: actor.user.id,
            deviceId: actor.terminal?.device.id,
            staffProfileId: actor.terminal?.operator.staffProfileId,
          })),
        },
        null,
        2
      ),
    });
  } finally {
    for (const context of contexts) await context.close();
  }
});

test('unknown personas and injected other-seat identities are rejected before a login is issued', async ({
  page,
}) => {
  for (const selection of [
    { persona: '__unknown_persona__' },
    {
      persona: 'cashier',
      userId: `user_demo_restaurant_seat_${seatFromEnv('DEMO_E2E_OTHER_SEAT')}_owner`,
    },
    {
      persona: 'cashier',
      organizationId: `org_demo_restaurant_seat_${seatFromEnv('DEMO_E2E_OTHER_SEAT')}`,
    },
  ]) {
    await rejectedAccess(
      page,
      { code: requiredEnv('DEMO_ACCESS_CODE'), seat, ...selection },
      400,
      'Invalid request.'
    );
  }
  const session = await page.request.get('/api/auth/session');
  expect(session.status()).toBe(200);
  expect((await session.json())?.user).toBeUndefined();
});

// Backend/PM must pre-provision and independently verify these reserved fixtures:
// inactive User cashier (staff ACTIVE), suspended Staff kitchen (User ACTIVE),
// and canonical seat organization isDemo=false (otherwise ACTIVE/SHARED/RESTAURANT).
// Missing fixtures are not evidence of those states; this spec never creates them.
for (const fixture of [
  { env: 'DEMO_E2E_INACTIVE_USER_SEAT', persona: 'cashier', title: 'inactive user' },
  { env: 'DEMO_E2E_INACTIVE_STAFF_SEAT', persona: 'kitchen', title: 'suspended staff profile' },
  { env: 'DEMO_E2E_NON_DEMO_SEAT', persona: 'owner', title: 'non-demo organization' },
]) {
  test(`server refuses selection of ${fixture.title}`, async ({ page }) => {
    await rejectedAccess(
      page,
      {
        code: requiredEnv('DEMO_ACCESS_CODE'),
        seat: seatFromEnv(fixture.env),
        persona: fixture.persona,
      },
      409,
      'Demo seat is not ready.'
    );
    const session = await page.request.get('/api/auth/session');
    expect(session.status()).toBe(200);
    expect((await session.json())?.user).toBeUndefined();
  });
}
