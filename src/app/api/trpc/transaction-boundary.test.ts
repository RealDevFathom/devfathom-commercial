/**
 * The transaction boundary at `/api/trpc`.
 *
 * Every tRPC request runs inside one `withTenantDb` transaction, and the fetch
 * adapter runs *inside* that transaction's callback. `fetchRequestHandler` never
 * rejects — a resolver that throws comes back as a fulfilled error `Response` —
 * so the callback used to resolve normally and the transaction COMMITTED the
 * writes the failed procedure had already made. PostgreSQL aborts a transaction
 * by itself only for SQL errors, so an application-level failure (a failed event
 * write, a thrown invariant) was invisible to it.
 *
 * These tests exercise the REAL `withTenantDb`/`exposeNestedTransaction` wrapper
 * and the REAL installed `fetchRequestHandler` against a real router, with only
 * the Prisma client replaced by a double that records COMMIT on a resolved
 * callback and ROLLBACK on a rejected one. That is the same composition the
 * route builds in production, so what is pinned here is the control flow, not a
 * mock's opinion.
 *
 * Not covered here, and still owed to a migrated multi-connection PostgreSQL/RLS
 * acceptance run: that ROLLBACK actually discards the rows, that RLS holds
 * across the boundary, and concurrent behaviour.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  /** Rows the current transaction has written, restored on ROLLBACK. */
  writes: [] as string[],
  /** One entry per transaction, in order. */
  outcomes: [] as string[],
  /** GUC statements the tenant scope issued before handing over the client. */
  scopeStatements: [] as string[],
  scopeTenants: [] as string[],
  scopeActors: [] as string[],
  credential: { failedAttempts: 0, lockedUntil: null as Date | null },
  verifyPin: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', () => ({ can: vi.fn(async () => true) }));
vi.mock('@/lib/restaurant/operator-credentials', async () => ({
  ...(await vi.importActual<typeof import('@/lib/restaurant/operator-credentials')>(
    '@/lib/restaurant/operator-credentials'
  )),
  verifyOperatorCredential: harness.verifyPin,
}));

vi.mock('@/lib/db', () => {
  const tx = {
    $queryRawUnsafe: async (sql: string, organizationId: string, userId: string) => {
      harness.scopeTenants.push(organizationId);
      harness.scopeActors.push(userId);
      harness.scopeStatements.push(sql);
      return [];
    },
    ledger: {
      create: async ({ data }: { data: { label: string } }) => {
        harness.writes.push(data.label);
        return data;
      },
    },
  };

  return {
    db: {
      async $transaction(run: (client: typeof tx) => Promise<unknown>) {
        const snapshot = [...harness.writes];
        // Each connection buffers its own credential writes. An outer rollback
        // cannot undo a credential update committed on a separate connection.
        let credentialUpdate: typeof harness.credential | undefined;
        const client = {
          ...tx,
          $queryRaw: async () => [],
          user: { findFirst: async () => ({ id: 'user_1', status: 'ACTIVE' }) },
          restaurantOperatorCredential: {
            findFirst: async () => ({
              id: 'credential',
              credentialHash: 'hash',
              ...(credentialUpdate ?? harness.credential),
              staffProfile: {
                status: 'ACTIVE',
                user: { id: 'witness', organizationId: 'org_acme', status: 'ACTIVE' },
              },
            }),
            update: async ({ data }: { data: typeof harness.credential }) => {
              credentialUpdate = data;
              return data;
            },
          },
        };
        try {
          const result = await run(client);
          if (credentialUpdate) harness.credential = credentialUpdate;
          harness.outcomes.push('COMMIT');
          return result;
        } catch (error) {
          harness.writes.splice(0, harness.writes.length, ...snapshot);
          harness.outcomes.push('ROLLBACK');
          throw error;
        }
      },
    },
  };
});

// A real router, with the production transformer, so the assertions below read
// the serialization the client actually receives.
vi.mock('@/server/routers/_app', async () => {
  const { initTRPC, TRPCError } = await import('@trpc/server');
  const superjson = (await import('superjson')).default;
  const { authorizeControlledRestoration, ControlledRestorationDenied } =
    await import('@/lib/pharmacy/controlled-restoration-authorization');

  const t = initTRPC
    .context<{
      db: { ledger: { create: (args: { data: { label: string } }) => Promise<unknown> } };
    }>()
    .create({ transformer: superjson });

  return {
    appRouter: t.router({
      witnessPin: t.procedure.mutation(async ({ ctx }) => {
        try {
          await authorizeControlledRestoration(
            ctx.db as never,
            { organizationId: 'org_acme', branchId: 'branch', actorId: 'user_1' },
            { staffProfileId: 'staff', pin: '1234' },
            'pharmacy:safety'
          );
        } catch (error) {
          if (error instanceof ControlledRestorationDenied) {
            throw new TRPCError({ code: 'FORBIDDEN', message: error.message });
          }
          throw error;
        }
        return { witnessed: true };
      }),
      write: t.procedure.mutation(async ({ ctx }) => {
        await ctx.db.ledger.create({ data: { label: 'requisition' } });
        return { committed: true };
      }),
      // The shape of the reported defect: the draft and its idempotency action
      // are written, then the event that gives them meaning fails.
      writeThenFail: t.procedure.mutation(async ({ ctx }) => {
        await ctx.db.ledger.create({ data: { label: 'draft' } });
        await ctx.db.ledger.create({ data: { label: 'action' } });
        throw new Error('event failed');
      }),
      passwordReset: t.router({
        request: t.procedure.mutation(async ({ ctx }) => {
          await ctx.db.ledger.create({ data: { label: 'anonymous-action' } });
          throw new Error('anonymous event failed');
        }),
      }),
      read: t.procedure.query(() => ({ read: true })),
      // A deliberate refusal: the caller is told exactly this, and nothing failed.
      refuse: t.procedure.mutation(() => {
        throw new TRPCError({ code: 'CONFLICT', message: 'Already taken.' });
      }),
      // A query that fails after an incidental write — the shape of one broken
      // widget on a page whose other queries share its GET batch.
      readThenFail: t.procedure.query(async ({ ctx }) => {
        await ctx.db.ledger.create({ data: { label: 'cache' } });
        throw new Error('lookup failed');
      }),
    }),
  };
});

vi.mock('@/server/routers/anonymous-fallback', () => ({ anonymousFallbackRouter: {} }));

vi.mock('@/server/trpc', () => ({
  createTRPCContext: async (opts: { db: unknown }) => ({ db: opts.db }),
}));

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  requireOrganizationForRequest: vi.fn(),
  resolveOrganizationById: vi.fn(),
  resolveExplicitOrganizationByHost: vi.fn(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/lib/auth/anonymous-tenant', () => ({
  organizationForAnonymousToken: vi.fn(async () => null),
}));
vi.mock('@/lib/auth/anonymous-rate-limit', () => ({
  admitAnonymousRequest: () => ({ ok: true }),
}));
vi.mock('@/lib/tenancy/host', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tenancy/host')>('@/lib/tenancy/host');
  return {
    ...actual,
    requireOrganizationForRequest: mocks.requireOrganizationForRequest,
    resolveOrganizationById: mocks.resolveOrganizationById,
    resolveExplicitOrganizationByHost: mocks.resolveExplicitOrganizationByHost,
  };
});

import { createTRPCUntypedClient, httpBatchLink, TRPCClientError } from '@trpc/client';
import type { AnyTRPCRouter } from '@trpc/server';
import superjson from 'superjson';
import { TenantHostError } from '@/lib/tenancy/host';
import { GET, POST } from './[trpc]/route';

const ORGANIZATION = { id: 'org_acme', slug: 'acme', status: 'ACTIVE' };
const SESSION = { expires: 'later', user: { id: 'user_1', organizationId: 'org_acme' } };

const ENDPOINT = 'http://acme.example.com/api/trpc';
const url = (path: string, query = '') => `${ENDPOINT}/${path}${query}`;

/** A signed-in mutation call, batched exactly as `httpBatchLink` sends them. */
function mutate(paths: string[], headers: Record<string, string> = {}) {
  const input = Object.fromEntries(paths.map((_path, index) => [String(index), { json: null }]));
  return POST(
    new Request(url(paths.join(','), '?batch=1'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(input),
    })
  );
}

/**
 * The client the app actually configures — real `httpBatchLink`, real superjson,
 * real result decoding — with its fetch routed straight into the route handler.
 * Whether a caller sees success or failure is decided by tRPC's own
 * `transformResult`, not by this test's reading of the body.
 */
const client = createTRPCUntypedClient<AnyTRPCRouter>({
  links: [
    httpBatchLink({
      url: ENDPOINT,
      transformer: superjson,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        POST(new Request(input as string, init))) as typeof fetch,
    }),
  ],
});

type Settled = PromiseSettledResult<unknown>;
const reason = (settled: Settled) =>
  settled.status === 'rejected' ? (settled.reason as TRPCClientError<AnyTRPCRouter>) : null;

beforeEach(() => {
  vi.clearAllMocks();
  harness.writes.length = 0;
  harness.outcomes.length = 0;
  harness.scopeStatements.length = 0;
  harness.scopeTenants.length = 0;
  harness.scopeActors.length = 0;
  harness.credential = { failedAttempts: 0, lockedUntil: null };
  harness.verifyPin.mockReset().mockResolvedValue(false);
  mocks.resolveTenantActor.mockResolvedValue({ session: SESSION, support: null });
  mocks.requireOrganizationForRequest.mockResolvedValue(ORGANIZATION);
});

describe('durable witness PIN lockout through HTTP', () => {
  it('accepts a fresh valid PIN and clears prior failed attempts', async () => {
    harness.credential.failedAttempts = 2;
    harness.verifyPin.mockResolvedValue(true);
    expect((await mutate(['witnessPin'])).status).toBe(200);
    expect(harness.credential).toEqual({ failedAttempts: 0, lockedUntil: null });
    expect(harness.outcomes).toEqual(['COMMIT', 'COMMIT']);
  });

  it('commits each failed attempt despite request rollback and refuses a correct PIN while locked', async () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect((await mutate(['witnessPin'])).status).toBe(403);
      expect(harness.credential.failedAttempts).toBe(attempt < 5 ? attempt : 0);
    }
    expect(harness.credential.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(harness.outcomes).toEqual(
      Array.from({ length: 5 }, () => ['COMMIT', 'ROLLBACK']).flat()
    );
    expect(harness.verifyPin).toHaveBeenCalledTimes(5);
    harness.verifyPin.mockResolvedValue(true);
    expect((await mutate(['witnessPin'])).status).toBe(403);
    expect(harness.verifyPin).toHaveBeenCalledTimes(5);
    expect(harness.writes).toEqual([]);
    expect(harness.scopeTenants.every((id) => id === 'org_acme')).toBe(true);
    expect(harness.scopeActors.every((id) => id === 'user_1')).toBe(true);
  });

  it('keeps the failed attempt when a sibling mutation also rolls back', async () => {
    const response = await mutate(['write', 'witnessPin']);
    const body = await response.json();
    expect(body[0].error.json.data.code).toBe('INTERNAL_SERVER_ERROR');
    expect(body[1].error.json.data.code).toBe('FORBIDDEN');
    expect(harness.credential.failedAttempts).toBe(1);
    expect(harness.writes).toEqual([]);
    expect(harness.outcomes).toEqual(['COMMIT', 'ROLLBACK']);
  });
});

describe('a procedure that fails after writing', () => {
  it('binds only the verified session actor despite forged request headers', async () => {
    await mutate(['write'], { 'x-user-id': 'forged', 'x-actor-id': 'forged' });
    expect(harness.scopeActors).toEqual(['user_1']);
  });

  it('rolls the owning transaction back instead of committing a partial draft', async () => {
    const response = await mutate(['writeThenFail']);

    // The error still reaches the caller, with tRPC's own status and shape.
    expect(response.status).toBe(500);
    const body = (await response.json()) as [{ error: { json: { message: string } } }];
    expect(body[0].error.json.message).toBe('event failed');

    // The boundary: one transaction, rolled back, retaining nothing.
    expect(harness.outcomes).toEqual(['ROLLBACK']);
    expect(harness.writes).toEqual([]);
  });

  it('reports the rolled-back sibling of a batch as an error, never as a result', async () => {
    const response = await mutate(['write', 'writeThenFail']);

    // One transaction spans the batch, so it cannot half-apply. Discarding the
    // successful sibling is the conservative direction: a client can retry it,
    // but a half-applied batch could not be repaired.
    expect(harness.outcomes).toEqual(['ROLLBACK']);
    expect(harness.writes).toEqual([]);

    // Nothing survived, so nothing may be described as a `result`. The 207 that
    // "mixed outcomes" would produce is itself the bug: `httpBatchLink` reads
    // each entry independently, so a `result` entry fulfils its caller's promise
    // whatever the overall status says.
    type Entry = { error: { json: { message: string; data: { path?: string } } } };
    const body = (await response.json()) as [Entry, Entry];
    expect(body).toHaveLength(2);
    expect(body[0]).not.toHaveProperty('result');
    expect(body[1]).not.toHaveProperty('result');
    expect(response.status).toBe(500);

    // The discarded entry says so, names its own procedure, and carries the
    // sibling failure that caused the rollback.
    expect(body[0].error.json.message).toMatch(/rolled back/i);
    expect(body[0].error.json.message).toContain('"writeThenFail"');
    expect(body[0].error.json.message).toContain('event failed');
    expect(body[0].error.json.data.path).toBe('write');

    // The original failure is preserved exactly, not replaced by the rollback.
    expect(body[1].error.json.message).toBe('event failed');
    expect(body[1].error.json.data.path).toBe('writeThenFail');
  });

  it('rejects both promises in the real client, with no ID for a discarded row', async () => {
    const settled = await Promise.allSettled([
      client.mutation('write'),
      client.mutation('writeThenFail'),
    ]);

    // One transaction proves the two calls really did share one HTTP request.
    expect(harness.outcomes).toEqual(['ROLLBACK']);
    expect(harness.writes).toEqual([]);

    // This is the assertion that matters: the caller is told both calls failed.
    // Before the fix the first promise fulfilled, handing the caller an ID for a
    // row the rollback had already discarded — a success no refetch can undo.
    expect(settled.map((entry) => entry.status)).toEqual(['rejected', 'rejected']);
    expect(reason(settled[0])?.message).toMatch(/rolled back/i);
    expect(reason(settled[0])?.data?.code).toBe('INTERNAL_SERVER_ERROR');
    expect(reason(settled[1])?.message).toBe('event failed');
  });
});

/**
 * `application/jsonl` is answered with a lazy stream, so the adapter's response
 * exists before its resolvers do. Nothing could be inferred from it inside the
 * transaction callback, and the callback would resolve — and COMMIT — while the
 * resolvers were still running.
 */
/**
 * A GET batch can only run queries (`allowMethodOverride` is off), and a query's
 * result is what it read — a rollback does not unread it. One failing query must
 * therefore never blank its siblings, which is what the whole-batch rewrite did
 * to the catering Create-order dialog's customer list.
 */
describe('the server-side record of a failure', () => {
  // The errorFormatter withholds an unexpected failure's own message from a
  // production client; the route is where the original must still be recorded.
  it('logs an internal failure with its original error, cause and procedure', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await mutate(['writeThenFail'])).status).toBe(500);
      expect(logged).toHaveBeenCalledExactlyOnceWith(
        '[trpc] writeThenFail failed:',
        expect.objectContaining({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'event failed',
          cause: expect.objectContaining({ message: 'event failed' }),
        })
      );
    } finally {
      logged.mockRestore();
    }
  });

  it('records nothing for a deliberate refusal, which the caller is told in full', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await mutate(['refuse'])).status).toBe(409);
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});

describe('a query batch with one failing query', () => {
  const getBatch = (paths: string[]) => {
    const input = Object.fromEntries(paths.map((_path, index) => [String(index), { json: null }]));
    const query = encodeURIComponent(JSON.stringify(input));
    return GET(new Request(url(paths.join(','), `?batch=1&input=${query}`)));
  };

  it('keeps every other query a result, and the failure exactly as tRPC made it', async () => {
    const response = await getBatch(['read', 'readThenFail', 'read']);

    // tRPC's own mixed-outcome status, untouched.
    expect(response.status).toBe(207);
    type Entry = {
      result?: { data: { json: unknown } };
      error?: { json: { message: string; data: { path: string } } };
    };
    const body = (await response.json()) as Entry[];
    expect(body).toHaveLength(3);
    expect(body[0].result?.data.json).toEqual({ read: true });
    expect(body[2].result?.data.json).toEqual({ read: true });
    expect(body[1].error?.json.message).toBe('lookup failed');
    expect(body[1].error?.json.data.path).toBe('readThenFail');

    // The failing query's partial write is still rolled back.
    expect(harness.outcomes).toEqual(['ROLLBACK']);
    expect(harness.writes).toEqual([]);
  });

  it('fulfils the healthy queries in the real client', async () => {
    const settled = await Promise.allSettled([client.query('read'), client.query('readThenFail')]);

    // One transaction proves the two queries really did share one GET request.
    expect(harness.outcomes).toEqual(['ROLLBACK']);
    expect(settled[0]).toEqual({ status: 'fulfilled', value: { read: true } });
    expect(settled[1].status).toBe('rejected');
    expect(reason(settled[1])?.message).toBe('lookup failed');
  });
});

describe('a single procedure', () => {
  it('returns its own failure unchanged when it is not batched', async () => {
    const response = await POST(
      new Request(url('writeThenFail'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ json: null }),
      })
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      error: { json: { message: string; data: { code: string; path: string } } };
    };
    expect(body.error.json.message).toBe('event failed');
    expect(body.error.json.data).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      path: 'writeThenFail',
    });
    expect(harness.outcomes).toEqual(['ROLLBACK']);
    expect(harness.writes).toEqual([]);
  });

  it('returns a failing query unchanged', async () => {
    const response = await GET(new Request(url('readThenFail', '?input=%7B%22json%22%3Anull%7D')));

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { json: { message: string } } };
    expect(body.error.json.message).toBe('lookup failed');
    expect(harness.outcomes).toEqual(['ROLLBACK']);
    expect(harness.writes).toEqual([]);
  });
});

describe('streamed transports', () => {
  it('refuses a trpc-accept: application/jsonl request before any resolver runs', async () => {
    const response = await mutate(['write'], { 'trpc-accept': 'application/jsonl' });

    expect(response.status).toBe(415);
    const body = (await response.json()) as {
      error: { json: { message: string; data: { code: string } } };
    };
    expect(body.error.json.data.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(body.error.json.message).toMatch(/not supported/i);

    // The point of the guard: no transaction was opened and nothing was written.
    expect(harness.outcomes).toEqual([]);
    expect(harness.writes).toEqual([]);
  });

  it('refuses it by the accept header too, which is the other way tRPC reads it', async () => {
    const response = await mutate(['write'], { accept: 'application/json, application/jsonl' });

    expect(response.status).toBe(415);
    expect(harness.outcomes).toEqual([]);
    expect(harness.writes).toEqual([]);
  });

  it('serves an ordinary request whose accept header is not streamed', async () => {
    const response = await mutate(['write'], { accept: 'application/json' });

    expect(response.status).toBe(200);
    expect(harness.outcomes).toEqual(['COMMIT']);
    expect(harness.writes).toEqual(['requisition']);
  });
});

describe('requests that succeed', () => {
  it('commits exactly once and keeps its writes', async () => {
    const response = await mutate(['write']);

    expect(response.status).toBe(200);
    const body = (await response.json()) as [{ result: { data: { json: unknown } } }];
    expect(body[0].result.data.json).toEqual({ committed: true });
    expect(harness.outcomes).toEqual(['COMMIT']);
    expect(harness.writes).toEqual(['requisition']);
  });

  it('keeps every entry of an all-succeeding batch a result', async () => {
    const response = await mutate(['write', 'write']);

    expect(response.status).toBe(200);
    const body = (await response.json()) as [{ result: unknown }, { result: unknown }];
    expect(body[0]).toHaveProperty('result');
    expect(body[1]).toHaveProperty('result');
    expect(harness.outcomes).toEqual(['COMMIT']);
    expect(harness.writes).toEqual(['requisition', 'requisition']);
  });

  it('fulfils a batch in the real client and keeps its writes', async () => {
    const settled = await Promise.allSettled([client.mutation('write'), client.query('read')]);

    expect(settled).toEqual([
      { status: 'fulfilled', value: { committed: true } },
      { status: 'fulfilled', value: { read: true } },
    ]);
    // A query and a mutation cannot share a batch, so this is two requests.
    expect(harness.outcomes).toEqual(['COMMIT', 'COMMIT']);
    expect(harness.writes).toEqual(['requisition']);
  });

  it('still opens the tenant scope before the router runs', async () => {
    await mutate(['write']);

    expect(harness.scopeStatements).toHaveLength(1);
    expect(harness.scopeStatements[0]).toContain('app.current_organization_id');
  });

  it('commits a read-only batch', async () => {
    const query = encodeURIComponent(JSON.stringify({ '0': { json: null } }));
    const response = await GET(new Request(url('read', `?batch=1&input=${query}`)));

    expect(response.status).toBe(200);
    expect(harness.outcomes).toEqual(['COMMIT']);
  });
});

describe('paths that never reach a transaction', () => {
  it('answers 401 for an unauthenticated, non-allowlisted procedure', async () => {
    mocks.resolveTenantActor.mockResolvedValue(null);

    const response = await mutate(['write']);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(harness.outcomes).toEqual([]);
    expect(harness.writes).toEqual([]);
  });

  it('still maps a tenant host failure to its own status', async () => {
    mocks.requireOrganizationForRequest.mockRejectedValue(
      new TenantHostError('Workspace is suspended.', 423)
    );

    const response = await mutate(['write']);

    expect(response.status).toBe(423);
    await expect(response.json()).resolves.toEqual({ error: 'Workspace is suspended.' });
    expect(harness.outcomes).toEqual([]);
  });
});

// These assert route-to-scope propagation, not PostgreSQL RLS enforcement.
describe('tenant scope across aborts', () => {
  it('uses the next tenant scope after an abort and preserves its successful write', async () => {
    await mutate(['writeThenFail']);
    mocks.resolveTenantActor.mockResolvedValue({
      session: { ...SESSION, user: { ...SESSION.user, organizationId: 'org_beta' } },
      support: null,
    });
    mocks.requireOrganizationForRequest.mockResolvedValue({ ...ORGANIZATION, id: 'org_beta' });
    expect((await mutate(['write'])).status).toBe(200);
    expect(harness.scopeTenants).toEqual(['org_acme', 'org_beta']);
    expect(harness.outcomes).toEqual(['ROLLBACK', 'COMMIT']);
    expect(harness.writes).toEqual(['requisition']);
  });

  it('rejects a cross-tenant host mismatch before opening a transaction', async () => {
    mocks.requireOrganizationForRequest.mockRejectedValue(
      new TenantHostError('Tenant mismatch.', 409)
    );
    expect((await mutate(['write'])).status).toBe(409);
    expect(harness.scopeTenants).toEqual([]);
    expect(harness.writes).toEqual([]);
  });

  it('rolls back an allowlisted anonymous mutation in its resolved tenant', async () => {
    mocks.resolveTenantActor.mockResolvedValue(null);
    mocks.resolveExplicitOrganizationByHost.mockResolvedValue(ORGANIZATION);
    const response = await mutate(['passwordReset.request']);
    expect(response.status).toBe(500);
    expect(harness.scopeTenants).toEqual(['org_acme']);
    expect(harness.outcomes).toEqual(['ROLLBACK']);
    expect(harness.writes).toEqual([]);
  });
});
