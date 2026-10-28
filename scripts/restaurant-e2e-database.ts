// Shared by the seed and browser assertions; no database side effects on import.
export const RESTAURANT_E2E_BRANCH_COUNT = 3;

const DISPOSABLE_NAME = /(?:^|[_-])(test|e2e|tmp|disposable)(?:[_-]|$)/i;
const FORBIDDEN_HOST = /(?:^|[.-])(prod|production|preview|staging)(?:[.-]|$)/i;
const COMMON_POSTGRES_PORTS = new Set(['5432', '6432']);
const REQUIRED_INTEGRATED_ENV = [
  'RESTAURANT_ACTOR_ADMIN_EMAIL',
  'RESTAURANT_ACTOR_ADMIN_PASSWORD',
  'RESTAURANT_ACTOR_OPERATOR_EMAIL',
  'RESTAURANT_ACTOR_OPERATOR_PASSWORD',
  'RESTAURANT_ACTOR_AGENCY_EMAIL',
  'RESTAURANT_ACTOR_AGENCY_PASSWORD',
  'RESTAURANT_ACTOR_SUPER_ADMIN_EMAIL',
  'RESTAURANT_ACTOR_SUPER_ADMIN_PASSWORD',
] as const;
const INTEGRATED_CREDENTIALS = new Set<string>(REQUIRED_INTEGRATED_ENV);
const RESTAURANT_OPERATOR_EMAIL = 'operator@restaurant-e2e.test';

/**
 * WHA-1542 — the ONLY administrator identity the Restaurant E2E fixture has.
 * `scripts/seed-restaurant-e2e.ts` mirrors org_devfathom's Alex into Chai Chowk
 * under the `*` manager role and copies his existing password hash rather than
 * hashing one of its own; it creates no dedicated admin user. Wiring a different
 * address (or a password other than the `SEED_PASSWORD` that produced that hash)
 * is therefore unauthenticatable, and NextAuth reports it as `CredentialsSignin`
 * — indistinguishable from a real credential rejection. Assert it here so the
 * lane fails closed during setup instead of red-lining every admin-entry case.
 */
const RESTAURANT_ADMIN_EMAIL = 'alex@company.com';

/**
 * WHA-1567 — the plaintext secret of the REVOKED print-bridge device that
 * `scripts/seed-restaurant-e2e.ts` registers. It is published here, rather than
 * left to the caller, because it must hash to exactly the row the seed wrote: a
 * mismatched value would take the web-session branch of the transport and the
 * acceptance case would fail for a reason unrelated to revocation.
 *
 * Local/CI fixture only. The device it authenticates is REVOKED, so the single
 * reachable outcome is the 403 refusal the spec asserts — it grants no access.
 */
export const RESTAURANT_E2E_REVOKED_BRIDGE_DEVICE_SECRET =
  'rdk_restaurant_e2e_print_bridge_revoked_local_ci_only';

/**
 * WHA-1567 — the plaintext secret of the ASCII receipt branch's POS, which is
 * also its print bridge (`isBridgeRequest` only requires an `rdk_` bearer, so no
 * separate bridge enrolment exists). Published here for the same reason as the
 * revoked secret above: it must hash to exactly the row the seed wrote.
 *
 * Local/CI fixture only. It authenticates one synthetic device in the disposable
 * E2E tenant and is never a production credential.
 */
export const RESTAURANT_E2E_ASCII_RECEIPT_DEVICE_SECRET =
  'rdk_restaurant_e2e_ascii_receipt_pos_local_ci_only';

export function resolveRestaurantE2eDatabaseUrl(
  env: Record<string, string | undefined> = process.env
): string {
  const canonical = env.RESTAURANT_E2E_DATABASE_URL;
  if (!canonical) throw new Error('RESTAURANT_E2E_DATABASE_URL is required.');

  let parsed: URL;
  try {
    parsed = new URL(canonical);
  } catch {
    throw new Error('RESTAURANT_E2E_DATABASE_URL must be a valid URL.');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('RESTAURANT_E2E_DATABASE_URL must use PostgreSQL.');
  }
  if (!parsed.port) parsed.port = '5432';
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!DISPOSABLE_NAME.test(database)) {
    throw new Error('Database name must explicitly identify a disposable test database.');
  }
  if (
    FORBIDDEN_HOST.test(parsed.hostname) ||
    /^(postgres|devfathom|production|staging)$/i.test(database)
  ) {
    throw new Error('Refusing a production, shared, preview, or staging database target.');
  }
  if (COMMON_POSTGRES_PORTS.has(parsed.port)) {
    throw new Error(
      `Refusing common PostgreSQL port ${parsed.port}; use an isolated disposable port.`
    );
  }

  for (const name of ['DATABASE_URL', 'TEST_DATABASE_URL'] as const) {
    const configured = env[name];
    if (configured && new URL(configured).href !== parsed.href) {
      throw new Error(`${name} must match RESTAURANT_E2E_DATABASE_URL exactly.`);
    }
  }
  return parsed.href;
}

export function restaurantE2eEnvironment(
  env: Record<string, string | undefined> = process.env
): Record<string, string | undefined> {
  if (env.RESTAURANT_INTEGRATED_E2E !== '1') {
    throw new Error('RESTAURANT_INTEGRATED_E2E=1 is required.');
  }
  if (env.PLAYWRIGHT_BASE_URL) {
    throw new Error('PLAYWRIGHT_BASE_URL is forbidden for the integrated Restaurant E2E lane.');
  }
  for (const name of REQUIRED_INTEGRATED_ENV) {
    if (!env[name]) throw new Error(`${name} is required.`);
  }
  if (env.RESTAURANT_ACTOR_OPERATOR_EMAIL !== RESTAURANT_OPERATOR_EMAIL) {
    throw new Error(`RESTAURANT_ACTOR_OPERATOR_EMAIL must be ${RESTAURANT_OPERATOR_EMAIL}.`);
  }
  if (env.RESTAURANT_ACTOR_ADMIN_EMAIL !== RESTAURANT_ADMIN_EMAIL) {
    throw new Error(`RESTAURANT_ACTOR_ADMIN_EMAIL must be ${RESTAURANT_ADMIN_EMAIL}.`);
  }
  if (env.SEED_PASSWORD && env.RESTAURANT_ACTOR_ADMIN_PASSWORD !== env.SEED_PASSWORD) {
    throw new Error('RESTAURANT_ACTOR_ADMIN_PASSWORD must equal SEED_PASSWORD.');
  }
  // Reuse the identities seeded by prisma/seed.ts in the disposable template.
  if (env.RESTAURANT_ACTOR_AGENCY_EMAIL !== RESTAURANT_ADMIN_EMAIL) {
    throw new Error(`RESTAURANT_ACTOR_AGENCY_EMAIL must be ${RESTAURANT_ADMIN_EMAIL}.`);
  }
  if (env.RESTAURANT_ACTOR_AGENCY_PASSWORD !== env.RESTAURANT_ACTOR_ADMIN_PASSWORD) {
    throw new Error('RESTAURANT_ACTOR_AGENCY_PASSWORD must equal RESTAURANT_ACTOR_ADMIN_PASSWORD.');
  }
  if (!env.PLATFORM_ADMIN_EMAIL || !env.PLATFORM_ADMIN_PASSWORD) {
    throw new Error(
      'Disposable template PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD are required.'
    );
  }
  if (env.RESTAURANT_ACTOR_SUPER_ADMIN_EMAIL !== env.PLATFORM_ADMIN_EMAIL.toLowerCase()) {
    throw new Error(
      'RESTAURANT_ACTOR_SUPER_ADMIN_EMAIL must match the seeded PLATFORM_ADMIN_EMAIL.'
    );
  }
  if (env.RESTAURANT_ACTOR_SUPER_ADMIN_PASSWORD !== env.PLATFORM_ADMIN_PASSWORD) {
    throw new Error('RESTAURANT_ACTOR_SUPER_ADMIN_PASSWORD must equal PLATFORM_ADMIN_PASSWORD.');
  }
  const databaseUrl = resolveRestaurantE2eDatabaseUrl(env);
  const result: Record<string, string | undefined> = {
    ...env,
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
    // Browser and job worker share explicit disposable-only extraction/storage.
    NODE_ENV: 'test',
    MENU_IMPORT_ADAPTER: 'FIXTURE',
    STORAGE_ADAPTER: 'local',
    // Set, never merged: the value has to hash to the seeded row, so a caller
    // override could only ever break the case it is meant to enable.
    RESTAURANT_E2E_REVOKED_BRIDGE_DEVICE_SECRET,
    RESTAURANT_E2E_ASCII_RECEIPT_DEVICE_SECRET,
  };
  for (const name of Object.keys(result)) {
    if (
      /^RESTAURANT_ACTOR_.+_(?:EMAIL|PASSWORD)$/.test(name) &&
      !INTEGRATED_CREDENTIALS.has(name)
    ) {
      delete result[name];
    }
  }
  return result;
}
