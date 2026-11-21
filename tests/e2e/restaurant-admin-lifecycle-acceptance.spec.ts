import { chooseSelectField, selectFieldNative } from './fixtures/select-field';
/**
 * WHA-1236 — Restaurant admin lifecycle acceptance (staff seat administration and
 * branch configuration persistence).
 *
 * Why this file exists. The integrated Restaurant lane already proves the *negative*
 * side of admin configuration and the *read-only* side of the staff directory:
 *
 *   - tests/e2e/restaurant-controls-final.spec.ts
 *       'branch controls use readable codes and enforce duplicate, limit, and
 *        deactivation guards' — duplicate-name rejection, branch-limit disablement,
 *        primary-branch deactivation guard, and the permanently disabled branch code.
 *        Every branch mutation it drives is expected to FAIL; nothing there proves a
 *        branch edit is persisted.
 *   - tests/e2e/restaurant-integrated.spec.ts — visits '/restaurant/staff' in the route
 *        matrix and asserts only the page heading.
 *   - tests/e2e/restaurant-actor-accessibility.spec.ts — screenshots '/restaurant/staff'
 *        and '/restaurant/settings/branches' for the accessibility matrix.
 *   - src/components/restaurant/restaurant-staff-console.test.tsx and
 *     src/server/routers/restaurant-staff.test.ts — component and router coverage with
 *        a mocked transport/db; neither writes to or reads back a database.
 *
 * So the user-reported gap is real and narrow: no executable test adds a staff seat
 * through the real console, edits that seat, or proves either survives a reload; and no
 * executable test proves a branch configuration edit is persisted. This file adds only
 * that, against real application behaviour, reusing the lane's existing fixtures
 * (./fixtures/restaurant-actor-accessibility, ./restaurant-fixture). It introduces no
 * new framework, page object, or global fixture.
 *
 * FIXTURE CONTRACT — prerequisites this file depends on at execution time:
 *   1. RESTAURANT_INTEGRATED_E2E=1 and a server started by
 *      playwright.restaurant-integrated.config.ts against an isolated, seeded database
 *      (scripts/seed-restaurant-e2e.ts). Both are asserted below and FAIL LOUDLY —
 *      this file never skips itself into a vacuous pass.
 *   2. RESTAURANT_ACTOR_ADMIN_* and RESTAURANT_ACTOR_OPERATOR_* credentials, as used by
 *      signInAs(). Asserted below.
 *   3. The seeded organization must resolve the Restaurant operator seat ceiling
 *      with headroom. `restaurantStaff.create` routes an ACTIVE profile through
 *      createStaffProfileWithinCommercialLimit, which resolves
 *      RESTAURANT_OPERATORS_LIMIT from `ctx.entitlements.limits` — explicit key
 *      'restaurant.operators.max', bootstrapped key
 *      'restaurant-core.restaurant.operators.max' — and rejects the mutation with
 *      'Restaurant operator limit is not configured correctly.' when neither key is
 *      present. scripts/seed-restaurant-e2e.ts seeds no explicit
 *      'restaurant.operators.max' organization limit (only
 *      'restaurant.locations.max'), so the ceiling arrives through the bootstrapped
 *      key: the `packageId: null` written at scripts/seed-restaurant-e2e.ts:567 is
 *      immediately overwritten by seedRestaurantDemoControlPlane (called at :595),
 *      which stamps org_chai_chowk onto the 'restaurant-operations' package whose
 *      'restaurant-core' module link carries 'restaurant.operators.max': 100. Those
 *      link limits are applied because 'restaurant-core' is mandatory and therefore
 *      VERTICAL_CORE rather than BASELINE — src/lib/entitlements.ts skips package,
 *      contract, and override limits only for BASELINE modules — so the limit
 *      resolves 'bootstrapped' at 100, far above the handful of seeded profiles.
 *      If any link in that chain breaks (package unstamped, module link disabled,
 *      catalog row rebanded BASELINE), the ceiling resolves as *missing*. The first
 *      test below reports the server message verbatim when that happens, so the
 *      failure names the fixture chain rather than looking like a UI defect. The
 *      repair, if it is ever needed, is an explicit 'restaurant.operators.max'
 *      organizationLimit row for the organization — a package assignment alone
 *      cannot substitute for it once 'restaurant-core' is banded BASELINE. The
 *      shared seed is deliberately not modified from this lane.
 *   4. Three active branches, as seeded: 'Gulberg Café' (primary), 'DHA Café', and
 *      the ASCII-printable 'Gulberg Cafe Receipt Lab' that queued-receipt
 *      acceptance needs (see the fixture note on `SEEDED_ACTIVE_BRANCHES`).
 *
 * CONFIG REQUIREMENT — playwright.restaurant-integrated.config.ts declares an exact,
 * per-file `testMatch` array. Until 'restaurant-admin-lifecycle-acceptance.spec.ts' is
 * added to it, this file is NOT collected by the integrated lane. That shared config is
 * outside this lane's owned file set and is deliberately left unchanged here.
 *
 * Both mutating tests restore the fixture in a `finally` block and read the restoration
 * back, so the serial lane is left as it was found. That includes the branch settings
 * the second test deliberately turns on to make its preservation claim observable.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { restaurantE2eCredentials as fixture } from './restaurant-fixture';
import {
  actorFixture,
  assertNoRawDatabaseIds,
  signInAs,
} from './fixtures/restaurant-actor-accessibility';

test.describe.configure({ mode: 'serial' });

if (process.env.RESTAURANT_INTEGRATED_E2E !== '1') {
  throw new Error('RESTAURANT_INTEGRATED_E2E=1 is required.');
}
/**
 * The two seats this file actually signs in as, checked individually rather than
 * through the shared `actorFixtureReady`. That flag additionally requires the
 * SuperAdmin and Agency credentials, which `restaurantE2eEnvironment`
 * (scripts/restaurant-e2e-database.ts) DELETES from the lane environment on
 * purpose: its allowlist admits only the four RESTAURANT_ACTOR_ADMIN_* /
 * RESTAURANT_ACTOR_OPERATOR_* names. So the wider flag can never be true in the
 * one lane that sets RESTAURANT_INTEGRATED_E2E=1, and this file threw at load and
 * registered ZERO cases instead of running.
 *
 * Narrowing the guard to the seats in use restores collection without weakening
 * anything: a missing credential still fails loudly at load, and neither this file
 * nor the lane's credential allowlist gains a seat it did not already hold.
 */
for (const seat of ['restaurantAdmin', 'restaurantOperator'] as const) {
  const { email, password } = actorFixture[seat];
  if (!email || !password) {
    throw new Error(
      `RESTAURANT_ACTOR_${seat === 'restaurantAdmin' ? 'ADMIN' : 'OPERATOR'}_EMAIL and ` +
        `_PASSWORD are required; this lane must not skip admin acceptance.`
    );
  }
}

/** Unique per run so a create against a retained database cannot collide on email. */
const RUN = Date.now().toString(36);
const NEW_STAFF = {
  name: `E2E Seat Hire ${RUN}`,
  email: `seat-hire-${RUN}@restaurant-e2e.test`,
  renamed: `E2E Seat Hire ${RUN} (Renamed)`,
  renamedEmail: `seat-hire-renamed-${RUN}@restaurant-e2e.test`,
} as const;

const PRIMARY_BRANCH = 'Gulberg Café';
const SECOND_BRANCH = fixture.delivery.branchName; // 'DHA Café'
/**
 * The branch capacity the Locations card publishes as "<active> of <total> active".
 *
 * This is a COUNT of `scripts/seed-restaurant-e2e.ts`'s branches, not a property
 * of the test: every branch the shared seed adds moves it. It is named once here
 * so a fixture addition fails with this constant in view instead of leaving a
 * bare literal to be hunted through the assertions. The claim the two assertions
 * below make is unchanged — the capacity must be the seeded one BEFORE an edit
 * and the SAME one after it, so an edit cannot create or retire a location.
 */
const SEEDED_ACTIVE_BRANCHES = 3;
const seededCapacity = `${SEEDED_ACTIVE_BRANCHES} of ${SEEDED_ACTIVE_BRANCHES} active`;

/**
 * The branch editor seeds its draft from EMPTY on every save, so a preservation
 * claim is only real if the asserted value differs from that default. The console's
 * defaults are `businessDayCutoff: '00:00'` and `shiftSignInEnforced: false`
 * (src/components/restaurant/restaurant-branches-console.tsx), which are exactly
 * what scripts/seed-restaurant-e2e.ts writes for both branches. So the branch test
 * below saves the opposite of each default first, and asserts against these.
 */
const ARMED_CUTOFF = '05:30';
const ARMED_SHIFT_RULE = true;
const SHIFT_RULE_LABEL = /Require an active scheduled shift for terminal sign-in/;

/**
 * Branch options render as "<name> · <code>[ (default)]" and codes are generated, so the
 * exact label is read from the live option instead of hard-coding a database value.
 */
async function selectBranchByName(select: Locator, branchName: string) {
  const option = (await selectFieldNative(select))
    .locator('option')
    .filter({ hasText: branchName })
    .first();
  await expect(option, `branch option "${branchName}" must be offered`).toHaveCount(1);
  const label = (await option.textContent())?.trim();
  if (!label) throw new Error(`Branch option "${branchName}" rendered no label.`);
  await chooseSelectField(select, { label });
  return label;
}

/**
 * Submits the staff dialog and resolves the real outcome. A rejected mutation keeps the
 * dialog open and renders the server message in the form's alert; surfacing that message
 * turns a fixture/entitlement failure into a named diagnostic instead of a bare timeout.
 */
async function submitStaffDialog(dialog: Locator) {
  const alert = dialog.getByRole('alert');
  await dialog.getByRole('button', { name: 'Save staff member' }).click();
  const outcome = await Promise.race([
    dialog.waitFor({ state: 'hidden', timeout: 30_000 }).then(() => 'saved' as const),
    alert.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'rejected' as const),
  ]);
  if (outcome === 'rejected') {
    throw new Error(
      `Restaurant staff mutation was rejected by the server: ${(await alert.textContent())?.trim()}`
    );
  }
}

function staffRow(page: Page, displayName: string) {
  return page.getByRole('row').filter({ hasText: displayName });
}

function directoryCount(page: Page) {
  return page.getByRole('heading', { name: /^\d+ staff members?$/ });
}

async function readDirectoryCount(page: Page) {
  const text = (await directoryCount(page).textContent())?.trim() ?? '';
  const parsed = Number.parseInt(text, 10);
  expect(Number.isInteger(parsed), `directory heading "${text}" must publish a count`).toBe(true);
  return parsed;
}

function branchEditor(page: Page, title: 'Edit branch' | 'Create branch') {
  return page.locator('[data-slot="section-card"]', {
    has: page.getByRole('heading', { name: title, exact: true }),
  });
}

function shiftRuleBox(editor: Locator) {
  return editor.getByRole('checkbox', { name: SHIFT_RULE_LABEL });
}

/**
 * Saving collapses the editor back to its create state, so every subsequent read
 * has to re-open the row. Re-opening also forces the values to come from the
 * refetched list rather than from the draft that was just submitted.
 */
async function reopenBranchEditor(page: Page, row: Locator) {
  await row.getByRole('button', { name: 'Edit' }).click();
  const editor = branchEditor(page, 'Edit branch');
  await expect(editor).toBeVisible();
  return editor;
}

async function saveBranchEdit(page: Page, editor: Locator) {
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Branch updated.')).toBeVisible();
  await expect(
    branchEditor(page, 'Create branch'),
    'a saved edit must return the editor to its create state'
  ).toBeVisible();
}

test('an added staff seat persists, and editing it reassigns name, email, and branch across a reload', async ({
  page,
}) => {
  const origin = await signInAs(page, 'restaurantAdmin');
  const staffUrl = new URL('/restaurant/staff', origin).href;
  await page.goto(staffUrl);
  await expect(page.getByRole('heading', { name: 'Staff', exact: true })).toBeVisible();

  const before = await readDirectoryCount(page);
  await expect(staffRow(page, NEW_STAFF.name)).toHaveCount(0);

  let created = false;
  try {
    // ── Add ────────────────────────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Add staff member' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Add staff member' })).toBeVisible();
    await dialog.getByLabel('Display name').fill(NEW_STAFF.name);
    await dialog.getByLabel('Email').fill(NEW_STAFF.email);
    await selectBranchByName(dialog.getByRole('combobox', { name: 'Branch' }), PRIMARY_BRANCH);
    await dialog.getByLabel('Status').selectOption('ACTIVE');
    await submitStaffDialog(dialog);
    created = true;
    await expect(page.getByText('Staff profile created.')).toBeVisible();

    // ── Persistence readback: a full reload re-reads the row from the database ──
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Staff', exact: true })).toBeVisible();
    expect(await readDirectoryCount(page), 'the added seat must be registered').toBe(before + 1);
    const row = staffRow(page, NEW_STAFF.name);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(NEW_STAFF.email);
    await expect(row, 'the directory must name the branch, not only its id').toContainText(
      PRIMARY_BRANCH
    );
    await expect(row.getByRole('combobox', { name: `Status for ${NEW_STAFF.name}` })).toHaveValue(
      'ACTIVE'
    );

    // ── Edit the seat: rename, re-address, and reassign the primary branch ──────
    await row.getByRole('button', { name: 'Edit' }).click();
    const editDialog = page.getByRole('dialog');
    await expect(editDialog.getByRole('heading', { name: 'Edit staff member' })).toBeVisible();
    await expect(
      editDialog.getByLabel('Display name'),
      'the edit dialog must open on the saved profile'
    ).toHaveValue(NEW_STAFF.name);
    await expect(editDialog.getByLabel('Email')).toHaveValue(NEW_STAFF.email);
    await editDialog.getByLabel('Display name').fill(NEW_STAFF.renamed);
    await editDialog.getByLabel('Email').fill(NEW_STAFF.renamedEmail);
    await selectBranchByName(editDialog.getByRole('combobox', { name: 'Branch' }), SECOND_BRANCH);
    await submitStaffDialog(editDialog);
    await expect(page.getByText('Staff profile updated.')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Staff', exact: true })).toBeVisible();
    const renamed = staffRow(page, NEW_STAFF.renamed);
    await expect(renamed).toHaveCount(1);
    await expect(renamed).toContainText(NEW_STAFF.renamedEmail);
    await expect(renamed, 'the seat must move to its reassigned branch').toContainText(
      SECOND_BRANCH
    );
    await expect(
      staffRow(page, NEW_STAFF.email),
      'the superseded email must not survive the edit'
    ).toHaveCount(0);
    expect(await readDirectoryCount(page), 'editing a seat must not create a second profile').toBe(
      before + 1
    );
  } finally {
    // The staff console exposes no delete, so the seat is archived to return the
    // operator ceiling to the lane and keep this spec re-runnable.
    if (created) {
      await page.goto(staffUrl);
      // `renamed` is `${name} (Renamed)`, so this row filter matches before and after
      // the edit and needs no branch on how far the test progressed.
      const live = staffRow(page, NEW_STAFF.name);
      await expect(live).toHaveCount(1);
      await live.getByRole('combobox').selectOption('ARCHIVED');
      await expect(page.getByText('Staff status updated.')).toBeVisible();
      await page.reload();
      await expect(live.getByRole('combobox')).toHaveValue('ARCHIVED');
    }
  }
});

test('a branch configuration edit is persisted and leaves the code, shift rule, and active count intact', async ({
  page,
}) => {
  const origin = await signInAs(page, 'restaurantAdmin');
  const branchesUrl = new URL('/restaurant/settings/branches', origin).href;
  await page.goto(branchesUrl);
  await expect(page.getByRole('heading', { name: 'Branches', exact: true })).toBeVisible();

  const locations = page.locator('[data-slot="section-card"]', {
    has: page.getByRole('heading', { name: 'Locations' }),
  });
  const row = locations.getByRole('listitem').filter({ hasText: SECOND_BRANCH });
  await expect(row).toHaveCount(1);
  await expect(page.getByText(seededCapacity)).toBeVisible();

  const editor = await reopenBranchEditor(page, row);
  const originalAddress = await editor.getByLabel('Address').inputValue();
  const originalCode = await editor.getByLabel('Branch code').inputValue();
  const originalTimezone = await editor.getByLabel('Timezone').inputValue();
  const originalCutoff = await editor.getByLabel('Business day cutoff').inputValue();
  const originalShiftRule = await shiftRuleBox(editor).isChecked();
  expect(originalCode, 'the seeded branch must publish a readable code').toMatch(/^[A-Z0-9-]{2,}$/);
  // Guards the arming step below: each armed value must be a real transition from
  // what the fixture ships, otherwise the save proves nothing and the preservation
  // assertions could not tell a kept setting from a draft reset to the defaults.
  expect(
    originalCutoff,
    'the armed cutoff must differ from the seeded one for preservation to be observable'
  ).not.toBe(ARMED_CUTOFF);
  expect(
    originalShiftRule,
    'the armed shift rule must differ from the seeded one for preservation to be observable'
  ).not.toBe(ARMED_SHIFT_RULE);

  const edited = `Plot ${RUN}, Phase 6 Commercial, DHA Lahore`;
  let armed = false;
  try {
    // ── Arm the settings whose preservation this test claims ───────────────────
    // Saved and read back on their own first, so the later assertions measure
    // survival of the address edit rather than agreement with a default.
    await editor.getByLabel('Business day cutoff').fill(ARMED_CUTOFF);
    await shiftRuleBox(editor).setChecked(ARMED_SHIFT_RULE);
    // Armed BEFORE the awaited save, not after: `saveBranchEdit` can commit the
    // change and still throw on the UI assertion that follows it, and a flag set
    // afterwards would then leave the branch permanently on the armed cutoff and
    // shift rule for every later spec in this serial lane. Restoring settings that
    // were never changed is a no-op; failing to restore committed ones is not.
    armed = true;
    await saveBranchEdit(page, editor);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Branches', exact: true })).toBeVisible();
    await expect(row, 'the directory must publish the saved business day').toContainText(
      `business day ${ARMED_CUTOFF}`
    );
    const configured = await reopenBranchEditor(page, row);
    await expect(
      configured.getByLabel('Business day cutoff'),
      'a non-default business day cutoff must persist'
    ).toHaveValue(ARMED_CUTOFF);
    expect(
      await shiftRuleBox(configured).isChecked(),
      'enabling the terminal shift rule must persist'
    ).toBe(ARMED_SHIFT_RULE);

    // ── The unrelated edit: address only, settings untouched ───────────────────
    await configured.getByLabel('Address').fill(edited);
    await saveBranchEdit(page, configured);

    // ── Persistence readback from a fresh load ─────────────────────────────────
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Branches', exact: true })).toBeVisible();
    await expect(page.getByText(seededCapacity), 'an edit must not change capacity').toBeVisible();
    const reloaded = await reopenBranchEditor(page, row);
    await expect(reloaded.getByLabel('Address')).toHaveValue(edited);
    await expect(
      reloaded.getByLabel('Branch code'),
      'branch codes are permanent so operational references stay stable'
    ).toHaveValue(originalCode);
    await expect(reloaded.getByLabel('Branch code')).toBeDisabled();
    await expect(reloaded.getByLabel('Name', { exact: true })).toHaveValue(SECOND_BRANCH);
    await expect(reloaded.getByLabel('Timezone')).toHaveValue(originalTimezone);
    await expect(
      reloaded.getByLabel('Business day cutoff'),
      'an address edit must not reset the business day cutoff to the draft default'
    ).toHaveValue(ARMED_CUTOFF);
    expect(
      await shiftRuleBox(reloaded).isChecked(),
      'an address edit must not silently clear the terminal shift rule'
    ).toBe(ARMED_SHIFT_RULE);
  } finally {
    // Restores the address and, when the arming save landed, the two settings it
    // changed — all three in one submit, then read back from a fresh load.
    await page.goto(branchesUrl);
    const restore = await reopenBranchEditor(page, row);
    await restore.getByLabel('Address').fill(originalAddress);
    if (armed) {
      await restore.getByLabel('Business day cutoff').fill(originalCutoff);
      await shiftRuleBox(restore).setChecked(originalShiftRule);
    }
    await saveBranchEdit(page, restore);

    await page.reload();
    const restored = await reopenBranchEditor(page, row);
    await expect(restored.getByLabel('Address')).toHaveValue(originalAddress);
    await expect(restored.getByLabel('Business day cutoff')).toHaveValue(originalCutoff);
    expect(await shiftRuleBox(restored).isChecked()).toBe(originalShiftRule);
  }
});

test('an assigned-branch operator is denied staff and branch administration', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const operator = await context.newPage();
  try {
    const origin = await signInAs(operator, 'restaurantOperator');

    await operator.goto(new URL('/restaurant/staff', origin).href);
    await expect(operator.getByRole('heading', { name: 'Staff', exact: true })).toBeVisible();
    await expect(operator.getByRole('heading', { name: 'Staff access unavailable' })).toBeVisible();
    await expect(
      operator.getByText('You do not have permission to manage restaurant staff.', { exact: true })
    ).toBeVisible();
    await expect(operator.getByRole('button', { name: 'Add staff member' })).toHaveCount(0);
    await expect(operator.getByRole('row')).toHaveCount(0);
    await expect(operator.locator('body')).not.toContainText(NEW_STAFF.name);

    await operator.goto(new URL('/restaurant/settings/branches', origin).href);
    await expect(operator.getByRole('heading', { name: 'Branches', exact: true })).toBeVisible();
    await expect(
      operator.getByRole('heading', { name: 'Branch settings unavailable' })
    ).toBeVisible();
    await expect(
      operator.getByText('You do not have permission to configure restaurant branches.', {
        exact: true,
      })
    ).toBeVisible();
    await expect(operator.getByRole('heading', { name: 'Locations' })).toHaveCount(0);
    await expect(operator.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(operator.locator('body')).not.toContainText(fixture.branchA2Id);
    await assertNoRawDatabaseIds(operator);
  } finally {
    await context.close();
  }
});
