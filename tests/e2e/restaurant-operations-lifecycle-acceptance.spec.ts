import { expect, test, type Locator, type Page } from '@playwright/test';
import pg from 'pg';

import { signInAs } from './fixtures/restaurant-actor-accessibility';
import {
  restaurantE2eCredentials as fixture,
  installSeededTerminalCookie,
  terminalBrowserBaseUrl,
} from './restaurant-fixture';

/**
 * WHA-1566 — browser acceptance for the two Restaurant daily-operations surfaces
 * that the integrated lane never actually exercised: the branch SOP execution
 * board (`/restaurant/sop`) and the branch shift roster
 * (`/restaurant/staff/roster`).
 *
 * WHAT WAS ALREADY COVERED, AND IS DELIBERATELY NOT RESTATED HERE
 * ---------------------------------------------------------------
 * · `restaurant-integrated.spec.ts` (route matrix) visits `/restaurant/sop` and
 *   asserts the `Branch SOP board` heading. That heading is rendered by
 *   `SopBoardView` in EVERY state — `disabled`, `permission`, `error`, `empty`
 *   and `ready` alike — so it proves the route responds, not that the board
 *   loaded. Tenancy and raw-id leakage for that matrix are asserted there and in
 *   `restaurant-actor-accessibility.spec.ts`; neither is repeated in this file.
 * · `restaurant-actor-accessibility.spec.ts` drives `/restaurant/sop/admin`
 *   through its loading → error → retry → recovery states. SOP administration
 *   UI states are therefore out of scope here.
 * · SOP recurrence ENUMERATION (`sop-recurrence.test.ts`) and occurrence
 *   MATERIALISATION (`sop-occurrence-generation.test.ts`) are already proven at
 *   the unit boundary, and the generator is a scheduler job this lane does not
 *   enqueue. This spec therefore asserts the recurrence facts the running app
 *   actually renders — the assignment's 08:00 daily due time and its 1440-minute
 *   window, both projected into the branch timezone — instead of re-deriving the
 *   rule through a fabricated job run.
 * · Shift scheduling invariants have node-level coverage in
 *   `tests/restaurant-shift-concurrency.test.ts`, `tests/restaurant-shifts-rls.test.ts`
 *   and `tests/restaurant-workforce-migration.test.ts`. None of them opens a
 *   browser, so the console's create → edit → cancel path, its optimistic-
 *   concurrency versioning and its capability denial are genuinely uncovered.
 * · Restaurant notification semantics are NOT asserted here. Nothing in the SOP
 *   execution or verification path writes a notification inline — fanout is
 *   job-driven (`src/lib/restaurant/notification-fanout.ts`) and the integrated
 *   lane enqueues no such job, and the seed creates no notification rows. Any
 *   assertion on `/restaurant/notifications` in this lane today would either be
 *   an empty-state tautology or need an invented fixture, so that requirement
 *   stays open rather than being claimed by a hollow case.
 *
 * NOTHING IS MOCKED. No route interception, no stubbed tRPC payload, no injected
 * Server Function result. Every command is issued by clicking the application's
 * own control, and every outcome is read back twice: from what the re-rendered
 * server component published, and from the tenant-scoped database rows.
 *
 * WHAT THOSE READBACKS DO AND DO NOT ACCEPT. On the SOP board they prove COMMAND
 * ACCEPTANCE and COMMITTED SERVER STATE — the Server Function's own answer, the
 * board the server re-rendered afterwards, and the tenant-scoped rows. They do
 * NOT prove that an operator ever SEES a confirmation: that board's notice
 * banner is deliberately not asserted, for the routing reason documented on
 * `runSopCommand` below. Visible command confirmation on `/restaurant/sop` is
 * therefore an explicitly uncovered gap and must not be read into any "browser
 * acceptance" claim made from this file. The roster console is a different case
 * and is held to the stronger bar: it is a client component, so its dialogs,
 * rows, disabled controls and live counts ARE asserted as visible UI, and each
 * of those is still confirmed against the committed row underneath it.
 *
 * NOT YET WIRED INTO THE LANE. `playwright.restaurant-integrated.config.ts`
 * enumerates its suite file by file — `testMatch` is an exact list, not a glob —
 * so this file is collected by nothing until
 *
 *     'restaurant-operations-lifecycle-acceptance.spec.ts'
 *
 * is added to that array. That config is shared and is NOT edited from here.
 * Until it is, `bun run test:e2e:restaurant-integrated` neither runs nor reports
 * these cases; do not read a green lane as coverage of this file.
 *
 * Each case is independent and this file declares no serial mode on purpose: an
 * unrelated failure must not convert the others into skips, which would read as
 * "not broken" when nothing was actually executed.
 */

/** Unit-level suites run without it; this lane must never silently degrade. */
if (process.env.RESTAURANT_INTEGRATED_E2E !== '1') {
  throw new Error('RESTAURANT_INTEGRATED_E2E=1 is required.');
}

// ── Fixture contract ─────────────────────────────────────────────────────────

const BRANCH_NAME = 'Gulberg Café';
const BRANCH_TIMEZONE = 'Asia/Karachi';
/** `seed-restaurant-e2e.ts` stamps the SOP fixture on this fixed business date. */
const SOP_BUSINESS_DATE = '2026-08-27';
const SOP_TEMPLATE_NAME = 'Opening food-safety check';
const SOP_STEP_TITLE = 'Record cold-storage temperature';
/**
 * The roster/assignment legs below still pick the seeded operator as the person
 * a new assignment or shift is FOR (that is a target, not an actor).
 */
const SOP_OWNER_STAFF_NAME = 'E2E Operator';
/**
 * Every SOP command is recorded against the signed-in user's own staff profile;
 * the board offers no "who did it" picker and the server ignores any client actor
 * id (H5). The seeded PERSON-target occurrence is therefore owned by the signed-in
 * admin's staff profile, which `assertOccurrenceOwner` requires for START,
 * COMPLETE STEP and SUBMIT, and the same session records the verification.
 */
const SOP_SESSION_STAFF_NAME = 'Alex Carter';
/** `seed-restaurant-e2e.ts` IDS.alexStaff — the restaurantAdmin's staff profile. */
const SOP_SESSION_STAFF_PROFILE_ID = 'staff_chai_chowk_alex';
const SOP_COMPLETION_NOTE = 'Walk-in chiller held at 3C at open.';
const SOP_VERIFICATION_REASON = 'Temperature log matches the chiller display.';

const SHIFT_ROLE = 'Line Cook';
const SHIFT_REVISED_ROLE = 'Shift Manager';
const SHIFT_NOTES = 'WHA-1566 roster acceptance.';
const SHIFT_CANCEL_REASON = 'Operator swapped onto the delivery lane.';

/**
 * ONE row the seed does not create, identified by the exact id PAIR that is its
 * unique key, named here so a failure on the paths that need it reads as a
 * fixture gap rather than a product defect.
 *
 *     occurrenceId   = sop_occurrence_restaurant_e2e_opening
 *     templateStepId = sop_step_restaurant_e2e_opening_1
 *
 * This file documents that prerequisite and does NOT insert it: the spec owns no
 * fixture writes, and `scripts/seed-restaurant-e2e.ts` is out of this lane.
 * Until the row is seeded there, the completion leg of case 1 is authored-red by
 * design and reports the recipe below instead of a bare locator timeout.
 *
 * `seed-restaurant-e2e.ts` upserts `restaurant_sop_occurrences` DIRECTLY. Real
 * occurrences are materialised by `generateDueSopOccurrences`, which also seeds
 * the pinned version's per-step checklist into
 * `restaurant_sop_occurrence_steps`; the direct upsert skips that table
 * entirely. `completeStep` looks the step up by
 * `(occurrenceId, templateStepId)` and throws `Step not found on this
 * occurrence.` when it is absent, so the checklist leg of the SOP lifecycle
 * cannot pass until the row exists.
 */
const SOP_OCCURRENCE_STEP_REQUIREMENT = [
  'Missing fixture: the per-step checklist row for the seeded SOP occurrence.',
  `Seed into organization ${fixture.organizationId}:`,
  '  · restaurant_sop_occurrence_steps with',
  '      occurrenceId   = sop_occurrence_restaurant_e2e_opening',
  '      templateStepId = sop_step_restaurant_e2e_opening_1',
  '      completed      = false, completedAt = null, note = null,',
  '      completedByStaffProfileId = null',
  '    (the unique key is (occurrenceId, templateStepId), so an upsert is safe),',
  '  · and it must be reset alongside the occurrence itself, which the seed',
  '    already returns to SCHEDULED/startedAt=null on every run.',
  'Real generation creates this row from the pinned template version; the seed',
  'writes the occurrence directly and therefore never does. Without it the board',
  'renders the step with a null occurrenceStepId and "Complete step" is answered',
  'with "Step not found on this occurrence."',
].join('\n');

/**
 * Both mutating cases consume single-use seeded state: the SOP case is the only
 * consumer of the one seeded occurrence, and the roster case relies on the
 * operator having no overlapping live shift. `run-restaurant-e2e.ts` re-seeds
 * before every run, which restores both. Re-running this spec against an
 * already-used database fails loudly (`Cannot start an occurrence in status …`,
 * `This operator already has an overlapping shift on the roster.`) rather than
 * skipping or passing vacuously — that is the intended behaviour.
 */
const FRESH_FIXTURE_NOTE =
  'This case requires the freshly seeded lane database that run-restaurant-e2e.ts provides.';

// ── Helpers (private to this file on purpose) ────────────────────────────────

/**
 * A deliberate private copy of the tenant-scoped read used by
 * `restaurant-lifecycles-final.spec.ts`. The lane's rule is that a spec owns its
 * own database reader rather than growing a shared E2E utility layer, so this
 * mirrors that one instead of hoisting either into a common module.
 *
 * Reads run inside a transaction that sets the tenant GUC and is ALWAYS rolled
 * back: the verification is an observer, never a writer.
 */
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
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function withTenantPool<T>(run: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const databaseUrl = process.env.DATABASE_URL;
  expect(
    databaseUrl,
    'DATABASE_URL is required: this spec reads back committed tenant rows.'
  ).toBeTruthy();
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    return await run(pool);
  } finally {
    await pool.end();
  }
}

/** `YYYY-MM-DD` for a day offset from now, in the BRANCH's calendar. */
function branchDay(offsetDays: number): string {
  const instant = new Date(Date.now() + offsetDays * 86_400_000);
  // `en-CA` renders ISO-ordered parts, so no manual part assembly is needed.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BRANCH_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/**
 * The SOP board's forms are Server Functions that end in `redirect()`. WHA-1196
 * measured that this app's client router silently DISCARDS such a redirect
 * roughly half the time (Next 16.2.12): the command commits, the server answers
 * with a correct `x-action-redirect`, and the browser simply never navigates —
 * so the on-screen notice banner is a coin flip and asserting it would make this
 * spec flaky for a reason that has nothing to do with SOPs.
 *
 * The SERVER's answer is not a coin flip, so that is what is asserted: the
 * redirect target the Server Function chose carries `kind` and `notice`, which
 * `page.tsx` sets from the command's own success string or from the thrown
 * error's message. A failed command is therefore reported with the application's
 * real message instead of a timed-out locator. The board is then re-fetched so
 * every following assertion reads committed server state rather than an
 * optimistic client render.
 */
async function runSopCommand(
  page: Page,
  boardUrl: string,
  submit: Locator,
  expectedNotice: string
) {
  const posted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/restaurant/sop'
  );
  await submit.click();
  const response = await posted;

  const headers = response.headers();
  const redirect = headers['x-action-redirect'] ?? headers['location'];
  expect(
    redirect,
    `"${expectedNotice}": the SOP Server Function answered ${response.status()} with neither ` +
      `x-action-redirect nor location. Headers: ${JSON.stringify(headers)}`
  ).toBeTruthy();

  // Next appends a routing hint (e.g. `;push`) to the header value in some
  // versions; the URL is always the first segment.
  const target = new URL(redirect!.split(';')[0]!, page.url());
  expect(
    { kind: target.searchParams.get('kind'), notice: target.searchParams.get('notice') },
    `the SOP board must accept this command (${expectedNotice})`
  ).toEqual({ kind: 'success', notice: expectedNotice });

  await page.goto(boardUrl);
}

/** Attaches a named fixture recipe to whatever actually failed, preserving it. */
async function withFixtureContext<T>(
  step: string,
  requirement: string,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    const original = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
    throw new Error(`${step} failed.\n\n${requirement}\n\n${original}`, { cause });
  }
}

/**
 * The page's own main region, and the scope EVERY content locator in this file
 * is built from.
 *
 * These surfaces stream: React emits each out-of-order Suspense payload as a
 * `<div hidden id="S:n">…</div>` appended to `<body>`, after `</main>`, holding
 * a byte-identical copy of that boundary's markup. The copies observed on the
 * SOP board outlive the swap — a full second copy of the selected-SOP panel sat
 * in the settled DOM — and `hidden` does not exclude an element from locator
 * MATCHING, only from `toBeVisible`. So an unscoped `page.locator(…)` here is a
 * strict-mode violation waiting on whichever boundary happens to stream late,
 * and one that reports itself as a locator bug rather than as what it is.
 *
 * Scoping to `main` keeps every assertion strict rather than relaxing it with
 * `.first()`: exactly one copy lives in the main region, and a genuine duplicate
 * rendered INSIDE the region — the condition actually worth catching — still
 * fails the way it should.
 */
function main(page: Page): Locator {
  return page.getByRole('main');
}

/** One status column of the execution board, addressed by its own `h3`. */
function sopGroup(page: Page, label: string): Locator {
  return main(page)
    .locator('section')
    .filter({ has: page.getByRole('heading', { level: 3, name: label, exact: true }) });
}

function sopCard(page: Page, group: string): Locator {
  return sopGroup(page, group).getByRole('link').filter({ hasText: SOP_TEMPLATE_NAME });
}

/** The SOP board form that owns a given submit button. */
function sopForm(page: Page, submitName: string): Locator {
  return main(page)
    .locator('form')
    .filter({ has: page.getByRole('button', { name: submitName, exact: true }) });
}

/**
 * A Studio panel addressed by its OWN heading rather than by any text it
 * happens to contain — `hasText` is a case-insensitive substring, and several
 * sibling panels on both surfaces mention each other's titles in body copy.
 */
function sectionCard(page: Page, heading: string, level: 2 | 3 = 3): Locator {
  return main(page)
    .locator('[data-slot="section-card"]')
    .filter({ has: page.getByRole('heading', { level, name: heading, exact: true }) });
}

/**
 * Selects the seeded branch by reading its own option value rather than by a
 * hard-coded identifier, so no database id is typed into this file and a label
 * change (`code`, `(default)`) cannot silently mis-target another branch.
 */
async function selectSeededBranch(select: Locator) {
  const option = select.locator('option').filter({ hasText: BRANCH_NAME });
  await expect(option, `the ${BRANCH_NAME} branch option must load`).toHaveCount(1);
  const value = await option.getAttribute('value');
  expect(value, 'the branch option must carry a value').toBeTruthy();
  await select.selectOption(value!);
}

// ── SOP execution ────────────────────────────────────────────────────────────

test('the seeded daily SOP is completed, submitted LATE past its window, and verified off the board', async ({
  page,
}) => {
  test.slow();
  await withTenantPool(async (pool) => {
    const origin = await signInAs(page, 'restaurantAdmin');
    await page.goto(new URL('/restaurant/sop', origin).href);
    await expect(
      main(page).getByRole('heading', { level: 1, name: 'Branch SOP board' })
    ).toBeVisible();

    // `Branch` and `Business date` are implicit labels wrapping their control, so
    // the accessible name can absorb the control's own value. Substring matching
    // is used throughout this board for that reason.
    await selectSeededBranch(main(page).getByLabel('Branch'));
    await main(page).getByLabel('Business date').fill(SOP_BUSINESS_DATE);
    await main(page).getByRole('button', { name: 'Load board' }).click();
    await page.waitForURL(new RegExp(`[?&]date=${SOP_BUSINESS_DATE}(?:&|$)`, 'u'));
    const boardUrl = page.url();

    const boardDate = sectionCard(page, 'Board date', 2);
    await expect(boardDate).toContainText(`${BRANCH_NAME} · August 27, 2026 · ${BRANCH_TIMEZONE}`);
    // The branch's business-day cutoff, which is what stamps the operating day.
    await expect(boardDate).toContainText('Cutoff 00:00');

    // The occurrence is due, unstarted, and pinned to the published version. Its
    // due instant and window are the assignment's recurrence rule (daily,
    // dueTimeMinutes 480, windowMinutes 1440) projected into the branch zone:
    // 08:00 on the business date, closing 08:00 the next day.
    //
    // The card's step counter reads the OCCURRENCE checklist, so it is asserted
    // with the completion leg below rather than here — a missing checklist row
    // must surface as the named fixture gap, not as an unexplained count.
    await expect(sopCard(page, 'Due')).toContainText('OPENING');
    await expect(sopCard(page, 'Due')).toContainText('Scheduled');
    // Both of these address the selected-SOP panel, which is exactly the boundary
    // the streamed copy duplicates — see `main()` above for why the region, and
    // not `.first()`, is the scope.
    await expect(main(page).getByText('Selected SOP · version 1')).toBeVisible();
    const detail = main(page).locator('dl').filter({ hasText: 'Window ends' });
    await expect(detail).toContainText(BRANCH_NAME);
    await expect(detail).toContainText('August 27, 2026');
    // `\s` also matches the narrow no-break space ICU 72+ emits before AM/PM.
    await expect(detail).toContainText(/Aug 27, 2026, 8:00\sAM/u);
    await expect(detail).toContainText(/Aug 28, 2026, 8:00\sAM/u);

    // ── Start ────────────────────────────────────────────────────────────────
    const operatorControls = sopForm(page, 'Start SOP');
    await runSopCommand(
      page,
      boardUrl,
      operatorControls.getByRole('button', { name: 'Start SOP', exact: true }),
      'SOP started.'
    );
    await expect(sopCard(page, 'In progress')).toBeVisible();
    await expect(sopCard(page, 'Due')).toHaveCount(0);
    await expect(
      main(page).getByRole('button', { name: 'Submit for review', exact: true })
    ).toBeVisible();

    // ── Complete the checklist ───────────────────────────────────────────────
    await withFixtureContext(
      'Completing the seeded SOP checklist step',
      SOP_OCCURRENCE_STEP_REQUIREMENT,
      async () => {
        const stepForm = sopForm(page, 'Complete step');
        await stepForm.getByLabel('Completion note').fill(SOP_COMPLETION_NOTE);
        await runSopCommand(
          page,
          boardUrl,
          stepForm.getByRole('button', { name: 'Complete step', exact: true }),
          'Checklist step completed.'
        );

        // Every one of these reads the occurrence checklist row, so they belong
        // inside the same fixture context as the command that writes it.
        const checklistStep = main(page).getByRole('listitem').filter({ hasText: SOP_STEP_TITLE });
        await expect(checklistStep).toContainText('Complete');
        await expect(checklistStep).toContainText(`Note: ${SOP_COMPLETION_NOTE}`);
        await expect(checklistStep).toContainText(`Completed by ${SOP_SESSION_STAFF_NAME}`);
        await expect(sopCard(page, 'In progress')).toContainText('OPENING · 1/1 steps');
      }
    );

    // ── Submit after the window closed ───────────────────────────────────────
    // Recorded as the signed-in staff profile, like every SOP command.
    const submitControls = sopForm(page, 'Submit for review');
    // The seeded window ended 2026-08-28T03:00Z, so `submitOccurrence` records
    // LATE rather than SUBMITTED. That is the assertion — not a tolerance.
    await runSopCommand(
      page,
      boardUrl,
      submitControls.getByRole('button', { name: 'Submit for review', exact: true }),
      'SOP submitted for review.'
    );
    await expect(sopCard(page, 'Late')).toBeVisible();
    await expect(sopCard(page, 'Awaiting review')).toHaveCount(0);
    // A submitted occurrence has no operator action left.
    await expect(
      main(page).getByRole('heading', { level: 3, name: 'Operator controls', exact: true })
    ).toHaveCount(0);

    const beforeVerification = await tenantQuery<{
      status: string;
      business_date: string;
      started: boolean;
      submitted: boolean;
      resolved: boolean;
      step_completed: boolean;
      step_note: string | null;
      step_actor: string | null;
    }>(
      pool,
      `SELECT o.status,
              to_char(o."businessDate", 'YYYY-MM-DD') business_date,
              o."startedAt" IS NOT NULL started,
              o."submittedAt" IS NOT NULL submitted,
              o."resolvedAt" IS NOT NULL resolved,
              s.completed step_completed,
              s.note step_note,
              s."completedByStaffProfileId" step_actor
         FROM restaurant_sop_occurrences o
         JOIN restaurant_sop_occurrence_steps s ON s."occurrenceId" = o.id
        WHERE o.id = $1`,
      ['sop_occurrence_restaurant_e2e_opening']
    );
    expect(beforeVerification.rows, FRESH_FIXTURE_NOTE).toEqual([
      {
        status: 'LATE',
        business_date: SOP_BUSINESS_DATE,
        started: true,
        submitted: true,
        resolved: false,
        step_completed: true,
        step_note: SOP_COMPLETION_NOTE,
        step_actor: SOP_SESSION_STAFF_PROFILE_ID,
      },
    ]);

    // ── Verify ───────────────────────────────────────────────────────────────
    const verifierControls = sopForm(page, 'Verify');
    await verifierControls.getByLabel('Verification reason').fill(SOP_VERIFICATION_REASON);
    await runSopCommand(
      page,
      boardUrl,
      verifierControls.getByRole('button', { name: 'Verify', exact: true }),
      'SOP verified.'
    );

    // VERIFIED is not one of the board's seven execution groups, so resolved work
    // leaves the board entirely instead of lingering as due work.
    await expect(
      main(page).getByRole('region', { name: 'SOP summary, 0 occurrences' })
    ).toBeVisible();
    await expect(
      main(page).getByRole('heading', { level: 2, name: 'No SOP selected', exact: true })
    ).toBeVisible();
    await expect(
      main(page).getByText('No occurrences match this branch business date.')
    ).toBeVisible();
    await expect(
      main(page).getByText('No scheduled SOPs are due for this business date.')
    ).toBeVisible();

    const afterVerification = await tenantQuery<{
      status: string;
      resolved: boolean;
      action: string;
      actor: string | null;
      reason: string | null;
      co_authorization: string | null;
    }>(
      pool,
      `SELECT o.status,
              o."resolvedAt" IS NOT NULL resolved,
              v.action,
              v."actorStaffProfileId" actor,
              v.reason,
              v."coAuthorizationId" co_authorization
         FROM restaurant_sop_occurrences o
         JOIN restaurant_sop_verifications v ON v."occurrenceId" = o.id
        WHERE o.id = $1
        ORDER BY v."createdAt"`,
      ['sop_occurrence_restaurant_e2e_opening']
    );
    expect(afterVerification.rows).toEqual([
      {
        status: 'VERIFIED',
        resolved: true,
        action: 'VERIFY',
        actor: SOP_SESSION_STAFF_PROFILE_ID,
        reason: SOP_VERIFICATION_REASON,
        // Single-signature verification; only a waiver carries a co-authorization.
        co_authorization: null,
      },
    ]);
  });
});

// ── Roster scheduling ────────────────────────────────────────────────────────

test('a published shift is stamped to the branch operating day, re-versions on edit, and keeps its cancellation reason', async ({
  page,
}) => {
  test.slow();
  await withTenantPool(async (pool) => {
    const origin = await signInAs(page, 'restaurantAdmin');
    await page.goto(new URL('/restaurant/staff/roster', origin).href);
    await expect(page.getByRole('heading', { level: 1, name: 'Roster' })).toBeVisible();

    // Tomorrow in the BRANCH's calendar, so the shift is still `SCHEDULED` when
    // read back (a shift whose end is already past presents as `ABSENT`), and so
    // the assertion does not depend on the runner host's timezone.
    const businessDay = branchDay(1);
    await selectSeededBranch(page.getByLabel('Branch', { exact: true }));
    await page.getByLabel('From', { exact: true }).fill(businessDay);
    await page.getByLabel('To', { exact: true }).fill(businessDay);

    // ── Publish ──────────────────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Schedule shift', exact: true }).click();
    const createDialog = page.getByRole('dialog');
    await expect(
      createDialog.getByRole('heading', { name: 'Schedule shift', exact: true })
    ).toBeVisible();
    // The dialog states the zone its `datetime-local` inputs are read in; the
    // SERVER still derives the operating day from the branch cutoff.
    await expect(createDialog).toContainText(`Times are entered in ${BRANCH_TIMEZONE}`);
    await createDialog.getByLabel('Operator').selectOption({ label: SOP_OWNER_STAFF_NAME });
    await createDialog.getByLabel('Starts').fill(`${businessDay}T09:00`);
    await createDialog.getByLabel('Ends').fill(`${businessDay}T17:00`);
    await createDialog.getByLabel('Role').fill(SHIFT_ROLE);
    await createDialog.getByLabel('Notes').fill(SHIFT_NOTES);
    await createDialog.getByRole('button', { name: 'Schedule shift', exact: true }).click();
    await expect(createDialog).toBeHidden();

    const liveRow = page
      .getByRole('row')
      .filter({ hasText: SHIFT_ROLE })
      .filter({ hasText: 'SCHEDULED' });
    await expect(liveRow, FRESH_FIXTURE_NOTE).toHaveCount(1);
    await expect(liveRow).toContainText(SOP_OWNER_STAFF_NAME);
    await expect(liveRow).toContainText(/9:00\sAM/u);
    await expect(liveRow).toContainText(/5:00\sPM/u);
    await expect(liveRow).toContainText(BRANCH_TIMEZONE);
    // The shifts panel titles itself with its own live count.
    await expect(
      page.getByRole('heading', { level: 2, name: '1 scheduled shift', exact: true })
    ).toBeVisible();

    const published = await tenantQuery<{
      business_date: string;
      role: string | null;
      notes: string | null;
      status: string;
      version: number;
      branch: string;
      cancelled_at: Date | null;
    }>(
      pool,
      `SELECT to_char("businessDate", 'YYYY-MM-DD') business_date,
              role, notes, status, version, "branchId" branch, "cancelledAt" cancelled_at
         FROM restaurant_shifts
        WHERE "staffProfileId" = $1 AND "businessDate" = $2::date`,
      [fixture.operator.staffProfileId, businessDay]
    );
    expect(published.rows, FRESH_FIXTURE_NOTE).toEqual([
      {
        business_date: businessDay,
        role: SHIFT_ROLE,
        notes: SHIFT_NOTES,
        status: 'SCHEDULED',
        version: 1,
        branch: fixture.branchId,
        cancelled_at: null,
      },
    ]);

    // ── Edit ─────────────────────────────────────────────────────────────────
    // The console submits the row's loaded `version` as `expectedVersion`, so a
    // successful save is proof the compare-and-set path ran, not a blind write.
    await liveRow.getByRole('button', { name: 'Edit', exact: true }).click();
    const editDialog = page.getByRole('dialog');
    await expect(
      editDialog.getByRole('heading', { name: 'Edit shift', exact: true })
    ).toBeVisible();
    await expect(editDialog).toContainText(`Operator: ${SOP_OWNER_STAFF_NAME}`);
    await editDialog.getByLabel('Role').fill(SHIFT_REVISED_ROLE);
    await editDialog.getByRole('button', { name: 'Save shift', exact: true }).click();
    await expect(editDialog).toBeHidden();

    const revisedRow = page
      .getByRole('row')
      .filter({ hasText: SHIFT_REVISED_ROLE })
      .filter({ hasText: 'SCHEDULED' });
    await expect(revisedRow).toHaveCount(1);
    await expect(page.getByRole('row').filter({ hasText: SHIFT_ROLE })).toHaveCount(0);

    const edited = await tenantQuery<{ role: string | null; version: number; status: string }>(
      pool,
      `SELECT role, version, status FROM restaurant_shifts
        WHERE "staffProfileId" = $1 AND "businessDate" = $2::date`,
      [fixture.operator.staffProfileId, businessDay]
    );
    expect(edited.rows).toEqual([{ role: SHIFT_REVISED_ROLE, version: 2, status: 'SCHEDULED' }]);

    // ── Cancel ───────────────────────────────────────────────────────────────
    // Cancellation is a soft state: the row stays on the published roster with
    // its reason, and stops blocking a replacement.
    await revisedRow.getByRole('button', { name: 'Cancel shift', exact: true }).click();
    const cancelDialog = page.getByRole('dialog');
    await expect(
      cancelDialog.getByRole('heading', { name: 'Cancel this shift?', exact: true })
    ).toBeVisible();
    await cancelDialog.getByLabel('Reason').fill(SHIFT_CANCEL_REASON);
    await cancelDialog.getByRole('button', { name: 'Cancel shift', exact: true }).click();
    await expect(cancelDialog).toBeHidden();

    const cancelledRow = page
      .getByRole('row')
      .filter({ hasText: SHIFT_REVISED_ROLE })
      .filter({ hasText: 'CANCELLED' });
    await expect(cancelledRow).toHaveCount(1);
    await expect(cancelledRow).toContainText(SHIFT_CANCEL_REASON);
    await expect(cancelledRow.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled();
    await expect(
      cancelledRow.getByRole('button', { name: 'Cancel shift', exact: true })
    ).toBeDisabled();
    await expect(
      page.getByRole('heading', { level: 2, name: '0 scheduled shifts', exact: true })
    ).toBeVisible();

    const cancelled = await tenantQuery<{
      status: string;
      version: number;
      cancel_reason: string | null;
      cancelled: boolean;
    }>(
      pool,
      `SELECT status, version, "cancelReason" cancel_reason, "cancelledAt" IS NOT NULL cancelled
         FROM restaurant_shifts
        WHERE "staffProfileId" = $1 AND "businessDate" = $2::date`,
      [fixture.operator.staffProfileId, businessDay]
    );
    expect(cancelled.rows).toEqual([
      { status: 'CANCELLED', version: 3, cancel_reason: SHIFT_CANCEL_REASON, cancelled: true },
    ]);
  });
});

// ── Roster role behaviour ────────────────────────────────────────────────────

test('an operator without staff:manage is refused the manager roster and keeps only their own timekeeping', async ({
  page,
}) => {
  // `restaurantShifts.managerRoster` is a `staff:manage` capability procedure and
  // the seeded operator role grants only payments/cash/orders/customers, while
  // `myRoster` is a plain protected procedure resolving the actor's own staff
  // profile. Restaurant Workforce is licensed for this organization, so a denial
  // here is a CAPABILITY denial and not a licence denial.
  const origin = await signInAs(page, 'restaurantOperator');
  await page.goto(new URL('/restaurant/staff/roster', origin).href);
  await expect(page.getByRole('heading', { level: 1, name: 'Roster' })).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Employee timekeeping', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 3, name: 'Restaurant Workforce disabled', exact: true })
  ).toHaveCount(0);

  // The refusal lands EARLIER than the manager roster itself, and asserting it
  // at the roster query would have been asserting a state this actor can never
  // reach. `restaurantStaff.listBranches` resolves the caller's scope through
  // `resolveStaffBranchAuthorization`, which is `staff:manage`; for an actor with
  // neither that capability nor `restaurant:configure` it resolves to zero
  // branches and THROWS (`denyStaffBranchAccess`). So the branch picker this
  // console gates the roster behind never populates, and the manager roster is
  // never requested at all — refused, fail-closed, one seam before the one this
  // case originally reached for.
  const branchPicker = page.getByLabel('Branch', { exact: true });
  await expect(
    branchPicker.locator('option').filter({ hasText: BRANCH_NAME }),
    'a staff:manage-less operator must not be offered a branch to administer'
  ).toHaveCount(0);
  await expect(branchPicker, 'the branch picker must be inert, not merely empty').toBeDisabled();
  await expect(branchPicker).toContainText('Branches unavailable');

  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Schedule shift', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Export attendance CSV', exact: true })
  ).toHaveCount(0);
});

// WHA-1599: back-office mutations must reach the actual terminal surfaces.
// Riders and platforms (WHA-219) are outside this demo acceptance scope.
async function openOperationsPos(page: Page, delivery: boolean) {
  const origin = terminalBrowserBaseUrl();
  const device = delivery ? fixture.delivery.pos : fixture.pos;
  const operator = delivery ? fixture.deliveryOperator : fixture.operator;
  await installSeededTerminalCookie(page.context(), device, origin);
  await page.goto(new URL('/pos', origin).href);
  await page.getByLabel('Operator', { exact: true }).selectOption(operator.staffProfileId);
  await page.getByLabel('Operator PIN', { exact: true }).fill(operator.pin);
  await page.getByRole('button', { name: 'Unlock terminal' }).click();
  await expect(page.getByRole('heading', { name: 'Order pad' })).toBeVisible();
}

test('WHA-1599 floor table edit reaches the POS table map', async ({ page }, testInfo) => {
  test.slow();
  await signInAs(page, 'restaurantAdmin');
  await page.goto(new URL('/restaurant/floor', page.url()).href);
  await page.getByLabel('Branch', { exact: true }).selectOption(fixture.branchId);
  const original = await withTenantPool(
    async (pool) =>
      (
        await tenantQuery<{ code: string }>(
          pool,
          'SELECT code FROM restaurant_tables WHERE id = $1',
          [fixture.table.id]
        )
      ).rows[0]
  );
  expect(original).toBeTruthy();
  const card = main(page)
    .locator('div.rounded-md')
    .filter({
      has: page.getByText(`Table ${original.code}`, { exact: true }),
    })
    .filter({ has: page.getByRole('button', { name: 'Edit', exact: true }) });
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Table code').fill('QA1599');
  await dialog.getByLabel('Capacity').fill('7');
  await dialog.getByRole('button', { name: 'Edit table', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(main(page).getByText('Table QA1599', { exact: true })).toBeVisible();
  await testInfo.attach('floor-edited', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await withTenantPool(async (pool) => {
    const result = await tenantQuery(
      pool,
      'SELECT code, capacity FROM restaurant_tables WHERE id = $1',
      [fixture.table.id]
    );
    expect(result.rows).toEqual([{ code: 'QA1599', capacity: 7 }]);
  });
  await openOperationsPos(page, false);
  await page.getByLabel('Channel', { exact: true }).selectOption('DINE_IN');
  const table = page.getByRole('checkbox', { name: /QA1599.*7 seats/ });
  await expect(table).toBeEnabled();
  await table.check();
  await expect(table).toBeChecked();
  await testInfo.attach('pos-updated-table', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('WHA-1599 delivery zone and saved address attach through POS to KDS', async ({
  page,
  browser,
}, testInfo) => {
  test.slow();
  await signInAs(page, 'restaurantAdmin');
  await page.goto(new URL('/restaurant/delivery', page.url()).href);
  await page
    .getByRole('combobox', { name: 'Branch', exact: true })
    .selectOption(fixture.delivery.branchId);
  await page.getByRole('button', { name: 'Add zone', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Zone name').fill('QA1599 zone');
  await dialog.getByLabel('Area or postal label').fill('QA1599 area');
  await dialog.getByLabel('Fixed fee').fill('4.25');
  await dialog.getByLabel('Promised minutes').fill('35');
  await dialog.getByRole('button', { name: 'Add zone', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(main(page).getByText('QA1599 zone', { exact: true })).toBeVisible();
  await page.getByLabel('Customer', { exact: true }).selectOption(fixture.customer.id);
  await page.getByRole('button', { name: 'Add address', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Address label').fill('QA1599 home');
  await dialog.getByLabel('Recipient name').fill('E2E Guest');
  await dialog.getByLabel('Phone', { exact: true }).fill('+923001599001');
  await dialog.getByLabel('Country code').fill('PK');
  await dialog.getByLabel('Address line 1', { exact: true }).fill('1599 Test Street');
  await dialog.getByLabel('City or locality').fill('Lahore');
  await dialog.getByRole('button', { name: 'Add address', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(main(page).getByText('QA1599 home', { exact: true })).toBeVisible();
  await testInfo.attach('delivery-backoffice', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await openOperationsPos(page, true);
  await page.getByLabel('Channel', { exact: true }).selectOption('DELIVERY');
  await page.getByLabel('Customer name').fill(fixture.customer.name);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(fixture.customer.name) }).click();
  await page.getByLabel('Saved address').selectOption({ label: 'QA1599 home · E2E Guest' });
  await page.getByLabel('Delivery zone').selectOption({ label: 'QA1599 zone' });
  await page.getByRole('button', { name: new RegExp(fixture.menuItem.name) }).click();
  await page.getByLabel(new RegExp(fixture.modifier.name)).check();
  await page.getByRole('button', { name: 'Add to order' }).click();
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/api/restaurant/orders/open') && r.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Open order', exact: true }).click();
  const openedResponse = await response;
  expect(openedResponse.ok()).toBeTruthy();
  const opened = (await openedResponse.json()) as { orderId: string; orderNumber: number };
  await expect(
    page.getByText(`Delivery order ${opened.orderNumber} opened and fulfillment attached.`)
  ).toBeVisible();
  await page.getByRole('button', { name: 'Send whole order' }).click();
  await expect(page.getByText('Order sent to kitchen.')).toBeVisible();
  await withTenantPool(async (pool) => {
    const result = await tenantQuery(
      pool,
      'SELECT "addressLine1Snapshot", "zoneNameSnapshot", "deliveryFeeSnapshot"::text AS fee FROM restaurant_delivery_fulfillments WHERE "orderId" = $1',
      [opened.orderId]
    );
    expect(result.rows).toEqual([
      { addressLine1Snapshot: '1599 Test Street', zoneNameSnapshot: 'QA1599 zone', fee: '4.25' },
    ]);
  });
  const origin = terminalBrowserBaseUrl();
  const context = await browser.newContext({ baseURL: origin });
  try {
    await installSeededTerminalCookie(context, fixture.delivery.kds, origin);
    const kds = await context.newPage();
    await kds.goto('/kds');
    await kds.getByLabel('Acting operator').selectOption(fixture.deliveryOperator.staffProfileId);
    await kds.getByLabel('Operator PIN', { exact: true }).fill(fixture.deliveryOperator.pin);
    await kds.getByRole('button', { name: 'Verify PIN and unlock' }).click();
    const order = kds.getByRole('article').filter({ hasText: `Order #${opened.orderNumber}` });
    await expect(order.getByText(fixture.customer.name, { exact: true })).toBeVisible();
    await expect(order.getByText('4.25', { exact: true })).toBeVisible();
    await expect(order.getByText(/Lahore/)).toBeVisible();
    await testInfo.attach('kds-delivery-board', {
      body: await kds.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  } finally {
    await context.close();
  }
});
