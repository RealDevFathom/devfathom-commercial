const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DISPOSABLE_DATABASE = /(?:^|[_-])(test|tests|e2e|tmp|disposable|synthetic)(?:[_-]|$)/i;
const FORBIDDEN_DATABASE = /(?:^|[_-])(prod|production|preview|staging|live)(?:[_-]|$)/i;
const REFUSAL = 'Extension preparation requires an attested disposable local PostgreSQL target';

/** Pure preflight: never connect, create, drop, or infer a remote opt-in. */
export function assertDisposableExtensionDatabase(
  connectionString: string,
  env: Record<string, string | undefined> = process.env
): URL {
  const refuse = (): never => {
    throw new Error(REFUSAL);
  };
  if (
    env.PREPARE_EXTENSIONS_FRESH_DB_TEST !== '1' ||
    env.PREPARE_EXTENSIONS_DISPOSABLE_CLUSTER !== '1' ||
    !connectionString ||
    connectionString !== connectionString.trim()
  ) {
    return refuse();
  }

  let url: URL;
  try {
    url = new URL(connectionString);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !/^[a-z0-9_-]+$/i.test(database) ||
      !DISPOSABLE_DATABASE.test(database) ||
      FORBIDDEN_DATABASE.test(database)
    ) {
      return refuse();
    }

    // pg connection-string query fields can override the URL authority/path.
    // Permit only one explicit socket host and/or port, never hidden targets,
    // options, services, credentials, or duplicate last-value overrides.
    for (const key of url.searchParams.keys()) {
      if (!['host', 'port'].includes(key) || url.searchParams.getAll(key).length !== 1) {
        return refuse();
      }
    }
    const authorityHost = decodeURIComponent(url.hostname).toLowerCase();
    const queryHost = url.searchParams.get('host');
    const isSocket = (host: string) =>
      host.startsWith('/') && !host.startsWith('//') && !/[\s\0,\\]/.test(host);
    if (authorityHost && !LOCAL_HOSTS.has(authorityHost) && !isSocket(authorityHost)) {
      return refuse();
    }
    if (queryHost !== null && !isSocket(queryHost)) return refuse();
    // No implicit PGHOST/default host, even when the database name looks safe.
    if (!authorityHost && queryHost === null) return refuse();
    const queryPort = url.searchParams.get('port');
    if (url.port && queryPort !== null) return refuse();
    const port = queryPort ?? url.port;
    if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) {
      return refuse();
    }
    if (queryPort === '') return refuse();
  } catch {
    // Do not echo credentials or connection URLs in collection/hook failures.
    return refuse();
  }
  return url;
}
