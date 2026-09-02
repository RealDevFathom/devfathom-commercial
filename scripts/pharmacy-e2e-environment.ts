/**
 * PH-POS counter E2E environment guard.
 *
 * The same refusals the Agency lane applies, for the same reason: a browser
 * acceptance run seeds and mutates real rows, so it may only ever point at a
 * disposable database on an isolated port.
 */
const DISPOSABLE_DATABASE = /(?:^|[_-])(test|e2e|tmp|disposable)(?:[_-]|$)/i;
const FORBIDDEN_HOST = /(?:^|[.-])(prod|production|preview|staging)(?:[.-]|$)/i;
const COMMON_POSTGRES_PORTS = new Set(['5432', '6432']);
const REQUIRED = ['PHARMACY_E2E_ADMIN_EMAIL', 'PHARMACY_E2E_ADMIN_PASSWORD'] as const;

export function resolvePharmacyE2eDatabaseUrl(
  env: Record<string, string | undefined> = process.env
): string {
  if (env.PHARMACY_E2E !== '1') throw new Error('PHARMACY_E2E=1 explicit opt-in is required.');
  const configured = env.PHARMACY_E2E_DATABASE_URL;
  if (!configured) throw new Error('PHARMACY_E2E_DATABASE_URL is required.');

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error('PHARMACY_E2E_DATABASE_URL must be a valid URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('PHARMACY_E2E_DATABASE_URL must use PostgreSQL.');
  }
  if (!parsed.port) parsed.port = '5432';
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!DISPOSABLE_DATABASE.test(database)) {
    throw new Error('Database name must explicitly identify a disposable test database.');
  }
  if (
    FORBIDDEN_HOST.test(parsed.hostname) ||
    /^(postgres|devfathom|production|preview|staging)$/i.test(database)
  ) {
    throw new Error('Refusing a production, shared, preview, or staging database target.');
  }
  if (COMMON_POSTGRES_PORTS.has(parsed.port)) {
    throw new Error(`Refusing common PostgreSQL port ${parsed.port}; use an isolated port.`);
  }

  for (const name of ['DATABASE_URL', 'TEST_DATABASE_URL'] as const) {
    if (env[name] && new URL(env[name]).href !== parsed.href) {
      throw new Error(`${name} must match PHARMACY_E2E_DATABASE_URL exactly.`);
    }
  }
  return parsed.href;
}

export function pharmacyE2eEnvironment(
  env: Record<string, string | undefined> = process.env
): Record<string, string | undefined> {
  if (env.PLAYWRIGHT_BASE_URL) {
    throw new Error('PLAYWRIGHT_BASE_URL is forbidden for the Pharmacy counter E2E lane.');
  }
  for (const name of REQUIRED) {
    if (!env[name]) throw new Error(`${name} is required.`);
  }
  const databaseUrl = resolvePharmacyE2eDatabaseUrl(env);
  return { ...env, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl, PHARMACY_E2E: '1' };
}
