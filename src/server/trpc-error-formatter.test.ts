/**
 * The `errorFormatter` gate, exercised through the real transport.
 *
 * tRPC sets `error.cause` to a ZodError in TWO unrelated situations:
 *   - input validation failed            → code BAD_REQUEST      → reformat
 *   - a raw `schema.parse()` threw in a
 *     procedure body                     → INTERNAL_SERVER_ERROR → do NOT
 *
 * Without the code gate the second case would reach the client wearing a
 * field-level validation message and would publish internal schema field names
 * in `data.validation`. These cases pin both halves.
 *
 * In production, an unexpected failure — anything a procedure throws that is not
 * a TRPCError, which tRPC wraps in an INTERNAL_SERVER_ERROR carrying the thrown
 * error's own message — reaches the client with a generic message instead.
 * Deliberate TRPCErrors keep their words, internal ones included, and every
 * other code is untouched; outside production the pass-through stays as pinned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import superjson from 'superjson';
import { z } from 'zod';

// Same stubs `anonymous-fallback.test.ts` uses: `@/server/trpc` is imported for
// its REAL tRPC instance, so only its unrelated server-side dependencies are
// stubbed. The `errorFormatter` under test is untouched.
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
/** What an unmapped database error says about the schema behind it. */
const INTERNALS =
  'duplicate key value violates unique constraint "users_email_key" on table "users"';
const GENERIC = 'Something went wrong on our side. Please try again.';

const testRouter = router({
  // Input validation: tRPC rejects before the resolver runs.
  validated: publicProcedure
    .input(z.object({ key: z.string().regex(/^[a-z]+$/, 'Use lowercase letters only.') }))
    .query(() => 'ok'),
  // A raw parse inside the body: the ZodError escapes the resolver instead.
  internal: publicProcedure.query(() => internalSchema.parse({ internalOnlyField: 1 })),
  // Unexpected failures: an Error, and a value that is not even one.
  crashed: publicProcedure.query(() => {
    throw new Error(INTERNALS);
  }),
  thrownValue: publicProcedure.query(() => {
    throw `raw: ${INTERNALS}`;
  }),
  // Deliberate refusals, internal or not, with or without an internal cause.
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
  return body.error.json;
}

describe('trpc errorFormatter', () => {
  it('reformats input-validation failures', async () => {
    const error = await call('validated', { key: 'NOPE' });

    expect(error.data.code).toBe('BAD_REQUEST');
    expect(error.message).toBe('Key: Use lowercase letters only.');
    expect(error.data.validation).toEqual({ key: ['Use lowercase letters only.'] });
  });

  it('leaves a ZodError cause alone when the error is not a BAD_REQUEST', async () => {
    // The message an untouched INTERNAL_SERVER_ERROR carries. tRPC substitutes no
    // generic text for this code — it passes `error.message` through, and for a
    // ZodError that is the serialized issues. Asserting equality with it pins the
    // pass-through itself; reformatted, this would instead read
    // "Internal Only Field: Invalid input: expected string, received number".
    const untouched = internalSchema.safeParse({ internalOnlyField: 1 });

    const error = await call('internal');

    expect(error.data.code).toBe('INTERNAL_SERVER_ERROR');
    expect(error.data.validation).toBeNull();
    expect(error.message).toBe(untouched.error?.message);
  });

  it('never publishes the server stack on any error', async () => {
    // tRPC attaches `data.stack` outside production; the formatter must drop it
    // so file paths and bundle chunk names never reach the client. An internal
    // error is the case that carries a stack by default.
    const internal = await call('internal');
    expect(internal.data.stack).toBeUndefined();

    const validated = await call('validated', { key: 'NOPE' });
    expect(validated.data.stack).toBeUndefined();
  });
});

describe('trpc errorFormatter in production', () => {
  beforeEach(() => vi.stubEnv('NODE_ENV', 'production'));
  afterEach(() => vi.unstubAllEnvs());

  it.each(['crashed', 'thrownValue', 'internal'])(
    'withholds the message of an unexpected failure (%s)',
    async (path) => {
      const error = await call(path);

      expect(error.data).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 });
      expect(error.message).toBe(GENERIC);
      // Nowhere in the body: not the message, not a stack that repeats it.
      expect(JSON.stringify(error)).not.toMatch(/users_email_key|internalOnlyField/);
    }
  );

  it.each([
    ['deliberate', 'Camera credential storage is not configured.'],
    ['deliberateWithCause', 'Rolled back: another operation failed in the same request.'],
  ])('keeps the words of a deliberate INTERNAL_SERVER_ERROR (%s)', async (path, message) => {
    const error = await call(path);

    expect(error.data.code).toBe('INTERNAL_SERVER_ERROR');
    expect(error.message).toBe(message);
  });

  it('leaves every other code alone', async () => {
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
    'passes an unexpected failure through as before (NODE_ENV=%s)',
    async (environment) => {
      vi.stubEnv('NODE_ENV', environment);

      expect((await call('crashed')).message).toBe(INTERNALS);
      expect((await call('thrownValue')).message).toBe(`raw: ${INTERNALS}`);
    }
  );
});
