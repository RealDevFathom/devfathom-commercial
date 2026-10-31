import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { hash } from 'bcryptjs';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import pg from 'pg';

const runtimeUrl = process.env.DATABASE_URL;
const adminUrl = process.env.PLAYWRIGHT_DATABASE_ADMIN_URL;
const platformOrigin = new URL(
  process.env.PLAYWRIGHT_BASE_URL ?? `http://admin.localhost:${process.env.PLAYWRIGHT_PORT ?? 4319}`
).origin;

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

/**
 * The disposable-database guard and the shared commercial catalog, split out so
 * a sibling `platform-control-plane*.spec.ts` can stand its own organization up
 * without running (and therefore without deleting) another file's fixture. Every
 * write here is an idempotent upsert, so any order of callers converges.
 */
export async function ensureControlPlaneCatalog() {
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

    await admin.query(
      `INSERT INTO platform_modules (id, key, name, category, band, vertical, "routePrefix", active, "sortOrder", "createdAt", "updatedAt")
       VALUES
         ('e2e_restaurant_core', 'restaurant-core', 'Restaurant Core', 'Restaurant', 'VERTICAL_CORE', 'RESTAURANT', '/restaurant', true, 0, now(), now()),
         ('e2e_restaurant_menu', 'restaurant-menu', 'Restaurant Menu', 'Restaurant', 'VERTICAL_OPTIONAL', 'RESTAURANT', '/restaurant/menus', true, 1, now(), now())
       ON CONFLICT (key) DO UPDATE SET active = true, "updatedAt" = now()`
    );
    await admin.query(
      `INSERT INTO platform_packages (id, key, name, vertical, version, active, "defaultSeats", "createdAt", "updatedAt")
       VALUES ('e2e_restaurant_package', 'e2e-restaurant-package', 'E2E Restaurant Package', 'RESTAURANT', 1, true, 25, now(), now())
       ON CONFLICT (key) DO UPDATE SET vertical = 'RESTAURANT', active = true, "updatedAt" = now()`
    );
    await admin.query(
      `INSERT INTO platform_package_modules (id, "packageId", "moduleId", enabled)
       SELECT 'e2e_package_' || m.key, p.id, m.id, true
       FROM platform_packages p
       JOIN platform_modules m ON m.key IN ('restaurant-core', 'restaurant-menu')
       WHERE p.key = 'e2e-restaurant-package'
       ON CONFLICT ("packageId", "moduleId") DO UPDATE SET enabled = true`
    );
  } finally {
    await Promise.all([runtime.end(), admin.end()]);
  }
}

/** Drop one organization and the lifecycle rows that outlive it, by slug. */
export async function resetOrganization(slug: string) {
  await withAdminDatabase(async (admin) => {
    await admin.query(
      `DELETE FROM organization_lifecycle_events WHERE "organizationId"=(SELECT id FROM organizations WHERE slug=$1)`,
      [slug]
    );
    await admin.query(`DELETE FROM organizations WHERE slug = $1`, [slug]);
  });
}

export async function prepareControlPlaneFixture() {
  await ensureControlPlaneCatalog();
  if (!runtimeUrl || !adminUrl)
    throw new Error('Disposable runtime and admin database URLs required.');

  const runtime = new pg.Client({ connectionString: runtimeUrl });
  const admin = new pg.Client({ connectionString: adminUrl });
  await Promise.all([runtime.connect(), admin.connect()]);
  try {
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

// Disposable fixture authenticator: exercise MFA rather than disabling enforcement.
export async function platformAuthentication(identity: { email: string; password: string }) {
  if (!runtimeUrl || !adminUrl || !/(?:test|e2e)/i.test(databaseName(runtimeUrl)))
    throw new Error('MFA fixture requires the disposable control-plane database.');
  const rawKey = process.env.PLATFORM_ENCRYPTION_KEY?.trim();
  if (!rawKey) throw new Error('MFA fixture requires the platform encryption key.');
  const decoded = Buffer.from(rawKey, 'base64');
  const key = /^[a-f0-9]{64}$/i.test(rawKey)
    ? Buffer.from(rawKey, 'hex')
    : decoded.length === 32
      ? decoded
      : createHash('sha256').update(rawKey).digest();
  const secret = 'JBSWY3DPEHPK3PXP';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const encrypted = `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
  await withAdminDatabase(async (db) => {
    await db.query(
      `UPDATE platform_users SET "encryptedTotpSecret"=$1, "mfaEnabledAt"=now() WHERE email=$2`,
      [encrypted, identity.email]
    );
  });
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', Buffer.from('48656c6c6f21deadbeef', 'hex'))
    .update(counter)
    .digest();
  const offset = digest[digest.length - 1]! & 15;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return { ...identity, authenticationCode: String(code).padStart(6, '0') };
}

export async function loginPlatform(page: Page, identity = platformFixture.admin) {
  const response = await page.request.post('/api/platform/session', {
    headers: { origin: platformOrigin },
    data: await platformAuthentication(identity),
  });
  expect(response.status()).toBe(200);
  const cookie = response.headers()['set-cookie']?.match(/df_platform_session=([^;]+)/)?.[1];
  if (!cookie) throw new Error('Platform session response did not set its opaque cookie.');
  await page.context().addCookies([
    {
      name: 'df_platform_session',
      value: cookie,
      domain: new URL(platformOrigin).hostname,
      path: '/',
    },
  ]);
  await page.goto('/platform');
  await expect(page).toHaveURL(/\/platform(?:\/|$)/);
}

export async function loginPlatformRequest(
  request: APIRequestContext,
  identity = platformFixture.admin
) {
  const response = await request.post('/api/platform/session', {
    headers: { origin: platformOrigin },
    data: await platformAuthentication(identity),
  });
  expect(response.status()).toBe(200);
}

export const platformMutationHeaders = {
  origin: platformOrigin,
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

/** A provisioned administrator must rotate the temporary credential before entering the workspace. */
export async function signInProvisionedTenant(
  page: Page,
  origin: string,
  identity: { email: string; password: string },
  destination = /\/dashboard(?:\?|$)/
) {
  const login = new URL('/login', origin).href;
  await page.goto(login);
  await page.getByLabel('Email').fill(identity.email);
  await page.locator('input[name="password"]').fill(identity.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/change-password(?:\?|$)/);
  await page.getByLabel('Current password', { exact: true }).fill(identity.password);
  const password = `Rotated1!${randomBytes(16).toString('hex')}`;
  await page.getByLabel('New password', { exact: true }).fill(password);
  await page.getByLabel('Confirm new password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await page.waitForURL(login);
  await page.getByLabel('Email').fill(identity.email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(destination);
  expect(new URL(page.url()).origin).toBe(new URL(origin).origin);
  return password;
}
