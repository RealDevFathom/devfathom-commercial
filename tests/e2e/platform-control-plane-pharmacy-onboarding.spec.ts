/**
 * WHA-1198 — PLAT-02/03 end to end, from a fresh pharmacy organization.
 *
 * The whole claim of these two surfaces is that they tell the operator the
 * truth about activation, so the only proof worth having is the one that
 * *tries* to activate: fill the branch regulatory profile in the browser, watch
 * the readiness steps flip, be refused activation while one step is
 * outstanding, clear it, and be activated.
 *
 * A sibling `platform-control-plane*.spec.ts` file with its own slug and its own
 * organization (WHA-1180's pattern), so it neither depends on nor disturbs
 * another lane's fixture whichever order they run in.
 *
 * Two things this fixture used to seed by hand, because `organization.create`
 * provisioned them only for RESTAURANT: the vertical role templates the
 * OWNER_AND_ROLE_TEMPLATES gate requires, and the `PharmacyBranch` a regulatory
 * profile belongs to. WHA-1206 moved both into provisioning, so the fixture now
 * *asserts* them instead — a pharmacy that stops being provisioned with either
 * fails here rather than being propped up by the test.
 *
 * The confirmed Sindh rule set stands in for counsel confirming a jurisdiction
 * (PHARM-P0-COUNSEL-001) — an out-of-band act with no application path by
 * design: the table is INSERT-able only under the platform-admin GUC.
 */
import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import {
  controlPlaneEnvironmentAvailable,
  ensureControlPlaneCatalog,
  loginPlatformRequest,
  platformMutationHeaders,
  resetOrganization,
  withAdminDatabase,
} from './fixtures/platform-control-plane';

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1440, height: 900 } });
test.skip(
  !controlPlaneEnvironmentAvailable(),
  'Requires a fresh test/e2e PostgreSQL database, restricted DATABASE_URL, admin setup URL, and seeded platform admin email/password.'
);

const CONFIRMED_RULE_SET = 'e2e_pk_sd_confirmed_v1';

/**
 * A fresh organization, and fresh row ids, on every run.
 *
 * This spec cannot reuse one slug the way its siblings do, because a pharmacy
 * organization that has recorded an onboarding attestation **cannot be
 * deleted**: `pharmacy_onboarding_events` carries an unconditional BEFORE
 * DELETE trigger, so the cascade from `organizations` is refused for every
 * role. `pharmacy_branches` also has no foreign key back to `organizations` at
 * all, so its rows would outlive the tenant even if the delete succeeded.
 * Rather than reach around either, each run stands up its own tenant; the
 * previous run's rows are inert, and the control-plane fixture already refuses
 * any database not explicitly named test/e2e.
 */
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);

const tenant = {
  slug: `e2e-pharmacy-onboarding-${suffix}`,
  displayName: 'E2E Onboarding Pharmacy',
  legalName: 'E2E Onboarding Pharmacy (Private) Limited',
  email: `pharmacy-onboarding-owner-${suffix}@e2e.invalid`,
  password: 'Local-only-pharmacy-42!',
  branchName: 'Clifton Chemist',
} as const;

const sharedBaseUrl = process.env.PLAYWRIGHT_SHARED_BASE_URL;

/** The six steps an operator confirms; the other six are answered from data. */
const ATTESTED_STEPS = [
  'Organization type',
  'Legal business',
  'Launch jurisdiction',
  'Branches and locations',
  'Devices and documents',
  'Readiness and parallel run',
] as const;
/** Recorded last, so activation has exactly one outstanding step to refuse on. */
const LAST_STEP = 'Readiness and parallel run';

test.beforeAll(async () => {
  await ensureControlPlaneCatalog();
  // A no-op for this run's fresh slug; kept so a re-run after an interrupted
  // one, before any attestation was recorded, still starts clean.
  await resetOrganization(tenant.slug);
  await withAdminDatabase(async (db) => {
    // Band and vertical are left exactly as the shipped module catalog defines
    // them (`module-catalog.ts` lists `pharmacy-core` as PLATFORM band with no
    // vertical, and a CHECK ties the two together). This fixture only asserts
    // that the row exists and is active.
    await db.query(
      `INSERT INTO platform_modules (id, key, name, category, band, vertical, "routePrefix", active, "sortOrder", "createdAt", "updatedAt")
       VALUES ('e2e_pharmacy_core', 'pharmacy-core', 'Pharmacy Core', 'Pharmacy', 'PLATFORM', NULL, '/pharmacy', true, 0, now(), now())
       ON CONFLICT (key) DO UPDATE SET active = true, "routePrefix" = '/pharmacy', "updatedAt" = now()`
    );
    await db.query(
      `INSERT INTO platform_packages (id, key, name, vertical, version, active, "defaultSeats", "createdAt", "updatedAt")
       VALUES ('e2e_pharmacy_package', 'e2e-pharmacy-package', 'E2E Pharmacy Package', 'PHARMACY', 1, true, 25, now(), now())
       ON CONFLICT (key) DO UPDATE SET vertical = 'PHARMACY', active = true, "updatedAt" = now()`
    );
    // Joined on the module KEY, never on the fixture's own id: the shipped
    // catalog may already own a `pharmacy-core` row under a different id.
    await db.query(
      `INSERT INTO platform_package_modules (id, "packageId", "moduleId", enabled)
       SELECT 'e2e_pharmacy_package_core', p.id, m.id, true
         FROM platform_packages p JOIN platform_modules m ON m.key = 'pharmacy-core'
        WHERE p.key = 'e2e-pharmacy-package'
       ON CONFLICT ("packageId", "moduleId") DO UPDATE SET enabled = true`
    );
    // A jurisdiction whose rules counsel has confirmed. The migration ships only
    // a provisional Punjab, on which no branch may operate — the form must offer
    // both and the gate must flip only on the confirmed one.
    await db.query(
      `INSERT INTO pharmacy_jurisdiction_rule_sets
         (id, code, version, "effectiveFrom", "licenceCategories", "permittedSchedules",
          "prescriptionOnlyClasses", "prescriptionRetentionDays", "controlledRegisterFlags",
          "pharmacistCoverageRule", "recordRetentionByClass")
       VALUES ($1, 'PK-SD', 1, '2026-01-01T00:00:00.000Z',
         '{"values":["RETAIL","WHOLESALE"],"provisional":false}',
         '{"values":["G","H"],"provisional":false}',
         '{"values":["H"],"provisional":false}',
         '{"values":{"H":1825},"provisional":false}',
         '{"values":{"H":true},"provisional":false}',
         '{"values":{"minimumHoursPerWeek":40},"provisional":false}',
         '{"values":{"prescription":1825},"provisional":false}')
       ON CONFLICT (code, version) DO NOTHING`,
      [CONFIRMED_RULE_SET]
    );
  });
});

/** Every readiness gate row this organization currently has, by gate. */
async function gateStates() {
  return withAdminDatabase(async (db) => {
    const result = await db.query<{ gate: string; status: string; evidenceRef: string | null }>(
      `SELECT gate::text, status::text, "evidenceRef" FROM pharmacy_onboarding_gate_states
        WHERE "organizationId" = (SELECT id FROM organizations WHERE slug = $1)
        ORDER BY gate`,
      [tenant.slug]
    );
    return result.rows;
  });
}

test('a fresh pharmacy fills its regulatory profile, watches the steps flip, and is refused activation until the last one', async ({
  page,
  request,
}) => {
  // One test that walks a whole onboarding: a platform command, a full fixture,
  // a sign-in, two page loads and around thirty interactions. The config's
  // 30s default is a per-*test* budget, and under the dev server each first
  // route compile alone eats several seconds of it.
  test.setTimeout(300_000);

  const unexpectedErrors: string[] = [];
  // Recorded by URL, not by the console's opaque "status of 403" text, so a
  // denial is attributable to the call that produced it.
  const deniedCalls: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400) deniedCalls.push(`${response.status()} ${response.url()}`);
  });
  page.on('pageerror', (error) => unexpectedErrors.push(error.message));

  expect(
    sharedBaseUrl,
    'PLAYWRIGHT_SHARED_BASE_URL is required to sign the created administrator in.'
  ).toBeTruthy();

  // ── Onboarding: SuperAdmin creates the pharmacy organization ───────────────
  await loginPlatformRequest(request);
  const created = await request.post('/api/platform/control', {
    headers: platformMutationHeaders,
    data: {
      action: 'organization.create',
      payload: {
        slug: tenant.slug,
        legalName: tenant.legalName,
        displayName: tenant.displayName,
        vertical: 'PHARMACY',
        deploymentMode: 'SHARED',
        packageId: 'e2e_pharmacy_package',
        timezone: 'Asia/Karachi',
        locale: 'en-US',
        currency: 'PKR',
        primaryContactName: 'Pharmacy Owner',
        primaryContactEmail: tenant.email,
        adminName: 'Pharmacy Owner',
        adminEmail: tenant.email,
        adminPassword: tenant.password,
        // WHA-1206 — the premises of the branch provisioning creates, the same
        // four answers the operator console asks a pharmacy for.
        firstBranchName: tenant.branchName,
        firstBranchAddress: '21 Khayaban-e-Shamsheer',
        firstBranchCity: 'Karachi',
        firstBranchProvinceCode: 'PK-SD',
      },
    },
    failOnStatusCode: false,
  });
  expect(created.status(), await created.text()).toBe(200);

  const organizationId = await withAdminDatabase(async (db) => {
    const row = await db.query<{ id: string }>(`SELECT id FROM organizations WHERE slug = $1`, [
      tenant.slug,
    ]);
    return row.rows[0]!.id;
  });

  // ── WHA-1206 — what `organization.create` provisioned, read back ───────────
  // Both of these used to be seeded here by hand. Asserted rather than created,
  // so the fix stays proven: if provisioning stops writing either one, this test
  // fails at the assertion instead of quietly passing on fixture data.
  const branchId = await withAdminDatabase(async (db) => {
    const roles = await db.query<{ key: string }>(
      `SELECT key FROM organization_roles WHERE "organizationId" = $1 ORDER BY key`,
      [organizationId]
    );
    expect(roles.rows.map((row) => row.key)).toEqual([
      'admin',
      'auditor',
      'cashier',
      'finance',
      'inventory',
      'manager',
      'owner',
      'pharmacist',
      'procurement',
    ]);
    const branches = await db.query<{
      id: string;
      code: string;
      name: string;
      city: string;
      provinceCode: string;
    }>(
      `SELECT id, code, name, city, "provinceCode" FROM pharmacy_branches WHERE "organizationId" = $1`,
      [organizationId]
    );
    expect(branches.rows).toHaveLength(1);
    expect(branches.rows[0]).toMatchObject({
      code: 'MAIN',
      name: tenant.branchName,
      city: 'Karachi',
      provinceCode: 'PK-SD',
    });
    return branches.rows[0]!.id;
  });

  await withAdminDatabase(async (db) => {
    // The base activation gate every vertical shares.
    await db.query(
      `UPDATE organization_deployments SET status='READY'
        WHERE "organizationId"=$1 AND environment='production'`,
      [organizationId]
    );
    // The three evidence gates whose own consoles are other lanes' rows: an
    // authorized supplier, a published medicine catalog, and received opening
    // stock. Seeded as the data those consoles would write.
    await db.query(
      `INSERT INTO pharmacy_suppliers (id,"organizationId",name,authorized,active,"updatedAt")
       VALUES ($1,$2,'Karachi Pharma Distributors',true,true,now())`,
      [`supplier_${suffix}`, organizationId]
    );
    await db.query(
      `INSERT INTO pharmacy_medicines (id,"organizationId","productName","productFamily",otc,saleable,"updatedAt")
       VALUES ($1,$2,'Paracetamol 500mg','PHARMACEUTICAL',true,true,now())`,
      [`medicine_${suffix}`, organizationId]
    );
    await db.query(
      `INSERT INTO pharmacy_presentations (id,"organizationId","medicineId",presentation,"updatedAt")
       VALUES ($1,$2,$3,'Tablet, 500mg',now())`,
      [`presentation_${suffix}`, organizationId, `medicine_${suffix}`]
    );
    await db.query(
      `INSERT INTO pharmacy_pack_levels
         (id,"organizationId","presentationId","versionGroupId",version,level,"unitsPerParent","effectiveFrom")
       VALUES ($1,$2,$3,$1,1,'CARTON',1,'2026-01-01T00:00:00.000Z')`,
      [`pack_${suffix}`, organizationId, `presentation_${suffix}`]
    );
    await db.query(
      `INSERT INTO pharmacy_manufacturing_batches
         (id,"organizationId","medicineId","batchNumber","expiresAt","updatedAt")
       VALUES ($1,$2,$3,'B-2026-01','2027-06-30T00:00:00.000Z',now())`,
      [`mfgbatch_${suffix}`, organizationId, `medicine_${suffix}`]
    );
    await db.query(
      `INSERT INTO pharmacy_medicine_provenance
         (id,"organizationId","medicineId",field,source,"retrievedAt",status,"sourceType","assertedValue",reviewer)
       VALUES ($1,$2,$3,'productName','DRAP register',now(),'ACCEPTED','REGULATOR','"Paracetamol 500mg"',$4)`,
      [`assertion_${suffix}`, organizationId, `medicine_${suffix}`, tenant.email]
    );
    await db.query(
      `INSERT INTO pharmacy_medicine_publication_batches (id,"organizationId",status,"publishedAt")
       VALUES ($1,$2,'PUBLISHED',now())`,
      [`pubbatch_${suffix}`, organizationId]
    );
    await db.query(
      `INSERT INTO pharmacy_medicine_publication_entries (id,"organizationId","batchId","assertionId")
       VALUES ($1,$2,$3,$4)`,
      [`pubentry_${suffix}`, organizationId, `pubbatch_${suffix}`, `assertion_${suffix}`]
    );
    await db.query(
      `INSERT INTO pharmacy_inventory_lots
         (id,"organizationId","branchId","manufacturingBatchId","packLevelId","unitsPerPack",
          "supplierName","supplierInvoiceRef","unitCostMinor","printedMrpMinor",
          "receivedExpiresAt","receivedExpiryPrecision","receivedAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,10,'Karachi Pharma Distributors','INV-1',500,900,
               '2027-06-30T00:00:00.000Z','DAY',now(),now())`,
      [`lot_${suffix}`, organizationId, branchId, `mfgbatch_${suffix}`, `pack_${suffix}`]
    );
  });

  // ── The administrator signs in and reads the checklist ─────────────────────
  await page.goto(`${sharedBaseUrl}/login`);
  await page.getByLabel('Email').fill(tenant.email);
  await page.locator('input[name="password"]').fill(tenant.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/, { timeout: 60_000 });

  // Reached by clicking, not by typing a URL: the nav must actually offer it.
  await page.getByRole('link', { name: 'Onboarding' }).click();
  await expect(page).toHaveURL(/\/pharmacy(?:\?|$)/, { timeout: 60_000 });

  // Scoped to the checklist itself: the activation panel above it renders its
  // own list of blocking steps, so an unscoped `listitem` matches both.
  const checklist = page.locator('[data-slot="readiness-checklist"]');
  const step = (label: string) => checklist.getByRole('listitem').filter({ hasText: label });
  await expect(checklist.getByRole('listitem')).toHaveCount(12);
  // Five steps are already answered from the data the fixture seeded (package,
  // roles, catalog, opening stock, suppliers). Premises and licences is the
  // sixth evidence-backed step and is the one this test fills in; the remaining
  // six are the operator's own confirmations.
  await expect(page.getByText('5/12 done')).toBeVisible();
  await expect(page.getByText('Activation is refused until')).toBeVisible();
  await expect(step('Premises and licences')).toContainText('Needs you');

  // ── The regulatory profile, reached from the step that needs it ────────────
  await step('Premises and licences')
    .getByRole('link', { name: /Open regulatory profile/ })
    .click();
  await expect(page).toHaveURL(/\/pharmacy\/regulatory$/);

  // The branch is a picker over this organization's own records — never an id.
  await expect(page.getByLabel('Which branch is this profile for?')).toHaveValue(
    `branch_${suffix}`
  );
  await expect(page.getByRole('option', { name: /Clifton Chemist/ })).toBeAttached();

  // Punjab's rules are provisional and say so; Sindh's are confirmed.
  await expect(page.getByRole('option', { name: 'Punjab (rules provisional)' })).toBeAttached();
  await page.getByLabel('Province').selectOption('PK-PB');
  await expect(page.getByText('Pending legal review')).toBeVisible();
  await expect(page.getByRole('status')).toContainText(
    'Regulatory profiles can still be recorded, but dispensing and activation remain blocked until confirmed rules and a valid profile are in force.'
  );
  await page.getByLabel('Province').selectOption('PK-SD');
  await expect(page.getByText('Pending legal review')).toHaveCount(0);
  await expect(page.getByLabel('Licence category')).toContainText('RETAIL');

  // A submission missing its evidence is refused ON THE FIELD, not as a banner.
  await page.getByLabel('Licence number').fill('SD-RET-88214');
  await page.getByLabel('Licence valid from').fill('2026-01-01');
  await page.getByLabel('Licence valid to').fill('2028-01-01');
  await page
    .getByLabel('Medicine storage at these premises')
    .fill('Locked controlled-drug cabinet and a monitored cold-chain fridge.');
  await page.getByLabel('Registration number').fill('PC-77410');
  await page.getByLabel('Registered from').fill('2026-01-01');
  await page.getByLabel('Registered to').fill('2028-01-01');
  await page.getByLabel('Coverage roster').fill('Roster 2026-Q3, signed by the superintendent');
  await page.getByRole('button', { name: 'Save this version' }).click();
  await expect(
    page.getByText('Upload a scan or photograph of the licence as evidence.')
  ).toBeVisible();

  await page.setInputFiles('#licenceEvidence', {
    name: 'licence.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 e2e licence evidence'),
  });
  await expect(page.getByText('Licence evidence attached.')).toBeVisible();
  // Each schedule is a real checkbox with its own accessible name, so it is
  // reachable by keyboard and by name — not a div wearing a click handler.
  await page.getByRole('checkbox', { name: 'G', exact: true }).check();
  await page.getByRole('button', { name: 'Save this version' }).click();
  await expect(page.getByText(/^Version 1 saved\./)).toBeVisible();
  await expect(
    page.getByText('Premises and licences is now marked done on your setup steps.')
  ).toBeVisible();

  // The record is effective-dated, and version 1 is in force.
  const history = page.getByRole('table');
  await expect(history.getByRole('row')).toHaveCount(2);
  await expect(history.getByText('In force')).toBeVisible();
  await expect(history.getByText('SD-RET-88214')).toBeVisible();

  // ── Back on the checklist: the licences step flipped ───────────────────────
  await page.getByRole('link', { name: 'Back to your setup steps' }).first().click();
  await expect(page).toHaveURL(/\/pharmacy$/);
  await expect(page.getByText('6/12 done')).toBeVisible();
  await expect(step('Premises and licences')).toContainText('Done');

  // ── The operator's own confirmations, all but the last ────────────────────
  for (const label of ATTESTED_STEPS.filter((step) => step !== LAST_STEP)) {
    const row = step(label);
    await row.getByRole('button', { name: 'Confirm this step' }).click();
    await row
      .getByLabel('Where is the evidence recorded?')
      .fill(`Board minute 2026-09-02 — ${label}`);
    await row.getByRole('button', { name: 'Mark as done' }).click();
    await expect(page.getByText(`“${label}” is recorded as done.`)).toBeVisible();
  }
  await expect(page.getByText('11/12 done')).toBeVisible();
  await expect(
    page.getByText(`Activation is refused until this step is done: ${LAST_STEP}.`)
  ).toBeVisible();

  // ── Activation is refused, naming the step, while one remains ─────────────
  const refused = await request.post('/api/platform/control', {
    headers: platformMutationHeaders,
    data: {
      action: 'organization.transition',
      payload: {
        id: organizationId,
        status: 'ACTIVE',
        reason: 'E2E activation attempt with one readiness step outstanding',
      },
    },
    failOnStatusCode: false,
  });
  expect(refused.status()).toBe(400);
  expect(await refused.text()).toContain('READINESS_AND_PARALLEL_RUN');
  await withAdminDatabase(async (db) => {
    const status = await db.query<{ status: string }>(
      `SELECT status FROM organizations WHERE id = $1`,
      [organizationId]
    );
    expect(status.rows).toEqual([{ status: 'ONBOARDING' }]);
  });

  // ── The last step, then activation succeeds ───────────────────────────────
  const lastRow = step(LAST_STEP);
  await lastRow.getByRole('button', { name: 'Confirm this step' }).click();
  await lastRow
    .getByLabel('Where is the evidence recorded?')
    .fill('Parallel run signed off 2026-09-02');
  await lastRow.getByRole('button', { name: 'Mark as done' }).click();
  await expect(page.getByText('12/12 done')).toBeVisible();
  await expect(
    page.getByText('Every readiness step is done. This pharmacy can be activated.')
  ).toBeVisible();

  // Every attestation carries its evidence and the actor who recorded it —
  // "seed data cannot fake readiness" is a stored property, not a UI one.
  const gates = await gateStates();
  expect(gates).toHaveLength(6);
  for (const gate of gates) {
    expect(gate.status).toBe('PASSED');
    expect(gate.evidenceRef?.length ?? 0).toBeGreaterThan(0);
  }

  const activated = await request.post('/api/platform/control', {
    headers: platformMutationHeaders,
    data: {
      action: 'organization.transition',
      payload: {
        id: organizationId,
        status: 'ACTIVE',
        reason: 'E2E activation once every pharmacy readiness step passed',
      },
    },
    failOnStatusCode: false,
  });
  expect(activated.status(), await activated.text()).toBe(200);
  await withAdminDatabase(async (db) => {
    const status = await db.query<{ status: string }>(
      `SELECT status FROM organizations WHERE id = $1`,
      [organizationId]
    );
    expect(status.rows).toEqual([{ status: 'ACTIVE' }]);
  });

  expect(unexpectedErrors).toEqual([]);
  // Exactly one denial is accounted for, and nothing else may be: the deliberate
  // submit with no licence evidence attached, which the form is supposed to
  // reject on the field.
  const unexplained = deniedCalls.filter((call) => !/^400 .*saveRegulatoryProfile/.test(call));
  expect(unexplained).toEqual([]);
  // WHA-1207 — the shared topbar bell used to issue `team.getNotifications` on
  // every workspace regardless of vertical, and a pharmacy package does not
  // license the `hr` module that procedure gates on, so it answered 403 on every
  // page load. UX rule 17: a 403 is definitive, so the bell now gates the query
  // on the same licence the server checks and the call is never made at all.
  // Asserted separately from `unexplained` so a regression names itself.
  const notificationDenials = deniedCalls.filter((call) => call.includes('team.getNotifications'));
  expect(notificationDenials).toEqual([]);
});
