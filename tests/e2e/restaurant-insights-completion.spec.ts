import { readFile } from 'node:fs/promises';

import { expect, test, type Locator, type Page } from '@playwright/test';
import pg from 'pg';

import {
  completeWorkspaceSelection,
  isAuthenticatedAppDestination,
  signInAs,
} from './fixtures/restaurant-actor-accessibility';
import {
  insightsCompletionFixtureReady,
  insightsCompletionOrigin,
  insightsCompletionPassword,
  restaurantInsightsCompletionFixture,
  type InsightsCompletionTenant,
} from './fixtures/restaurant-insights-completion';
import { restaurantE2eCredentials as fixture } from './restaurant-fixture';

test.describe.configure({ mode: 'serial' });

if (process.env.RESTAURANT_INTEGRATED_E2E !== '1') {
  throw new Error('RESTAURANT_INTEGRATED_E2E=1 is required.');
}

/**
 * Completion coverage for the Insights console: close-readiness preparation,
 * contribution scenarios, the client-side scope/freshness guard, chat
 * independence and the capability boundary. Every expectation is derived from
 * the seeded fixture read live over the tenant connection — this spec never
 * writes, seeds or mutates any record, entitlement or company setting.
 */
const CLOSE_PACKET_PROCEDURE = 'restaurantInsights.prepareClosePacket';
const SEEDED_DRAWER_ID = 'drawer_restaurant_e2e';
const CONTRIBUTION_DEFINITION =
  '(Unit price − per-unit discount − unit variable cost) × assumed quantity − incremental cost';
const SCENARIO_PERIOD = { from: '2026-09-01', to: '2026-09-07' } as const;
const STALE_ANCHOR = '2026-01-01T00:00:00.000Z';

/**
 * `requireLicensedModule` names the catalog module and falls back to the module
 * key when the withheld module is absent from the entitlement snapshot. Both
 * branches are accepted so a lagging platform catalog name cannot masquerade as
 * a missing denial; nothing else may satisfy this.
 */
const MODULE_DENIED_MESSAGE =
  /^The (?:Restaurant Insights|restaurant-insights) module is not enabled for this organization\.$/;

/**
 * The app has exactly two assistant/chat transports: the `/api/assistant` route
 * and the `chat.*` procedures of the `/api/trpc` router (`src/server/routers/_app.ts`).
 * `organizationAdmin.askFathomSettings` only reads availability metadata for the
 * shell's launcher, and `app-shell.tsx` issues it on every shell-mounted page —
 * Insights included — so matching the bare `askFathom` token would score that
 * ordinary read as a chat turn.
 *
 * `httpBatchLink` joins batched procedure names with `,` inside the path segment,
 * so a batch is judged per procedure. That keeps a batch that carries both the
 * availability read and a real chat turn classified as chat; only a batch whose
 * every procedure is a permitted availability read is let through.
 */
const AVAILABILITY_ONLY_PROCEDURES = new Set(['organizationAdmin.askFathomSettings']);
const TRPC_ENDPOINT_PREFIX = '/api/trpc/';

function isAssistantOrChatRequest(requestUrl: string): boolean {
  const url = new URL(requestUrl);
  const pathname = decodeURIComponent(url.pathname);
  if (pathname === '/api/assistant' || pathname.startsWith('/api/assistant/')) return true;
  if (pathname.startsWith(TRPC_ENDPOINT_PREFIX)) {
    return pathname
      .slice(TRPC_ENDPOINT_PREFIX.length)
      .split(',')
      .some(
        (procedure) =>
          !AVAILABILITY_ONLY_PROCEDURES.has(procedure) &&
          (procedure.startsWith('chat.') || /askFathom/i.test(procedure))
      );
  }
  return /askFathom/i.test(url.href);
}

type DrawerRow = { id: string; status: string; counted_cash: string | null };
type CloseFixtureState = {
  openBillIds: string[];
  drawers: DrawerRow[];
  openDrawerIds: string[];
  missingCountDrawerIds: string[];
  unbilledOrderIds: string[];
  chainTipCloseId: string | null;
};

let pool: pg.Pool;
let businessDate: string;
let currency: string;
let askFathomEnabled: boolean;

async function withTenantClient<T>(
  action: (client: pg.PoolClient) => Promise<T>,
  organizationId: string = fixture.organizationId
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_organization_id', $1, true),
              set_config('app.is_platform_admin', 'false', true)`,
      [organizationId]
    );
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function tenantQuery<T extends pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
  organizationId: string = fixture.organizationId
) {
  return withTenantClient((client) => client.query<T>(text, values), organizationId);
}

/** Reads the live authoritative state the close packet must reproduce. */
async function readCloseFixtureState(): Promise<CloseFixtureState> {
  const scope = [fixture.organizationId, fixture.branchId, businessDate];
  const openBills = await tenantQuery<{ id: string }>(
    `SELECT id FROM restaurant_bills
     WHERE "organizationId" = $1 AND "branchId" = $2 AND "businessDate" = $3::date
       AND status = 'OPEN'
     ORDER BY id`,
    scope
  );
  const drawers = await tenantQuery<DrawerRow>(
    `SELECT id, status::text, "countedCash"::text counted_cash
     FROM restaurant_drawer_sessions
     WHERE "organizationId" = $1 AND "branchId" = $2 AND "businessDate" = $3::date
     ORDER BY id`,
    scope
  );
  const unbilledOrders = await tenantQuery<{ id: string }>(
    `SELECT o.id FROM restaurant_orders o
     WHERE o."organizationId" = $1 AND o."branchId" = $2 AND o."businessDate" = $3::date
       AND o.status <> 'CANCELLED'
       AND EXISTS (
         SELECT 1 FROM restaurant_order_items i
         WHERE i."orderId" = o.id AND i.status <> 'VOIDED')
       AND NOT EXISTS (
         SELECT 1 FROM restaurant_bills b
         WHERE b."orderId" = o.id AND b.status <> 'VOID')
     ORDER BY o.id`,
    scope
  );
  // resolveChainTip: the close no other close supersedes.
  const chainTip = await tenantQuery<{ id: string }>(
    `SELECT c.id FROM restaurant_daily_closes c
     WHERE c."organizationId" = $1 AND c."branchId" = $2 AND c."businessDate" = $3::date
       AND NOT EXISTS (
         SELECT 1 FROM restaurant_daily_closes s
         WHERE s."organizationId" = c."organizationId" AND s."supersedesCloseId" = c.id)
     ORDER BY c."createdAt" DESC`,
    scope
  );
  return {
    openBillIds: openBills.rows.map((row) => row.id),
    drawers: drawers.rows,
    openDrawerIds: drawers.rows.filter((row) => row.status === 'OPEN').map((row) => row.id),
    missingCountDrawerIds: drawers.rows
      .filter((row) => row.counted_cash === null)
      .map((row) => row.id),
    unbilledOrderIds: unbilledOrders.rows.map((row) => row.id),
    chainTipCloseId: chainTip.rows[0]?.id ?? null,
  };
}

async function openInsights(page: Page, actor: 'restaurantAdmin' | 'restaurantOperator') {
  const origin = await signInAs(page, actor);
  await page.goto(new URL('/restaurant/insights', origin).href);
  await expect(page.getByRole('heading', { name: 'Insights', exact: true })).toBeVisible();
  return origin;
}

async function selectSeededBranch(page: Page) {
  const branch = page.getByLabel('Branch', { exact: true });
  await expect(branch).toBeEnabled();
  await branch.selectOption(fixture.branchId);
  await expect(branch).toHaveValue(fixture.branchId);
}

function insightsTab(page: Page, name: string) {
  return page.getByRole('tablist', { name: 'Insight reports' }).getByRole('tab', { name });
}

async function openInsightsTab(page: Page, name: string) {
  const tab = insightsTab(page, name);
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

function sectionCard(page: Page, heading: string) {
  return page
    .locator('[data-slot="section-card"]')
    .filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
    .first();
}

/** The `<dd>` holding the rendered value for a `<dt>` label inside a card. */
function definitionValue(page: Page, card: Locator, term: string) {
  return card
    .locator('dl > div')
    .filter({ has: page.getByText(term, { exact: true }) })
    .locator('dd')
    .first();
}

async function preparePacket(page: Page, date: string) {
  await page.getByLabel('Close business date').fill(date);
  const responded = page.waitForResponse((response) =>
    response.url().includes(CLOSE_PACKET_PROCEDURE)
  );
  await page.getByRole('button', { name: /close packet/ }).click();
  return responded;
}

type PacketRewrite = (packet: PacketBody) => void;
type PacketBody = {
  scope: { branchId: string };
  period: { from: string; to: string };
  freshness: { asOf: string };
};

/**
 * Installs one interceptor whose rewrite is swapped per case; `page.unroute`
 * cannot match a fresh predicate instance, so the handler outlives the cases.
 */
async function interceptPacket(page: Page, rewrite: () => PacketRewrite | null) {
  await page.route(
    (url) => url.pathname.includes('/api/trpc/') && url.href.includes(CLOSE_PACKET_PROCEDURE),
    async (route) => {
      const mutate = rewrite();
      if (!mutate) return route.fallback();
      const response = await route.fetch();
      const body = (await response.json()) as unknown;
      const entries = (Array.isArray(body) ? body : [body]) as Array<{
        result?: { data?: { json?: PacketBody } };
      }>;
      const packets = entries
        .map((entry) => entry.result?.data?.json)
        .filter((packet): packet is PacketBody => Boolean(packet?.scope));
      if (packets.length === 0) {
        throw new Error(`No ${CLOSE_PACKET_PROCEDURE} payload to rewrite in ${response.url()}`);
      }
      for (const packet of packets) mutate(packet);
      await route.fulfill({
        status: response.status(),
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    }
  );
}

async function expectPacketRejected(page: Page) {
  const alert = page.getByRole('alert').filter({ hasText: 'Preparation failed' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(
    'Could not prepare matching close evidence. Retry the request. Your inputs are preserved; previous evidence is hidden.'
  );
  await expect(page.getByText('Not ready for unattended close')).toBeHidden();
  await expect(sectionCard(page, 'Financial readiness')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Retry close packet' })).toBeVisible();
  await expect(page.getByLabel('Close business date')).toHaveValue(businessDate);
}

/**
 * WHA-1553 acceptance tenants. The two cases below never touch the Chai Chowk
 * fixture the five cases above use: turning company chat off there, or revoking
 * its Insights entitlement, would destroy those cases. Each of these tenants is
 * its own organization, signed in on its own host, and every expectation is the
 * seeded fact read back over the tenant connection.
 */
type CompletionRollup = {
  businessDate: string;
  orderCount: number;
  coverCount: number;
  grossSales: string;
  netSales: string;
};
type CompletionTenantFacts = {
  askFathomEnabled: boolean;
  currency: string;
  rollups: CompletionRollup[];
};

/** `Prisma.Decimal.toString()` drops a column scale's trailing zeros. */
function normalizeDecimal(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reads the persisted acceptance facts for one completion tenant and rejects a
 * fixture that does not match its published contract. A missing seed or a
 * drifted value fails the case loudly — it is never skipped and never spoofed.
 */
async function readCompletionTenantFacts(
  tenant: InsightsCompletionTenant
): Promise<CompletionTenantFacts> {
  expect(
    insightsCompletionFixtureReady(),
    'fixture prerequisite: RESTAURANT_ACTOR_ADMIN_PASSWORD must reach the browser process'
  ).toBe(true);

  const organization = await tenantQuery<{ currency: string; ask_fathom_enabled: boolean }>(
    `SELECT currency, "askFathomEnabled" ask_fathom_enabled FROM organizations WHERE id = $1`,
    [tenant.organizationId],
    tenant.organizationId
  );
  expect(
    organization.rows,
    `fixture prerequisite: organization ${tenant.organizationId} must be seeded by scripts/seed-restaurant-insights-completion-fixtures.ts`
  ).toHaveLength(1);
  expect(
    organization.rows[0]!.ask_fathom_enabled,
    `fixture prerequisite: ${tenant.organizationId} must persist askFathomEnabled=${tenant.askFathomEnabled}`
  ).toBe(tenant.askFathomEnabled);
  expect(organization.rows[0]!.currency).toBe(tenant.currency);

  const rollups = await tenantQuery<{
    business_date: string;
    order_count: number;
    cover_count: number;
    gross_sales: string;
    net_sales: string;
  }>(
    `SELECT to_char("businessDate", 'YYYY-MM-DD') business_date,
            "orderCount" order_count, "coverCount" cover_count,
            "grossSales"::text gross_sales, "netSales"::text net_sales
     FROM restaurant_insight_daily_rollups
     WHERE "organizationId" = $1 AND "branchId" = $2 AND "businessDate" = ANY($3::date[])
     ORDER BY "businessDate"`,
    [tenant.organizationId, tenant.branchId, [...tenant.businessDates]],
    tenant.organizationId
  );
  expect(
    rollups.rows.map((row) => row.business_date),
    `fixture prerequisite: branch ${tenant.branchId} must hold one rollup per published business date`
  ).toEqual([...tenant.businessDates]);
  expect(rollups.rows).toHaveLength(tenant.rollupCount);

  return {
    askFathomEnabled: organization.rows[0]!.ask_fathom_enabled,
    currency: organization.rows[0]!.currency,
    rollups: rollups.rows.map((row) => ({
      businessDate: row.business_date,
      orderCount: row.order_count,
      coverCount: row.cover_count,
      grossSales: row.gross_sales,
      netSales: row.net_sales,
    })),
  };
}

/**
 * Signs the tenant's own administrator in on the tenant's own host, which is
 * how `resolveOrganizationByHost` picks the organization. Reuses the shared
 * accessibility fixture's authentication waits, so a failed sign-in raises the
 * same diagnostic the other restaurant specs raise.
 */
async function signInToCompletionTenant(page: Page, tenant: InsightsCompletionTenant) {
  const origin = insightsCompletionOrigin(tenant);
  await page.goto(new URL('/login', origin).href);
  await page.getByLabel(/email/i).fill(tenant.admin.email);
  await page.locator('input[name="password"]').fill(insightsCompletionPassword());
  await page.getByRole('button', { name: 'Sign in' }).click();
  await completeWorkspaceSelection(
    page,
    '/login',
    new RegExp(`${escapeForRegExp(tenant.displayName)}|${escapeForRegExp(tenant.slug)}`, 'i')
  );
  await page.waitForURL((url) => isAuthenticatedAppDestination(url, '/login'));
  expect(new URL(page.url()).host, `sign-in must stay on the ${tenant.slug} tenant host`).toBe(
    new URL(origin).host
  );
  return origin;
}

/** Every money string the denied tenant holds, in stored and rendered form. */
function moneyStrings(facts: CompletionTenantFacts): string[] {
  return [
    ...new Set(
      facts.rollups.flatMap((rollup) => [
        rollup.grossSales,
        rollup.netSales,
        normalizeDecimal(rollup.grossSales),
        normalizeDecimal(rollup.netSales),
      ])
    ),
  ];
}

test.beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  expect(databaseUrl, 'integrated lane requires DATABASE_URL').toBeTruthy();
  for (const name of [
    'RESTAURANT_ACTOR_ADMIN_EMAIL',
    'RESTAURANT_ACTOR_ADMIN_PASSWORD',
    'RESTAURANT_ACTOR_OPERATOR_EMAIL',
    'RESTAURANT_ACTOR_OPERATOR_PASSWORD',
  ] as const) {
    expect(process.env[name], `${name} is required by the Insights completion lane`).toBeTruthy();
  }
  pool = new pg.Pool({ connectionString: databaseUrl });

  // The seeded open drawer pins the branch business date; it is never a future
  // date, so the packet reader cannot reject it. Reject the fixture loudly
  // rather than skipping when the seed did not create it.
  const drawer = await tenantQuery<{ business_date: string; branch_id: string }>(
    `SELECT to_char("businessDate", 'YYYY-MM-DD') business_date, "branchId" branch_id
     FROM restaurant_drawer_sessions
     WHERE "organizationId" = $1 AND id = $2`,
    [fixture.organizationId, SEEDED_DRAWER_ID]
  );
  expect(
    drawer.rows,
    `fixture prerequisite: restaurant_drawer_sessions row ${SEEDED_DRAWER_ID} must exist for ${fixture.organizationId}`
  ).toHaveLength(1);
  expect(drawer.rows[0]!.branch_id).toBe(fixture.branchId);
  businessDate = drawer.rows[0]!.business_date;

  const organization = await tenantQuery<{ currency: string; ask_fathom_enabled: boolean }>(
    `SELECT currency, "askFathomEnabled" ask_fathom_enabled
     FROM organizations WHERE id = $1`,
    [fixture.organizationId]
  );
  expect(
    organization.rows,
    `fixture prerequisite: organization ${fixture.organizationId} must be readable`
  ).toHaveLength(1);
  currency = organization.rows[0]!.currency;
  askFathomEnabled = organization.rows[0]!.ask_fathom_enabled;
  expect(currency, 'fixture prerequisite: organization currency must be populated').toMatch(
    /^[A-Z]{3}$/
  );

  const state = await readCloseFixtureState();
  expect(
    state.drawers.length + state.openBillIds.length + state.unbilledOrderIds.length,
    `fixture prerequisite: branch ${fixture.branchId} must hold drawer, bill or order evidence on ${businessDate}`
  ).toBeGreaterThan(0);
});

test.afterAll(async () => {
  await pool.end();
});

test('prepares a populated close packet that matches live evidence and redacts unavailable amounts', async ({
  page,
}) => {
  test.slow();
  await openInsights(page, 'restaurantAdmin');
  await selectSeededBranch(page);
  await openInsightsTab(page, 'Close readiness');

  // Nothing else mutates this branch while the integrated lane runs one worker
  // serially, so the state read here is the state the packet must report.
  const state = await readCloseFixtureState();
  expect((await preparePacket(page, businessDate)).status()).toBe(200);

  await expect(page.getByRole('status').filter({ hasText: 'Close packet prepared' })).toContainText(
    'Close packet prepared. Review financial readiness and operational handover separately.'
  );
  await expect(page.getByText('Not ready for unattended close')).toBeVisible();
  await expect(
    page.getByText(
      `Branch: ${fixture.branchId} · Business date: ${businessDate} to ${businessDate} (BUSINESS_DATE)`
    )
  ).toBeVisible();

  const financial = sectionCard(page, 'Financial readiness');
  await expect(financial).toContainText(`Currency: ${currency} · Decimal major amounts`);
  await expect(financial).toContainText(
    state.chainTipCloseId
      ? `Close: ${state.chainTipCloseId}`
      : 'Financial source: closePreview · Live preview'
  );
  await expect(financial).toContainText(
    state.chainTipCloseId
      ? 'Already closed at observation'
      : state.openBillIds.length || state.openDrawerIds.length
        ? 'Blocked at observation'
        : 'Checks passed at observation'
  );

  // Redaction contract: counted cash and variance stay unavailable unless the
  // coverage the reader itself reports is COMPLETE. No zero is ever imputed.
  const coverageHeading = financial.getByText(/^Cash count coverage: (COMPLETE|INCOMPLETE)$/);
  await expect(coverageHeading).toBeVisible();
  const complete = (await coverageHeading.innerText()).trim().endsWith(': COMPLETE');
  if (!state.chainTipCloseId) {
    expect(complete).toBe(state.openDrawerIds.length + state.missingCountDrawerIds.length === 0);
  }
  const money = /^[A-Z]{3} -?\d+(?:\.\d{2})?$/;
  for (const term of ['Counted drawer cash', 'Drawer cash variance']) {
    await expect(definitionValue(page, financial, term)).toHaveText(
      complete ? money : 'Unavailable'
    );
  }
  for (const term of ['Gross sales', 'Net sales', 'Refund principal', 'Expected drawer cash']) {
    await expect(definitionValue(page, financial, term)).toHaveText(money);
  }
  if (!complete) {
    await expect(financial).toContainText('CASH_COUNT_INCOMPLETE');
    await expect(financial).toContainText(
      'Cash counts are incomplete or do not verify the source close. Counted cash and variance are unavailable.'
    );
  }
  if (state.openDrawerIds.length) {
    await expect(financial).toContainText(
      `${state.openDrawerIds.length} open drawers prevent the existing daily close.`
    );
    await expect(financial).toContainText('OPEN_DRAWER');
    await expect(financial).toContainText('Responsible role: Cashier');
    await expect(financial.getByRole('link', { name: 'Review drawers' }).first()).toHaveAttribute(
      'href',
      '/restaurant/money'
    );
  }
  if (state.openBillIds.length) {
    await expect(financial).toContainText(
      `${state.openBillIds.length} open bills prevent the existing daily close. Record IDs show at most 100.`
    );
  }
  // A disagreement between the packet's own sequential reads is never silent.
  await expect(financial).not.toContainText('SOURCE_CHANGED');
  await expect(financial).not.toContainText('CURRENCY_UNAVAILABLE');

  const operational = sectionCard(page, 'Operational handover');
  await expect(operational).toContainText(
    `Orders without a live bill: ${state.unbilledOrderIds.length}`
  );
  await expect(operational).toContainText('Terminal synchronization: UNKNOWN');
  await expect(operational).toContainText('Staff clockouts: UNAVAILABLE');
  for (const code of [
    'TERMINAL_SYNC_UNKNOWN',
    'PARTIAL_BILL_COVERAGE_UNAVAILABLE',
    'STAFF_CLOCKOUTS_UNAVAILABLE',
  ]) {
    await expect(operational).toContainText(code);
  }
  await expect(operational).not.toContainText('SOURCE_CHANGED');
  if (state.unbilledOrderIds.length) {
    await expect(operational).toContainText(
      `${state.unbilledOrderIds.length} orders with active items have no live bill. Operational handover requires review.`
    );
    await expect(
      operational
        .getByRole('listitem')
        .filter({ hasText: 'orders with active items have no live bill' })
        .getByText(`Observed record references (${Math.min(state.unbilledOrderIds.length, 100)})`, {
          exact: true,
        })
    ).toBeVisible();
  }
});

test('rejects a close packet whose branch, business date or freshness anchor does not match the request', async ({
  page,
}) => {
  test.slow();
  await openInsights(page, 'restaurantAdmin');
  await selectSeededBranch(page);
  await openInsightsTab(page, 'Close readiness');

  let rewrite: PacketRewrite | null = null;
  await interceptPacket(page, () => rewrite);

  const cases: Array<[string, PacketRewrite]> = [
    ['a different branch', (packet) => void (packet.scope.branchId = fixture.branchA2Id)],
    ['a different business date', (packet) => void (packet.period.from = '2026-01-01')],
    ['a stale freshness anchor', (packet) => void (packet.freshness.asOf = STALE_ANCHOR)],
  ];
  for (const [label, mutate] of cases) {
    await test.step(`rejects ${label}`, async () => {
      rewrite = mutate;
      const response = await preparePacket(page, businessDate);
      expect(response.status()).toBe(200);
      await expectPacketRejected(page);
    });
  }

  // The guard hides evidence without wedging the console: the unmodified
  // response is accepted immediately afterwards.
  rewrite = null;
  await preparePacket(page, businessDate);
  await expect(page.getByText('Not ready for unattended close')).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Preparation failed' })).toBeHidden();
  await expect(
    page.getByText(
      `Branch: ${fixture.branchId} · Business date: ${businessDate} to ${businessDate} (BUSINESS_DATE)`
    )
  ).toBeVisible();
});

test('invalidates contribution assumptions and exports the calculated evidence as JSON', async ({
  page,
}) => {
  test.slow();
  await openInsights(page, 'restaurantAdmin');
  await selectSeededBranch(page);
  await page.getByLabel('From date').fill(SCENARIO_PERIOD.from);
  await page.getByLabel('To date').fill(SCENARIO_PERIOD.to);
  await openInsightsTab(page, 'Scenarios');

  const baseline = page.getByRole('group', { name: 'Baseline assumptions' });
  const scenario = page.getByRole('group', { name: 'Scenario assumptions' });
  const currencyField = page.getByLabel('Assumed currency code');
  const calculate = page.getByRole('button', { name: 'Calculate contribution' });
  const exportJson = page.getByRole('button', { name: 'Export assumptions JSON' });
  const result = page.getByRole('status', { name: 'Contribution result' });

  const fill = async (group: Locator, values: Record<string, string>) => {
    for (const [label, value] of Object.entries(values)) {
      await group.getByLabel(label, { exact: true }).fill(value);
    }
  };
  await fill(baseline, {
    'Unit price': '10.00',
    'Unit variable cost': '4.00',
    Quantity: '100',
    'Discount per unit': '0',
    'Incremental cost': '0',
  });
  await fill(scenario, {
    'Unit price': '12.00',
    'Unit variable cost': '4.50',
    Quantity: '120',
    'Discount per unit': '13.00',
    'Incremental cost': '150.00',
  });
  await currencyField.fill('pk');
  await expect(currencyField).toHaveValue('PK');
  await expect(exportJson).toBeDisabled();

  await calculate.click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Complete or correct the marked assumptions' })
  ).toBeVisible();
  await expect(
    page.getByText('Enter the three-letter currency code for all assumptions, such as PKR.')
  ).toBeVisible();
  await expect(currencyField).toHaveAttribute('aria-invalid', 'true');
  const scenarioDiscount = scenario.getByLabel('Discount per unit', { exact: true });
  await expect(scenario.getByText('Per-unit discount cannot exceed unit price.')).toBeVisible();
  await expect(scenarioDiscount).toHaveAttribute('aria-invalid', 'true');
  await expect(baseline.getByLabel('Discount per unit', { exact: true })).not.toHaveAttribute(
    'aria-invalid',
    'true'
  );
  await expect(result).toContainText(
    'Enter both cases and calculate. Editing assumptions clears the previous result and export.'
  );
  await expect(exportJson).toBeDisabled();

  await currencyField.fill('PKR');
  await scenarioDiscount.fill('1.00');
  await expect(scenario.getByText('Per-unit discount cannot exceed unit price.')).toBeHidden();
  await expect(currencyField).not.toHaveAttribute('aria-invalid', 'true');

  await calculate.click();
  const metric = (label: string) =>
    result
      .locator('dl > div')
      .filter({ has: page.getByText(label, { exact: true }) })
      .locator('dd');
  await expect(metric('Baseline contribution')).toHaveText('PKR 600.00');
  await expect(metric('Scenario contribution')).toHaveText('PKR 630.00');
  await expect(metric('Contribution change')).toHaveText('PKR 30.00');
  await expect(metric('Baseline revenue')).toHaveText('PKR 1000.00');
  await expect(metric('Scenario revenue')).toHaveText('PKR 1320.00');
  await expect(metric('Scenario contribution per unit')).toHaveText('PKR 6.50');
  await expect(result).toContainText(
    'Break-even volume (cover entered incremental cost): 24 units.'
  );
  await expect(result).toContainText('Volume to match baseline contribution: 116 units.');

  const [download] = await Promise.all([page.waitForEvent('download'), exportJson.click()]);
  expect(download.suggestedFilename()).toBe('restaurant-contribution-assumptions.json');
  const path = await download.path();
  expect(path, 'the browser must produce a real downloaded file').toBeTruthy();
  const evidence = JSON.parse(await readFile(path!, 'utf8')) as Record<string, unknown>;
  expect(evidence).toMatchObject({
    version: 'restaurant-contribution-scenario-v1',
    basis: 'assumptions',
    currency: 'PKR',
    moneyUnit: 'decimal-major',
    period: { ...SCENARIO_PERIOD, basis: 'planning-assumption' },
    scope: { branchId: fixture.branchId, basis: 'manual scenario; no branch data read' },
    definition: CONTRIBUTION_DEFINITION,
    baseline: {
      inputs: {
        unitPrice: '10.00',
        unitVariableCost: '4.00',
        quantity: '100',
        discount: '0',
        incrementalCost: '0',
      },
      netUnitPrice: '10.00',
      unitContribution: '6.00',
      revenue: '1000.00',
      variableCost: '400.00',
      contribution: '600.00',
    },
    scenario: {
      inputs: {
        unitPrice: '12.00',
        unitVariableCost: '4.50',
        quantity: '120',
        discount: '1.00',
        incrementalCost: '150.00',
      },
      netUnitPrice: '11.00',
      unitContribution: '6.50',
      revenue: '1320.00',
      variableCost: '540.00',
      contribution: '630.00',
    },
    change: { contribution: '30.00', revenue: '320.00' },
    breakEven: { status: 'reachable', quantity: '24' },
    matchBaseline: { status: 'reachable', quantity: '116' },
  });
  expect(evidence.source).toContain('no observed margin baseline supplied');
  expect(evidence.conditions).toContain('contribution is not net profit or cash');
  await expect(page.getByText('Export unavailable.')).toBeHidden();
});

test('serves ordinary Insights reports without any AskFathom transport or chat affordance', async ({
  page,
}) => {
  test.slow();
  const assistantRequests: string[] = [];
  page.on('request', (request) => {
    if (isAssistantOrChatRequest(request.url())) {
      assistantRequests.push(request.url());
    }
  });
  test.info().annotations.push({
    type: 'fixture',
    description: `organizations.askFathomEnabled=${askFathomEnabled} for ${fixture.organizationId}`,
  });

  await openInsights(page, 'restaurantAdmin');
  // Financial is the default tab, so choosing the branch — not a later click —
  // is what issues its read; the listener has to be armed before that.
  const financialResponded = page.waitForResponse(
    (response) =>
      response.url().includes('restaurantInsights.listFinancialReports') &&
      response.status() === 200
  );
  await selectSeededBranch(page);
  await financialResponded;

  const rollups = await tenantQuery<{ total: string }>(
    `SELECT count(*)::text total FROM restaurant_insight_daily_rollups WHERE "branchId" = $1`,
    [fixture.branchId]
  );
  const expectedRows = Math.min(Number(rollups.rows[0]!.total), 100);
  const expectReportCard = async (heading: string) => {
    const card = sectionCard(page, heading);
    await expect(card.getByText('Insights access denied')).toBeHidden();
    await expect(card.getByRole('row')).toHaveCount(expectedRows === 0 ? 0 : expectedRows + 1);
    if (expectedRows === 0) await expect(card.getByText('No rollups found')).toBeVisible();
    await expect(card.getByRole('button', { name: /^Export .* report CSV$/ })).toBeEnabled();
  };

  await expect(insightsTab(page, 'Financial')).toHaveAttribute('aria-selected', 'true');
  await expectReportCard('Sales and reconciliation');

  const operationalResponded = page.waitForResponse(
    (response) =>
      response.url().includes('restaurantInsights.listOperationalReports') &&
      response.status() === 200
  );
  await openInsightsTab(page, 'Operational');
  await operationalResponded;
  await expectReportCard('Covers and throughput');

  const labourResponded = page.waitForResponse(
    (response) =>
      response.url().includes('restaurantInsights.listLabourCosts') && response.status() === 200
  );
  await openInsightsTab(page, 'Labour');
  await labourResponded;
  await expect(sectionCard(page, 'Imported labour cost facts')).toBeVisible();

  await openInsightsTab(page, 'Scenarios');
  const scenarios = sectionCard(page, 'Contribution scenarios');
  await expect(scenarios).toContainText(`Contribution = ${CONTRIBUTION_DEFINITION}.`);

  // Module independence: the reports carry no chat entry point of their own and
  // never reached the assistant transport. The company chat flag governs the
  // shell affordance only, which lives outside <main>.
  await expect(page.getByRole('main').getByText(/ask fathom/i)).toHaveCount(0);
  expect(assistantRequests, 'Insights must not invoke the AskFathom transport').toEqual([]);
});

test('denies every Insights read to an actor without the report capabilities', async ({ page }) => {
  test.slow();
  await openInsights(page, 'restaurantOperator');
  const origin = new URL(page.url()).origin;
  // This actor cannot list branches. The UI correctly fails closed before any
  // branch-scoped card can load; selecting an unavailable option is not a user path.
  const branch = page.getByLabel('Branch', { exact: true });
  await expect(branch).toBeDisabled();
  await expect(branch).toHaveAttribute('aria-invalid', 'true');
  await expect(branch).toContainText('Branches unavailable');
  for (const tab of ['Financial', 'Operational', 'Labour', 'Close readiness']) {
    await openInsightsTab(page, tab);
    await expect(sectionCard(page, 'Branch required')).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText('Gross sales');
  }
  await expect(page.getByRole('region', { name: 'financial reports table' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Labour cost facts table' })).toHaveCount(0);
  await expect(sectionCard(page, 'Financial readiness')).toHaveCount(0);

  // A disabled selector is not authorization. Prove the same authenticated
  // actor cannot bypass it by supplying the known fixture branch to any read.
  const range = { branchId: fixture.branchId, from: businessDate, to: businessDate };
  const detail = { branchId: fixture.branchId, businessDate };
  const reads: Array<[string, Record<string, unknown> | undefined]> = [
    ['restaurantStaff.listBranches', undefined],
    ['restaurantInsights.listFinancialReports', { ...range, limit: 100 }],
    ['restaurantInsights.readFinancialReport', detail],
    ['restaurantInsights.listOperationalReports', { ...range, limit: 100 }],
    ['restaurantInsights.readOperationalReport', detail],
    ['restaurantInsights.listLabourCosts', { ...range, limit: 100 }],
    ['restaurantInsights.exportFinancialReports', range],
    ['restaurantInsights.prepareClosePacket', { ...detail, asOf: new Date().toISOString() }],
  ];
  for (const [procedure, input] of reads) {
    const url = new URL(`/api/trpc/${procedure}`, origin);
    if (input) url.searchParams.set('input', JSON.stringify({ json: input }));
    const response = await page.request.get(url.href, { headers: { Origin: origin } });
    expect(response.status(), procedure).toBe(403);
    const payload = await response.json();
    expect(payload).toMatchObject({
      error: { json: { data: { code: 'FORBIDDEN', httpStatus: 403, path: procedure } } },
    });
    expect(payload).not.toHaveProperty('result');
    for (const key of ['grossSales', 'netSales', 'coverCount', 'labourCost']) {
      expect(JSON.stringify(payload), `${procedure} must not leak ${key}`).not.toContain(key);
    }
  }
});

test('serves populated Insights on a tenant whose company chat is persistently off', async ({
  page,
}) => {
  test.slow();
  const tenant = restaurantInsightsCompletionFixture.chatOff;
  // The assistant transport is `/api/assistant`; the chat router is its tRPC
  // half. `organizationAdmin.askFathomSettings` is the shell's availability
  // read, not a chat turn, so it is deliberately not counted here.
  const assistantRequests: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/api/assistant') || /\/api\/trpc\/(?:.*,)?chat\./.test(pathname)) {
      assistantRequests.push(request.url());
    }
  });

  const facts = await readCompletionTenantFacts(tenant);
  expect(facts.askFathomEnabled, 'this tenant exists to prove chat is persistently off').toBe(
    false
  );
  const [from] = tenant.businessDates;
  const to = tenant.businessDates[tenant.businessDates.length - 1]!;

  const origin = await signInToCompletionTenant(page, tenant);
  await page.goto(new URL('/restaurant/insights', origin).href);
  await expect(page.getByRole('heading', { name: 'Insights', exact: true })).toBeVisible();
  // The entitlement is real here, so neither denial surface may appear.
  await expect(page.getByRole('heading', { name: 'This module is not enabled' })).toHaveCount(0);
  await expect(page.getByText('Restaurant Insights module disabled')).toHaveCount(0);

  // The shell hides Ask Fathom when organization availability is explicitly off.
  await expect(page.getByRole('button', { name: 'Open Ask Fathom assistant' })).toHaveCount(0);

  // Fixed seeded dates, never "today": these tenants carry no drawer fixture.
  await page.getByLabel('From date').fill(from!);
  await page.getByLabel('To date').fill(to);
  const financialResponded = page.waitForResponse(
    (response) =>
      response.url().includes('restaurantInsights.listFinancialReports') &&
      response.status() === 200
  );
  const branch = page.getByLabel('Branch', { exact: true });
  await expect(branch).toBeEnabled();
  await branch.selectOption(tenant.branchId);
  await expect(branch).toHaveValue(tenant.branchId);
  await financialResponded;

  await expect(insightsTab(page, 'Financial')).toHaveAttribute('aria-selected', 'true');
  const financial = sectionCard(page, 'Sales and reconciliation');
  await expect(financial.getByText('Insights access denied')).toHaveCount(0);
  await expect(financial.getByText('No rollups found')).toHaveCount(0);
  const table = page.getByRole('region', { name: 'financial reports table' });
  await expect(table).toBeVisible();
  await expect(table.getByRole('row')).toHaveCount(facts.rollups.length + 1);

  for (const rollup of facts.rollups) {
    const row = table.getByRole('row').filter({ hasText: rollup.businessDate });
    await expect(row).toHaveCount(1);
    const cells = row.getByRole('cell');
    await expect(cells.nth(0)).toHaveText(rollup.businessDate);
    await expect(cells.nth(1)).toHaveText(tenant.branchName);
    await expect(cells.nth(3)).toHaveText(String(rollup.orderCount));
    await expect(cells.nth(4)).toHaveText(String(rollup.coverCount));
    await expect(cells.nth(5)).toHaveText(normalizeDecimal(rollup.grossSales));
    await expect(cells.nth(6)).toHaveText(normalizeDecimal(rollup.netSales));
  }
  await expect(
    financial.getByRole('button', { name: 'Export financial report CSV' })
  ).toBeEnabled();

  // Chat off removes the chat turn, not the report: no assistant transport was
  // ever reached, and the reports carry no chat entry point of their own.
  await expect(page.getByRole('main').getByText(/ask fathom/i)).toHaveCount(0);
  expect(assistantRequests, 'chat-off Insights must not invoke the assistant transport').toEqual(
    []
  );
});

test('denies the Insights route and its authenticated API when the module entitlement is withheld', async ({
  page,
}) => {
  test.slow();
  const tenant = restaurantInsightsCompletionFixture.insightsDenied;
  const facts = await readCompletionTenantFacts(tenant);
  // Company chat stays on and the report capabilities are granted, so anything
  // denied below can only be the withheld Restaurant Insights entitlement.
  expect(facts.askFathomEnabled, 'company chat must stay on for this tenant').toBe(true);
  const money = moneyStrings(facts);
  expect(money.length, 'the denied tenant must hold money the denial can withhold').toBeGreaterThan(
    0
  );

  const origin = await signInToCompletionTenant(page, tenant);
  await page.goto(new URL('/restaurant/insights', origin).href);
  expect(new URL(page.url()).pathname).toBe('/restaurant/insights');

  // The outer AppShell module gate renders instead of the page, so the console's
  // own disabled card — an inner state that needs the console to mount — must be
  // absent along with every filter control.
  const canvas = page.getByRole('main');
  await expect(canvas.getByRole('heading', { name: 'This module is not enabled' })).toBeVisible();
  await expect(canvas).toContainText('Module control');
  await expect(canvas).toContainText(
    `does not include ${tenant.insightsEntitlement.moduleKey}. Organization administrators can review the license ledger in settings.`
  );
  await expect(canvas.getByRole('link', { name: 'Open organization settings' })).toHaveAttribute(
    'href',
    '/organization'
  );
  await expect(page.getByRole('heading', { name: 'Insights', exact: true })).toHaveCount(0);
  await expect(page.getByText('Restaurant Insights module disabled')).toHaveCount(0);
  await expect(page.getByLabel('Branch', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('From date')).toHaveCount(0);

  // The shell's chat affordance is live here, which separates this denial from
  // the company chat control the previous case covers.
  await expect(page.getByRole('button', { name: 'Open Ask Fathom assistant' })).toBeEnabled();
  for (const amount of money) await expect(page.locator('body')).not.toContainText(amount);

  // The same authenticated session still reads a licensed sibling module, so the
  // refusals below are the entitlement and not a broken session.
  const licensed = await page.request.get(
    new URL('/api/trpc/restaurantStaff.listBranches', origin).href
  );
  expect(licensed.status(), 'restaurant-core stays licensed for this tenant').toBe(200);
  expect(await licensed.text()).toContain(tenant.branchId);

  const businessDate = tenant.businessDates[tenant.businessDates.length - 1]!;
  const range = {
    branchId: tenant.branchId,
    from: tenant.businessDates[0]!,
    to: businessDate,
  };
  const reads: Array<[string, Record<string, unknown>]> = [
    ['restaurantInsights.listFinancialReports', { ...range, limit: 100 }],
    ['restaurantInsights.listOperationalReports', { ...range, limit: 100 }],
    ['restaurantInsights.listLabourCosts', { ...range, limit: 100 }],
    ['restaurantInsights.exportFinancialReports', range],
    [
      'restaurantInsights.prepareClosePacket',
      { branchId: tenant.branchId, businessDate, asOf: `${businessDate}T00:00:00.000Z` },
    ],
  ];
  for (const [procedure, input] of reads) {
    const query = `input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
    const response = await page.request.get(
      new URL(`/api/trpc/${procedure}?${query}`, origin).href,
      { headers: { Origin: origin } }
    );
    expect(response.status(), `${procedure} must be refused`).toBe(403);
    const payload = await response.text();
    expect(JSON.parse(payload)).toMatchObject({
      error: { json: { data: { code: 'FORBIDDEN', httpStatus: 403, path: procedure } } },
    });
    expect(
      (JSON.parse(payload) as { error: { json: { message: string } } }).error.json.message
    ).toMatch(MODULE_DENIED_MESSAGE);
    // A refusal carries no report shape and no amount.
    for (const key of ['grossSales', 'netSales', 'coverCount', 'labourCost']) {
      expect(payload, `${procedure} must not leak ${key}`).not.toContain(key);
    }
    for (const amount of money) {
      expect(payload, `${procedure} must not leak a seeded amount`).not.toContain(amount);
    }
  }
});
