import { expect, test } from '@playwright/test';
import {
  controlPlaneEnvironmentAvailable,
  loginPlatform,
  loginPlatformRequest,
  platformFixture,
  platformMutationHeaders,
  prepareControlPlaneFixture,
  withAdminDatabase,
} from './fixtures/platform-control-plane';

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1440, height: 900 } });
test.skip(
  !controlPlaneEnvironmentAvailable(),
  'Requires a fresh test/e2e PostgreSQL database, restricted DATABASE_URL, admin setup URL, and seeded platform admin.'
);

const routes = [
  ['Control room', '/platform'],
  ['Organizations', '/platform/organizations'],
  ['Deployments', '/platform/deployments'],
  ['Jobs', '/platform/jobs'],
  ['Sales CRM', '/platform/crm'],
  ['Commercial', '/platform/commercial'],
  ['Modules & plans', '/platform/catalog'],
  ['Operators', '/platform/operators'],
  ['Audit ledger', '/platform/audit'],
  ['Platform settings', '/platform/settings'],
] as const;

test.beforeAll(async () => prepareControlPlaneFixture());

test('full administrator can load every declared route and matching navigation', async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await loginPlatform(page);

  for (const [label, href] of routes) {
    const response = await page.goto(href);
    expect(response?.status(), href).toBe(200);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(
      page.getByRole('navigation').getByRole('link', { name: label, exact: true })
    ).toBeVisible();
  }
  expect(browserErrors).toEqual([]);
});

test('restricted operator sees only grants and denied document/data requests fail safely', async ({
  page,
}) => {
  const unexpectedErrors: string[] = [];
  page.on('pageerror', (error) => unexpectedErrors.push(error.message));
  await loginPlatform(page, platformFixture.operator);

  const granted = routes.filter(([, href]) =>
    [
      '/platform/organizations',
      '/platform/deployments',
      '/platform/jobs',
      '/platform/catalog',
    ].includes(href)
  );
  const denied = routes.filter((entry) => !granted.includes(entry));
  for (const [label] of granted) {
    await expect(
      page.getByRole('navigation').getByRole('link', { name: label, exact: true })
    ).toBeVisible();
  }
  for (const [label] of denied) {
    await expect(
      page.getByRole('navigation').getByRole('link', { name: label, exact: true })
    ).toHaveCount(0);
  }

  for (const [, href] of denied) {
    const document = await page.request.get(href, { failOnStatusCode: false, maxRedirects: 0 });
    expect([302, 303, 307, 308, 403]).toContain(document.status());
    expect(document.status()).toBeLessThan(500);
    expect(await document.text()).not.toMatch(/passwordHash|tokenHash|platform_users/);

    const flight = await page.request.get(href, {
      headers: { RSC: '1', 'Next-Router-Prefetch': '1' },
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    expect(flight.status()).toBeLessThan(500);
    expect(await flight.text()).not.toMatch(/passwordHash|tokenHash|platform_users/);
  }
  expect(unexpectedErrors).toEqual([]);
});

test('failure ledger records denial, validation, rollback, success, replay, and redaction', async ({
  request,
}) => {
  const correlation = 'e2e-failure-ledger';
  await loginPlatformRequest(request, platformFixture.operator);
  const denial = await request.post('/api/platform/control', {
    headers: { ...platformMutationHeaders, 'x-devfathom-request-id': `${correlation}-deny` },
    data: {
      action: 'setting.upsert',
      payload: { key: 'e2e.denied', category: 'e2e', value: true },
    },
    failOnStatusCode: false,
  });
  expect(denial.status()).toBe(403);

  await request.delete('/api/platform/session', { headers: platformMutationHeaders });
  await loginPlatformRequest(request);
  const secret = 'password=e2e-secret-never-persist';
  const invalid = await request.post('/api/platform/control', {
    headers: { ...platformMutationHeaders, 'x-devfathom-request-id': `${correlation}-invalid` },
    data: { action: 'setting.upsert', payload: { key: secret, category: 'e2e', value: true } },
    failOnStatusCode: false,
  });
  expect(invalid.status()).toBe(400);

  const successfulPayload = {
    key: 'e2e.ledger.success',
    category: 'e2e',
    value: { enabled: true },
    sensitive: false,
  };
  const success = await request.post('/api/platform/control', {
    headers: { ...platformMutationHeaders, 'x-devfathom-request-id': `${correlation}-success` },
    data: { action: 'setting.upsert', payload: successfulPayload },
  });
  expect(success.status()).toBe(200);

  await withAdminDatabase(async (db) => {
    await db.query(
      `CREATE OR REPLACE FUNCTION e2e_force_setting_rollback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key = 'e2e.rollback' THEN RAISE EXCEPTION 'forced e2e rollback'; END IF; RETURN NEW; END $$`
    );
    await db.query(
      `CREATE TRIGGER e2e_force_setting_rollback BEFORE INSERT OR UPDATE ON platform_settings FOR EACH ROW EXECUTE FUNCTION e2e_force_setting_rollback()`
    );
  });
  try {
    for (let replay = 0; replay < 2; replay += 1) {
      const failed = await request.post('/api/platform/control', {
        headers: {
          ...platformMutationHeaders,
          'x-devfathom-request-id': `${correlation}-rollback`,
        },
        data: {
          action: 'setting.upsert',
          payload: {
            key: 'e2e.rollback',
            category: 'e2e',
            value: { token: secret },
            sensitive: false,
          },
        },
        failOnStatusCode: false,
      });
      expect(failed.status()).toBe(500);
      expect(await failed.text()).not.toContain(secret);
    }
  } finally {
    await withAdminDatabase(async (db) => {
      await db.query('DROP TRIGGER IF EXISTS e2e_force_setting_rollback ON platform_settings');
      await db.query('DROP FUNCTION IF EXISTS e2e_force_setting_rollback()');
    });
  }

  await withAdminDatabase(async (db) => {
    const evidence = await db.query<{
      request_id: string;
      success: boolean | null;
      payload: string;
    }>(
      `SELECT "requestId" AS request_id, success, row_to_json(a)::text AS payload FROM platform_audit_logs a WHERE "requestId" LIKE $1 ORDER BY "requestId"`,
      [`${correlation}-%`]
    );
    const byRequest = new Map(evidence.rows.map((row) => [row.request_id, row]));
    expect(evidence.rows.filter((row) => row.request_id === `${correlation}-deny`)).toHaveLength(1);
    expect(evidence.rows.filter((row) => row.request_id === `${correlation}-invalid`)).toHaveLength(
      1
    );
    expect(
      evidence.rows.filter((row) => row.request_id === `${correlation}-rollback`)
    ).toHaveLength(1);
    expect(evidence.rows.filter((row) => row.request_id === `${correlation}-success`)).toHaveLength(
      1
    );
    expect(byRequest.get(`${correlation}-rollback`)?.success).toBe(false);
    expect(JSON.stringify(evidence.rows)).not.toContain(secret);
    expect(JSON.stringify(evidence.rows)).not.toMatch(/forced e2e rollback|\bat .+\(.+\.ts:/);
  });
});

test('restaurant onboarding reaches ACTIVE and shared-host tenant dashboard', async ({
  page,
  request,
}) => {
  await loginPlatform(page);
  await page.goto('/platform/organizations/new');
  await page.getByRole('link', { name: /Continue as Restaurant/ }).click();
  await page.getByLabel('Display name').fill('E2E Restaurant');
  await page.getByLabel('Legal name').fill('E2E Restaurant Limited');
  await page.getByLabel('Workspace slug').fill(platformFixture.tenant.slug);
  await page.getByLabel('Primary contact').fill('Restaurant Owner');
  await page.getByLabel('Primary contact email').fill(platformFixture.tenant.email);
  await page.getByLabel('Tenant administrator').fill('Restaurant Owner');
  await page.getByLabel('Administrator email').fill(platformFixture.tenant.email);
  await page.getByLabel('Temporary administrator password').fill(platformFixture.tenant.password);
  await page.getByRole('button', { name: 'Create onboarding record' }).click();
  await expect(page).toHaveURL(/\/platform\/organizations\//);
  await page.getByLabel('Move to').selectOption('ACTIVE');
  await page.getByLabel('Operator reason').fill('E2E activation gate');
  await page.getByRole('button', { name: 'Apply lifecycle change' }).click();
  await expect(page.getByText('ACTIVE', { exact: true }).first()).toBeVisible();

  await withAdminDatabase(async (db) => {
    const proof = await db.query<{
      status: string;
      vertical: string;
      branches: number;
      assignments: number;
      departments: number;
      roles: number;
      modules: number;
    }>(
      `SELECT o.status, o.vertical,
        (SELECT count(*)::int FROM restaurant_branches b WHERE b."organizationId"=o.id AND b."isDefault" AND b.active) branches,
        (SELECT count(*)::int FROM restaurant_branch_assignments a WHERE a."organizationId"=o.id) assignments,
        (SELECT count(*)::int FROM organization_departments d WHERE d."organizationId"=o.id) departments,
        (SELECT count(*)::int FROM organization_roles r WHERE r."organizationId"=o.id) roles,
        (SELECT count(*)::int FROM platform_package_modules pm WHERE pm."packageId"=o."packageId" AND pm.enabled) modules
       FROM organizations o JOIN platform_packages p ON p.id=o."packageId"
       WHERE o.slug=$1 AND p.vertical='RESTAURANT'`,
      [platformFixture.tenant.slug]
    );
    expect(proof.rows).toHaveLength(1);
    expect(proof.rows[0]).toMatchObject({
      status: 'ACTIVE',
      vertical: 'RESTAURANT',
      branches: 1,
      assignments: 1,
    });
    expect(proof.rows[0].departments).toBeGreaterThan(0);
    expect(proof.rows[0].roles).toBeGreaterThan(1);
    expect(proof.rows[0].modules).toBeGreaterThan(1);
  });

  const shared = process.env.PLAYWRIGHT_SHARED_BASE_URL;
  test.skip(!shared, 'PLAYWRIGHT_SHARED_BASE_URL is required for shared-host proof.');
  await page.goto(`${shared}/login`);
  await page.getByLabel('Email').fill(platformFixture.tenant.email);
  await page.locator('input[name="password"]').fill(platformFixture.tenant.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/);
  expect(page.url()).not.toMatch(/organizationId|workspace|org_/);

  await request.post(`${shared}/api/login`, {
    headers: { origin: new URL(shared!).origin },
    data: { email: platformFixture.tenant.email, password: platformFixture.tenant.password },
  });
  const forged = await request.post(`${shared}/api/auth/callback/login-intent`, {
    headers: { origin: new URL(shared!).origin },
    form: { organizationId: 'forged-incompatible-selection', redirect: 'false' },
    failOnStatusCode: false,
  });
  expect(forged.status()).toBeLessThan(500);
  expect(await forged.text()).not.toMatch(/organization.*not found|E2E Restaurant/i);
});

test('compact navigation preserves keyboard focus and has no hydration/request errors', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const failures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('requestfailed', (request) =>
    failures.push(request.failure()?.errorText ?? 'request failed')
  );
  await loginPlatform(page);
  await page.getByRole('button', { name: 'Open platform navigation' }).click();
  await expect(page.getByRole('complementary', { name: 'Platform navigation' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Close menu' }).click();
  await expect(page.getByRole('complementary', { name: 'Platform navigation' })).toHaveCount(0);
  expect(failures).toEqual([]);
});
