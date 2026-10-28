import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import {
  controlPlaneEnvironmentAvailable,
  loginPlatform,
  loginPlatformRequest,
  platformFixture,
  platformMutationHeaders,
  prepareControlPlaneFixture,
  signInProvisionedTenant,
  withAdminDatabase,
} from './fixtures/platform-control-plane';

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1440, height: 900 } });
test.skip(
  !controlPlaneEnvironmentAvailable(),
  'Requires a fresh test/e2e PostgreSQL database, restricted DATABASE_URL, admin setup URL, and seeded platform admin email/password.'
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
const navigationName = (label: string) =>
  new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const sharedBaseUrl = process.env.PLAYWRIGHT_SHARED_BASE_URL;
const fixtureIdentity =
  /E2E Restaurant|e2e-restaurant-control-plane|restaurant-owner@e2e\.invalid|E2E Platform Operator|platform-operator@e2e\.invalid/i;

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
      page.getByRole('navigation').getByRole('link', { name: navigationName(label) })
    ).toBeVisible();
  }
  expect(browserErrors).toEqual([]);
});

for (const theme of ['light', 'dark'] as const) {
  test(`CRM scroll regions support keyboard access and axe in ${theme} theme`, async ({
    page,
  }, testInfo) => {
    const browserErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text());
    });
    page.on('pageerror', (error) => browserErrors.push(error.message));

    // The six board columns and the 700px Leads table overflow even an empty
    // disposable fixture at this viewport. No extra CRM records are needed.
    await page.setViewportSize({ width: 375, height: 812 });
    await loginPlatform(page);
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', /^(light|dark)$/);
    if ((await html.getAttribute('data-theme')) !== theme) {
      await page
        .getByRole('button', { name: theme === 'dark' ? 'Use dark theme' : 'Use light theme' })
        .click();
    }
    await expect(html).toHaveAttribute('data-theme', theme);
    const response = await page.goto('/platform/crm');
    expect(response?.status(), `CRM document in ${theme} theme`).toBe(200);
    await expect(page.getByRole('heading', { name: 'Sales command', exact: true })).toBeVisible();
    await expect(html).toHaveAttribute('data-theme', theme);

    for (const name of ['Opportunity board', 'Leads'] as const) {
      await test.step(`${name}: overflow, Tab, focus ring, scrolling and axe (${theme})`, async () => {
        const region = page.getByRole('region', { name, exact: true });
        const context = `${name} (${theme})`;
        await expect(region, context).toHaveCount(1);
        await expect(region, context).toBeVisible();
        await expect(region, context).toHaveAttribute('tabindex', '0');
        const headingId = await page.getByRole('heading', { name, exact: true }).getAttribute('id');
        expect(headingId, `${context}: visible heading has an ID`).toBeTruthy();
        await expect(region, context).toHaveAttribute('aria-labelledby', headingId!);
        await expect(region, context).toHaveCSS('overflow-x', 'auto');
        await expect
          .poll(() => region.evaluate((element) => element.scrollWidth - element.clientWidth), {
            message: `${context}: the named region must actually overflow horizontally`,
          })
          .toBeGreaterThan(0);

        const restingShadow = await region.evaluate(
          (element) => getComputedStyle(element).boxShadow
        );
        // An upper bound based on this document's potential Tab stops allows
        // changing fixture content without depending on its order or row IDs.
        const tabBudget =
          (await page
            .locator('a[href], button, input, select, textarea, summary, [tabindex]')
            .count()) + 2;
        let reached = false;
        for (let presses = 0; presses < tabBudget; presses += 1) {
          await page.keyboard.press('Tab');
          if (await region.evaluate((element) => document.activeElement === element)) {
            reached = true;
            break;
          }
        }
        expect(reached, `${context}: real Tab traversal exhausted ${tabBudget} presses`).toBe(true);
        await expect(region, context).toBeFocused();
        expect(await region.evaluate((element) => element.matches(':focus-visible')), context).toBe(
          true
        );
        await expect(region, context).toHaveClass(/\bfocus-visible:ring-2\b/);
        await expect(region, context).toHaveClass(/\bfocus-visible:ring-ring\b/);
        await expect
          .poll(() => region.evaluate((element) => getComputedStyle(element).boxShadow), {
            message: `${context}: keyboard focus must render the semantic ring`,
          })
          .not.toBe(restingShadow);
        await expect(region, context).not.toHaveCSS('box-shadow', 'none');

        // Tab may reveal a descendant while traversing the board. Choose the
        // arrow with room to scroll, and measure this region rather than main.
        const before = await region.evaluate((element) => ({
          left: element.scrollLeft,
          max: element.scrollWidth - element.clientWidth,
        }));
        const direction = before.left < before.max / 2 ? 1 : -1;
        await page.keyboard.press(direction === 1 ? 'ArrowRight' : 'ArrowLeft');
        await expect
          .poll(() => region.evaluate((element) => element.scrollLeft), {
            message: `${context}: arrow key must scroll the focused region`,
          })
          [direction === 1 ? 'toBeGreaterThan' : 'toBeLessThan'](before.left);
        await expect(region, context).toBeFocused();
        await testInfo.attach(`${name}-${theme}-keyboard-focus`, {
          body: await page.screenshot(),
          contentType: 'image/png',
        });

        const results = await new AxeBuilder({ page })
          .include(`[role="region"][aria-labelledby="${headingId}"]`)
          .withRules(['scrollable-region-focusable'])
          .analyze();
        expect(results.violations, `${context}: ${JSON.stringify(results.violations)}`).toEqual([]);
        expect(results.incomplete, `${context}: axe needs a conclusive result`).toEqual([]);
        expect(
          results.passes.map((result) => result.id),
          `${context}: rule was exercised`
        ).toContain('scrollable-region-focusable');
      });
    }
    expect(browserErrors, `CRM browser errors in ${theme} theme`).toEqual([]);
  });
}

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
      page.getByRole('navigation').getByRole('link', { name: navigationName(label) })
    ).toBeVisible();
  }
  for (const [, href] of granted) {
    const response = await page.goto(href);
    expect(response?.status(), href).toBe(200);
    await expect(page.getByRole('main')).toBeVisible();
  }
  for (const [label] of denied) {
    await expect(
      page.getByRole('navigation').getByRole('link', { name: navigationName(label) })
    ).toHaveCount(0);
  }

  for (const [, href] of denied) {
    const document = await page.request.get(href, { failOnStatusCode: false, maxRedirects: 0 });
    expect([302, 303, 307, 308, 403]).toContain(document.status());
    const documentBody = await document.text();
    expect(documentBody).not.toMatch(/passwordHash|tokenHash|platform_users/);
    expect(documentBody).not.toMatch(fixtureIdentity);

    const flight = await page.request.get(href, {
      headers: { RSC: '1', 'Next-Router-Prefetch': '1' },
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    expect([200, 302, 303, 307, 308, 403]).toContain(flight.status());
    const flightBody = await flight.text();
    expect(flightBody).not.toMatch(/passwordHash|tokenHash|platform_users/);
    expect(flightBody).not.toMatch(fixtureIdentity);
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
    const failureRequestId = (suffix: string) =>
      `pcorr_${createHash('sha256').update(`${correlation}-${suffix}`).digest('hex').slice(0, 32)}`;
    const denyRequestId = failureRequestId('deny');
    const invalidRequestId = failureRequestId('invalid');
    const rollbackRequestId = failureRequestId('rollback');
    const successRequestId = `${correlation}-success`;
    const evidence = await db.query<{
      request_id: string;
      success: boolean | null;
      payload: string;
    }>(
      `SELECT "requestId" AS request_id, success, row_to_json(a)::text AS payload FROM platform_audit_logs a WHERE "requestId" = ANY($1::text[]) ORDER BY "requestId"`,
      [[denyRequestId, invalidRequestId, rollbackRequestId, successRequestId]]
    );
    const byRequest = new Map(evidence.rows.map((row) => [row.request_id, row]));
    expect(evidence.rows.filter((row) => row.request_id === denyRequestId)).toHaveLength(1);
    expect(evidence.rows.filter((row) => row.request_id === invalidRequestId)).toHaveLength(1);
    expect(evidence.rows.filter((row) => row.request_id === rollbackRequestId)).toHaveLength(1);
    expect(evidence.rows.filter((row) => row.request_id === successRequestId)).toHaveLength(1);
    expect(byRequest.get(rollbackRequestId)?.success).toBe(false);
    expect(byRequest.get(denyRequestId)?.success).toBe(false);
    expect(byRequest.get(invalidRequestId)?.success).toBe(false);
    expect(byRequest.get(successRequestId)?.success).toBe(true);
    expect(JSON.stringify(evidence.rows)).not.toContain(secret);
    expect(JSON.stringify(evidence.rows)).not.toMatch(/forced e2e rollback|\bat .+\(.+\.ts:/);
  });
});

test('restaurant onboarding time field exposes the HH:MM input contract', async ({ page }) => {
  await loginPlatform(page);
  await page.goto('/platform/organizations/new');
  await page.getByRole('link', { name: /Continue as Restaurant/ }).click();

  const cutoff = page.locator('input[name="businessDayCutoff"]');
  await expect(cutoff).toHaveAttribute('placeholder', 'HH:MM');
  await expect(cutoff).toHaveAttribute('inputmode', 'numeric');
  await expect(cutoff).toHaveAttribute('maxlength', '5');
});

test('restaurant onboarding reaches ACTIVE', async ({ page }) => {
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
  await page.getByRole('link', { name: /Continue as Restaurant/ }).click();
  await page.getByLabel('Display name').fill('E2E Restaurant');
  await page.getByLabel('Legal name').fill('E2E Restaurant Limited');
  await page.getByLabel('Workspace slug').fill(platformFixture.tenant.slug);
  const timezone = page.getByRole('button', { name: 'Timezone', exact: true });
  await expect(timezone).toHaveText('Asia/Karachi');
  await page.getByLabel('First branch name').fill('Gulberg Flagship');
  await page.getByLabel('First branch address').fill('42 Main Boulevard, Lahore');
  await page.getByLabel('Primary contact', { exact: true }).fill('Restaurant Owner');
  await page.getByLabel('Primary contact email').fill(platformFixture.tenant.email);
  await page.getByLabel('Tenant administrator').fill('Restaurant Owner');
  await page.getByLabel('Administrator email').fill(platformFixture.tenant.email);
  await page.getByLabel('Temporary administrator password').fill(platformFixture.tenant.password);
  const onboardingCutoff = page.locator('input[name="businessDayCutoff"]');
  await expect(onboardingCutoff).toHaveAttribute('placeholder', 'HH:MM');
  await onboardingCutoff.fill('24:30');
  await page.getByRole('button', { name: 'Create onboarding record' }).click();
  await expect(page.getByTestId('platform-field-error-businessDayCutoff')).toHaveText(
    'Use 24-hour time, e.g. 09:30'
  );
  await expect(onboardingCutoff).toBeFocused();
  await onboardingCutoff.fill('04:30');
  let injectInvalidTimezone = true;
  await page.route('**/api/platform/control', async (route) => {
    const request = route.request();
    const body = request.postDataJSON() as {
      action?: string;
      payload?: Record<string, unknown>;
    };
    if (injectInvalidTimezone && body.action === 'organization.create' && body.payload) {
      injectInvalidTimezone = false;
      body.payload.timezone = 'Karachi-ish';
      await route.continue({ postData: JSON.stringify(body) });
      return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Create onboarding record' }).click();
  await expect(page.getByText('Choose a valid IANA timezone.')).toBeVisible();
  await expect(timezone).toBeFocused();
  await timezone.click();
  await page.getByPlaceholder('Search city or IANA timezone…').fill('Asia/Karachi');
  await page.getByRole('option', { name: 'Asia/Karachi', exact: true }).click();
  await expect(timezone).toHaveText('Asia/Karachi');
  await page.getByRole('button', { name: 'Create onboarding record' }).click();
  await expect(page).toHaveURL(/\/platform\/organizations\/(?!new(?:[/?]|$))[^/?]+/);
  await withAdminDatabase(async (db) => {
    const ready = await db.query(
      `UPDATE organization_deployments SET status='READY'
        WHERE "organizationId"=(SELECT id FROM organizations WHERE slug=$1)
          AND environment='production' RETURNING id`,
      [platformFixture.tenant.slug]
    );
    expect(ready.rowCount).toBe(1);
  });
  await page.getByLabel('Move to').selectOption('ACTIVE');
  await page
    .locator('#lifecycle')
    .getByLabel('Reason (required)')
    .fill('E2E activation denied before setup');
  await page.getByRole('button', { name: 'Apply lifecycle change' }).click();
  await expect(page.getByText('Activation preflight failed:', { exact: false })).toBeVisible();
  await expect(page.getByText('ONBOARDING', { exact: true }).first()).toBeVisible();

  for (const [kind, reference] of [
    ['Tax', 'tax-policy-v1'],
    ['Payment', 'payment-policy-v2'],
    ['Device', 'device-policy-v3'],
    ['Operator', 'operator-policy-v4'],
  ] as const) {
    const key = kind.toLowerCase();
    await expect(page.getByText(`${kind} policy reference`, { exact: true })).toBeVisible();
    await page.locator(`input[name="${key}PolicyReference"]`).fill(reference);
    const acknowledgement = page.locator(`input[name="${key}Acknowledged"]`);
    await acknowledgement.focus();
    await expect(acknowledgement).toBeFocused();
    await page.keyboard.press('Space');
    await expect(acknowledgement).toBeChecked();
  }
  await page.getByRole('button', { name: 'Save Restaurant readiness' }).click();
  await expect(page.locator('input[name="taxPolicyReference"]')).toHaveValue('tax-policy-v1');

  await page.getByLabel('Move to').selectOption('ACTIVE');
  await page
    .locator('#lifecycle')
    .getByLabel('Reason (required)')
    .fill('E2E activation after Restaurant setup');
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
      branch_name: string;
      address: string;
      timezone: string;
      cutoff: string;
      acknowledgements: number;
      acknowledgement_actors: number;
      acknowledgement_timestamps: number;
    }>(
      `SELECT o.status, o.vertical,
        (SELECT count(*)::int FROM restaurant_branches b WHERE b."organizationId"=o.id AND b."isDefault" AND b.active) branches,
        (SELECT count(*)::int FROM restaurant_branch_assignments a WHERE a."organizationId"=o.id) assignments,
        (SELECT count(*)::int FROM organization_departments d WHERE d."organizationId"=o.id) departments,
        (SELECT count(*)::int FROM organization_roles r WHERE r."organizationId"=o.id) roles,
        (SELECT count(*)::int FROM platform_package_modules pm WHERE pm."packageId"=o."packageId" AND pm.enabled) modules,
        (SELECT b.name FROM restaurant_branches b WHERE b."organizationId"=o.id AND b."isDefault" AND b.active) branch_name,
        (SELECT b.address FROM restaurant_branches b WHERE b."organizationId"=o.id AND b."isDefault" AND b.active) address,
        (SELECT b.timezone FROM restaurant_branches b WHERE b."organizationId"=o.id AND b."isDefault" AND b.active) timezone,
        (SELECT b."businessDayCutoff" FROM restaurant_branches b WHERE b."organizationId"=o.id AND b."isDefault" AND b.active) cutoff,
        (SELECT count(*)::int FROM restaurant_activation_acknowledgements a WHERE a."organizationId"=o.id) acknowledgements,
        (SELECT count(DISTINCT a."acknowledgedById")::int FROM restaurant_activation_acknowledgements a WHERE a."organizationId"=o.id) acknowledgement_actors,
        (SELECT count(*)::int FROM restaurant_activation_acknowledgements a WHERE a."organizationId"=o.id AND a."acknowledgedAt" IS NOT NULL) acknowledgement_timestamps
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
      branch_name: 'Gulberg Flagship',
      address: '42 Main Boulevard, Lahore',
      timezone: 'Asia/Karachi',
      cutoff: '04:30',
      acknowledgements: 4,
      acknowledgement_actors: 1,
      acknowledgement_timestamps: 4,
    });
    expect(proof.rows[0].departments).toBeGreaterThan(0);
    expect(proof.rows[0].roles).toBeGreaterThan(1);
    expect(proof.rows[0].modules).toBeGreaterThan(1);
  });
  expect(unexpectedErrors).toEqual([]);
});

test('agency onboarding exposes no Restaurant setup fields', async ({ page }) => {
  await loginPlatform(page);
  await page.goto('/platform/organizations/new');
  await page.getByRole('link', { name: /Continue as Agency/ }).click();
  await expect(page.getByLabel('First branch name')).toHaveCount(0);
  await expect(page.getByLabel('First branch address')).toHaveCount(0);
  await expect(page.getByLabel('Business-day cutoff')).toHaveCount(0);
  await expect(page.getByText('Restaurant readiness')).toHaveCount(0);
});

test('shared-host login succeeds and forged tenant selection is generic', async ({ browser }) => {
  test.skip(!sharedBaseUrl, 'PLAYWRIGHT_SHARED_BASE_URL is required before shared-host proof.');

  const loginContext = await browser.newContext();
  const page = await loginContext.newPage();
  const tenantPassword = await signInProvisionedTenant(
    page,
    sharedBaseUrl!,
    platformFixture.tenant
  );
  expect(page.url()).not.toMatch(/organizationId|workspace|org_/);

  await page.goto(`${sharedBaseUrl}/restaurant/staff`);
  await page.getByRole('button', { name: 'Add staff member' }).click();
  const branchOptions = page.locator('#staff-primary-branch option');
  const userOptions = page.locator('#staff-organization-user option');
  await expect(branchOptions).toHaveCount(2);
  await expect(userOptions).toHaveCount(2);
  await expect(branchOptions.nth(1)).toContainText('Gulberg Flagship');
  await expect(userOptions.nth(1)).toContainText(platformFixture.tenant.email);
  await loginContext.close();

  const forgedContext = await browser.newContext({ baseURL: sharedBaseUrl });
  const intent = await forgedContext.request.post('/api/login', {
    headers: { origin: new URL(sharedBaseUrl!).origin },
    data: { email: platformFixture.tenant.email, password: tenantPassword },
  });
  expect(intent.ok()).toBe(true);
  const forged = await forgedContext.request.post('/api/auth/callback/login-intent', {
    headers: { origin: new URL(sharedBaseUrl!).origin },
    form: { organizationId: 'forged-incompatible-selection', redirect: 'false' },
    failOnStatusCode: false,
  });
  expect(forged.status()).toBeLessThan(500);
  const forgedBody = await forged.text();
  expect(forgedBody).not.toMatch(/organization.*not found|E2E Restaurant/i);
  expect(forgedBody).not.toMatch(fixtureIdentity);
  const forgedCookies = (await forgedContext.storageState()).cookies.map((cookie) => cookie.name);
  expect(forgedCookies).not.toContain('authjs.session-token');
  expect(forgedCookies).not.toContain('__Secure-authjs.session-token');
  const forgedPage = await forgedContext.newPage();
  await forgedPage.goto('/dashboard');
  await expect(forgedPage).not.toHaveURL(/\/dashboard(?:\?|$)/);
  await forgedContext.close();
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
  page.on('requestfailed', (request) => {
    // Closing the drawer unmounts its links, so Chromium cancels the RSC
    // prefetches they still had in flight. Excluded the same way the onboarding
    // test above excludes it.
    const failure = request.failure()?.errorText ?? 'request failed';
    if (failure !== 'net::ERR_ABORTED') failures.push(failure);
  });
  await loginPlatform(page);
  const trigger = page.getByRole('button', { name: 'Open platform navigation' });
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary', { name: 'Platform navigation' })).toBeVisible();
  const close = page.getByRole('button', { name: 'Close menu' });
  await close.focus();
  await expect(close).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary', { name: 'Platform navigation' })).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary', { name: 'Platform navigation' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', { name: 'Platform navigation' })).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(failures).toEqual([]);
});
