const DISPOSABLE_NAME = /(?:^|[_-])(test|e2e|tmp|disposable)(?:[_-]|$)/i;
const FORBIDDEN_HOST = /(?:^|[.-])(prod|production|preview|staging)(?:[.-]|$)/i;
const COMMON_POSTGRES_PORTS = new Set(['5432', '6432']);
const REQUIRED_INTEGRATED_ENV = [
  'RESTAURANT_ACTOR_ADMIN_EMAIL',
  'RESTAURANT_ACTOR_ADMIN_PASSWORD',
] as const;
const INTEGRATED_CREDENTIALS = new Set<string>(REQUIRED_INTEGRATED_ENV);

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
  const databaseUrl = resolveRestaurantE2eDatabaseUrl(env);
  const result: Record<string, string | undefined> = {
    ...env,
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
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
