import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { hash } from 'bcryptjs';
import pg from 'pg';

const runtimeUrl = process.env.DATABASE_URL;
const adminUrl = process.env.PLAYWRIGHT_DATABASE_ADMIN_URL;

export const platformFixture = {
  admin: {
    email: process.env.PLAYWRIGHT_PLATFORM_ADMIN_EMAIL ?? 'platform-admin@e2e.invalid',
    password: process.env.PLAYWRIGHT_PLATFORM_ADMIN_PASSWORD ?? '',
  },
  operator: {
    email: 'platform-operator@e2e.invalid',
    password: 'Local-only-operator-42!',
  },
  tenant: {
    email: 'restaurant-owner@e2e.invalid',
    password: 'Local-only-restaurant-42!',
    slug: 'e2e-restaurant-control-plane',
  },
} as const;

export function controlPlaneEnvironmentAvailable() {
  return Boolean(
    runtimeUrl &&
    adminUrl &&
    process.env.PLAYWRIGHT_PLATFORM_ADMIN_EMAIL &&
    process.env.PLAYWRIGHT_PLATFORM_ADMIN_PASSWORD
  );
}

function databaseName(connectionString: string) {
  return decodeURIComponent(new URL(connectionString).pathname.slice(1));
}

export async function prepareControlPlaneFixture() {
  if (!runtimeUrl || !adminUrl)
    throw new Error('Disposable runtime and admin database URLs required.');
  const name = databaseName(runtimeUrl);
  if (!/(?:e2e|test)/i.test(name) || databaseName(adminUrl) !== name) {
    throw new Error('Control-plane E2E refuses any database not explicitly named test/e2e.');
  }

  const runtime = new pg.Client({ connectionString: runtimeUrl });
  const admin = new pg.Client({ connectionString: adminUrl });
  await Promise.all([runtime.connect(), admin.connect()]);
  try {
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);

    const operatorHash = await hash(platformFixture.operator.password, 12);
    await admin.query(`DROP TRIGGER IF EXISTS e2e_force_setting_rollback ON platform_settings`);
    await admin.query(`DROP FUNCTION IF EXISTS e2e_force_setting_rollback()`);
    await admin.query(
      `DELETE FROM platform_audit_logs WHERE "requestId" LIKE 'e2e-failure-ledger-%'`
    );
    await admin.query(
      `DELETE FROM platform_settings WHERE key IN ('e2e.denied', 'e2e.ledger.success', 'e2e.rollback')`
    );
    await admin.query(
      `INSERT INTO platform_users (id, name, email, "passwordHash", role, active, "mfaRequired", "createdAt", "updatedAt")
       VALUES ('e2e_platform_operator', 'E2E Platform Operator', $1, $2, 'OPERATIONS', true, false, now(), now())
       ON CONFLICT (email) DO UPDATE SET "passwordHash" = EXCLUDED."passwordHash", role = 'OPERATIONS', active = true, "mfaRequired" = false`,
      [platformFixture.operator.email, operatorHash]
    );
    await admin.query(
      `DELETE FROM organization_lifecycle_events WHERE "organizationId"=(SELECT id FROM organizations WHERE slug=$1)`,
      [platformFixture.tenant.slug]
    );
    await admin.query(`DELETE FROM organizations WHERE slug = $1`, [platformFixture.tenant.slug]);
  } finally {
    await Promise.all([runtime.end(), admin.end()]);
  }
}

export async function loginPlatform(page: Page, identity = platformFixture.admin) {
  const origin = new URL(process.env.PLAYWRIGHT_BASE_URL ?? 'http://admin.localhost:4319').origin;
  const response = await page.request.post('/api/platform/session', {
    headers: { origin },
    data: identity,
  });
  expect(response.status()).toBe(200);
  const cookie = response.headers()['set-cookie']?.match(/df_platform_session=([^;]+)/)?.[1];
  if (!cookie) throw new Error('Platform session response did not set its opaque cookie.');
  await page
    .context()
    .addCookies([
      { name: 'df_platform_session', value: cookie, domain: new URL(origin).hostname, path: '/' },
    ]);
  await page.goto('/platform');
  await expect(page).toHaveURL(/\/platform(?:\/|$)/);
}

export async function loginPlatformRequest(
  request: APIRequestContext,
  identity = platformFixture.admin
) {
  const response = await request.post('/api/platform/session', {
    headers: { origin: new URL(process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4319').origin },
    data: identity,
  });
  expect(response.status()).toBe(200);
}

export const platformMutationHeaders = {
  origin: new URL(process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4319').origin,
};

export async function withAdminDatabase<T>(run: (client: pg.Client) => Promise<T>) {
  if (!adminUrl) throw new Error('PLAYWRIGHT_DATABASE_ADMIN_URL is required.');
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}
