/**
 * Failure paths for the readiness probe, driven through a mocked client.
 *
 * Every error shape asserted here was captured from a real PostgreSQL 16
 * database first: the `P2022` case is the exact error the staging deploy
 * produced (`organizations.vertical` renamed away, then restored), and the
 * `P2010` cases carry the `meta.driverAdapterError.cause.originalCode` the
 * `@prisma/adapter-pg` driver actually reports. The DB-backed half of the proof
 * — that the probe passes against a migrated schema, as an unprivileged role —
 * lives in `route.db.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: { $queryRaw: mocks.queryRaw, organization: { findFirst: mocks.findFirst } },
}));

import { Prisma } from '@/generated/prisma/client';

import { GET } from './route';

/** No pending migrations, and no tenant row visible — the expected steady state. */
function healthyDatabase() {
  mocks.queryRaw
    .mockResolvedValueOnce([{ rolsuper: false, rolbypassrls: false }])
    .mockResolvedValueOnce([{ pending: 0 }]);
  mocks.findFirst.mockResolvedValue(null);
}

function knownRequestError(code: string, sqlState?: string) {
  return new Prisma.PrismaClientKnownRequestError('unused', {
    code,
    clientVersion: 'test',
    meta: sqlState
      ? { driverAdapterError: { name: 'DriverAdapterError', cause: { originalCode: sqlState } } }
      : undefined,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('GET /api/ready', () => {
  it('reports the schema as current when the migrations are complete and the column reads', async () => {
    healthyDatabase();

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', schema: 'current' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('proves the schema through the generated client, not raw SQL', async () => {
    healthyDatabase();

    await GET();

    // A raw `SELECT vertical` would pass against a database the generated
    // client cannot query. Selecting through the model is what makes P2022
    // reachable, so assert the probe really goes that way.
    expect(mocks.findFirst).toHaveBeenCalledWith({ select: { vertical: true } });
  });

  it('is not ready while a migration is applied but unfinished', async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{ rolsuper: false, rolbypassrls: false }])
      .mockResolvedValueOnce([{ pending: 1 }]);

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: 'unavailable',
      reason: 'migrations_pending',
    });
    // A half-migrated database must not be probed for columns it may not have
    // yet; the pending row is already the whole answer.
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it.each([[{ rolsuper: true, rolbypassrls: false }], [{ rolsuper: false, rolbypassrls: true }]])(
    'refuses readiness for a PostgreSQL role that can bypass RLS (%o)',
    async (role) => {
      mocks.queryRaw.mockResolvedValueOnce([role]);

      const response = await GET();

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        status: 'unavailable',
        reason: 'runtime_role_privileged',
      });
      expect(mocks.findFirst).not.toHaveBeenCalled();
    }
  );

  it('reports schema drift when the recent column is missing (the staging P2022)', async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{ rolsuper: false, rolbypassrls: false }])
      .mockResolvedValueOnce([{ pending: 0 }]);
    mocks.findFirst.mockRejectedValue(knownRequestError('P2022', '42703'));

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: 'unavailable',
      reason: 'schema_drift',
    });
  });

  it('reports schema drift when the model table itself is absent', async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{ rolsuper: false, rolbypassrls: false }])
      .mockResolvedValueOnce([{ pending: 0 }]);
    mocks.findFirst.mockRejectedValue(knownRequestError('P2021', '42P01'));

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ reason: 'schema_drift' });
  });

  it('reports schema drift on a never-migrated database, where _prisma_migrations does not exist', async () => {
    mocks.queryRaw.mockRejectedValue(knownRequestError('P2010', '42P01'));

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ reason: 'schema_drift' });
  });

  it('distinguishes an unreachable database from schema drift', async () => {
    mocks.queryRaw.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.4:5432'));

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: 'unavailable',
      reason: 'database_unavailable',
    });
  });

  it('does not treat an unrelated Prisma SQLSTATE as drift', async () => {
    // 53300 too_many_connections — a real outage, and the reason code has to
    // stay actionable rather than sending an operator to run migrations.
    mocks.queryRaw.mockRejectedValue(knownRequestError('P2010', '53300'));

    const response = await GET();

    await expect(response.json()).resolves.toMatchObject({ reason: 'database_unavailable' });
  });

  it('answers 503 at the two second bound instead of hanging with the probe', async () => {
    vi.useFakeTimers();
    mocks.queryRaw.mockReturnValue(new Promise(() => {}));

    const pending = GET();
    await vi.advanceTimersByTimeAsync(1_999);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: 'unavailable', reason: 'timeout' });
  });

  it('never leaks SQL, a host, a stack or a secret into the failure body', async () => {
    const leaky = knownRequestError('P2010', '42703');
    leaky.message = [
      'Invalid `prisma.$queryRaw()` invocation:',
      'SELECT count(*) FROM "_prisma_migrations"',
      'at postgresql://devfathomadmin:hunter2@db.example123.ap-southeast-1.rds.amazonaws.com:5432',
    ].join('\n');
    mocks.queryRaw.mockRejectedValue(leaky);

    const body = await (await GET()).text();

    expect(JSON.parse(body)).toEqual({ status: 'unavailable', reason: 'schema_drift' });
    for (const secret of [
      'SELECT',
      '_prisma_migrations',
      'hunter2',
      'devfathomadmin',
      'rds.amazonaws.com',
      'Invalid `prisma',
      'at ',
    ]) {
      expect(body).not.toContain(secret);
    }
  });
});
