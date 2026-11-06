/** Exercise the real tRPC error formatter through its transport. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import superjson from 'superjson';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

import { publicProcedure, router } from './trpc';

const internalSchema = z.object({ internalOnlyField: z.string() });
const INTERNALS =
  'duplicate key value violates unique constraint "users_email_key" on table "users"';
const GENERIC = 'Something went wrong on our side. Please try again.';

const testRouter = router({
  validated: publicProcedure
    .input(z.object({ key: z.string().regex(/^[a-z]+$/, 'Use lowercase letters only.') }))
    .query(() => 'ok'),
  internal: publicProcedure.query(() => internalSchema.parse({ internalOnlyField: 1 })),
  crashed: publicProcedure.query(() => {
    throw new Error(INTERNALS);
  }),
  thrownValue: publicProcedure.query(() => {
    throw `raw: ${INTERNALS}`;
  }),
  deliberate: publicProcedure.query(() => {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Camera credential storage is not configured.',
    });
  }),
  deliberateWithCause: publicProcedure.query(() => {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Rolled back: another operation failed in the same request.',
      cause: new Error(INTERNALS),
    });
  }),
  conflict: publicProcedure.query(() => {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'This message changed while you were working.',
      cause: new Error(INTERNALS),
    });
  }),
  notFound: publicProcedure.query(() => {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'That version no longer exists.' });
  }),
  staleUpdate: publicProcedure.query(() => {
    throw new Prisma.PrismaClientKnownRequestError(
      '\nInvalid `prisma.client.update()` invocation: record does not exist',
      { code: 'P2025', clientVersion: 'test' }
    );
  }),
  duplicate: publicProcedure.query(() => {
    throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on Client_name_key', {
      code: 'P2002',
      clientVersion: 'test',
    });
  }),
  foreignKey: publicProcedure.query(() => {
    throw new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
      code: 'P2003',
      clientVersion: 'test',
    });
  }),
  unknownPrisma: publicProcedure.query(() => {
    throw new Prisma.PrismaClientKnownRequestError('Unknown prisma.client.delete() failure', {
      code: 'P2999',
      clientVersion: 'test',
    });
  }),
  deliberateDuplicate: publicProcedure.query(() => {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'A template with this name already exists.',
      cause: new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on Client_name_key',
        {
          code: 'P2002',
          clientVersion: 'test',
        }
      ),
    });
  }),
  deliberateWriteConflict: publicProcedure.query(() => {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Reload the current version before trying again.',
      cause: new Prisma.PrismaClientKnownRequestError(
        'Transaction failed due to a write conflict',
        {
          code: 'P2034',
          clientVersion: 'test',
        }
      ),
    });
  }),
  unwordedConflict: publicProcedure.query(() => {
    throw new TRPCError({
      code: 'CONFLICT',
      cause: new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on Client_name_key',
        {
          code: 'P2002',
          clientVersion: 'test',
        }
      ),
    });
  }),
});

async function call(path: string, input?: unknown) {
  const url = new URL(`http://localhost/api/trpc/${path}`);
  if (input !== undefined) {
    url.searchParams.set('input', JSON.stringify(superjson.serialize(input)));
  }
  const response = await fetchRequestHandler({
    endpoint: '/api/trpc',
    req: new Request(url),
    router: testRouter,
    createContext: () => ({}) as never,
  });
  const body = (await response.json()) as {
    error: {
      json: {
        message: string;
        code: number;
        data: { code: string; httpStatus: number; validation: unknown; stack?: unknown };
      };
    };
  };
  return { ...body.error.json, transportStatus: response.status };
}

describe('trpc errorFormatter', () => {
  it.each([
    ['staleUpdate', 'NOT_FOUND', 404, 'Record not found.'],
    ['duplicate', 'CONFLICT', 409, 'A record with those details already exists.'],
    ['foreignKey', 'CONFLICT', 409, 'This change conflicts with a related record.'],
  ])(
    'maps Prisma failures without exposing ORM details (%s)',
    async (path, code, status, message) => {
      const error = await call(path);
      expect(error).toMatchObject({ message, data: { code, httpStatus: status } });
      expect(JSON.stringify(error)).not.toMatch(/prisma\.|Invalid .*invocation|Client_name_key/i);
    }
  );

  it('withholds unknown Prisma errors in every environment', async () => {
    expect((await call('unknownPrisma')).message).toBe(GENERIC);
  });

  it.each([
    ['deliberateDuplicate', 'A template with this name already exists.'],
    ['deliberateWriteConflict', 'Reload the current version before trying again.'],
  ])('preserves deliberate errors with a Prisma cause (%s)', async (path, message) => {
    const error = await call(path);
    expect(error).toMatchObject({
      message,
      code: -32009,
      data: { code: 'CONFLICT', httpStatus: 409 },
      transportStatus: 409,
    });
  });

  it('sanitizes raw Prisma text without changing a deliberate code', async () => {
    const error = await call('unwordedConflict');
    expect(error).toMatchObject({
      message: 'A record with those details already exists.',
      data: { code: 'CONFLICT', httpStatus: 409 },
      transportStatus: 409,
    });
    expect(JSON.stringify(error)).not.toMatch(/prisma\.|Invalid .*invocation|Client_name_key/i);
  });

  it('reformats input-validation failures', async () => {
    const error = await call('validated', { key: 'NOPE' });
    expect(error.data.code).toBe('BAD_REQUEST');
    expect(error.message).toBe('Key: Use lowercase letters only.');
    expect(error.data.validation).toEqual({ key: ['Use lowercase letters only.'] });
  });

  it('does not present a resolver schema failure as input validation', async () => {
    const error = await call('internal');
    expect(error.data.code).toBe('INTERNAL_SERVER_ERROR');
    expect(error.data.validation).toBeNull();
    expect(error.message).toBe(GENERIC);
    expect(JSON.stringify(error)).not.toContain('internalOnlyField');
  });

  it('never publishes the server stack on any error', async () => {
    expect((await call('internal')).data.stack).toBeUndefined();
    expect((await call('validated', { key: 'NOPE' })).data.stack).toBeUndefined();
  });
});

describe('trpc errorFormatter in production', () => {
  beforeEach(() => vi.stubEnv('NODE_ENV', 'production'));
  afterEach(() => vi.unstubAllEnvs());

  it.each(['crashed', 'thrownValue', 'internal'])(
    'withholds unexpected failures (%s)',
    async (path) => {
      const error = await call(path);
      expect(error.data).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 });
      expect(error.message).toBe(GENERIC);
      expect(JSON.stringify(error)).not.toMatch(/users_email_key|internalOnlyField/);
    }
  );

  it.each([
    ['deliberate', 'Camera credential storage is not configured.'],
    ['deliberateWithCause', 'Rolled back: another operation failed in the same request.'],
  ])('preserves deliberate errors (%s)', async (path, message) => {
    const error = await call(path);
    expect(error.data.code).toBe('INTERNAL_SERVER_ERROR');
    expect(error.message).toBe(message);
  });

  it('preserves other intentional codes and validation', async () => {
    expect(await call('conflict')).toMatchObject({
      message: 'This message changed while you were working.',
      data: { code: 'CONFLICT' },
    });
    expect(await call('notFound')).toMatchObject({
      message: 'That version no longer exists.',
      data: { code: 'NOT_FOUND' },
    });
    expect(await call('validated', { key: 'NOPE' })).toMatchObject({
      message: 'Key: Use lowercase letters only.',
      data: { code: 'BAD_REQUEST', validation: { key: ['Use lowercase letters only.'] } },
    });
  });
});

describe('trpc errorFormatter outside production', () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each(['test', 'development'])(
    'also sanitizes unexpected failures (NODE_ENV=%s)',
    async (environment) => {
      vi.stubEnv('NODE_ENV', environment);
      expect((await call('crashed')).message).toBe(GENERIC);
      expect((await call('thrownValue')).message).toBe(GENERIC);
    }
  );
});
