import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountsTestDatabase, assertAccountsTestDatabase } from './accounts-test-database';

const fs = vi.hoisted(() => ({
  realpath: '/tmp/qa603-private',
  mode: 0o40700,
  uid: process.getuid?.(),
  directory: true,
  symlink: false,
  socket: true,
}));
vi.mock('node:fs', () => {
  const mock = {
    realpathSync: () => fs.realpath,
    lstatSync: (path: string) => ({
      mode: fs.mode,
      uid: fs.uid,
      isDirectory: () => fs.directory,
      isSymbolicLink: () => fs.symlink,
      isSocket: () => path.endsWith('/.s.PGSQL.5432') && fs.socket,
    }),
  };
  return { ...mock, default: mock };
});
const runId = 'a'.repeat(32);
const database = `qa603_${runId}`;
const socket = '/tmp/qa603-private';
const role = 'qa603_runtime';
const url = `postgresql://${role}@localhost/${database}?host=${socket}`;
const pinnedUrl = url.replace('@localhost/', '@localhost:5432/');
const env = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  TEST_DATABASE_URL: url,
  PHARMACY_ACCOUNTS_TEST_RUN_ID: runId,
  PHARMACY_ACCOUNTS_TEST_DATABASE: database,
  PHARMACY_ACCOUNTS_TEST_ROLE: role,
  PHARMACY_ACCOUNTS_TEST_SOCKET: socket,
});
beforeEach(() =>
  Object.assign(fs, {
    realpath: socket,
    mode: 0o40700,
    uid: process.getuid?.(),
    directory: true,
    symlink: false,
    socket: true,
  })
);

describe('Accounts DB preflight BEFORE importing any connection client', () => {
  it('admits only a pinned synthetic DB on an owned private real socket directory', () => {
    expect(accountsTestDatabase(env())).toEqual({ url: pinnedUrl, database, role, socket, runId });
  });
  it.each([undefined, '6543', 'invalid'])(
    'emits the verified port explicitly rather than inheriting PGPORT=%s',
    (port) => {
      const target = accountsTestDatabase({ ...env(), PGPORT: port });
      expect(target.url).toBe(pinnedUrl);
      expect(new URL(target.url).port).toBe('5432');
      expect(new URL(target.url).searchParams.get('host')).toBe(socket);
    }
  );
  it.each([
    ['missing URL', undefined],
    ['remote authority', url.replace('@localhost/', '@production.invalid/')],
    ['loopback TCP', url.replace('@localhost/', '@127.0.0.1/')],
    ['host override last', `${url}&host=production.invalid`],
    [
      'host override first',
      url.replace(`host=${socket}`, `host=production.invalid&host=${socket}`),
    ],
    ['encoded duplicate host', `${url}&%68ost=production.invalid`],
    ['hostaddr', `${url}&hostaddr=127.0.0.1`],
    ['database override', `${url}&database=production`],
    ['dbname override', `${url}&dbname=production`],
    ['user override', `${url}&user=owner`],
    ['options override', `${url}&options=-c%20row_security=off`],
    ['connection string override', `${url}&connectionString=bad`],
    ['unknown option', `${url}&sslmode=disable`],
    ['multiple port', `${url}&port=5433`],
    ['authority port', url.replace('@localhost/', '@localhost:5433/')],
    ['authority fixed port supplied by caller', url.replace('@localhost/', '@localhost:5432/')],
    ['wrong role', url.replace(role, 'qa603_owner')],
    ['real database', url.replace(database, 'devfathom')],
    ['wrong scheme', url.replace('postgresql:', 'https:')],
    ['fragment', `${url}#x`],
    ['whitespace', `${url} `],
    ['relative socket', url.replace(socket, 'relative')],
    ['missing socket', url.split('?')[0]],
    ['different socket', url.replace(socket, '/tmp/another')],
  ])('denies %s before connection', (_name, value) => {
    expect(() => accountsTestDatabase({ ...env(), TEST_DATABASE_URL: value })).toThrow(
      'ACCOUNTS_TEST_REQUIRES_FRESH_PRIVATE_SOCKET_DATABASE'
    );
  });
  it.each([
    'PHARMACY_ACCOUNTS_TEST_RUN_ID',
    'PHARMACY_ACCOUNTS_TEST_DATABASE',
    'PHARMACY_ACCOUNTS_TEST_ROLE',
    'PHARMACY_ACCOUNTS_TEST_SOCKET',
  ])('requires independent %s attestation, not URL self-attestation', (field) => {
    expect(() => accountsTestDatabase({ ...env(), [field]: undefined })).toThrow();
  });
  it('does not fall back from an explicitly empty preferred URL', () => {
    expect(() => accountsTestDatabase({ ...env(), M8_TEST_RUNTIME_DATABASE_URL: '' })).toThrow();
  });
  it.each([
    { mode: 0o40755 },
    { mode: 0o40770 },
    { uid: -1 },
    { directory: false },
    { symlink: true },
    { realpath: '/somewhere/else' },
    { socket: false },
  ])('rejects unsafe filesystem identity %j', (shape) => {
    Object.assign(fs, shape);
    expect(() => accountsTestDatabase(env())).toThrow();
  });
});

describe('Accounts actual-target read-only guard BEFORE fixture writes', () => {
  const correct = () => [{ database, role, local: true, runId }];
  const run = (rows: unknown) => {
    const query = vi.fn().mockResolvedValue(rows);
    const withDb = async <T>(
      fn: (db: {
        $queryRawUnsafe<R = unknown>(sql: string, ...values: unknown[]): Promise<R>;
      }) => Promise<T>
    ) => fn({ $queryRawUnsafe: query });
    return { query, promise: assertAccountsTestDatabase(withDb, accountsTestDatabase(env())) };
  };
  it('requires exact live database, runtime role, socket transport and fresh marker', async () => {
    const { query, promise } = run(correct());
    await expect(promise).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/^SELECT /);
    expect(query.mock.calls[0][0]).not.toMatch(/INSERT|UPDATE|DELETE|DROP|ALTER/);
  });
  it.each([
    { rows: [] },
    { rows: [...correct(), ...correct()] },
    { rows: [{ ...correct()[0], database: 'devfathom' }] },
    { rows: [{ ...correct()[0], role: 'owner' }] },
    { rows: [{ ...correct()[0], local: false }] },
    { rows: [{ ...correct()[0], runId: 'b'.repeat(32) }] },
  ])('refuses mismatched actual identity %j without writes', async ({ rows }) => {
    await expect(run(rows).promise).rejects.toThrow('ACCOUNTS_TEST_ACTUAL_TARGET_MISMATCH');
  });
});
