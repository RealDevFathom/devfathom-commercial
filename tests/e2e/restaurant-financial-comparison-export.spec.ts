import { chooseSelectField } from './fixtures/select-field';
import { readFile } from 'node:fs/promises';

import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  completeWorkspaceSelection,
  isAuthenticatedAppDestination,
  signInAs,
} from './fixtures/restaurant-actor-accessibility';
import { restaurantE2eCredentials as fixture } from './restaurant-fixture';

test.describe.configure({ mode: 'serial' });

if (process.env.RESTAURANT_INTEGRATED_E2E !== '1') {
  throw new Error('RESTAURANT_INTEGRATED_E2E=1 is required.');
}

/**
 * WHA-1564 — real-browser acceptance for the WHA-1484 Restaurant financial
 * comparison CSV export.
 *
 * Every expectation is derived from what the running application actually
 * rendered for the live `restaurantReports.financialComparison` response: the
 * spec reads the report card's own table, coverage panels and period lines and
 * requires the downloaded file to agree with them. No report payload, network
 * response or CSV fixture is mocked, stubbed or seeded here, and this spec
 * never writes a record, entitlement or organization setting.
 *
 * Deliberately out of scope, because it is already covered at the unit boundary
 * by `financial-comparison-export.test.ts` and must not be restated as a fake
 * browser case: formula-injection escaping of adversarial cells, quote doubling
 * and the per-cell neutralization table. This spec only asserts the structural
 * consequences that a real fixture genuinely produces — 43 records, six fields
 * per record and the leading apostrophe on values that legitimately open with a
 * sign, such as a negative percentage change.
 */

const EXPORT_BUTTON = 'Export comparison CSV';
const COMPARISON_HEADING = 'Financial comparison';
const STALE_MESSAGE = 'Filters changed. Apply the report filters again before exporting.';
const FINANCIAL_PERMISSION_NOTICE = 'Permission required: reports:financial is required.';
/** Curly apostrophe, exactly as `financial-comparison.tsx` renders it. */
const POS_PACKAGE_NOTICE = 'Restaurant POS is not included in this organization’s current package.';
/** `financialComparisonExport` emits a fixed record count; see the WHA-1484 receipt. */
const CSV_RECORD_COUNT = 43;
const CSV_FIELD_COUNT = 6;
const DRIVER_ROW_COUNT = 14;
const FIRST_DRIVER_ROW = 6;
/** Bounded negative wait: long enough for a download to start, never a sleep. */
const NO_DOWNLOAD_TIMEOUT = 3_000;

/**
 * The integrated lane has no actor that reaches Restaurant reports while being
 * refused financial figures: `restaurant-e2e-operator` holds neither
 * `reports:operational` nor `reports:financial`, so it is stopped by the
 * page-level "Reports unavailable" card and never renders the export at all,
 * and `restaurant-e2e-manager` holds `*`.
 *
 * Disambiguating "permission denied" from "module not licensed" requires an
 * actor inside the already-POS-entitled `org_chai_chowk`, so the licence is held
 * constant and only the capability differs. That actor does not exist yet; the
 * denial case fails loudly with these exact inputs rather than skipping or
 * inventing records. `restaurantE2eEnvironment` strips every
 * `RESTAURANT_ACTOR_*_EMAIL`/`_PASSWORD` outside its four-name allowlist, so the
 * identity is carried by a distinct seeded email and the already-allowlisted
 * admin password, exactly as the Insights completion fixture does.
 */
const reportsOperationalActor = {
  email: 'reports-operational@restaurant-e2e.test',
  userId: 'user_restaurant_e2e_reports_operational',
  roleId: 'role_restaurant_e2e_reports_operational',
  roleKey: 'restaurant-e2e-reports-operational',
  capabilities: ['reports:operational'],
  withheldCapabilities: ['reports:financial'],
  organizationId: fixture.organizationId,
  branchId: fixture.branchId,
  host: 'chai-chowk.localhost',
  workspace: /Chai Chowk Café|chai-chowk/i,
} as const;

const REPORTS_OPERATIONAL_FIXTURE_REQUIREMENT = [
  'Missing fixture: an operational-only Restaurant reports actor.',
  `Seed into organization ${reportsOperationalActor.organizationId}:`,
  `  · organizationRole id=${reportsOperationalActor.roleId} key=${reportsOperationalActor.roleKey}`,
  `    with ALLOW permissions exactly [${reportsOperationalActor.capabilities.join(', ')}]`,
  `    and no [${reportsOperationalActor.withheldCapabilities.join(', ')}] grant and no '*' grant`,
  `  · user id=${reportsOperationalActor.userId} email=${reportsOperationalActor.email}`,
  `    status=ACTIVE, branch=${reportsOperationalActor.branchId}, holding that role,`,
  '    password hashed from RESTAURANT_ACTOR_ADMIN_PASSWORD (the allowlisted lane credential),',
  '    plus the staff profile the other seeded reports users receive.',
  '  · that user must additionally resolve to real branch scope: the reports page returns',
  '    "No reportable branches" unless the actor has an active primary branch or an explicit',
  `    Restaurant branch assignment reaching ${reportsOperationalActor.branchId}. An actor with`,
  '    the capability but no branch scope never renders the comparison card at all, so it',
  '    cannot demonstrate the financial denial this case exists to prove.',
  'The organization must keep its existing restaurant-pos entitlement so this case',
  'proves a capability denial and not a licence denial.',
].join('\n');

function adminPassword(): string {
  return process.env.RESTAURANT_ACTOR_ADMIN_PASSWORD ?? '';
}

/**
 * Attaches the fixture recipe to whatever actually failed, so the prerequisite is
 * reachable on the path that needs it instead of being pre-empted by a generic
 * helper error. The original failure is preserved verbatim and re-raised: nothing
 * is skipped, swallowed, or allowed to fall back to a passing result.
 */
async function withFixtureContext<T>(step: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    const original = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
    throw new Error(
      `${step} failed.\n\n${REPORTS_OPERATIONAL_FIXTURE_REQUIREMENT}\n\n${original}`,
      {
        cause,
      }
    );
  }
}

function comparisonSection(page: Page): Locator {
  return page.locator('[data-slot="section-card"]', {
    has: page.getByRole('heading', { name: COMPARISON_HEADING, exact: true, level: 2 }),
  });
}

function exportButton(section: Locator): Locator {
  return section.getByRole('button', { name: EXPORT_BUTTON, exact: true });
}

function reportFilters(page: Page): Locator {
  return page.locator('[data-slot="section-card"]', {
    has: page.getByRole('heading', { name: 'Report filters', exact: true, level: 2 }),
  });
}

/** Collapses the whitespace `innerText` already normalized, on both sides. */
function normalize(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * `financialComparisonExport` prefixes a lone apostrophe onto any cell opening
 * with `=`, `+`, `-` or `@` before the shared `csvCell` runs. A negative change
 * percentage is a legitimate value that takes that prefix, so the reader has to
 * remove it before comparing a field with the figure the page displayed.
 */
function displayedValue(field: string): string {
  return /^'[\s]*[=+\-@]/u.test(field) ? field.slice(1) : field;
}

function isNeutralized(field: string): boolean {
  return field.startsWith("'");
}

/** RFC 4180 reader: CRLF records, doubled quotes inside quoted fields. */
function parseCsv(csv: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index]!;
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\r' && csv[index + 1] === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      index += 1;
    } else {
      field += char;
    }
  }
  record.push(field);
  records.push(record);
  return records;
}

function csvRow(records: string[][], label: string): string[] {
  const row = records.find((candidate) => displayedValue(candidate[0]!) === label);
  expect(row, `the export must carry a "${label}" record`).toBeTruthy();
  return row!;
}

type DownloadedCsv = { filename: string; text: string; records: string[][] };

async function downloadComparisonCsv(page: Page, section: Locator): Promise<DownloadedCsv> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    exportButton(section).click(),
  ]);
  const path = await download.path();
  expect(path, 'the browser must produce a real downloaded file').toBeTruthy();
  const text = await readFile(path!, 'utf8');
  expect(text.length, 'the downloaded CSV must not be empty').toBeGreaterThan(0);
  const records = parseCsv(text);
  expect(records, 'the export is a fixed-shape record set').toHaveLength(CSV_RECORD_COUNT);
  for (const [index, record] of records.entries()) {
    expect(record, `record ${index} must carry ${CSV_FIELD_COUNT} fields`).toHaveLength(
      CSV_FIELD_COUNT
    );
  }
  expect(text, 'records are CRLF separated').toContain('\r\n');
  expect(text.endsWith('\r\n'), 'the final record carries no trailing separator').toBe(false);
  return { filename: download.suggestedFilename(), text, records };
}

/**
 * Asserts the observable refusal contract only: the export control is disabled
 * and no file is written.
 *
 * It deliberately makes no claim about *which* internal guard refused. The
 * button's `disabled` is `!current` and the handler's own first line is
 * `if (!current || !file) return` — the same `current` — so no browser-level
 * probe here can separate "disabled" from "handler refused". The live-query
 * re-check inside `download()` stays covered at the unit boundary; this spec
 * does not manufacture runtime proof of it.
 */
async function assertNoDownload(page: Page, section: Locator) {
  const button = exportButton(section);
  await expect(button).toBeDisabled();
  const started = page
    .waitForEvent('download', { timeout: NO_DOWNLOAD_TIMEOUT })
    .then(() => 'download' as const)
    .catch(() => 'none' as const);
  // Dispatched directly so the negative does not rest on actionability alone.
  await button.dispatchEvent('click');
  expect(await started, 'a disabled or refused export must not write any file').toBe('none');
}

type RenderedPeriods = {
  current: { from: string; to: string };
  previous: { from: string; to: string };
  branchLabel: string;
  daysPerPeriod: string;
  currency: string;
};

async function renderedPeriods(section: Locator): Promise<RenderedPeriods> {
  const current = normalize(
    await section
      .getByText(/^Current period:/u)
      .first()
      .innerText()
  );
  const previous = normalize(
    await section
      .getByText(/^Previous period:/u)
      .first()
      .innerText()
  );
  const currentMatch =
    /^Current period: (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2}) · Scope: (.+)$/u.exec(current);
  const previousMatch =
    /^Previous period: (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2}) · (.+) business days per period · Currency: (.+)$/u.exec(
      previous
    );
  expect(currentMatch, `unreadable current period line: ${current}`).toBeTruthy();
  expect(previousMatch, `unreadable previous period line: ${previous}`).toBeTruthy();
  return {
    current: { from: currentMatch![1]!, to: currentMatch![2]! },
    previous: { from: previousMatch![1]!, to: previousMatch![2]! },
    branchLabel: currentMatch![3]!,
    daysPerPeriod: previousMatch![3]!,
    currency: previousMatch![4]!,
  };
}

/** The displayed driver ledger: row header plus its five cells, in page order. */
async function renderedDriverRows(section: Locator): Promise<string[][]> {
  const table = section.getByRole('region', { name: 'Financial comparison drivers' });
  const rows = table.locator('tbody tr');
  await expect(rows).toHaveCount(DRIVER_ROW_COUNT);
  const rendered: string[][] = [];
  for (let index = 0; index < DRIVER_ROW_COUNT; index += 1) {
    const cells = await rows.nth(index).locator('th, td').allInnerTexts();
    expect(cells, `driver row ${index} must render six cells`).toHaveLength(CSV_FIELD_COUNT);
    rendered.push(cells.map(normalize));
  }
  return rendered;
}

/**
 * The innermost wrapper holding one period's coverage heading. Playwright
 * returns matches in document order, so the last enclosing `div` is the panel
 * itself rather than one of its ancestors.
 *
 * KNOWN LIMITATION (WHA-1484 production note, deliberately not fixed here): the
 * coverage panels carry no `role="group"`/`aria-labelledby`, so there is no
 * accessible handle to bind to and this structural selector is the only option.
 * It is correct against today's DOM, but nesting any further `div` inside a
 * panel would silently re-target `.last()` and quietly narrow the coverage
 * assertions below. The durable fix is a labelled grouping in
 * `financial-comparison.tsx`, which is production UI and out of this file's
 * ownership.
 */
function coveragePanel(page: Page, section: Locator, period: 'current' | 'previous'): Locator {
  return section
    .locator('div')
    .filter({
      has: page.getByRole('heading', { level: 3, name: `${period} coverage`, exact: true }),
    })
    .last();
}

/**
 * Loads the reports page, scopes it to the seeded branch through the real
 * filter form and returns the applied query once the server has answered.
 */
async function applySeededBranchFilters(page: Page, origin: string) {
  await page.goto(new URL('/restaurant/reports', origin).href);
  await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
  const filters = reportFilters(page);
  await chooseSelectField(
    filters.getByRole('combobox', { name: 'Branch', exact: true }),
    fixture.branchId
  );
  const from = await filters.getByLabel('From date', { exact: true }).inputValue();
  const to = await filters.getByLabel('To date', { exact: true }).inputValue();
  await filters.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await page.waitForURL((url) => {
    const applied = url.searchParams;
    return (
      url.pathname === '/restaurant/reports' &&
      applied.get('branch') === fixture.branchId &&
      applied.get('from') === from &&
      applied.get('to') === to
    );
  });
  await expect(page.getByRole('heading', { name: COMPARISON_HEADING, exact: true })).toBeVisible();
  return { from, to };
}

/** Every notice the comparison card renders *instead of* a result. */
const COMPARISON_NOTICE =
  /^(Permission required|Restaurant POS is not included|Financial data could not load|No financial comparison|Financial comparison filters changed)/u;

/**
 * Availability, checked before any period or driver reader runs. Without this
 * first, an absent report dies on a period-line regex or a row-count timeout
 * and the real cause never reaches the report.
 */
async function requireRenderedComparison(section: Locator) {
  const notices = (await section.getByText(COMPARISON_NOTICE).allInnerTexts()).map(normalize);
  expect(
    notices,
    'the authorized comparison must render a result, not a notice: the actor needs ' +
      `reports:financial inside ${fixture.organizationId}, that organization must keep its ` +
      'restaurant-pos entitlement, and the applied filters must match the returned window'
  ).toEqual([]);
  await expect(
    section.getByRole('region', { name: 'Financial comparison drivers' }),
    'the driver table must be rendered before it can be read'
  ).toBeVisible();
}

/**
 * The real gate on exportable money, published accurately so the next lane's
 * remedy actually fixes the failure it reads.
 *
 * Every driver resolves through `change()` in `src/lib/restaurant/financial-comparison.ts`,
 * which yields a figure only when `report.freshness.closedDayCount` is non-zero,
 * and `src/lib/restaurant/reports.ts` sets `closedDayCount = closes.length` —
 * `RestaurantDailyClose` chain tips, further bounded to `close.createdAt <= asOf`
 * by the report's own bounded reader. Settled bills are an input to a close, not
 * a substitute for one: bills outside an observed closed branch-day leave every
 * driver `Unavailable` permanently.
 */
const MEANINGFUL_MONEY_REQUIREMENT = [
  'Missing fixture: no driver carries a current figure, so there is no money to export.',
  '',
  'Drivers are gated on freshness.closedDayCount (RestaurantDailyClose chain tips observed',
  'at or before the report asOf cutoff), NOT on settled bills. Seeding bills alone reproduces',
  'this exact failure.',
  '',
  `Required, for branch ${fixture.branchId} in ${fixture.organizationId}:`,
  '  · CURRENT window — at least one RestaurantDailyClose chain tip whose business date falls',
  '    inside the applied current window and whose createdAt is at or before the report asOf.',
  '    This is what makes any driver carry a figure at all.',
  '  · PREVIOUS window — the equally long window immediately preceding the current one needs',
  '    its own closes before the Previous, Absolute change and Change % columns carry figures.',
  '    With no previous closes those three columns stay Unavailable; this spec accepts that',
  '    and it alone satisfies the unknown assertion below.',
  '  · Counted cash and Cash variance additionally require cashCountCoverage.status === COMPLETE',
  '    for the window in question. Anything short of complete drawer-count coverage keeps those',
  '    two drivers Unavailable even when closed days exist, so numeric expectations on them',
  '    require complete cash counts, not merely closes.',
  '  · At least one genuinely unknown value must survive across the 14 drivers, because this',
  '    spec asserts the file never substitutes zero for a missing figure. An absent previous',
  '    window, incomplete cash-count coverage, or a zero previous baseline each satisfy that',
  '    honestly.',
  '',
  'Do not invent closes, edit seed data, or relax this into a skip. Either run against a',
  'fixture that already holds real closed branch-days, or produce them through the ordinary',
  'daily-close path before running this spec.',
].join('\n');

function requireMeaningfulMoney(drivers: string[][]) {
  const populated = drivers.filter(([, current]) => current !== 'Unavailable');
  expect(populated.length, MEANINGFUL_MONEY_REQUIREMENT).toBeGreaterThan(0);
}

test.describe('Restaurant financial comparison CSV export', () => {
  test('an authorized populated comparison downloads exactly what the page displayed', async ({
    page,
  }) => {
    const origin = await signInAs(page, 'restaurantAdmin');
    const applied = await applySeededBranchFilters(page, origin);
    const section = comparisonSection(page);
    // Availability first: an absent report must report its cause, not time out.
    await requireRenderedComparison(section);
    const periods = await renderedPeriods(section);
    const drivers = await renderedDriverRows(section);
    requireMeaningfulMoney(drivers);

    const csv = await downloadComparisonCsv(page, section);
    expect(csv.filename).toBe(
      `restaurant-financial-comparison-${applied.from}-to-${applied.to}.csv`
    );
    expect(periods.current).toEqual(applied);

    // Periods, scope and currency: the file must name both windows the page named.
    const periodRow = csvRow(csv.records, 'Business-date period');
    expect(periodRow[1]).toBe(`${periods.current.from} to ${periods.current.to}`);
    expect(periodRow[2]).toBe(`${periods.previous.from} to ${periods.previous.to}`);
    expect(normalize(periodRow[5]!)).toContain(
      `${periods.daysPerPeriod} business days per period;`
    );
    const branchRow = csvRow(csv.records, 'Branch scope');
    expect(normalize(branchRow[1]!)).toBe(periods.branchLabel);
    expect(branchRow[5]!.split('; ')).toEqual([fixture.branchId]);
    expect(csvRow(csv.records, 'Organization')[1]).toBe(fixture.organizationId);
    expect(csvRow(csv.records, 'Currency')[1]).toBe(periods.currency);
    expect(csvRow(csv.records, 'Money unit')[1]).toBe('DECIMAL_MAJOR');
    expect(normalize(periodRow[5]!)).toContain('BUSINESS_DATE');

    // Driver ledger: same labels, same order, same rendered strings.
    const driverRecords = csv.records.slice(FIRST_DRIVER_ROW, FIRST_DRIVER_ROW + DRIVER_ROW_COUNT);
    expect(
      driverRecords.map((record) => record.map((field) => normalize(displayedValue(field))))
    ).toEqual(drivers);

    // Decimal precision and unknowns: never a substituted zero, never a float tail.
    //
    // The period line renders `report.currency ?? 'Unknown'` while the money cells
    // fall back to `'Currency unknown'`, so a null organization currency would make
    // the pattern below unsatisfiable and misreport a missing currency as a broken
    // decimal format. Fail on the real cause instead.
    expect(
      periods.currency,
      [
        'Missing fixture: the organization has no currency, so no money cell can be',
        `format-checked. Set a currency on ${fixture.organizationId} before running this`,
        'spec. This is a missing-currency prerequisite, not a decimal-format defect.',
      ].join('\n')
    ).not.toBe('Unknown');
    const moneyPattern = new RegExp(
      `^${periods.currency.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} -?\\d+\\.\\d{2}$`,
      'u'
    );
    let unknownSeen = false;
    for (const record of driverRecords) {
      for (const index of [1, 2, 3]) {
        const field = displayedValue(record[index]!);
        if (field === 'Unavailable') {
          unknownSeen = true;
          continue;
        }
        expect(field, `driver "${record[0]}" field ${index} must keep two-decimal money`).toMatch(
          moneyPattern
        );
      }
      const percentage = displayedValue(record[4]!);
      if (percentage === 'Unavailable — zero or missing baseline') {
        unknownSeen = true;
      } else {
        expect(percentage).toMatch(/^-?\d+(?:\.\d+)?%$/u);
        // A negative percentage legitimately opens with `-` and must be neutralized.
        if (percentage.startsWith('-')) expect(isNeutralized(record[4]!)).toBe(true);
      }
    }
    expect(
      unknownSeen,
      'this fixture must exercise at least one genuinely unknown driver value so the file ' +
        'proves it never substitutes zero for a missing figure.\n\n' +
        MEANINGFUL_MONEY_REQUIREMENT
    ).toBe(true);

    // Coverage: both windows, both ledgers, as counted on the page.
    for (const period of ['current', 'previous'] as const) {
      const column = period === 'current' ? 1 : 2;
      const panel = normalize(await coveragePanel(page, section, period).innerText());
      const closed = /(\d+)\/(\d+) branch-days closed/u.exec(panel);
      const detail = /(\d+) missing · (\d+) stale · (\d+) unprojected · (\d+) corrected/u.exec(
        panel
      );
      const cash =
        /(\d+) drawer sessions · (\d+) missing counts · (\d+) unverified closes · (\d+) mismatched close days/u.exec(
          panel
        );
      expect(closed, `unreadable ${period} coverage panel: ${panel}`).toBeTruthy();
      expect(detail, `unreadable ${period} coverage detail: ${panel}`).toBeTruthy();
      expect(cash, `unreadable ${period} cash-count panel: ${panel}`).toBeTruthy();
      expect(csvRow(csv.records, 'Closed branch-days')[column]).toBe(closed![1]);
      expect(csvRow(csv.records, 'Expected branch-days')[column]).toBe(closed![2]);
      expect(csvRow(csv.records, 'Missing closed branch-days')[column]).toBe(detail![1]);
      expect(csvRow(csv.records, 'Stale branch-days')[column]).toBe(detail![2]);
      expect(csvRow(csv.records, 'Unprojected branch-days')[column]).toBe(detail![3]);
      expect(csvRow(csv.records, 'Corrected branch-days')[column]).toBe(detail![4]);
      expect(csvRow(csv.records, 'Drawer sessions')[column]).toBe(cash![1]);
      expect(csvRow(csv.records, 'Missing cash counts')[column]).toBe(cash![2]);
      expect(csvRow(csv.records, 'Unverified cash closes')[column]).toBe(cash![3]);
      expect(csvRow(csv.records, 'Mismatched cash close days')[column]).toBe(cash![4]);
      expect(panel).toContain(
        normalize(displayedValue(csvRow(csv.records, 'Coverage status')[column]!)).replaceAll(
          '_',
          ' '
        )
      );
      expect(panel).toContain(
        normalize(
          displayedValue(csvRow(csv.records, 'Cash-count coverage status')[column]!)
        ).replaceAll('_', ' ')
      );
      expect(panel).toContain(
        normalize(csvRow(csv.records, 'Cash-count coverage definition')[column]!)
      );
    }

    // The carried caveats must survive into the file, not only onto the screen.
    const sectionText = normalize(await section.innerText());
    for (const label of ['Change definition', 'Coverage definition', 'Interpretation'] as const) {
      const carried = normalize(csvRow(csv.records, label)[5]!);
      expect(sectionText, `"${label}" must be displayed as well as exported`).toContain(carried);
    }
    expect(sectionText).toContain(normalize(csvRow(csv.records, 'Refund-adjusted net sales')[5]!));
    expect(sectionText).toContain(normalize(csvRow(csv.records, 'Source')[1]!));
    expect(csvRow(csv.records, 'Snapshot guarantee')[1]).toBe(
      'Not guaranteed; observations are not atomic.'
    );
    expect(csvRow(csv.records, 'As of')[1]).not.toBe('');
    expect(csvRow(csv.records, 'Observed through')[1]).not.toBe('');
  });

  test('changed filters export the new result, never the previous snapshot', async ({ page }) => {
    const origin = await signInAs(page, 'restaurantAdmin');
    const applied = await applySeededBranchFilters(page, origin);
    const section = comparisonSection(page);
    await requireRenderedComparison(section);
    requireMeaningfulMoney(await renderedDriverRows(section));
    const first = await downloadComparisonCsv(page, section);
    expect(first.filename).toBe(
      `restaurant-financial-comparison-${applied.from}-to-${applied.to}.csv`
    );

    // Narrow the window to its final day through the real filter form.
    const narrowed = { from: applied.to, to: applied.to };
    expect(narrowed.from, 'the fixture window must be longer than one day').not.toBe(applied.from);
    const filters = reportFilters(page);
    await filters.getByLabel('From date', { exact: true }).fill(narrowed.from);
    await filters.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get('from') === narrowed.from);
    await expect(section.getByText(/^Current period:/u).first()).toHaveText(
      new RegExp(`^Current period: ${narrowed.from} to ${narrowed.to}\\b`, 'u')
    );

    const second = await downloadComparisonCsv(page, section);
    expect(second.filename).toBe(
      `restaurant-financial-comparison-${narrowed.from}-to-${narrowed.to}.csv`
    );
    expect(csvRow(second.records, 'Business-date period')[1]).toBe(
      `${narrowed.from} to ${narrowed.to}`
    );
    expect(
      second.text,
      'the second export must be the new result, not the earlier snapshot'
    ).not.toBe(first.text);
    const periods = await renderedPeriods(section);
    expect(csvRow(second.records, 'Business-date period')[2]).toBe(
      `${periods.previous.from} to ${periods.previous.to}`
    );
    await expect(section.getByText(STALE_MESSAGE, { exact: true })).toHaveCount(0);
  });

  test('an ambiguous applied filter refuses to export the displayed snapshot', async ({ page }) => {
    const origin = await signInAs(page, 'restaurantAdmin');
    const applied = await applySeededBranchFilters(page, origin);
    // The server resolves a single branch from a repeated parameter, so the page
    // still renders a result; the export must refuse because the applied query no
    // longer identifies it unambiguously.
    const ambiguous = new URL('/restaurant/reports', origin);
    ambiguous.searchParams.append('branch', fixture.branchId);
    ambiguous.searchParams.append('branch', fixture.branchA2Id);
    ambiguous.searchParams.set('from', applied.from);
    ambiguous.searchParams.set('to', applied.to);
    await page.goto(ambiguous.href);

    const section = comparisonSection(page);
    await expect(
      section.getByRole('heading', { name: COMPARISON_HEADING, exact: true })
    ).toBeVisible();
    await expect(
      section.getByRole('region', { name: 'Financial comparison drivers' })
    ).toBeVisible();
    const message = section.getByText(STALE_MESSAGE, { exact: true });
    await expect(message).toBeVisible();
    await expect(message).toHaveRole('status');
    await expect(exportButton(section)).toHaveAttribute(
      'aria-describedby',
      (await message.getAttribute('id')) ?? ''
    );
    await assertNoDownload(page, section);
  });

  test('a financially denied actor in the licensed organization gets no export', async ({
    page,
  }) => {
    expect(adminPassword().length, REPORTS_OPERATIONAL_FIXTURE_REQUIREMENT).toBeGreaterThan(0);
    const origin = new URL(
      process.env.PLAYWRIGHT_BASE_URL ??
        `http://localhost:${Number(process.env.PLAYWRIGHT_PORT ?? 4319)}`
    );
    origin.hostname = reportsOperationalActor.host;
    await page.goto(new URL('/login', origin).href);
    await page.getByLabel(/email/iu).fill(reportsOperationalActor.email);
    await page.locator('input[name="password"]').fill(adminPassword());
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    // Both sign-in steps carry the recipe: with the actor absent, the workspace
    // helper is what throws first, and its bare "Authentication failed" would
    // otherwise hide the prerequisite this case exists to publish.
    await withFixtureContext('Signing in as the operational-only reports actor', async () => {
      await completeWorkspaceSelection(page, '/login', reportsOperationalActor.workspace);
      await page.waitForURL((url) => isAuthenticatedAppDestination(url, '/login'), {
        timeout: 60_000,
      });
    });

    await page.goto(new URL('/restaurant/reports', origin).href);
    // Reaching the reports page at all proves `reports:operational`; the actor is
    // not stopped by the page-level "Reports unavailable" card.
    await expect(
      page.getByRole('heading', { name: 'Reports', exact: true }),
      REPORTS_OPERATIONAL_FIXTURE_REQUIREMENT
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Reports unavailable', exact: true }),
      REPORTS_OPERATIONAL_FIXTURE_REQUIREMENT
    ).toHaveCount(0);
    // Branch scope, checked before the card is located: without it the page renders
    // "No reportable branches" and the comparison card never exists, which would
    // otherwise surface as a bare locator timeout.
    await expect(
      page.getByRole('heading', { name: 'No reportable branches', exact: true }),
      REPORTS_OPERATIONAL_FIXTURE_REQUIREMENT
    ).toHaveCount(0);

    const section = comparisonSection(page);
    await withFixtureContext('Locating the financial comparison card', async () => {
      await expect(
        section.getByRole('heading', { name: COMPARISON_HEADING, exact: true })
      ).toBeVisible();
    });
    await expect(section.getByText(FINANCIAL_PERMISSION_NOTICE, { exact: true })).toBeVisible();
    // Same organization, same package: the refusal is the capability, not the licence.
    await expect(section.getByText(POS_PACKAGE_NOTICE, { exact: true })).toHaveCount(0);
    await expect(section.getByRole('region', { name: 'Financial comparison drivers' })).toHaveCount(
      0
    );
    // A denied actor gets no artifact and no stale-filter wording to retry against.
    await expect(section.getByText(STALE_MESSAGE, { exact: true })).toHaveCount(0);
    await assertNoDownload(page, section);
  });
});
