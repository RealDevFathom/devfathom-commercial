// @vitest-environment node
/**
 * Opt-in real PG + TCP HTTP probe. Run the adjacent Python runner.
 * Real: exported GET/POST, fetch adapter, client, superjson, db.ts, scoped-db,
 * Prisma/pg transactions, migrated restaurant_branches RLS, separate observer.
 * Fixtures: actor/host/context and procedure router. No Next server or real login.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { createTRPCUntypedClient, httpBatchLink } from '@trpc/client';
import type { AnyTRPCRouter } from '@trpc/server';
import superjson from 'superjson';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const state = vi.hoisted(() => ({
  observations: [] as { txid: string; pid: number; tenant: string; actor: string }[],
  arrivals: [] as (() => void)[],
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({
  resolveTenantActor: async ({ request }: { request: Request }) =>
    request.headers.get('x-probe-anonymous')
      ? null
      : {
          session: {
            user: {
              id: `fixture-${request.headers.get('x-probe-tenant')}`,
              organizationId: request.headers.get('x-probe-tenant'),
            },
          },
          support: null,
        },
}));
vi.mock('@/lib/tenancy/host', async (original) => ({
  ...(await original<object>()),
  requireOrganizationForRequest: async (_req: Request, id: string) => ({ id, status: 'ACTIVE' }),
  resolveExplicitOrganizationByHost: async () => ({ id: 'boundary_org_a', status: 'ACTIVE' }),
}));
vi.mock('@/lib/auth/anonymous-tenant', () => ({ organizationForAnonymousToken: async () => null }));
vi.mock('@/server/routers/anonymous-fallback', () => ({ anonymousFallbackRouter: {} }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: async (options: unknown) => options }));
vi.mock('@/server/routers/_app', async () => {
  const { initTRPC } = await import('@trpc/server');
  const { z } = await import('zod');
  const transformer = (await import('superjson')).default;
  const t = initTRPC
    .context<{ db: ScopedDb; req: Request; session: unknown }>()
    .create({ transformer });
  const snapshot = async (db: ScopedDb) => {
    const [scope] = await db.$queryRawUnsafe<
      { txid: string; pid: number; tenant: string; platform: string; actor: string }[]
    >(
      `SELECT pg_current_xact_id()::text AS txid, pg_backend_pid() AS pid,
       current_setting('app.current_organization_id',true) AS tenant,
       current_setting('app.is_platform_admin',true) AS platform,
       current_setting('app.current_user_id',true) AS actor`
    );
    state.observations.push(scope);
    const rows = await db.restaurantBranch.findMany({
      select: { id: true, organizationId: true },
      orderBy: { id: 'asc' },
    });
    return { ...scope, rows };
  };
  const write = async (db: ScopedDb, id: string, organizationId?: string) => {
    await db.restaurantBranch.create({
      data: {
        id,
        name: 'Synthetic boundary probe',
        code: id.toUpperCase(),
        ...(organizationId ? { organizationId } : {}),
      },
    });
    return snapshot(db);
  };
  return {
    appRouter: t.router({
      read: t.procedure.query(({ ctx }) => snapshot(ctx.db)),
      write: t.procedure.input(z.string()).mutation(({ ctx, input }) => write(ctx.db, input)),
      crossTenant: t.procedure
        .input(z.string())
        .mutation(({ ctx, input }) => write(ctx.db, input, 'boundary_org_b')),
      fail: t.procedure.input(z.string()).mutation(async ({ ctx, input }) => {
        await write(ctx.db, input);
        throw new Error('synthetic event failed');
      }),
      readFail: t.procedure.query(async ({ ctx }) => {
        await write(ctx.db, 'query-aborted');
        throw new Error('synthetic lookup failed');
      }),
      overlap: t.procedure.input(z.string()).mutation(async ({ ctx, input }) => {
        const before = await write(ctx.db, input);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('concurrency barrier timeout')), 5000);
          state.arrivals.push(() => {
            clearTimeout(timer);
            resolve();
          });
          if (state.arrivals.length === 2) state.arrivals.splice(0).forEach((release) => release());
        });
        const after = await snapshot(ctx.db);
        if (ctx.req.headers.get('x-probe-fail')) throw new Error('synthetic concurrent failure');
        return { before, after };
      }),
      passwordReset: t.router({
        request: t.procedure.input(z.string()).mutation(async ({ ctx, input }) => {
          if (ctx.session !== null) throw new Error('expected null anonymous session');
          await write(ctx.db, input);
          throw new Error('synthetic anonymous failure');
        }),
      }),
    }),
  };
});

const enabled = process.env.BOUNDARY_REAL_HTTP === '1';
const suite = enabled ? describe : describe.skip;
const A = 'boundary_org_a';
const B = 'boundary_org_b';
// The runner owns port defaults and passes the same values to this probe.
const pgPort = process.env.BOUNDARY_PG_PORT;
const httpPort = Number(process.env.BOUNDARY_HTTP_PORT);
const endpoint = `http://127.0.0.1:${httpPort}/api/trpc`;
function client(tenant = A, headers: Record<string, string> = {}) {
  return createTRPCUntypedClient<AnyTRPCRouter>({
    links: [
      httpBatchLink({
        url: endpoint,
        transformer: superjson,
        headers: { 'x-probe-tenant': tenant, ...headers },
      }),
    ],
  });
}
let server: Server;
let owner: pg.Client;
let db: ScopedDb;
const statuses = async () =>
  Promise.all(
    state.observations.map(
      async ({ txid }) =>
        (await owner.query('SELECT pg_xact_status($1::xid8) AS status', [txid])).rows[0]
          .status as string
    )
  );
const stored = async () => {
  await owner.query('BEGIN');
  try {
    await owner.query("SELECT set_config('app.is_platform_admin','true',true)");
    return (await owner.query('SELECT id FROM restaurant_branches ORDER BY id')).rows.map(
      (r: { id: string }) => r.id
    );
  } finally {
    await owner.query('ROLLBACK');
  }
};

suite('real restricted PostgreSQL through GET/POST over loopback HTTP', () => {
  beforeAll(async () => {
    for (const key of ['DATABASE_URL', 'BOUNDARY_OWNER_DATABASE_URL']) {
      const url = new URL(process.env[key]!);
      expect([url.hostname, url.port, url.pathname]).toEqual([
        '127.0.0.1',
        pgPort,
        '/boundary_disposable',
      ]);
    }
    db = (await import('@/lib/db')).db;
    owner = new pg.Client({ connectionString: process.env.BOUNDARY_OWNER_DATABASE_URL });
    await owner.connect();
    const { GET, POST } = await import('./[trpc]/route');
    server = createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const request = new Request(`http://127.0.0.1:${httpPort}${incoming.url}`, {
          method: incoming.method,
          headers: incoming.headers as Record<string, string>,
          ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
        });
        const response = await (incoming.method === 'POST' ? POST : GET)(request);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        outgoing.writeHead(500);
        outgoing.end('probe transport error');
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(httpPort, '127.0.0.1', resolve);
    });
  });
  beforeEach(async () => {
    state.observations.length = 0;
    await owner.query('BEGIN');
    await owner.query("SELECT set_config('app.is_platform_admin','true',true)");
    await owner.query('DELETE FROM restaurant_branches');
    await owner.query('COMMIT');
  });
  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    if (db) await db.$disconnect();
    if (owner) await owner.end();
  });

  it('uses restricted roles and existing FORCE RLS; rejects cross-tenant insertion', async () => {
    const roles = await owner.query(
      "SELECT rolname,rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname IN ('boundary_owner','boundary_runtime') ORDER BY rolname"
    );
    expect(roles.rows).toEqual([
      { rolname: 'boundary_owner', rolsuper: false, rolbypassrls: false, rolcreaterole: false },
      { rolname: 'boundary_runtime', rolsuper: false, rolbypassrls: false, rolcreaterole: false },
    ]);
    const relation = (
      await owner.query(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='restaurant_branches'::regclass"
      )
    ).rows[0];
    expect(relation).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    await expect(client().mutation('crossTenant', 'forbidden')).rejects.toThrow(
      /row-level security/i
    );
    expect(await stored()).toEqual([]);
  });
  it('commits GET query and POST write transactions, visible from another connection', async () => {
    const c = client();
    await c.mutation('write', 'saved');
    const result = await c.query('read');
    expect(result).toMatchObject({
      tenant: A,
      platform: 'false',
      rows: [{ id: 'saved', organizationId: A }],
    });
    expect(await stored()).toEqual(['saved']);
    expect(await statuses()).toEqual(['committed', 'committed']);
  });
  it('commits both mutations in a successful HTTP batch', async () => {
    const c = client();
    await Promise.all([c.mutation('write', 'one'), c.mutation('write', 'two')]);
    expect(new Set(state.observations.map((o) => o.txid)).size).toBe(1);
    expect(await stored()).toEqual(['one', 'two']);
    expect(await statuses()).toEqual(['committed', 'committed']);
  });
  it('rolls back application failure after write and permits same-key retry', async () => {
    await expect(client().mutation('fail', 'retry-key')).rejects.toThrow('synthetic event failed');
    expect(await stored()).toEqual([]);
    expect(await statuses()).toEqual(['aborted']);
    await client().mutation('write', 'retry-key');
    expect(await stored()).toEqual(['retry-key']);
  });
  it('rejects every mixed mutation sibling and preserves original failure', async () => {
    const c = client();
    const results = await Promise.allSettled([
      c.mutation('write', 'sibling'),
      c.mutation('fail', 'failed'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(results[0]).toMatchObject({
      reason: { message: expect.stringMatching(/Rolled back.*synthetic event failed/) },
    });
    expect(results[1]).toMatchObject({ reason: { message: 'synthetic event failed' } });
    expect(new Set(state.observations.map((o) => o.txid)).size).toBe(1);
    expect(await statuses()).toEqual(['aborted', 'aborted']);
    expect(await stored()).toEqual([]);
  });
  it('preserves healthy GET query siblings while rolling back failed query writes', async () => {
    const c = client();
    const results = await Promise.allSettled([c.query('read'), c.query('readFail')]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(await stored()).toEqual([]);
    expect(await statuses()).toEqual(['aborted', 'aborted']);
  });
  it('rolls back existing anonymous allowlisted path with null session', async () => {
    await expect(
      client(A, { 'x-probe-anonymous': '1' }).mutation('passwordReset.request', 'anonymous')
    ).rejects.toThrow('synthetic anonymous failure');
    expect(await stored()).toEqual([]);
    expect(await statuses()).toEqual(['aborted']);
    expect(state.observations.every((scope) => scope.actor === '')).toBe(true);
  });
  it('isolates overlapping tenant transactions and clears pooled context after abort', async () => {
    const results = await Promise.allSettled([
      client(A, { 'x-probe-fail': '1' }).mutation('overlap', 'a-aborted'),
      client(B).mutation('overlap', 'b-saved'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    expect(new Set(state.observations.map((o) => o.pid)).size).toBe(2);
    const survivor = (results[1] as PromiseFulfilledResult<{ before: unknown; after: unknown }>)
      .value;
    for (const scope of [survivor.before, survivor.after])
      expect(scope).toMatchObject({ tenant: B, rows: [{ id: 'b-saved', organizationId: B }] });
    expect(await stored()).toEqual(['b-saved']);
    expect(((await client(A).query('read')) as { rows: unknown }).rows).toEqual([]);
    expect(((await client(B).query('read')) as { rows: unknown }).rows).toEqual([
      { id: 'b-saved', organizationId: B },
    ]);
    expect(state.observations.length).toBeGreaterThan(0);
    for (const scope of state.observations) expect(scope.actor).toBe(`fixture-${scope.tenant}`);
    const used = new Set(state.observations.map((o) => o.pid));
    // Occupy all ten production pool slots concurrently so every used connection
    // is checked outside the tenant wrapper, including both overlap connections.
    const releases: (() => void)[] = [];
    const clean = await Promise.all(
      Array.from({ length: 10 }, () =>
        db.$transaction(
          async (tx) => {
            const [scope] = await tx.$queryRawUnsafe<
              {
                pid: number;
                tenant: string | null;
                platform: string | null;
                actor: string | null;
              }[]
            >(
              "SELECT pg_backend_pid() AS pid,current_setting('app.current_organization_id',true) AS tenant,current_setting('app.is_platform_admin',true) AS platform,current_setting('app.current_user_id',true) AS actor"
            );
            const rows = await tx.restaurantBranch.findMany();
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('pool barrier timeout')), 5000);
              releases.push(() => {
                clearTimeout(timer);
                resolve();
              });
              if (releases.length === 10) releases.forEach((release) => release());
            });
            return { ...scope, rows };
          },
          { timeout: 10000 }
        )
      )
    );
    for (const scope of clean) {
      expect(scope.tenant ?? '').toBe('');
      expect(scope.platform ?? '').toBe('');
      expect(scope.actor ?? '').toBe('');
      expect(scope.rows).toEqual([]);
    }
    expect([...used].every((pid) => clean.some((scope) => scope.pid === pid))).toBe(true);
  });
  it('rejects streaming before resolver execution or database writes', async () => {
    await expect(
      client(A, { 'trpc-accept': 'application/jsonl' }).mutation('write', 'stream')
    ).rejects.toThrow(/not supported/);
    expect(state.observations).toEqual([]);
    expect(await stored()).toEqual([]);
  });
});
