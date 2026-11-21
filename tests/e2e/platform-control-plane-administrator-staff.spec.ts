import { chooseSelectField, selectFieldNative } from './fixtures/select-field';
import { expect, test } from '@playwright/test';

import {
  controlPlaneEnvironmentAvailable,
  ensureControlPlaneCatalog,
  loginPlatformRequest,
  signInProvisionedTenant,
  platformMutationHeaders,
  resetOrganization,
  withAdminDatabase,
} from './fixtures/platform-control-plane';
import { RESTAURANT_JOB_ROLE_TEMPLATES } from '@/lib/vertical-catalog';

/**
 * WHA-1181 — the administrator SuperAdmin creates for a RESTAURANT organization
 * reached an activated workspace with no `RestaurantStaffProfile`, so
 * `restaurantNotifications.list` answered 403 on every poll while the nav
 * rendered normally.
 *
 * Deliberately a sibling file rather than an edit to
 * `platform-control-plane.spec.ts`: WHA-1178 and WHA-1180 are extending the same
 * scenario concurrently. It is therefore self-contained — its own slug, its own
 * organization, and only the shared commercial catalog in common — so it neither
 * depends on nor disturbs the other file's fixture whichever order they run in.
 */
test.describe.configure({ mode: 'serial' });
test.skip(
  !controlPlaneEnvironmentAvailable(),
  'Requires a fresh test/e2e PostgreSQL database, restricted DATABASE_URL, admin setup URL, and seeded platform admin email/password.'
);

const tenant = {
  slug: 'e2e-restaurant-admin-staff',
  displayName: 'E2E Administrator Staff Diner',
  email: 'admin-staff-owner@e2e.invalid',
  password: 'Local-only-admin-staff-42!',
  branchName: 'Clifton Flagship',
} as const;

const sharedBaseUrl = process.env.PLAYWRIGHT_SHARED_BASE_URL;

test.beforeAll(async () => {
  await ensureControlPlaneCatalog();
  await resetOrganization(tenant.slug);
});

type StaffRow = {
  staff_profile_id: string;
  user_id: string;
  status: string;
  primary_branch_id: string | null;
  default_branch_id: string;
};

/** Every restaurant staff profile linked to this organization's administrator. */
async function administratorStaffProfiles() {
  return withAdminDatabase(async (db) => {
    const result = await db.query<StaffRow>(
      `SELECT s.id AS staff_profile_id, s."userId" AS user_id, s.status::text AS status,
              s."primaryBranchId" AS primary_branch_id,
              (SELECT b.id FROM restaurant_branches b
                WHERE b."organizationId" = o.id AND b."isDefault" AND b.active) AS default_branch_id
         FROM organizations o
         JOIN users u ON u."organizationId" = o.id AND u.email = $2
         LEFT JOIN restaurant_staff_profiles s ON s."userId" = u.id
        WHERE o.slug = $1`,
      [tenant.slug, tenant.email]
    );
    return result.rows.filter((row) => row.staff_profile_id !== null);
  });
}

/** The organization's floor role profiles, by key. */
async function jobRoleKeys() {
  return withAdminDatabase(async (db) => {
    const result = await db.query<{ key: string }>(
      `SELECT r.key FROM restaurant_job_roles r
         JOIN organizations o ON o.id = r."organizationId"
        WHERE o.slug = $1 AND r.active
        ORDER BY r.key`,
      [tenant.slug]
    );
    return result.rows.map((row) => row.key);
  });
}

/**
 * The capabilities the administrator resolves at their branch, split by
 * provenance. WHA-1181 (5): they must be INHERITED FROM ROLE, not a pile of
 * direct exceptions granted one at a time.
 */
async function administratorAccess() {
  return withAdminDatabase(async (db) => {
    const inherited = await db.query<{ capability: string }>(
      `SELECT DISTINCT c.capability
         FROM restaurant_staff_job_roles h
         JOIN restaurant_job_role_capabilities c ON c."jobRoleId" = h."jobRoleId"
         JOIN restaurant_staff_profiles s ON s.id = h."staffProfileId"
         JOIN users u ON u.id = s."userId"
         JOIN organizations o ON o.id = s."organizationId"
        WHERE o.slug = $1 AND u.email = $2`,
      [tenant.slug, tenant.email]
    );
    const direct = await db.query<{ capability: string }>(
      `SELECT g.capability
         FROM restaurant_staff_capability_grants g
         JOIN restaurant_staff_profiles s ON s.id = g."staffProfileId"
         JOIN users u ON u.id = s."userId"
         JOIN organizations o ON o.id = s."organizationId"
        WHERE o.slug = $1 AND u.email = $2`,
      [tenant.slug, tenant.email]
    );
    const roles = await db.query<{ key: string }>(
      `SELECT r.key
         FROM restaurant_staff_job_roles h
         JOIN restaurant_job_roles r ON r.id = h."jobRoleId"
         JOIN restaurant_staff_profiles s ON s.id = h."staffProfileId"
         JOIN users u ON u.id = s."userId"
         JOIN organizations o ON o.id = s."organizationId"
        WHERE o.slug = $1 AND u.email = $2`,
      [tenant.slug, tenant.email]
    );
    return {
      roleKeys: roles.rows.map((row) => row.key),
      inherited: inherited.rows.map((row) => row.capability),
      direct: direct.rows.map((row) => row.capability),
    };
  });
}

/** The organization's kitchen stations, newest last. */
async function kitchenStations() {
  return withAdminDatabase(async (db) => {
    const result = await db.query<{ id: string; name: string; is_default: boolean }>(
      `SELECT st.id, st.name, st."isDefault" AS is_default
         FROM restaurant_kitchen_stations st
         JOIN organizations o ON o.id = st."organizationId"
        WHERE o.slug = $1
        ORDER BY st."createdAt"`,
      [tenant.slug]
    );
    return result.rows;
  });
}

test('the administrator SuperAdmin creates is provisioned a staff profile and is served notifications', async ({
  page,
  request,
}) => {
  await loginPlatformRequest(request);

  // ── Onboarding: the administrator step of `organization.create` ────────────
  const created = await request.post('/api/platform/control', {
    headers: platformMutationHeaders,
    data: {
      action: 'organization.create',
      payload: {
        slug: tenant.slug,
        legalName: 'E2E Administrator Staff Diner Ltd',
        displayName: tenant.displayName,
        vertical: 'RESTAURANT',
        deploymentMode: 'SHARED',
        packageId: 'e2e_restaurant_package',
        timezone: 'Asia/Karachi',
        locale: 'en-US',
        currency: 'PKR',
        primaryContactName: 'Administrator Staff Owner',
        primaryContactEmail: tenant.email,
        adminName: 'Administrator Staff Owner',
        adminEmail: tenant.email,
        adminPassword: tenant.password,
        firstBranchName: tenant.branchName,
        firstBranchAddress: '9 Zamzama Boulevard, Karachi',
        businessDayCutoff: '04:30',
      },
    },
    failOnStatusCode: false,
  });
  expect(created.status(), await created.text()).toBe(200);

  const afterCreate = await administratorStaffProfiles();
  expect(afterCreate).toHaveLength(1);
  expect(afterCreate[0]).toMatchObject({ status: 'ACTIVE' });
  expect(afterCreate[0]!.primary_branch_id).toBe(afterCreate[0]!.default_branch_id);

  // ── Activation: the same provisioning, for an organization created before
  // the onboarding fix. Removing the row reproduces exactly that state, so the
  // assertion after activation is about the activation path and nothing else.
  await withAdminDatabase(async (db) => {
    const removed = await db.query(
      `DELETE FROM restaurant_staff_profiles WHERE id = $1 RETURNING id`,
      [afterCreate[0]!.staff_profile_id]
    );
    expect(removed.rowCount).toBe(1);
    const ready = await db.query(
      `UPDATE organization_deployments SET status='READY'
        WHERE "organizationId"=(SELECT id FROM organizations WHERE slug=$1)
          AND environment='production' RETURNING id`,
      [tenant.slug]
    );
    expect(ready.rowCount).toBe(1);
  });
  expect(await administratorStaffProfiles()).toHaveLength(0);

  const organizationId = await withAdminDatabase(async (db) => {
    const row = await db.query<{ id: string }>(`SELECT id FROM organizations WHERE slug = $1`, [
      tenant.slug,
    ]);
    return row.rows[0]!.id;
  });

  const setup = await request.post('/api/platform/control', {
    headers: platformMutationHeaders,
    data: {
      action: 'organization.restaurant.setup',
      payload: {
        organizationId,
        branchName: tenant.branchName,
        address: '9 Zamzama Boulevard, Karachi',
        timezone: 'Asia/Karachi',
        businessDayCutoff: '04:30',
        taxAcknowledged: true,
        taxPolicyReference: 'tax-policy-v1',
        paymentAcknowledged: true,
        paymentPolicyReference: 'payment-policy-v2',
        deviceAcknowledged: true,
        devicePolicyReference: 'device-policy-v3',
        operatorAcknowledged: true,
        operatorPolicyReference: 'operator-policy-v4',
      },
    },
    failOnStatusCode: false,
  });
  expect(setup.status(), await setup.text()).toBe(200);

  const activated = await request.post('/api/platform/control', {
    headers: platformMutationHeaders,
    data: {
      action: 'organization.transition',
      payload: {
        id: organizationId,
        status: 'ACTIVE',
        reason: 'E2E activation for the administrator staff-profile proof',
      },
    },
    failOnStatusCode: false,
  });
  expect(activated.status(), await activated.text()).toBe(200);

  const afterActivation = await administratorStaffProfiles();
  expect(afterActivation).toHaveLength(1);
  expect(afterActivation[0]).toMatchObject({ status: 'ACTIVE' });
  expect(afterActivation[0]!.primary_branch_id).toBe(afterActivation[0]!.default_branch_id);

  // ── WHA-1181 (5): role profiles exist, and the administrator holds owner ───
  //
  // The owner's follow-up: the role-profile dialog read "No active role profiles
  // exist", so every capability had to be granted as a DIRECT exception.
  expect(await jobRoleKeys()).toEqual(
    [...RESTAURANT_JOB_ROLE_TEMPLATES].map((role) => role.key).sort()
  );

  const access = await administratorAccess();
  expect(access.roleKeys).toEqual(['owner']);
  // Every capability the owner template names resolves through the role. The
  // direct-exception layer stays empty: nothing was granted one at a time.
  const ownerTemplate = RESTAURANT_JOB_ROLE_TEMPLATES.find((role) => role.key === 'owner')!;
  expect([...access.inherited].sort()).toEqual([...ownerTemplate.capabilities].sort());
  expect(access.direct).toEqual([]);

  // ── WHA-1181 (9a): the branch has the default station a KDS needs ──────────
  const stations = await kitchenStations();
  expect(stations).toHaveLength(1);
  expect(stations[0]).toMatchObject({ name: 'Kitchen', is_default: true });

  // Kitchen stations live behind the POS module, and the fixture package
  // licenses only Restaurant Core and Menu. Enable it the way an operator would,
  // so the enrollment scenario at the end of this test is the real one rather
  // than a permission failure dressed up as an empty branch.
  const posModuleId = await withAdminDatabase(async (db) => {
    const row = await db.query<{ id: string }>(
      `SELECT id FROM platform_modules WHERE key = 'restaurant-pos'`
    );
    return row.rows[0]!.id;
  });
  const licensed = await request.post('/api/platform/control', {
    headers: platformMutationHeaders,
    data: {
      action: 'organization.module',
      payload: {
        organizationId,
        moduleId: posModuleId,
        status: 'ENABLED',
        reason: 'E2E kitchen-display enrollment needs Restaurant POS',
      },
    },
    failOnStatusCode: false,
  });
  expect(licensed.status(), await licensed.text()).toBe(200);

  // …and the device cap the enrollment path enforces, which the fixture package
  // does not carry either. Both are ordinary operator commands, set here rather
  // than in the shared fixture so the sibling control-plane specs are untouched.
  const capped = await request.post('/api/platform/control', {
    headers: platformMutationHeaders,
    data: {
      action: 'organization.limit',
      payload: {
        organizationId,
        key: 'pos.registeredDevices.max',
        value: 25,
        source: 'CONTRACT',
      },
    },
    failOnStatusCode: false,
  });
  expect(capped.status(), await capped.text()).toBe(200);

  // ── The owner-reported symptom: the created administrator signs in and the
  // notification poll is served rather than denied.
  expect(
    sharedBaseUrl,
    'PLAYWRIGHT_SHARED_BASE_URL is required to sign the created administrator in.'
  ).toBeTruthy();

  const notificationCalls: number[] = [];
  page.on('response', (response) => {
    if (response.url().includes('restaurantNotifications.list')) {
      notificationCalls.push(response.status());
    }
  });

  await signInProvisionedTenant(page, sharedBaseUrl!, tenant, /\/restaurant\/orders(?:[/?]|$)/);

  // The topbar bell is what issues the poll. Poll the responses the listener
  // above already collected rather than `waitForResponse`: the query fires on
  // mount, so a wait registered after the bell is visible can start AFTER the
  // only response has arrived — and `staleTime` means no second one is coming.
  await expect(page.getByRole('button', { name: /^Notifications/ })).toBeVisible();
  await expect.poll(() => notificationCalls.length, { timeout: 30_000 }).toBeGreaterThan(0);

  // Served, not denied. The exact retry policy is pinned deterministically in
  // src/lib/trpc-provider.test.ts; what this asserts is the reported symptom —
  // every poll succeeds, and one page load never becomes a burst of them.
  expect(notificationCalls.filter((status) => status !== 200)).toEqual([]);
  expect(notificationCalls.length).toBeLessThan(3);
  await expect(page.getByText('Set up your staff profile')).toHaveCount(0);

  // ── WHA-1181 (9b): a kitchen display enrolls with no station pre-created ───
  //
  // The owner's report: Device kind "Kitchen display" required a station, the
  // select was empty, and the form dead-ended on the browser's native "Please
  // select an item in the list". Nobody created a station here — the one this
  // picks is the one activation provisioned.
  await page.goto(`${sharedBaseUrl}/restaurant/devices`);
  await page.getByRole('button', { name: 'Enroll device' }).click();
  const enrollDialog = page.getByRole('dialog', { name: 'Enroll this browser' });
  await expect(enrollDialog).toBeVisible();

  // The station field belongs to a kitchen display only.
  await expect(enrollDialog.getByText('KDS station')).toHaveCount(0);

  // `RestaurantBranchSelect` decorates the option text ("Clifton Flagship ·
  // MAIN (default)"), and `selectOption({ label })` is an EXACT match — so the
  // value is read off the option rather than guessing at the presentation.
  const branchSelect = enrollDialog.getByRole('combobox', { name: 'Branch', exact: true });
  const branchValue = await (
    await selectFieldNative(branchSelect)
  )
    .locator('option', { hasText: tenant.branchName })
    .getAttribute('value');
  expect(branchValue, 'the default branch must be offered to the administrator').toBeTruthy();
  await chooseSelectField(branchSelect, branchValue!);
  await enrollDialog.getByLabel('Device kind').selectOption('KDS');

  const stationSelect = enrollDialog.getByLabel('KDS station');
  await expect(stationSelect).toBeVisible();
  await expect(stationSelect.locator('option', { hasText: 'Kitchen' })).toHaveCount(1);
  // The empty-state copy must NOT be here: activation left a real station.
  await expect(enrollDialog.getByRole('button', { name: 'Create station' })).toHaveCount(0);

  // Submitting without choosing raises the form's own message rather than the
  // browser tooltip, which no assertion could ever have reached.
  await enrollDialog.getByLabel('Device name').fill('Pass-through display');
  await enrollDialog.getByRole('checkbox').check();
  await enrollDialog.getByRole('button', { name: 'Enroll this browser' }).click();
  await expect(enrollDialog.getByRole('alert')).toHaveText(
    'Choose the KDS station this display shows tickets for.'
  );

  await stationSelect.selectOption({ label: 'Kitchen' });
  await expect(enrollDialog.getByRole('alert')).toHaveCount(0);
  await enrollDialog.getByRole('button', { name: 'Enroll this browser' }).click();

  // Enrollment ends the administrator session and turns this browser into the
  // terminal, so nothing may follow it in this test. A kitchen display lands on
  // the KDS rail (`/kds`); a POS register would land on `/pos`.
  await expect(page).toHaveURL(/\/kds$/, { timeout: 30_000 });
  const enrolled = await withAdminDatabase(async (db) => {
    const result = await db.query<{ kind: string; station_name: string | null }>(
      `SELECT d.kind::text AS kind, st.name AS station_name
         FROM restaurant_registered_devices d
         LEFT JOIN restaurant_kitchen_stations st ON st.id = d."stationId"
         JOIN organizations o ON o.id = d."organizationId"
        WHERE o.slug = $1 AND d.name = 'Pass-through display'`,
      [tenant.slug]
    );
    return result.rows;
  });
  expect(enrolled).toEqual([{ kind: 'KDS', station_name: 'Kitchen' }]);
});
