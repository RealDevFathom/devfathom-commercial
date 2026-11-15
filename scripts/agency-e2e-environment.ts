const DISPOSABLE_DATABASE = /(?:^|[_-])(test|e2e|tmp|disposable)(?:[_-]|$)/i;
const FORBIDDEN_HOST = /(?:^|[.-])(prod|production|preview|staging)(?:[.-]|$)/i;
const COMMON_POSTGRES_PORTS = new Set(['5432', '6432']);
const REQUIRED = [
  'AGENCY_E2E_ADMIN_EMAIL',
  'AGENCY_E2E_ADMIN_PASSWORD',
  'BREVO_API_KEY',
  'BREVO_SENDER_EMAIL',
] as const;

export function resolveAgencyE2eDatabaseUrl(
  env: Record<string, string | undefined> = process.env
): string {
  if (env.AGENCY_E2E !== '1') throw new Error('AGENCY_E2E=1 explicit opt-in is required.');
  const configured = env.AGENCY_E2E_DATABASE_URL;
  if (!configured) throw new Error('AGENCY_E2E_DATABASE_URL is required.');

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error('AGENCY_E2E_DATABASE_URL must be a valid URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('AGENCY_E2E_DATABASE_URL must use PostgreSQL.');
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
      throw new Error(`${name} must match AGENCY_E2E_DATABASE_URL exactly.`);
    }
  }
  return parsed.href;
}

export function agencyE2eEnvironment(
  env: Record<string, string | undefined> = process.env
): Record<string, string | undefined> {
  if (env.PLAYWRIGHT_BASE_URL) {
    throw new Error('PLAYWRIGHT_BASE_URL is forbidden for the Agency E2E lane.');
  }
  for (const name of REQUIRED) {
    if (!env[name]?.trim()) throw new Error(`${name} is required.`);
  }
  // Validate the same URL precedence used by invitation emails, before any seeds
  // or browser tests run. Local HTTP remains available outside this acceptance lane.
  const configuredUrl = env.NEXT_PUBLIC_APP_URL ?? env.NEXTAUTH_URL ?? env.AUTH_URL;
  let appUrl: URL;
  try {
    appUrl = new URL(configuredUrl ?? '');
  } catch {
    throw new Error(
      'A valid application URL (NEXT_PUBLIC_APP_URL, NEXTAUTH_URL, or AUTH_URL) is required.'
    );
  }
  if (appUrl.protocol !== 'https:' || appUrl.username || appUrl.password) {
    throw new Error('The Agency application URL must use HTTPS without embedded credentials.');
  }
  if (env.EMAIL_DELIVERY_MODE && env.EMAIL_DELIVERY_MODE !== 'send') {
    throw new Error(
      'Agency acceptance requires real email delivery; EMAIL_DELIVERY_MODE must be send.'
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.BREVO_SENDER_EMAIL!)) {
    throw new Error('BREVO_SENDER_EMAIL must be a valid sender email address.');
  }
  const databaseUrl = resolveAgencyE2eDatabaseUrl(env);
  return { ...env, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl, AGENCY_E2E: '1' };
}
