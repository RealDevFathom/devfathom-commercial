import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type BrowserContext,
} from '@playwright/test';
import { createHash } from 'node:crypto';
import pg from 'pg';

import {
  e2eIdempotencyKey,
  establishPosFixture,
  restaurantE2eCredentials as fixture,
  type RestaurantTerminalFixture,
} from './restaurant-fixture';
import { actorFixture, signInAs } from './fixtures/restaurant-actor-accessibility';

/**
 * REST-TEST (WHA-1567) — software-only receipt and KOT acceptance.
 *
 * The durable print boundary is covered in depth BELOW the transport by
 * `src/lib/restaurant/printing/claim.db.test.ts`, `printing.db.test.ts`,
 * `src/app/api/restaurant/checkout/receipt/receipt-dispatch.db.test.ts` and
 * `route.test.ts` (which mocks the print service entirely). NONE of that reaches the
 * running application: no integrated spec exercises `/api/restaurant/print-bridge`,
 * device-authenticated claim/acknowledge, or the queued ESC/POS bytes an operator
 * actually gets. This file covers only that gap and reuses the seeded restaurant
 * fixture, the installed Playwright runner and the existing `pg` readback idiom —
 * it introduces no page objects, no global fixtures and no parallel framework.
 *
 * Scope: software transports only. There is no physical printer, no device
 * enrolment and no OS/network spooler here; `SimulatedPrintBridgeAdapter` is not
 * used either, because the device bridge is the real transport for these routes.
 * Hardware certification stays deferred (coverage id `physical-printing` remains
 * Partial in `restaurant-acceptance-manifest.ts`).
 *
 * EXECUTION PREREQUISITES (this file is authored, not executed by this lane):
 *   1. `playwright.restaurant-integrated.config.ts` `testMatch` is an EXACT
 *      per-file list. It does NOT contain this file. Add the literal
 *      'restaurant-software-receipt-acceptance.spec.ts' to that array or this spec
 *      never runs. Editing that shared config is out of this lane's file ownership.
 *   2. The integrated lane env: `DATABASE_URL`, `AUTH_SECRET` and the
 *      `RESTAURANT_ACTOR_ADMIN_EMAIL` / `RESTAURANT_ACTOR_ADMIN_PASSWORD` pair the
 *      shared actor fixture reads. Missing env fails loudly in `beforeAll`; it is
 *      never skipped and never silently passed.
 *   3. `scripts/seed-restaurant-e2e.ts` seeds NO `restaurant_print_routes` rows, so
 *      this spec publishes them through the real `PUT /api/restaurant/print-bridge`
 *      configurator and restores the seeded empty configuration in `afterAll`.
 *   4. Both seeded branches are named with a non-ASCII accent ('Gulberg Café',
 *      'DHA Café'). The branch name is a VALIDATED receipt fact, so a queued RECEIPT
 *      job is unreachable in the seeded branches by design; that refusal is asserted
 *      here as the real contract, and queued receipt acceptance runs against the
 *      isolated branch in the ASCII receipt fixture contract below.
 *   5. The revoked-bridge-device case has no seeded fixture yet; see the fixture
 *      contract on that test.
 */

test.describe.configure({ mode: 'serial' });

const KITCHEN_PRINTER_ID = 'printer-e2e-software-kitchen';
const RECEIPT_PRINTER_ID = 'printer-e2e-software-receipt';

const bridgeRoutes = [
  {
    documentType: 'KITCHEN_TICKET' as const,
    stationId: null,
    printerId: KITCHEN_PRINTER_ID,
    enabled: true,
  },
  {
    documentType: 'RECEIPT' as const,
    stationId: null,
    printerId: RECEIPT_PRINTER_ID,
    enabled: true,
  },
];

/** The vendor-neutral ESC/POS envelope `renderEscPos` emits: initialize … full cut. */
const ESC_POS_INIT = '\x1b@';
const ESC_POS_CUT = '\x1dV\x00';

/**
 * `CLAIM_LEASE_MS` in `src/lib/restaurant/printing/service.ts`: a PRINTED/OFFLINE
 * acknowledgement is refused once the claim is this old. Only the FIRST settling
 * acknowledgement is lease-bound — a replayed identical outcome short-circuits before
 * the lease check, and a claimed job is never re-offered (the claim predicate requires
 * `attemptCount = 0`), so the remaining transport assertions are lease-independent.
 * The KOT is claimed in one test and acknowledged in the next, so this file asserts
 * that window instead of assuming it.
 */
const CLAIM_LEASE_MS = 30_000;

/**
 * FIXTURE CONTRACT — isolated ASCII-printable receipt branch (NOT yet seeded).
 *
 * `facts.businessName` is `bill.branch.name` (`checkout-routes.ts` →
 * `receipt-dispatch.ts`), and every receipt fact is charset-checked against
 * `/^[\x20-\x7e\n]*$/` in `printing/contract.ts` before the queue may accept the job.
 * Both seeded branches carry a non-ASCII `é`, so NO queued RECEIPT job is reachable in
 * the seeded branches at all. That is the product validating correctly; this file
 * neither weakens that validation nor renames a shared branch to work around it.
 *
 * Queued receipt acceptance therefore needs its own branch, seeded alongside the
 * existing lanes in `scripts/seed-restaurant-e2e.ts`. `branch_restaurant_e2e_a2` is
 * already a complete operational second branch — mirror its rows and change the name:
 *
 *   restaurant_branches:
 *     id          'branch_restaurant_e2e_ascii_receipt'
 *     name        'Gulberg Cafe Receipt Lab'   (ASCII-printable; the accent is the point)
 *     timezone    'Asia/Karachi', active true, isDefault false
 *
 *   restaurant_registered_devices:
 *     id                 'device_restaurant_e2e_ascii_receipt_pos'
 *     branchId           'branch_restaurant_e2e_ascii_receipt'
 *     kind               'POS'       (register and print bridge are one device here)
 *     status             'ACTIVE'
 *     deviceSecretHash   deviceSecretHash(<secret below>)
 *
 *   plus, scoped to that branch: an ACTIVE default kitchen station (firing throws
 *   `KitchenTicketError` without one), the seeded menu item on its DINE_IN effective
 *   menu, its tax profile, and an operator staff profile
 *   'staff_restaurant_e2e_ascii_receipt_operator' with PIN '353535' holding the same
 *   capabilities as the seeded `restaurant-e2e-operator` role.
 *
 * The plaintext device secret is exported to the lane as
 * RESTAURANT_E2E_ASCII_RECEIPT_DEVICE_SECRET (an `rdk_`-prefixed literal, e.g.
 * 'rdk_restaurant_e2e_ascii_receipt_pos_local_ci_only').
 *
 * NOTE: the branch is seeded with only the RECEIPT route published by this file, so its
 * queue contains receipts alone — a fired order there routes to no kitchen printer and
 * `PrintBridgeService.enqueue` persists nothing for NO_PRINTER.
 *
 * These tests FAIL rather than skip while the fixture is absent: acceptance that never
 * executed is not evidence.
 */
const ASCII_RECEIPT_BRANCH = {
  branchId: 'branch_restaurant_e2e_ascii_receipt',
  operator: { staffProfileId: 'staff_restaurant_e2e_ascii_receipt_operator', pin: '353535' },
  device: { deviceId: 'device_restaurant_e2e_ascii_receipt_pos', clientIp: '198.51.100.14' },
} as const;

const asciiReceiptRoute = {
  documentType: 'RECEIPT' as const,
  stationId: null,
  printerId: 'printer-e2e-software-ascii-receipt',
  enabled: true,
};

/** The document reference the dispatcher derives from the bill id; the durable job key prefix. */
const documentReference = (bill: string) =>
  `receipt:${createHash('sha256').update(bill).digest('hex')}`;

function asciiBridgeDevice() {
  const secret = process.env.RESTAURANT_E2E_ASCII_RECEIPT_DEVICE_SECRET;
  expect(
    secret,
    'RESTAURANT_E2E_ASCII_RECEIPT_DEVICE_SECRET is required; see the ASCII receipt branch fixture contract above.'
  ).toBeTruthy();
  expect(
    secret,
    'the isolated receipt bridge secret must be rdk_-prefixed to reach the bridge transport'
  ).toMatch(/^rdk_/);
  return { secret: secret!, clientIp: ASCII_RECEIPT_BRANCH.device.clientIp };
}

/** A registered branch device acting as the print bridge: device auth only, no terminal session. */
function bridgeHeaders(device: { secret: string; clientIp: string }) {
  return { authorization: `Bearer ${device.secret}`, 'x-forwarded-for': device.clientIp };
}

type ClaimedJob = {
  id: string;
  claimToken: string;
  printerId: string;
  documentType: 'KITCHEN_TICKET' | 'BAR_TICKET' | 'RECEIPT';
  bytes: string;
};

async function claimBridgeJob(
  request: APIRequestContext,
  device: { secret: string; clientIp: string }
) {
  const response = await request.get('/api/restaurant/print-bridge?wait=0', {
    headers: bridgeHeaders(device),
  });
  if (response.status() === 204) return null;
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { job: ClaimedJob }).job;
}

function acknowledgeBridgeJob(
  request: APIRequestContext,
  device: { secret: string; clientIp: string },
  body: { jobId: string; claimToken: string; status: 'PRINTED' | 'OFFLINE'; error?: string }
) {
  return request.post('/api/restaurant/print-bridge', {
    headers: bridgeHeaders(device),
    data: body,
  });
}

async function post(
  request: APIRequestContext,
  terminal: RestaurantTerminalFixture,
  path: string,
  data: Record<string, unknown>,
  key: string
) {
  const response = await request.post(path, {
    headers: { ...terminal.headers, 'Idempotency-Key': key },
    data,
  });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return response;
}

/**
 * The shared `establishPosFixture` is bound to the seeded register, so the isolated
 * branch runs the same two-step establish/unlock against its own device — same routes,
 * same contract, no new helper module and no change to the shared fixture.
 */
async function establishAsciiPosTerminal(
  request: APIRequestContext
): Promise<RestaurantTerminalFixture> {
  const device = asciiBridgeDevice();
  const authorization = `Bearer ${device.secret}`;
  const established = await request.post('/api/restaurant/terminal/establish', {
    headers: { authorization, 'x-forwarded-for': device.clientIp },
  });
  expect(established.status(), await established.text()).toBe(201);
  const body = (await established.json()) as { sessionToken: string; device: { id: string } };
  expect(body.device.id).toBe(ASCII_RECEIPT_BRANCH.device.deviceId);

  const unlocked = await request.post('/api/restaurant/terminal/unlock', {
    headers: {
      authorization,
      'x-terminal-session': body.sessionToken,
      'x-forwarded-for': device.clientIp,
    },
    data: {
      staffProfileId: ASCII_RECEIPT_BRANCH.operator.staffProfileId,
      type: 'PIN',
      secret: ASCII_RECEIPT_BRANCH.operator.pin,
    },
  });
  expect(unlocked.status(), await unlocked.text()).toBe(200);
  const { composerProof } = (await unlocked.json()) as { composerProof: string };
  expect(typeof composerProof).toBe('string');

  return {
    deviceId: ASCII_RECEIPT_BRANCH.device.deviceId,
    deviceSecret: device.secret,
    sessionToken: body.sessionToken,
    headers: {
      authorization,
      'x-terminal-session': body.sessionToken,
      'x-forwarded-for': device.clientIp,
      'x-pos-composer-proof': composerProof,
    },
  };
}

/** Routing is a `restaurant:configure` web-session action, never a terminal one. */
async function publishRoutes(branchId: string, routes: unknown[]) {
  const admin = await playwrightRequest.newContext({ storageState: adminStorageState! });
  try {
    const response = await admin.put(new URL('/api/restaurant/print-bridge', adminOrigin).href, {
      data: { branchId, routes },
    });
    expect(response.status(), await response.text()).toBe(200);
  } finally {
    await admin.dispose();
  }
}

/** Same tenant-scoped, rolled-back readback the delivery spec uses; nothing is mutated here. */
async function tenantQuery<T extends pg.QueryResultRow>(
  pool: pg.Pool,
  text: string,
  values: unknown[] = []
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_organization_id', $1, true),
              set_config('app.is_platform_admin', 'false', true)`,
      [fixture.organizationId]
    );
    const result = await client.query<T>(text, values);
    await client.query('ROLLBACK');
    return result;
  } finally {
    client.release();
  }
}

type PrintJobRow = {
  id: string;
  status: string;
  printerId: string | null;
  documentType: string;
  byteCount: number | null;
  attemptCount: number;
  lastAttemptAt: Date | null;
  printedAt: Date | null;
  document: unknown;
};

async function printJobByKey(
  pool: pg.Pool,
  idempotencyKey: string,
  branchId: string = fixture.branchId
) {
  const result = await tenantQuery<PrintJobRow>(
    pool,
    `SELECT id, status::text status, "printerId", "documentType"::text "documentType",
            "byteCount", "attemptCount", "lastAttemptAt", "printedAt", document
       FROM restaurant_print_jobs
      WHERE "branchId" = $1 AND "idempotencyKey" = $2`,
    [branchId, idempotencyKey]
  );
  return result.rows;
}

let pool: pg.Pool;
let adminOrigin = '';
let adminStorageState: Awaited<ReturnType<BrowserContext['storageState']>> | null = null;
let pos: RestaurantTerminalFixture;
let orderId = '';
let orderNumber = 0;
let kitchenTicketId = '';
let kitchenJobIdempotencyKey = '';
let kitchenClaim: ClaimedJob | null = null;
let kitchenClaimedAt = 0;
let kitchenTicketJobCount = 0;
let billId = '';
let asciiPos: RestaurantTerminalFixture;
let asciiOrderId = '';
let asciiOrderNumber = 0;
let asciiBillId = '';
let asciiRoutingPublished = false;
let receiptReference = '';
let reprintRequestId = '';

test.beforeAll(() => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is required: this acceptance spec reads the durable print queue back from PostgreSQL.'
    );
  }
  if (!actorFixture.restaurantAdmin.email || !actorFixture.restaurantAdmin.password) {
    throw new Error(
      'RESTAURANT_ACTOR_ADMIN_EMAIL and RESTAURANT_ACTOR_ADMIN_PASSWORD are required: only a web session with restaurant:configure can publish print routing.'
    );
  }
  pool = new pg.Pool({ connectionString: databaseUrl });
});

test.afterAll(async () => {
  try {
    if (adminStorageState && adminOrigin) {
      await publishRoutes(fixture.branchId, []);
      if (asciiRoutingPublished) await publishRoutes(ASCII_RECEIPT_BRANCH.branchId, []);
    }
  } finally {
    if (pool) await pool.end();
  }
});

test('publishes bridge routing and persists a routed KOT job with the fired items', async ({
  page,
  request,
}) => {
  test.slow();
  adminOrigin = await signInAs(page, 'restaurantAdmin');
  adminStorageState = await page.context().storageState();

  const configureUrl = new URL('/api/restaurant/print-bridge', adminOrigin).href;
  const published = await page.request.put(configureUrl, {
    data: { branchId: fixture.branchId, routes: bridgeRoutes },
  });
  expect(published.status(), await published.text()).toBe(200);
  expect(await published.json()).toMatchObject({
    mode: 'DEVICE_BRIDGE',
    config: { branchId: fixture.branchId },
  });

  const configured = await page.request.get(configureUrl);
  expect(configured.status()).toBe(200);
  const branches = (
    (await configured.json()) as {
      branches: Array<{ id: string; config: { routes: unknown[] } }>;
    }
  ).branches;
  const configuredBranch = branches.find((branch) => branch.id === fixture.branchId);
  expect(
    configuredBranch,
    `branch ${fixture.branchId} must be visible to the configurator`
  ).toBeDefined();
  expect(configuredBranch!.config.routes).toEqual(
    expect.arrayContaining(bridgeRoutes.map((route) => expect.objectContaining(route)))
  );

  pos = await establishPosFixture(request);
  const menuResponse = await request.get('/api/restaurant/orders/effective-menu?channel=DINE_IN', {
    headers: pos.headers,
  });
  expect(menuResponse.status(), await menuResponse.text()).toBe(200);
  const menu = (await menuResponse.json()) as {
    publicationId: string;
    sections: Array<{
      items: Array<{ id: string; displayName: string | null; product: { name: string } }>;
    }>;
  };
  const menuItem = menu.sections
    .flatMap((section) => section.items)
    .find((item) => (item.displayName ?? item.product.name) === fixture.menuItem.name);
  expect(
    menuItem,
    `seeded menu item "${fixture.menuItem.name}" must be on the DINE_IN menu`
  ).toBeDefined();

  // `orders/open` binds the publication from the REQUEST — `openOrder` stores
  // `input.publicationId ?? null` and never resolves one itself — and `addItem`
  // refuses an order without one ("The order has no menu publication"). The
  // publication the terminal is actually serving is the one `effective-menu`
  // just answered with, so it is carried across rather than re-derived.
  const opened = await post(
    request,
    pos,
    '/api/restaurant/orders/open',
    { channel: 'DINE_IN', coverCount: 1, publicationId: menu.publicationId },
    e2eIdempotencyKey('software-receipt-open', Date.now())
  );
  expect(opened.status()).toBe(201);
  ({ orderId, orderNumber } = (await opened.json()) as { orderId: string; orderNumber: number });

  // Required modifiers remain server-enforced; the valid fixture below must
  // satisfy Heat rather than relaxing the menu rule to reach printing.
  const missingHeat = await request.post('/api/restaurant/orders/add-item', {
    headers: {
      ...pos.headers,
      'Idempotency-Key': e2eIdempotencyKey('software-receipt-missing-heat', orderNumber),
    },
    data: { orderId, menuItemId: menuItem!.id, quantity: 1 },
  });
  expect(missingHeat.status()).toBe(400);
  expect(await missingHeat.json()).toMatchObject({
    error: 'Modifier group Heat requires at least 1 and at most 1 selections; received 0.',
  });

  await post(
    request,
    pos,
    '/api/restaurant/orders/add-item',
    {
      orderId,
      menuItemId: menuItem!.id,
      quantity: 1,
      modifierOptionIds: [fixture.modifier.optionId],
    },
    e2eIdempotencyKey('software-receipt-add-item', orderNumber)
  );
  await post(
    request,
    pos,
    '/api/restaurant/orders/fire',
    { orderId },
    e2eIdempotencyKey('software-receipt-fire', orderNumber)
  );

  const detail = await request.get(
    `/api/restaurant/orders/detail?orderId=${encodeURIComponent(orderId)}`,
    { headers: pos.headers }
  );
  expect(detail.status()).toBe(200);
  const tickets = (
    (await detail.json()) as {
      kitchenTickets: Array<{ id: string; stationId: string; ticketNumber: number }>;
    }
  ).kitchenTickets;
  expect(tickets).toHaveLength(1);
  kitchenTicketId = tickets[0]!.id;
  kitchenJobIdempotencyKey = `kitchen-ticket:${kitchenTicketId}:v1`;

  const rows = await printJobByKey(pool, kitchenJobIdempotencyKey);
  expect(rows, 'firing an order must persist exactly one routed KOT print job').toHaveLength(1);
  expect(rows[0]).toMatchObject({
    status: 'PENDING',
    documentType: 'KITCHEN_TICKET',
    printerId: KITCHEN_PRINTER_ID,
    attemptCount: 0,
    lastAttemptAt: null,
    printedAt: null,
    byteCount: null,
  });
  expect(rows[0]!.document).toMatchObject({
    type: 'KITCHEN_TICKET',
    title: 'KITCHEN',
    reference: `Order ${orderNumber}`,
    lines: [{ quantity: 1, label: fixture.menuItem.name }],
  });
});

test('a branch bridge device claims the KOT once and receives its ESC/POS bytes', async ({
  request,
}) => {
  kitchenClaim = await claimBridgeJob(request, fixture.kds);
  kitchenClaimedAt = Date.now();
  const claimed = kitchenClaim;
  expect(claimed, 'the pending KOT must be claimable by a branch device').not.toBeNull();
  expect(claimed!.documentType).toBe('KITCHEN_TICKET');
  expect(claimed!.printerId).toBe(KITCHEN_PRINTER_ID);
  expect(claimed!.claimToken).toMatch(/^[a-f0-9]{64}$/);

  const bytes = Buffer.from(claimed!.bytes, 'base64');
  const rendered = bytes.toString('latin1');
  expect(rendered.startsWith(ESC_POS_INIT)).toBe(true);
  expect(rendered.endsWith(ESC_POS_CUT)).toBe(true);
  expect(rendered).toContain('KITCHEN');
  expect(rendered).toContain(`Order ${orderNumber}`);
  expect(rendered).toContain(`1 x ${fixture.menuItem.name}`);

  // A second bridge on the same branch must not be handed the same uncertain bytes.
  expect(await claimBridgeJob(request, fixture.pos)).toBeNull();

  const rows = await printJobByKey(pool, kitchenJobIdempotencyKey);
  expect(rows[0]).toMatchObject({
    id: claimed!.id,
    status: 'PENDING',
    attemptCount: 1,
    printedAt: null,
  });
  expect(rows[0]!.lastAttemptAt).not.toBeNull();
});

test('KOT acknowledgement is idempotent, refuses a changed outcome and is not re-queued', async ({
  request,
}) => {
  expect(kitchenClaim, 'the KOT claim must carry over from the claim test').not.toBeNull();
  const { id: jobId, claimToken } = kitchenClaim!;

  expect(
    await claimBridgeJob(request, fixture.kds),
    'an already-claimed job must not be re-offered before acknowledgement'
  ).toBeNull();

  const malformed = await acknowledgeBridgeJob(request, fixture.kds, {
    jobId,
    claimToken: 'not-a-token',
    status: 'PRINTED',
  });
  expect(malformed.status()).toBe(400);

  const forged = await acknowledgeBridgeJob(request, fixture.kds, {
    jobId,
    claimToken: 'f'.repeat(64),
    status: 'PRINTED',
  });
  expect(forged.status()).toBe(404);
  expect((await printJobByKey(pool, kitchenJobIdempotencyKey))[0]).toMatchObject({
    status: 'PENDING',
    printedAt: null,
  });

  // The settling acknowledgement below is the one lease-bound call in this file; a
  // failure past the lease is environment slowness, not a transport defect.
  expect(
    Date.now() - kitchenClaimedAt,
    'the KOT was claimed in the previous test and the claim lease is 30s'
  ).toBeLessThan(CLAIM_LEASE_MS);
  const acknowledged = await acknowledgeBridgeJob(request, fixture.kds, {
    jobId,
    claimToken,
    status: 'PRINTED',
  });
  expect(acknowledged.status(), await acknowledged.text()).toBe(200);
  expect(await acknowledged.json()).toEqual({ acknowledged: true, replayed: false });

  // A lost ACK response is retried by the transport; the retry must be a replay, not work.
  const retried = await acknowledgeBridgeJob(request, fixture.kds, {
    jobId,
    claimToken,
    status: 'PRINTED',
  });
  expect(retried.status()).toBe(200);
  expect(await retried.json()).toEqual({ acknowledged: true, replayed: true });

  const rewritten = await acknowledgeBridgeJob(request, fixture.kds, {
    jobId,
    claimToken,
    status: 'OFFLINE',
    error: 'A settled outcome must never be rewritten by a late transport report.',
  });
  expect(rewritten.status()).toBe(404);

  const rows = await printJobByKey(pool, kitchenJobIdempotencyKey);
  expect(rows[0]).toMatchObject({
    status: 'PRINTED',
    attemptCount: 1,
    printerId: KITCHEN_PRINTER_ID,
    byteCount: Buffer.from(kitchenClaim!.bytes, 'base64').length,
  });
  expect(rows[0]!.printedAt).not.toBeNull();
  expect(
    await claimBridgeJob(request, fixture.kds),
    'an acknowledged job must never be handed out again'
  ).toBeNull();
});

test('a receipt dispatch persists the settled snapshot and dedupes on the document key', async ({
  request,
}) => {
  test.slow();
  const bill = await post(
    request,
    pos,
    '/api/restaurant/checkout/bill',
    { orderId, split: { kind: 'NONE' } },
    e2eIdempotencyKey('software-receipt-bill', orderNumber)
  );
  billId = ((await bill.json()) as { billIds: string[] }).billIds[0]!;

  const summaryResponse = await request.get(
    `/api/restaurant/checkout/summary?orderId=${encodeURIComponent(orderId)}`,
    { headers: pos.headers }
  );
  expect(summaryResponse.status()).toBe(200);
  const summary = (await summaryResponse.json()) as { derivedOrderTotal: string };

  await post(
    request,
    pos,
    '/api/restaurant/checkout/tender',
    {
      billId,
      tender: {
        type: 'CARD',
        amount: summary.derivedOrderTotal,
        manualConfirmation: { approvalCode: 'E2E739', reference: '4242' },
      },
    },
    e2eIdempotencyKey('software-receipt-tender', orderNumber)
  );

  // The seeded branch is 'Gulberg Café'. Its name IS a validated receipt fact, so the
  // ESC/POS queue must refuse these bytes and leave the register the browser/OS
  // fallback. Weakening that validation, not the refusal, would be the defect.
  const unsupported = await request.post('/api/restaurant/checkout/receipt', {
    headers: {
      ...pos.headers,
      'Idempotency-Key': e2eIdempotencyKey('software-receipt-print', orderNumber),
    },
    data: { billId, action: 'print' },
  });
  expect(unsupported.status(), await unsupported.text()).toBe(422);
  expect(await unsupported.json()).toMatchObject({
    code: 'UNSUPPORTED_PRINT_TEXT',
    fallback: 'BROWSER_OS',
  });
  expect(
    await printJobByKey(pool, `${documentReference(billId)}:original`),
    'a refused receipt must leave no durable job behind'
  ).toHaveLength(0);

  const refusedRead = await request.get(
    `/api/restaurant/checkout/receipt?billId=${encodeURIComponent(billId)}`,
    { headers: pos.headers }
  );
  expect(refusedRead.status()).toBe(200);
  const refused = (await refusedRead.json()) as {
    printing: {
      latestJob: unknown;
      preview: { text: string | null; validation: { code: string; fallback: string } | null };
    };
  };
  expect(refused.printing.latestJob).toBeNull();
  expect(refused.printing.preview.validation).toMatchObject({
    code: 'UNSUPPORTED_PRINT_TEXT',
    fallback: 'BROWSER_OS',
  });
  expect(
    refused.printing.preview.text,
    'a refused receipt must still render for the browser/OS fallback'
  ).toBeTruthy();

  // Queued acceptance runs in the isolated ASCII-printable branch. Same routes, same
  // register contract — only the branch name differs, which is the whole point.
  asciiPos = await establishAsciiPosTerminal(request);
  await publishRoutes(ASCII_RECEIPT_BRANCH.branchId, [asciiReceiptRoute]);
  asciiRoutingPublished = true;

  const asciiMenuResponse = await request.get(
    '/api/restaurant/orders/effective-menu?channel=DINE_IN',
    { headers: asciiPos.headers }
  );
  expect(asciiMenuResponse.status(), await asciiMenuResponse.text()).toBe(200);
  const asciiMenu = (await asciiMenuResponse.json()) as {
    publicationId: string;
    sections: Array<{
      items: Array<{ id: string; displayName: string | null; product: { name: string } }>;
    }>;
  };
  const asciiMenuItem = asciiMenu.sections
    .flatMap((section) => section.items)
    .find((item) => (item.displayName ?? item.product.name) === fixture.menuItem.name);
  expect(
    asciiMenuItem,
    `seeded menu item "${fixture.menuItem.name}" must be on the isolated branch DINE_IN menu`
  ).toBeDefined();

  const asciiOpened = await post(
    request,
    asciiPos,
    '/api/restaurant/orders/open',
    { channel: 'DINE_IN', coverCount: 1, publicationId: asciiMenu.publicationId },
    e2eIdempotencyKey('software-receipt-ascii-open', Date.now())
  );
  expect(asciiOpened.status()).toBe(201);
  ({ orderId: asciiOrderId, orderNumber: asciiOrderNumber } = (await asciiOpened.json()) as {
    orderId: string;
    orderNumber: number;
  });
  await post(
    request,
    asciiPos,
    '/api/restaurant/orders/add-item',
    {
      orderId: asciiOrderId,
      menuItemId: asciiMenuItem!.id,
      quantity: 1,
      modifierOptionIds: [fixture.modifier.optionId],
    },
    e2eIdempotencyKey('software-receipt-ascii-add-item', asciiOrderNumber)
  );
  await post(
    request,
    asciiPos,
    '/api/restaurant/orders/fire',
    { orderId: asciiOrderId },
    e2eIdempotencyKey('software-receipt-ascii-fire', asciiOrderNumber)
  );

  const asciiBill = await post(
    request,
    asciiPos,
    '/api/restaurant/checkout/bill',
    { orderId: asciiOrderId, split: { kind: 'NONE' } },
    e2eIdempotencyKey('software-receipt-ascii-bill', asciiOrderNumber)
  );
  asciiBillId = ((await asciiBill.json()) as { billIds: string[] }).billIds[0]!;

  const asciiSummaryResponse = await request.get(
    `/api/restaurant/checkout/summary?orderId=${encodeURIComponent(asciiOrderId)}`,
    { headers: asciiPos.headers }
  );
  expect(asciiSummaryResponse.status()).toBe(200);
  const asciiSummary = (await asciiSummaryResponse.json()) as { derivedOrderTotal: string };

  await post(
    request,
    asciiPos,
    '/api/restaurant/checkout/tender',
    {
      billId: asciiBillId,
      tender: {
        type: 'CARD',
        amount: asciiSummary.derivedOrderTotal,
        manualConfirmation: { approvalCode: 'E2E739', reference: '4242' },
      },
    },
    e2eIdempotencyKey('software-receipt-ascii-tender', asciiOrderNumber)
  );

  const printed = await post(
    request,
    asciiPos,
    '/api/restaurant/checkout/receipt',
    { billId: asciiBillId, action: 'print' },
    e2eIdempotencyKey('software-receipt-ascii-print', asciiOrderNumber)
  );
  const dispatch = (await printed.json()) as {
    outcome: string;
    replayed: boolean;
    printerId: string | null;
    latestJob: { id: string; status: string } | null;
    preview: { text: string | null; validation: unknown };
  };
  expect(dispatch).toMatchObject({
    outcome: 'QUEUED',
    replayed: false,
    printerId: asciiReceiptRoute.printerId,
  });
  expect(dispatch.latestJob).toMatchObject({ status: 'PENDING' });
  expect(
    dispatch.preview.validation,
    'ASCII-printable receipt facts must clear the charset gate outright'
  ).toBeNull();
  expect(dispatch.preview.text).toBeTruthy();

  const receiptRead = await request.get(
    `/api/restaurant/checkout/receipt?billId=${encodeURIComponent(asciiBillId)}`,
    { headers: asciiPos.headers }
  );
  expect(receiptRead.status()).toBe(200);
  const receipt = (await receiptRead.json()) as {
    receiptNumber: string;
    printing: { latestJob: { id: string; document?: unknown } | null };
  };
  expect(receipt.printing.latestJob).toMatchObject({ id: dispatch.latestJob!.id });
  expect(receipt.printing.latestJob).not.toHaveProperty('document');
  expect(receipt.receiptNumber).toBeTruthy();

  // A copy may only be issued once the bridge has confirmed the original reached paper.
  const earlyReprint = await request.post('/api/restaurant/checkout/receipt', {
    headers: {
      ...asciiPos.headers,
      'Idempotency-Key': e2eIdempotencyKey('software-receipt-reprint-early', asciiOrderNumber),
    },
    data: {
      billId: asciiBillId,
      action: 'reprint',
      reason: 'A copy must not precede an acknowledged original',
      requestId: '1c7a2c4e-5f60-4b7d-8f31-9a0b5c6d7e80',
    },
  });
  expect(earlyReprint.status()).toBe(409);

  // A fresh money idempotency key must still reuse the ONE durable receipt job.
  const replayed = await post(
    request,
    asciiPos,
    '/api/restaurant/checkout/receipt',
    { billId: asciiBillId, action: 'print' },
    e2eIdempotencyKey('software-receipt-print-transport-retry', asciiOrderNumber)
  );
  const replay = (await replayed.json()) as {
    replayed: boolean;
    latestJob: { id: string } | null;
  };
  expect(replay.replayed).toBe(true);
  expect(replay.latestJob!.id).toBe(dispatch.latestJob!.id);

  // Scoped to the BILL, not to the job's primary key: two print requests against one
  // settled bill must leave one row, and its key must be the derived document key.
  receiptReference = documentReference(asciiBillId);
  const jobs = await tenantQuery<{ id: string; key: string }>(
    pool,
    `SELECT id, "idempotencyKey" key
       FROM restaurant_print_jobs
      WHERE "branchId" = $1 AND "documentType" = 'RECEIPT' AND document->>'reference' = $2`,
    [ASCII_RECEIPT_BRANCH.branchId, receiptReference]
  );
  expect(
    jobs.rows,
    'one settled bill must hold exactly one durable original receipt job'
  ).toHaveLength(1);
  expect(jobs.rows[0]!.id).toBe(dispatch.latestJob!.id);
  expect(jobs.rows[0]!.key).toBe(`${receiptReference}:original`);
});

test('the queued receipt bytes carry exactly the operator-visible preview', async ({ request }) => {
  const receiptRead = await request.get(
    `/api/restaurant/checkout/receipt?billId=${encodeURIComponent(asciiBillId)}`,
    { headers: asciiPos.headers }
  );
  // `receiptNumber` is an Int in the schema, so it arrives as a JSON number.
  const receipt = (await receiptRead.json()) as {
    receiptNumber: number;
    printing: { preview: { text: string } };
  };

  const asciiBridge = asciiBridgeDevice();
  const claimed = await claimBridgeJob(request, asciiBridge);
  expect(claimed, 'the queued receipt must be claimable by a branch bridge').not.toBeNull();
  expect(claimed!.documentType).toBe('RECEIPT');
  expect(claimed!.printerId).toBe(asciiReceiptRoute.printerId);

  const rendered = Buffer.from(claimed!.bytes, 'base64').toString('latin1');
  expect(rendered.startsWith(ESC_POS_INIT)).toBe(true);
  expect(rendered.endsWith(ESC_POS_CUT)).toBe(true);
  // The transport must ship the SAME text the register showed, not a re-derivation.
  expect(rendered).toContain(receipt.printing.preview.text);
  expect(rendered).toContain(String(receipt.receiptNumber));

  const acknowledged = await acknowledgeBridgeJob(request, asciiBridge, {
    jobId: claimed!.id,
    claimToken: claimed!.claimToken,
    status: 'PRINTED',
  });
  expect(acknowledged.status(), await acknowledged.text()).toBe(200);
  expect(await acknowledged.json()).toEqual({ acknowledged: true, replayed: false });

  const rows = await printJobByKey(
    pool,
    `${receiptReference}:original`,
    ASCII_RECEIPT_BRANCH.branchId
  );
  expect(rows[0]).toMatchObject({
    status: 'PRINTED',
    attemptCount: 1,
    printerId: asciiReceiptRoute.printerId,
    byteCount: Buffer.from(claimed!.bytes, 'base64').length,
  });
  expect(rows[0]!.printedAt).not.toBeNull();
  expect(await claimBridgeJob(request, asciiBridge)).toBeNull();
});

test('a receipt reprint is idempotent per requestId and refuses a changed reason', async ({
  request,
}) => {
  reprintRequestId = '4d0f3d8c-6a1e-4f2b-9a7c-1e2b3c4d5e6f';
  const reason = 'Guest requested a duplicate software copy';

  const first = await post(
    request,
    asciiPos,
    '/api/restaurant/checkout/receipt',
    { billId: asciiBillId, action: 'reprint', reason, requestId: reprintRequestId },
    e2eIdempotencyKey('software-receipt-reprint', asciiOrderNumber)
  );
  const reprint = (await first.json()) as {
    outcome: string;
    replayed: boolean;
    latestJob: { id: string } | null;
  };
  expect(reprint).toMatchObject({ outcome: 'QUEUED', replayed: false });

  const retried = await post(
    request,
    asciiPos,
    '/api/restaurant/checkout/receipt',
    { billId: asciiBillId, action: 'reprint', reason, requestId: reprintRequestId },
    e2eIdempotencyKey('software-receipt-reprint-retry', asciiOrderNumber)
  );
  const retry = (await retried.json()) as { replayed: boolean; latestJob: { id: string } | null };
  expect(retry.replayed).toBe(true);
  expect(retry.latestJob!.id).toBe(reprint.latestJob!.id);

  const changedReason = await request.post('/api/restaurant/checkout/receipt', {
    headers: {
      ...asciiPos.headers,
      'Idempotency-Key': e2eIdempotencyKey('software-receipt-reprint-changed', asciiOrderNumber),
    },
    data: {
      billId: asciiBillId,
      action: 'reprint',
      reason: 'A different reason on the same request id',
      requestId: reprintRequestId,
    },
  });
  expect(changedReason.status()).toBe(409);

  const rows = await printJobByKey(
    pool,
    `${receiptReference}:reprint:${reprintRequestId}`,
    ASCII_RECEIPT_BRANCH.branchId
  );
  expect(rows, 'one reprint request id must map to exactly one durable job').toHaveLength(1);
  expect(rows[0]!.document).toMatchObject({ footer: `Receipt copy\nReprint: ${reason}` });
});

test('an OFFLINE acknowledgement holds the copy instead of silently retrying it', async ({
  request,
}) => {
  const asciiBridge = asciiBridgeDevice();
  const claimed = await claimBridgeJob(request, asciiBridge);
  expect(claimed, 'the queued reprint must be claimable').not.toBeNull();
  expect(claimed!.documentType).toBe('RECEIPT');

  const acknowledged = await acknowledgeBridgeJob(request, asciiBridge, {
    jobId: claimed!.id,
    claimToken: claimed!.claimToken,
    status: 'OFFLINE',
    error: 'Local spooler refused the copy',
  });
  expect(acknowledged.status()).toBe(200);
  expect(await acknowledged.json()).toEqual({ acknowledged: true, replayed: false });

  const rows = await printJobByKey(
    pool,
    `${receiptReference}:reprint:${reprintRequestId}`,
    ASCII_RECEIPT_BRANCH.branchId
  );
  expect(rows[0]).toMatchObject({
    status: 'OFFLINE',
    attemptCount: 1,
    printedAt: null,
    byteCount: null,
    printerId: asciiReceiptRoute.printerId,
  });
  expect(await claimBridgeJob(request, asciiBridge)).toBeNull();
});

test('a sibling-branch bridge can neither claim nor acknowledge this branch work', async ({
  request,
}) => {
  const manual = await post(
    request,
    pos,
    '/api/restaurant/orders/reprint-kot',
    { orderId, ticketId: kitchenTicketId },
    e2eIdempotencyKey('software-receipt-kot-reprint', orderNumber)
  );
  expect((await manual.json()).replayed).toBe(false);

  const pending = await tenantQuery<{ id: string }>(
    pool,
    `SELECT id FROM restaurant_print_jobs
      WHERE "branchId" = $1 AND status = 'PENDING' AND "documentType" = 'KITCHEN_TICKET'
        AND "idempotencyKey" <> $2`,
    [fixture.branchId, kitchenJobIdempotencyKey]
  );
  expect(pending.rows, 'a KOT reprint must queue a fresh durable copy').toHaveLength(1);
  kitchenTicketJobCount = Number(
    (
      await tenantQuery<{ count: string }>(
        pool,
        `SELECT count(*)::text count FROM restaurant_print_jobs
          WHERE "branchId" = $1 AND "documentType" = 'KITCHEN_TICKET'`,
        [fixture.branchId]
      )
    ).rows[0]!.count
  );

  expect(
    await claimBridgeJob(request, fixture.delivery.kds),
    'a sibling-branch bridge must never be handed this branch work'
  ).toBeNull();
  const foreignAck = await acknowledgeBridgeJob(request, fixture.delivery.kds, {
    jobId: pending.rows[0]!.id,
    claimToken: 'a'.repeat(64),
    status: 'PRINTED',
  });
  expect(foreignAck.status()).toBe(404);

  const unregistered = await request.get('/api/restaurant/print-bridge?wait=0', {
    headers: { authorization: 'Bearer rdk_not_a_registered_bridge_secret' },
  });
  expect(unregistered.status()).toBe(401);
});

test('a KOT reprint replays on the same key and fails closed once routing is revoked', async ({
  request,
}) => {
  const replayKey = e2eIdempotencyKey('software-receipt-kot-reprint', orderNumber);
  const replayed = await post(
    request,
    pos,
    '/api/restaurant/orders/reprint-kot',
    { orderId, ticketId: kitchenTicketId },
    replayKey
  );
  expect((await replayed.json()).replayed).toBe(true);
  const unchanged = await tenantQuery<{ count: string }>(
    pool,
    `SELECT count(*)::text count FROM restaurant_print_jobs
      WHERE "branchId" = $1 AND "documentType" = 'KITCHEN_TICKET'`,
    [fixture.branchId]
  );
  expect(
    Number(unchanged.rows[0]!.count),
    'a replayed reprint key must not queue a second copy'
  ).toBe(kitchenTicketJobCount);

  await publishRoutes(fixture.branchId, []);
  await publishRoutes(ASCII_RECEIPT_BRANCH.branchId, []);

  const afterRevocation = await request.post('/api/restaurant/orders/reprint-kot', {
    headers: {
      ...pos.headers,
      'Idempotency-Key': e2eIdempotencyKey('software-receipt-kot-reprint-revoked', orderNumber),
    },
    data: { orderId, ticketId: kitchenTicketId },
  });
  expect(afterRevocation.status()).toBe(409);

  // Revoking routing must not rewrite work that was already accepted.
  const preserved = await printJobByKey(pool, kitchenJobIdempotencyKey);
  expect(preserved[0]).toMatchObject({ printerId: KITCHEN_PRINTER_ID, status: 'PRINTED' });
  const settled = await printJobByKey(
    pool,
    `${receiptReference}:original`,
    ASCII_RECEIPT_BRANCH.branchId
  );
  expect(settled[0]).toMatchObject({ printerId: asciiReceiptRoute.printerId, status: 'PRINTED' });
});

/**
 * FIXTURE CONTRACT (not yet satisfied by `scripts/seed-restaurant-e2e.ts`).
 *
 * `withDeviceAuth` rejects a revoked device with 403 'This device has been revoked.'
 * before any queue read, but the restaurant E2E seed creates only ACTIVE devices, so
 * there is no way to prove it against the running application. Satisfying this needs,
 * in the isolated E2E tenant:
 *
 *   restaurant_registered_devices:
 *     id                 'device_restaurant_e2e_print_bridge_revoked'
 *     branchId           'branch_restaurant_e2e'
 *     kind               'KDS'
 *     status             'REVOKED'
 *     revokedAt          a fixed past timestamp
 *     deviceSecretHash   deviceSecretHash(<secret below>)
 *
 * and the plaintext secret exported to the lane as
 * RESTAURANT_E2E_REVOKED_BRIDGE_DEVICE_SECRET (an `rdk_`-prefixed literal, e.g.
 * 'rdk_restaurant_e2e_print_bridge_revoked_local_ci_only') so the transport takes the
 * bridge branch rather than the web-session branch.
 *
 * This test deliberately FAILS rather than skips while the fixture is absent: a
 * revocation gate that is never executed is not evidence.
 */
test('a revoked bridge device is refused at the transport', async ({ request }) => {
  const secret = process.env.RESTAURANT_E2E_REVOKED_BRIDGE_DEVICE_SECRET;
  expect(
    secret,
    'RESTAURANT_E2E_REVOKED_BRIDGE_DEVICE_SECRET is required; see the fixture contract above this test.'
  ).toBeTruthy();
  expect(
    secret,
    'the revoked bridge secret must be rdk_-prefixed to reach the bridge transport'
  ).toMatch(/^rdk_/);

  const claim = await request.get('/api/restaurant/print-bridge?wait=0', {
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(claim.status()).toBe(403);
  expect(await claim.json()).toMatchObject({ error: 'This device has been revoked.' });

  const ack = await request.post('/api/restaurant/print-bridge', {
    headers: { authorization: `Bearer ${secret}` },
    data: { jobId: 'any', claimToken: 'a'.repeat(64), status: 'PRINTED' },
  });
  expect(ack.status()).toBe(403);
});
