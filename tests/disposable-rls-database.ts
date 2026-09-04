const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DISPOSABLE_DATABASE = /(?:^|[_-])(test|e2e|tmp|disposable)(?:[_-]|$)/i;
const FORBIDDEN_HOST = /(?:^|[.-])(prod|production|preview|staging)(?:[.-]|$)/i;
const FORBIDDEN_DATABASE = /^(postgres|devfathom|production|preview|staging)$/i;

export function assertDisposableRlsDatabase(
  connectionString: string,
  env: Record<string, string | undefined> = process.env
) {
  const parsed = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('RLS probes require a PostgreSQL database URL');
  }
  if (LOCAL_HOSTS.has(parsed.hostname)) return;

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (
    env.ALLOW_REMOTE_RLS_TEST !== 'true' ||
    !DISPOSABLE_DATABASE.test(database) ||
    FORBIDDEN_HOST.test(parsed.hostname) ||
    FORBIDDEN_DATABASE.test(database)
  ) {
    throw new Error(
      'Refusing remote RLS probes without explicit opt-in and a disposable database target'
    );
  }
}
