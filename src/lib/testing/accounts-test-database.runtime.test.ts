import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountsTestDatabase } from './accounts-test-database';

// Inspect only pg's parameter parser, never a real Pool, Client or connection.
const ConnectionParameters = createRequire(import.meta.url)(
  'pg/lib/connection-parameters.js'
) as new (options: { connectionString: string; max: number }) => {
  host: string;
  port: number;
  user: string;
  database: string;
};
const boundary = vi.hoisted(() => ({
  pool: vi.fn(function refusePool(_options: { connectionString: string; max: number }) {
    void _options;
    throw new Error('ACCOUNTS_TEST_POOL_BOUNDARY_ONLY');
  }),
  adapter: vi.fn(),
  client: vi.fn(),
}));
vi.mock('pg', () => ({ default: { Pool: boundary.pool } }));
vi.mock('@prisma/adapter-pg', () => ({ PrismaPg: boundary.adapter }));
vi.mock('@/generated/prisma/client', () => ({ PrismaClient: boundary.client }));
vi.mock('node:fs', () => {
  const mock = {
    realpathSync: () => '/tmp/qa603-private',
    lstatSync: (path: string) => ({
      mode: 0o40700,
      uid: process.getuid?.(),
      isDirectory: () => path === '/tmp/qa603-private',
      isSymbolicLink: () => false,
      isSocket: () => path === '/tmp/qa603-private/.s.PGSQL.5432',
    }),
  };
  return { ...mock, default: mock };
});

const runId = 'a'.repeat(32);
const database = `qa603_${runId}`;
const role = 'qa603_runtime';
const socket = '/tmp/qa603-private';
const env = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  TEST_DATABASE_URL: `postgresql://${role}:synthetic@localhost/${database}?host=${encodeURIComponent(socket)}`,
  PHARMACY_ACCOUNTS_TEST_RUN_ID: runId,
  PHARMACY_ACCOUNTS_TEST_DATABASE: database,
  PHARMACY_ACCOUNTS_TEST_ROLE: role,
  PHARMACY_ACCOUNTS_TEST_SOCKET: socket,
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal('prisma', undefined);
  vi.stubGlobal('prismaVersion', undefined);
  // Explicit URL identity must win over any unrelated ambient target defaults.
  vi.stubEnv('PGHOST', 'production.invalid');
  vi.stubEnv('PGDATABASE', 'not_the_disposable_database');
  vi.stubEnv('PGUSER', 'not_the_runtime_role');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function assertActualPoolEndpoint(target: ReturnType<typeof accountsTestDatabase>) {
  vi.stubEnv('DATABASE_URL', target.url);
  const runtime = await import('@/lib/db');
  // The real db.ts URL validator runs; its pool factory is a throwing mock.
  expect(() => runtime.db.$transaction).toThrow('ACCOUNTS_TEST_POOL_BOUNDARY_ONLY');
  expect(boundary.pool).toHaveBeenCalledOnce();
  expect(boundary.adapter).not.toHaveBeenCalled();
  expect(boundary.client).not.toHaveBeenCalled();
  const actual = new ConnectionParameters(boundary.pool.mock.calls[0][0]);
  expect(actual.host).toBe(target.socket);
  expect(actual.port).toBe(5432);
  expect(`${actual.host}/.s.PGSQL.${actual.port}`).toBe(`${socket}/.s.PGSQL.5432`);
  expect(actual.database).toBe(target.database);
  expect(actual.user).toBe(target.role);
}

describe('Accounts preflight pins the endpoint through the real runtime pool boundary', () => {
  it.each([undefined, '', '5432', '6543', '0', 'invalid'])(
    'never selects an unchecked Unix socket when ambient PGPORT=%s',
    async (port) => {
      vi.stubEnv('PGPORT', port);
      await assertActualPoolEndpoint(accountsTestDatabase({ ...env(), PGPORT: port }));
    }
  );

  it('remains pinned if PGPORT changes after preflight and before client construction', async () => {
    vi.stubEnv('PGPORT', '5432');
    const target = accountsTestDatabase({ ...env(), PGPORT: '5432' });
    vi.stubEnv('PGPORT', '6543');
    await assertActualPoolEndpoint(target);
  });
});
