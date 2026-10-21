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
 */
import { describe, expect, it, vi } from 'vitest';
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

const testRouter = router({
  // Input validation: tRPC rejects before the resolver runs.
  validated: publicProcedure
    .input(z.object({ key: z.string().regex(/^[a-z]+$/, 'Use lowercase letters only.') }))
    .query(() => 'ok'),
  // A raw parse inside the body: the ZodError escapes the resolver instead.
  internal: publicProcedure.query(() => internalSchema.parse({ internalOnlyField: 1 })),
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
        data: { code: string; validation: unknown; stack?: unknown };
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
