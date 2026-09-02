import { expect, test } from '@playwright/test';

import {
  controlPlaneEnvironmentAvailable,
  ensureControlPlaneCatalog,
  loginPlatformRequest,
  platformMutationHeaders,
  resetOrganization,
  withAdminDatabase,
} from './fixtures/platform-control-plane';

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

  await page.goto(`${sharedBaseUrl}/login`);
  await page.getByLabel('Email').fill(tenant.email);
  await page.locator('input[name="password"]').fill(tenant.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/);

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
});
