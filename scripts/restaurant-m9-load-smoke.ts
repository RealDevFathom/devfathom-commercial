import { performance } from 'node:perf_hooks';

type Options = { orders: number; concurrency: number; timeoutMs: number };
type Headers = {
  authorization: string;
  'x-terminal-session': string;
  'x-pos-composer-proof': string;
};
type CommandResult = { replayed: boolean };
type OrderResult = {
  orderId: string;
  orderNumber: number;
  itemIds: string[];
  ticketIds: string[];
  durationMs: number;
};
type Queue = {
  tickets: Array<{
    ticketId: string;
    orderId: string;
    items: Array<{ orderItemId: string }>;
  }>;
  gap: boolean;
  hasMore: boolean;
};

const MENU_ITEM_ID = 'menu_item_restaurant_e2e_burger';
/** The seeded item's Heat group is mandatory (min 1, max 1). */
const HEAT_MODIFIER_OPTION_ID = 'modifier_option_restaurant_e2e_spicy';
const PUBLICATION_ID = 'menu_publication_restaurant_e2e';
const FIXTURE = {
  operatorId: 'staff_restaurant_e2e_operator',
  operatorPin: '424242',
  posDeviceSecret: 'rdk_restaurant_e2e_pos_local_ci_only',
  kdsDeviceSecret: 'rdk_restaurant_e2e_kds_local_ci_only',
} as const;

function parseOptions(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --name value arguments; received ${name ?? '<end>'}.`);
    }
    values.set(name, value);
  }

  const integer = (name: string, fallback: number) => {
    const raw = values.get(name);
    const parsed = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new Error(`${name} must be a positive integer.`);
    }
    return parsed;
  };

  const known = new Set(['--orders', '--concurrency', '--timeout-ms']);
  for (const name of values.keys()) {
    if (!known.has(name)) throw new Error(`Unknown argument: ${name}`);
  }
  return {
    orders: integer('--orders', 32),
    concurrency: integer('--concurrency', 8),
    timeoutMs: integer('--timeout-ms', 60_000),
  };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  signal: AbortSignal,
  init: RequestInit = {},
  expectedStatus = 200
): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), { ...init, signal });
  if (response.status >= 500) {
    throw new Error(`${path} returned server error ${response.status}.`);
  }
  if (response.status !== expectedStatus) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`${path} returned ${response.status}, expected ${expectedStatus}: ${body}`);
  }
  return (await response.json()) as T;
}

async function establishTerminal(
  baseUrl: string,
  signal: AbortSignal,
  deviceSecret: string
): Promise<Headers> {
  const authorization = `Bearer ${deviceSecret}`;
  const established = await requestJson<{ sessionToken: string }>(
    baseUrl,
    '/api/restaurant/terminal/establish',
    signal,
    { method: 'POST', headers: { authorization } },
    201
  );
  const headers = { authorization, 'x-terminal-session': established.sessionToken };
  const unlocked = await requestJson<{ composerProof: string }>(
    baseUrl,
    '/api/restaurant/terminal/unlock',
    signal,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        staffProfileId: FIXTURE.operatorId,
        type: 'PIN',
        secret: FIXTURE.operatorPin,
      }),
    }
  );
  if (typeof unlocked.composerProof !== 'string') {
    throw new Error('/api/restaurant/terminal/unlock returned no composer proof.');
  }
  return { ...headers, 'x-pos-composer-proof': unlocked.composerProof };
}

async function command<T extends CommandResult>(
  baseUrl: string,
  signal: AbortSignal,
  headers: Headers,
  path: string,
  idempotencyKey: string,
  body: unknown,
  expectedStatus = 200
): Promise<T> {
  return requestJson<T>(
    baseUrl,
    path,
    signal,
    {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(body),
    },
    expectedStatus
  );
}

async function runOrder(
  index: number,
  runId: string,
  baseUrl: string,
  signal: AbortSignal,
  headers: Headers
): Promise<OrderResult> {
  const startedAt = performance.now();
  const key = (operation: string) => `m9-load-${runId}-${index}-${operation}`;
  const clientHeaders = { ...headers, 'x-forwarded-for': `198.51.100.${index + 1}` };
  const openBody = { channel: 'TAKEAWAY', publicationId: PUBLICATION_ID };
  const opened = await command<
    CommandResult & { orderId: string; orderNumber: number; businessDate: string }
  >(baseUrl, signal, clientHeaders, '/api/restaurant/orders/open', key('open'), openBody, 201);
  if (opened.replayed) throw new Error(`Order ${index} unexpectedly replayed on first open.`);

  const itemIds: string[] = [];
  for (let itemIndex = 0; itemIndex < 2; itemIndex++) {
    const body = {
      orderId: opened.orderId,
      menuItemId: MENU_ITEM_ID,
      modifierOptionIds: [HEAT_MODIFIER_OPTION_ID],
    };
    const added = await command<CommandResult & { itemId: string }>(
      baseUrl,
      signal,
      clientHeaders,
      '/api/restaurant/orders/add-item',
      key(`item-${itemIndex}`),
      body,
      201
    );
    if (added.replayed) throw new Error(`Order ${index} item ${itemIndex} replayed on first add.`);
    itemIds.push(added.itemId);
  }

  const fireBody = { orderId: opened.orderId };
  const fired = await command<
    CommandResult & { orderId: string; itemIds: string[]; tickets: Array<{ ticketId: string }> }
  >(baseUrl, signal, clientHeaders, '/api/restaurant/orders/fire', key('fire'), fireBody);
  if (fired.replayed || fired.itemIds.length !== 2 || fired.tickets.length !== 1) {
    throw new Error(`Order ${index} initial fire count mismatch.`);
  }

  const replayedFire = await command<
    CommandResult & { itemIds: string[]; tickets: Array<{ ticketId: string }> }
  >(baseUrl, signal, clientHeaders, '/api/restaurant/orders/fire', key('fire'), fireBody);
  if (!replayedFire.replayed || replayedFire.itemIds.length || replayedFire.tickets.length) {
    throw new Error(`Order ${index} fire replay mismatch.`);
  }

  return {
    orderId: opened.orderId,
    orderNumber: opened.orderNumber,
    itemIds,
    ticketIds: fired.tickets.map((ticket) => ticket.ticketId),
    durationMs: performance.now() - startedAt,
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const baseUrl = process.env.PLAYWRIGHT_BASE_URL;
  if (!baseUrl) throw new Error('PLAYWRIGHT_BASE_URL is required.');

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('Load smoke hard timeout exceeded.')),
    options.timeoutMs
  );
  const startedAt = performance.now();
  try {
    const [posHeaders, kdsHeaders] = await Promise.all([
      establishTerminal(baseUrl, controller.signal, FIXTURE.posDeviceSecret),
      establishTerminal(baseUrl, controller.signal, FIXTURE.kdsDeviceSecret),
    ]);
    const runId = `${Date.now()}-${process.pid}`;
    const results: OrderResult[] = [];
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(options.orders, options.concurrency) },
      async () => {
        while (nextIndex < options.orders) {
          const index = nextIndex++;
          results.push(await runOrder(index, runId, baseUrl, controller.signal, posHeaders));
        }
      }
    );
    await Promise.all(workers);

    const queue = await requestJson<Queue>(
      baseUrl,
      '/api/restaurant/kds/queue?limit=200',
      controller.signal,
      { headers: kdsHeaders }
    );
    const orderIds = new Set(results.map((result) => result.orderId));
    const ticketIds = new Set(results.flatMap((result) => result.ticketIds));
    const currentTickets = queue.tickets.filter((ticket) => orderIds.has(ticket.orderId));
    const currentItems = currentTickets.flatMap((ticket) => ticket.items);
    const expectedItems = new Set(results.flatMap((result) => result.itemIds));
    const actualItems = new Set(currentItems.map((item) => item.orderItemId));
    if (
      results.length !== options.orders ||
      orderIds.size !== options.orders ||
      ticketIds.size !== options.orders ||
      currentTickets.length !== options.orders ||
      currentItems.length !== options.orders * 2 ||
      expectedItems.size !== options.orders * 2 ||
      actualItems.size !== expectedItems.size ||
      [...expectedItems].some((id) => !actualItems.has(id))
    ) {
      throw new Error(
        `KDS fanout mismatch: orders=${orderIds.size}, tickets=${currentTickets.length}, items=${currentItems.length}.`
      );
    }

    const durations = results.map((result) => result.durationMs);
    console.log(
      JSON.stringify({
        ok: true,
        orders: results.length,
        stationItems: currentItems.length,
        kdsTickets: currentTickets.length,
        duplicateReplays: results.length,
        concurrency: options.concurrency,
        elapsedMs: Math.round(performance.now() - startedAt),
        p50Ms: Math.round(percentile(durations, 0.5)),
        p95Ms: Math.round(percentile(durations, 0.95)),
        queueGap: queue.gap,
        queueHasMore: queue.hasMore,
      })
    );
  } finally {
    clearTimeout(timeout);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
