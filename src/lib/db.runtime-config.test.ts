// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pool: vi.fn(),
  adapter: vi.fn(),
  client: vi.fn(),
  query: vi.fn(),
  findFirst: vi.fn(),
  transaction: vi.fn(),
}));
const validUrl = 'postgres://fake-user:fake-password@fake-host.invalid/fake-db';
function fakeClient() {
  const organization = {
    findFirst: mocks.findFirst.mockImplementation(function (this: unknown) {
      expect(this).toBe(organization);
      return Promise.resolve(null);
    }),
  };
  const client = {
    organization,
    $queryRaw: mocks.query.mockImplementation(function (this: unknown) {
      expect(this).toBe(client);
      return Promise.resolve([{ result: 1 }]);
    }),
    $transaction: mocks.transaction.mockImplementation(function (this: unknown, work: unknown) {
      expect(this).toBe(client);
      if (typeof work === 'function') return work({ organization });
      return Promise.all(work as Promise<unknown>[]);
    }),
  };
  return client;
}
vi.mock('pg', () => ({ default: { Pool: mocks.pool } }));
vi.mock('@prisma/adapter-pg', () => ({ PrismaPg: mocks.adapter }));
vi.mock('@/generated/prisma/client', () => ({ PrismaClient: mocks.client }));

const cache = globalThis as typeof globalThis & {
  prisma?: unknown;
  credentialPrisma?: unknown;
  prismaVersion?: string;
};

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  delete cache.prisma;
  delete cache.credentialPrisma;
  delete cache.prismaVersion;
  vi.stubEnv('NODE_ENV', 'production');
  // All alternatives are inert; none may rescue invalid DATABASE_URL.
  for (const name of ['APP_DATABASE_URL', 'PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE']) {
    vi.stubEnv(name, 'fake-ambient-fallback');
  }
  mocks.pool.mockImplementation(function () {});
  mocks.adapter.mockImplementation(function () {});
  mocks.client.mockImplementation(function () {
    return fakeClient();
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete cache.prisma;
  delete cache.credentialPrisma;
  delete cache.prismaVersion;
});

describe('runtime pool configuration boundary', () => {
  it('reserves a separate bounded credential pool with the same runtime configuration', async () => {
    vi.stubEnv('DATABASE_URL', validUrl);
    const { db, credentialAttemptDb } = await import('./db');
    expect(mocks.pool).not.toHaveBeenCalled();
    expect(await Promise.resolve(credentialAttemptDb)).toBe(credentialAttemptDb);
    await db.$queryRaw`SELECT 1`;
    await credentialAttemptDb.$queryRaw`SELECT 2`;
    await credentialAttemptDb.$queryRaw`SELECT 3`;
    expect(mocks.pool.mock.calls).toEqual([
      [{ connectionString: validUrl, max: 10 }],
      [{ connectionString: validUrl, max: 2 }],
    ]);
    expect(mocks.client).toHaveBeenCalledTimes(2);
    expect(mocks.adapter.mock.calls[0][0]).not.toBe(mocks.adapter.mock.calls[1][0]);
  });

  it.each([undefined, '', ' ', '\n\t'])(
    'rejects absent/blank configuration (%j)',
    async (value) => {
      vi.stubEnv('DATABASE_URL', value);
      const { db, credentialAttemptDb } = await import('./db');
      expect(() => db.$queryRaw`SELECT 1`).toThrow('runtime_database_url_missing');
      expect(() => credentialAttemptDb.$queryRaw`SELECT 1`).toThrow('runtime_database_url_missing');
      expect(mocks.adapter).not.toHaveBeenCalled();
      expect(mocks.pool).not.toHaveBeenCalled();
      expect(mocks.client).not.toHaveBeenCalled();
    }
  );

  it.each([
    'not-a-url',
    'https://fake-user:fake-password@fake-host.invalid/db',
    'postgres://fake-user:fake-password@[bad/db',
    'postgres://fake-user:fake-password@fake-host.invalid:bad/db',
    'postgres://fake-user:%ZZ@fake-host.invalid/db',
    'postgres:fake-host.invalid',
    'postgres:///db',
    'postgres://fake-host.invalid/db\n',
  ])('rejects malformed/non-PostgreSQL configuration without echo (%j)', async (value) => {
    vi.stubEnv('DATABASE_URL', value);
    const { db } = await import('./db');
    let error: unknown;
    try {
      await db.$queryRaw`SELECT 1`;
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('runtime_database_url_invalid');
    expect((error as Error).cause).toBeUndefined();
    expect(mocks.pool).not.toHaveBeenCalled();
    expect(mocks.adapter).not.toHaveBeenCalled();
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each([
    'postgresql://fake-user:fake-password@fake-host.invalid:5432/fake-db?sslmode=verify-full',
    'postgres://other-user:fake%40password@other-host.invalid/fake-db?application_name=probe',
    'postgresql:///fake-db?host=%2Ffake-socket&user=fake-user',
  ])('passes valid configuration unchanged (%j)', async (value) => {
    vi.stubEnv('DATABASE_URL', value);
    const { db } = await import('./db');
    await db.$queryRaw`SELECT 1`;
    expect(mocks.pool).toHaveBeenCalledExactlyOnceWith({ connectionString: value, max: 10 });
    expect(mocks.client).toHaveBeenCalledWith({ adapter: expect.any(Object), log: [] });
  });

  it('retains development logging', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://fake-user:fake-password@fake-host.invalid/fake-db');
    vi.stubEnv('NODE_ENV', 'development');
    const { db } = await import('./db');
    await db.$queryRaw`SELECT 1`;
    expect(mocks.client).toHaveBeenCalledWith({
      adapter: expect.any(Object),
      log: ['warn', 'error'],
    });
  });
});

describe('lazy client lifecycle', () => {
  it('imports and awaits an ordinary export without configuration or constructors', async () => {
    vi.stubEnv('DATABASE_URL', undefined);
    const { db } = await import('./db');
    expect(typeof db).toBe('object');
    expect(await Promise.resolve(db)).toBe(db);
    expect(Object.keys(db)).toEqual([]);
    expect(mocks.pool).not.toHaveBeenCalled();
    expect(mocks.adapter).not.toHaveBeenCalled();
    expect(mocks.client).not.toHaveBeenCalled();
  });

  it('reads configuration at first use and binds raw, extracted and model calls', async () => {
    vi.stubEnv('DATABASE_URL', undefined);
    const { db } = await import('./db');
    vi.stubEnv('DATABASE_URL', validUrl);
    await expect(db.$queryRaw`SELECT 1`).resolves.toEqual([{ result: 1 }]);
    const query = db.$queryRaw;
    await query`SELECT 2`;
    await expect(db.organization.findFirst()).resolves.toBeNull();
    expect(mocks.query.mock.calls[0][0]).toEqual(['SELECT 1']);
    expect(mocks.query.mock.calls[1][0]).toEqual(['SELECT 2']);
    expect(mocks.pool).toHaveBeenCalledTimes(1);
    expect(mocks.adapter).toHaveBeenCalledTimes(1);
    expect(mocks.client).toHaveBeenCalledTimes(1);
    expect(cache.prisma).toBeUndefined();
  });

  it('preserves interactive and batch transactions and options', async () => {
    vi.stubEnv('DATABASE_URL', validUrl);
    const { db } = await import('./db');
    const transaction = db.$transaction;
    const callback = vi.fn(async (tx: unknown) => tx);
    const options = { timeout: 1234 };
    await expect(transaction(callback, options)).resolves.toEqual({
      organization: mocks.client.mock.results[0].value.organization,
    });
    expect(mocks.transaction).toHaveBeenCalledWith(callback, options);
    await expect(db.$transaction([db.$queryRaw`SELECT 1`])).resolves.toEqual([[{ result: 1 }]]);
    expect(mocks.client).toHaveBeenCalledTimes(1);
  });

  it('reuses the real development client across reloads including imports before first use', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DATABASE_URL', validUrl);
    const first = await import('./db');
    vi.resetModules();
    const second = await import('./db');
    expect(mocks.client).not.toHaveBeenCalled();
    await first.db.$queryRaw`SELECT 1`;
    await second.db.$queryRaw`SELECT 2`;
    vi.resetModules();
    const third = await import('./db');
    await third.db.$queryRaw`SELECT 3`;
    expect(cache.prisma).toBe(mocks.client.mock.results[0].value);
    expect(mocks.pool).toHaveBeenCalledTimes(1);
    expect(mocks.client).toHaveBeenCalledTimes(1);
  });

  it('invalidates a stale version without constructing a replacement until first use', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DATABASE_URL', validUrl);
    const stale = fakeClient();
    cache.prisma = stale;
    cache.prismaVersion = 'stale-schema-version';
    const { db } = await import('./db');
    expect(cache.prisma).toBeUndefined();
    expect(mocks.client).not.toHaveBeenCalled();
    await db.$queryRaw`SELECT 1`;
    expect(cache.prisma).not.toBe(stale);
    expect(mocks.client).toHaveBeenCalledTimes(1);
  });

  it('propagates operation failures unchanged', async () => {
    vi.stubEnv('DATABASE_URL', validUrl);
    const { db } = await import('./db');
    const query = db.$queryRaw;
    const error = new Error('fake-query-failure');
    mocks.query.mockRejectedValueOnce(error);
    await expect(query`SELECT 1`).rejects.toBe(error);
  });
});

it('imports the real health route without configuration, then fails safely on use', async () => {
  vi.stubEnv('DATABASE_URL', undefined);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { GET } = await import('../app/api/health/route');
  expect(mocks.pool).not.toHaveBeenCalled();
  expect(mocks.client).not.toHaveBeenCalled();
  const response = await GET();
  expect(response.status).toBe(503);
  await expect(response.json()).resolves.toEqual({
    status: 'unhealthy',
    reason: 'database_unavailable',
  });
  expect(log).toHaveBeenCalledExactlyOnceWith('[health]', 'database_unavailable');
  expect(mocks.pool).not.toHaveBeenCalled();
  expect(mocks.adapter).not.toHaveBeenCalled();
  expect(mocks.client).not.toHaveBeenCalled();
});
