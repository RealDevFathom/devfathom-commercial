/**
 * WHA-1180 — the Lifecycle gate checklist and the shared-host deployment
 * default, end to end.
 *
 * Owner report (staging): "Move to ACTIVE" answered "Activation preflight
 * failed: add ready production deployment." — a precondition with no route to
 * satisfying it, on an organization the shared platform hosts already serve.
 *
 * This drives the whole remedy through the console: an organization with NO
 * deployment record shows the unmet gate as its own checklist row with a link,
 * one click on "Use shared deployment" resolves it, and activation then
 * succeeds. It lives in its own spec file (per the issue) so it can land
 * alongside another lane's addition to platform-control-plane.spec.ts without
 * either lane touching the other's file.
 */
import { expect, test } from '@playwright/test';
import {
  controlPlaneEnvironmentAvailable,
  loginPlatform,
  withAdminDatabase,
} from './fixtures/platform-control-plane';

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1440, height: 900 } });
test.skip(
  !controlPlaneEnvironmentAvailable(),
  'Requires a fresh test/e2e PostgreSQL database, restricted DATABASE_URL, admin setup URL, and seeded platform admin email/password.'
);

const agency = {
  slug: 'e2e-agency-activation-gate',
  displayName: 'E2E Agency Activation',
  legalName: 'E2E Agency Activation Limited',
  email: 'agency-activation@e2e.invalid',
  password: 'Local-only-agency-42!',
  packageLabel: 'E2E Activation Gate Package · 25 default seats',
};

/**
 * An AGENCY package and module of its own, so the onboarding form has a
 * deterministic choice and the enabled-module gate is satisfied by the package
 * baseline. AGENCY is deliberate: its preflight is exactly the four base gates,
 * with none of the restaurant readiness steps in the way of the one under test.
 */
test.beforeAll(async () => {
  await withAdminDatabase(async (db) => {
    await db.query(
      `INSERT INTO platform_modules (id, key, name, category, band, vertical, "routePrefix", active, "sortOrder", "createdAt", "updatedAt")
       VALUES ('e2e_activation_gate_module', 'e2e-activation-gate', 'E2E Activation Gate', 'Delivery', 'VERTICAL_CORE', 'AGENCY', '/projects', true, 0, now(), now())
       ON CONFLICT (key) DO UPDATE SET active = true, vertical = 'AGENCY', "updatedAt" = now()`
    );
    await db.query(
      `INSERT INTO platform_packages (id, key, name, vertical, version, active, "defaultSeats", "createdAt", "updatedAt")
       VALUES ('e2e_activation_gate_package', 'e2e-activation-gate-package', 'E2E Activation Gate Package', 'AGENCY', 1, true, 25, now(), now())
       ON CONFLICT (key) DO UPDATE SET vertical = 'AGENCY', active = true, "defaultSeats" = 25, "updatedAt" = now()`
    );
    await db.query(
      `INSERT INTO platform_package_modules (id, "packageId", "moduleId", enabled)
       VALUES ('e2e_activation_gate_link', 'e2e_activation_gate_package', 'e2e_activation_gate_module', true)
       ON CONFLICT ("packageId", "moduleId") DO UPDATE SET enabled = true`
    );
    await db.query(
      `DELETE FROM organization_lifecycle_events WHERE "organizationId"=(SELECT id FROM organizations WHERE slug=$1)`,
      [agency.slug]
    );
    await db.query(`DELETE FROM organizations WHERE slug = $1`, [agency.slug]);
  });
});

test('activation checklist lists the unmet deployment gate and the shared default resolves it', async ({
  page,
}) => {
  const unexpectedErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('status of 400'))
      unexpectedErrors.push(message.text());
  });
  page.on('pageerror', (error) => unexpectedErrors.push(error.message));
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'request failed';
    if (failure !== 'net::ERR_ABORTED') unexpectedErrors.push(failure);
  });

  await loginPlatform(page);
  await page.goto('/platform/organizations/new');
  await page.getByRole('link', { name: /Continue as Agency/ }).click();
  await page.getByLabel('Display name').fill(agency.displayName);
  await page.getByLabel('Legal name').fill(agency.legalName);
  await page.getByLabel('Workspace slug').fill(agency.slug);
  await page.locator('select[name="packageId"]').selectOption({ label: agency.packageLabel });
  await page.getByLabel('Primary contact', { exact: true }).fill('Agency Owner');
  await page.getByLabel('Primary contact email').fill(agency.email);
  await page.getByLabel('Tenant administrator').fill('Agency Owner');
  await page.getByLabel('Administrator email').fill(agency.email);
  await page.getByLabel('Temporary administrator password').fill(agency.password);
  await page.getByRole('button', { name: 'Create onboarding record' }).click();
  await expect(page).toHaveURL(/\/platform\/organizations\/(?!new(?:[/?]|$))[^/?]+/);

  // Onboarding registers a PENDING production deployment. Removing it puts the
  // organization in exactly the owner-reported state: no deployment record at
  // all, which is the case the shared-host default exists for.
  await withAdminDatabase(async (db) => {
    const removed = await db.query(
      `DELETE FROM organization_deployments
        WHERE "organizationId"=(SELECT id FROM organizations WHERE slug=$1) RETURNING id`,
      [agency.slug]
    );
    expect(removed.rowCount).toBe(1);
  });
  await page.reload();

  // The gate is a checklist row carrying its own link — not one banner string.
  const lifecycle = page.locator('#lifecycle');
  await expect(lifecycle.getByText('Unmet activation gates')).toBeVisible();
  const deploymentGate = lifecycle
    .getByRole('listitem')
    .filter({ hasText: 'Add a ready production deployment.' });
  await expect(deploymentGate).toBeVisible();
  await expect(deploymentGate.getByRole('link', { name: 'Add deployment' })).toHaveAttribute(
    'href',
    /^\/platform\/deployments\?organizationId=.+/
  );
  // Package, modules and administrator all came from onboarding, so the
  // deployment gate is the ONLY row — the checklist reports state, not a fixed list.
  await expect(lifecycle.getByRole('listitem')).toHaveCount(1);

  // One click, on the row that reported the problem.
  await deploymentGate.getByRole('button', { name: 'Use shared deployment' }).click();
  await expect(lifecycle.getByText('Add a ready production deployment.')).toHaveCount(0);
  await expect(lifecycle.getByText('Unmet activation gates')).toHaveCount(0);

  await withAdminDatabase(async (db) => {
    const proof = await db.query<{
      environment: string;
      mode: string;
      status: string;
      url: string;
    }>(
      `SELECT environment, mode, status, url FROM organization_deployments
        WHERE "organizationId"=(SELECT id FROM organizations WHERE slug=$1)`,
      [agency.slug]
    );
    // Exactly one row: the command upserts on (organizationId, environment).
    expect(proof.rows).toHaveLength(1);
    expect(proof.rows[0]).toMatchObject({
      environment: 'production',
      mode: 'SHARED',
      status: 'READY',
    });
    expect(proof.rows[0]?.url).toContain(agency.slug);
    // The action is audited under its own command name.
    const audit = await db.query(
      `SELECT 1 FROM platform_audit_logs
        WHERE action='organization.deployment.shared'
          AND "organizationId"=(SELECT id FROM organizations WHERE slug=$1)`,
      [agency.slug]
    );
    expect(audit.rowCount).toBe(1);
  });

  // The gate it resolved was the only thing standing between here and ACTIVE.
  await page.getByLabel('Move to').selectOption('ACTIVE');
  await page
    .locator('#lifecycle')
    .getByLabel('Reason (required)')
    .fill('E2E activation after shared deployment default');
  await page.getByRole('button', { name: 'Apply lifecycle change' }).click();
  await expect(page.getByText('ACTIVE', { exact: true }).first()).toBeVisible();

  await withAdminDatabase(async (db) => {
    const proof = await db.query<{ status: string }>(
      `SELECT status FROM organizations WHERE slug=$1`,
      [agency.slug]
    );
    expect(proof.rows).toEqual([{ status: 'ACTIVE' }]);
  });

  expect(unexpectedErrors).toEqual([]);
});
