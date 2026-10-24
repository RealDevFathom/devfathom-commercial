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

/** The staging RDS instance is DBInstanceIdentifier devfathom-staging in ap-southeast-1. */
const STAGING_RDS_ENDPOINT = /^devfathom-staging\.[a-z0-9]+\.ap-southeast-1\.rds\.amazonaws\.com$/;
const NEVER_STAGING_HOST = /(?:^|[.-])(prod|production|preview)(?:[.-]|$)/i;

/**
 * Fail closed unless this is the staging deployment and the database URL points at the
 * staging RDS endpoint the stack itself passes in. Both must hold: DEPLOY_ENV must be
 * exactly 'staging', and the parsed host must equal STAGING_DB_ENDPOINT.
 */
export function assertStagingDemoTarget(
  databaseUrl: string,
  env: Record<string, string | undefined> = process.env
): string {
  if (env.DEPLOY_ENV !== 'staging') {
    throw new Error("Refusing the staging demo seed: DEPLOY_ENV must be exactly 'staging'.");
  }
  const endpoint = env.STAGING_DB_ENDPOINT?.trim().toLowerCase();
  if (!endpoint)
    throw new Error('Refusing the staging demo seed: STAGING_DB_ENDPOINT is required.');
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('Refusing the staging demo seed: the database URL is not a valid URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('Refusing the staging demo seed: the database URL must use PostgreSQL.');
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== endpoint) {
    throw new Error(
      'Refusing the staging demo seed: the database host is not the staging endpoint.'
    );
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (NEVER_STAGING_HOST.test(host) || /^(production|preview)$/i.test(database)) {
    throw new Error('Refusing the staging demo seed: production or preview target.');
  }
  if (!STAGING_RDS_ENDPOINT.test(host)) {
    throw new Error(
      'Refusing the staging demo seed: the host is not the devfathom-staging RDS endpoint in ap-southeast-1.'
    );
  }
  return parsed.href;
}

export function resolvePharmacyE2eDatabaseUrl(
  env: Record<string, string | undefined> = process.env
): string {
  // Staging demo seeding (scripts/seed-staging-demo.ts) targets the real staging
  // database on purpose, and only after assertStagingDemoTarget proves it is staging.
  if (env.STAGING_DEMO_SEED === '1') {
    const target = env.STAGING_DEMO_DATABASE_URL;
    if (!target) throw new Error('STAGING_DEMO_DATABASE_URL is required for STAGING_DEMO_SEED=1.');
    for (const name of REQUIRED) if (!env[name]) throw new Error(`${name} is required.`);
    return assertStagingDemoTarget(target, env);
  }
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
