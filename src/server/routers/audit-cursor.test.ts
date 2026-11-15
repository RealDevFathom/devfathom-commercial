/**
 * Audit list CURSOR PAGINATION, against a REAL PostgreSQL (#42).
 *
 * `audit.list` paged with `take: limit + 1` and handed the POPPED SENTINEL back
 * as `nextCursor`. Prisma's cursor is INCLUSIVE, so the next call re-selected
 * that row and `skip: 1` threw it away — the sentinel was the first row of the
 * next page, and it was never delivered to anybody. Exactly one row vanished at
 * every page boundary, silently, and the row that vanished was never the row
 * anyone was looking at.
 *
 * This needs a real database, not a mock:
 *
 *  - cursor semantics ARE the defect. `cursor` + `skip` is decided by Prisma
 *    and PostgreSQL, not by application code, so a mock would agree with
 *    whatever the mock was written to agree with;
 *  - a page boundary that lands inside a block of rows sharing one `createdAt`
 *    is resolved by the composite (createdAt desc, id desc) order in the
 *    database. That is the case a weak cursor gets wrong;
 *  - the cross-organization case is decided purely by row level security. The
 *    `where` clause carries no `organizationId` predicate ON PURPOSE — adding
 *    one would make this file pass even with RLS broken, which would turn a
 *    real guard into a decoration.
 *
 * Requires TEST_DATABASE_URL (a migrated, throwaway database — the same
 * variable `test:rls` uses, and never DATABASE_URL). Without it the suite
 * reports itself skipped rather than passing vacuously.
 *
 * The connection role must be NEITHER a superuser NOR BYPASSRLS. Both bypass
 * row level security outright, FORCE included, which would make the
 * cross-organization case pass no matter what. `assertRlsEnforcingRole`
 * refuses to run rather than let that happen quietly; this file's own copy of
 * that check was the model for the shared one (#39).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { assertRlsEnforcingRole } from '@/lib/testing/rls-role-guard';
import type { Prisma } from '@/generated/prisma/client';
import { seedDepartments } from '@/lib/test-support/departments';

// The router reaches `@/server/trpc`, which reaches Auth.js, which cannot load
// outside a Next server runtime. Nothing under test uses it: the context here
// is built by hand. The database, the router and the scoped-db transactions
// are all real.
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// The client in `@/lib/db` reads DATABASE_URL when its module is evaluated, so
// this must happen before the dynamic imports below.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const suffix = randomBytes(6).toString('hex');
const id = (name: string) => `${name}_cursor_${suffix}`;

const ORGANIZATION_A = id('org_a');
const ORGANIZATION_B = id('org_b');
const ADMIN_A = id('user_admin_a');
const ADMIN_B = id('user_admin_b');

const MINUTE = 60 * 1000;

/** Deliberately small: the interesting behaviour is AT the boundary. */
const PAGE = 5;
/** Not a multiple of PAGE, so the final page is genuinely short. */
const TOTAL_A = 23;
const TOTAL_B = 7;

/**
 * Two blocks of rows share one `createdAt` each. With PAGE = 5 the boundaries
 * fall at 5, 10, 15 and 20, so block one (ranks 3..8) straddles the boundary at
 * 5 and block two (ranks 13..17) straddles the one at 15. The tests prove the
 * straddle rather than assuming it.
 */
const TIE_ONE = { first: 3, last: 8 };
const TIE_TWO = { first: 13, last: 17 };

/** Ids sort lexically, so zero-padding makes the id tiebreaker predictable. */
const pad = (n: number) => String(n).padStart(3, '0');
const entryId = (tenant: 'a' | 'b', n: number) => `${id(`audit_${tenant}`)}_${pad(n)}`;

const range = (block: { first: number; last: number }) =>
  Array.from({ length: block.last - block.first + 1 }, (_, i) => entryId('a', block.first + i));

/** Rows inside a tie block collapse onto the block's first rank's instant. */
const rankOf = (index: number) => {
  if (index >= TIE_ONE.first && index <= TIE_ONE.last) return TIE_ONE.first;
  if (index >= TIE_TWO.first && index <= TIE_TWO.last) return TIE_TWO.first;
  return index;
};

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  auditRouter: (typeof import('./audit'))['auditRouter'];
};

let deps: Deps;

type Actor = { id: string; role: 'ADMIN' | 'EMPLOYEE' };

const ADMIN_ACTOR_A: Actor = { id: ADMIN_A, role: 'ADMIN' };
const ADMIN_ACTOR_B: Actor = { id: ADMIN_B, role: 'ADMIN' };

const caller = (db: unknown, actor: Actor) =>
  deps.auditRouter.createCaller({
    db,
    session: { user: { id: actor.id, role: actor.role, status: 'ACTIVE' } },
    entitlements: { enabledModules: ['audit'] },
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);

const user = (userId: string, organizationId: string) => ({
  id: userId,
  organizationId,
  email: `${userId}@example.test`,
  name: userId,
  title: 'Engineer',
  department: 'ENGINEERING' as const,
  role: 'ADMIN' as const,
  status: 'ACTIVE' as const,
});

type ListFilters = { limit: number; outcome?: 'SUCCESS' | 'FAILURE' };

/** Walk every page, following `nextCursor` until it runs out. */
const walk = async (organizationId: string, actor: Actor, filters: ListFilters) => {
  const ids: string[] = [];
  let cursor: string | undefined;
  let lastPageSize = 0;

  for (let page = 0; page <= TOTAL_A + TOTAL_B + 1; page++) {
    const result = await deps.withTenantDb(organizationId, (db) =>
      caller(db, actor).list({ ...filters, ...(cursor ? { cursor } : {}) })
    );
    ids.push(...result.items.map((row) => row.id));
    lastPageSize = result.items.length;
    if (!result.nextCursor) return { ids, pages: page + 1, lastPageSize };
    cursor = result.nextCursor;
  }

  throw new Error('pagination never reported a last page');
};

/**
 * The independent oracle: the same rows, in the same total order, fetched in
 * ONE unpaginated query issued straight at the database rather than through the
 * router — so it cannot agree with the paginator by construction.
 */
const oracle = (organizationId: string, where: Prisma.AuditLogWhereInput = {}) =>
  deps.withTenantDb(organizationId, async (db) =>
    (
      await db.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      })
    ).map((row) => row.id)
  );

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDatabase('audit list cursor pagination, against PostgreSQL', () => {
  beforeAll(async () => {
    const scopedDb = await import('@/lib/tenancy/scoped-db');
    deps = {
      withTenantDb: scopedDb.withTenantDb,
      withPlatformDb: scopedDb.withPlatformDb,
      auditRouter: (await import('./audit')).auditRouter,
    };

    // The cross-organization case is decided purely by row level security, so
    // a role that bypasses it would make that case pass no matter what.
    await assertRlsEnforcingRole(deps.withPlatformDb);

    await deps.withPlatformDb(async (db) => {
      for (const [organizationId, label] of [
        [ORGANIZATION_A, 'A'],
        [ORGANIZATION_B, 'B'],
      ] as const) {
        await db.organization.create({
          data: {
            id: organizationId,
            slug: organizationId.replaceAll('_', '-'),
            legalName: `Audit cursor ${label}`,
            displayName: `Audit cursor ${label}`,
            status: 'ACTIVE',
          },
        });
        await seedDepartments(db, [organizationId], ['ENGINEERING']);
      }
    });

    const base = Date.now();
    const entries = (tenant: 'a' | 'b', total: number): Prisma.AuditLogCreateManyInput[] =>
      Array.from({ length: total }, (_, i) => ({
        id: entryId(tenant, i),
        // Only tenant A carries the tie blocks; tenant B just needs to exist.
        createdAt: new Date(base - (tenant === 'a' ? rankOf(i) : i) * MINUTE),
        source: 'TRPC',
        category: 'SYSTEM',
        action: `fixture.${tenant}.${pad(i)}`,
        // A filter that splits the set across more than one page, so the
        // "filters are unchanged" case is not a single-page tautology.
        outcome: i % 3 === 0 ? 'FAILURE' : 'SUCCESS',
      }));

    await deps.withTenantDb(ORGANIZATION_A, async (db) => {
      await db.user.create({ data: user(ADMIN_A, ORGANIZATION_A) });
      await db.auditLog.createMany({ data: entries('a', TOTAL_A) });
    });

    await deps.withTenantDb(ORGANIZATION_B, async (db) => {
      await db.user.create({ data: user(ADMIN_B, ORGANIZATION_B) });
      await db.auditLog.createMany({ data: entries('b', TOTAL_B) });
    });
  }, 120_000);

  afterAll(async () => {
    if (!deps) return;
    await deps.withPlatformDb(async (db) => {
      const organizationId = { in: [ORGANIZATION_A, ORGANIZATION_B] };
      // Audit rows are append-only (DEV-155) and stay behind under this run's
      // unique organization ids; deleting their actors only clears `actorId`.
      await db.user.deleteMany({ where: { organizationId } });
      await db.organization.deleteMany({ where: { id: organizationId } });
    });
  }, 120_000);

  // 1. Walking every page yields the complete expected id set exactly once —
  //    no duplicates, no gaps — measured against an unpaginated oracle. Against
  //    the popped-sentinel cursor this is short by one row per boundary.
  it('walks every page to the complete id set, exactly once', async () => {
    const expected = await oracle(ORGANIZATION_A);
    expect(expected).toHaveLength(TOTAL_A);

    const { ids } = await walk(ORGANIZATION_A, ADMIN_ACTOR_A, { limit: PAGE });

    expect(ids).toHaveLength(TOTAL_A); // no gaps
    expect(new Set(ids).size).toBe(TOTAL_A); // no duplicates
    expect(ids).toEqual(expected); // and in the oracle's exact order
  });

  // 2. The case a weak cursor gets wrong: a tie in `createdAt` that STRADDLES a
  //    page boundary. Both blocks are proven to straddle rather than assumed to.
  it('stays complete when a createdAt tie straddles a page boundary', async () => {
    const { ids } = await walk(ORGANIZATION_A, ADMIN_ACTOR_A, { limit: PAGE });
    const boundaries = Array.from({ length: Math.ceil(TOTAL_A / PAGE) }, (_, k) => (k + 1) * PAGE);

    for (const block of [TIE_ONE, TIE_TWO]) {
      const tied = range(block);

      // Every tied row surfaced, and surfaced exactly once.
      for (const entry of tied) {
        expect(ids.filter((seen) => seen === entry)).toEqual([entry]);
      }

      // …and a page boundary genuinely falls inside the block, so the
      // assertion above is not passing by accident.
      const indexes = tied.map((entry) => ids.indexOf(entry));
      const min = Math.min(...indexes);
      const max = Math.max(...indexes);
      expect(boundaries.some((boundary) => min < boundary && boundary <= max)).toBe(true);
    }

    // The composite order is a total order, so the walk is reproducible.
    const second = await walk(ORGANIZATION_A, ADMIN_ACTOR_A, { limit: PAGE });
    expect(second.ids).toEqual(ids);
    expect(ids).toEqual(await oracle(ORGANIZATION_A));
  });

  // 3. A final page shorter than the limit ends the walk without a cursor.
  it('reports no nextCursor on a final page shorter than the limit', async () => {
    expect(TOTAL_A % PAGE).not.toBe(0);

    const { pages, lastPageSize } = await walk(ORGANIZATION_A, ADMIN_ACTOR_A, { limit: PAGE });
    expect(pages).toBe(Math.ceil(TOTAL_A / PAGE));
    expect(lastPageSize).toBe(TOTAL_A % PAGE);

    // The degenerate case of the same rule: one page that holds everything.
    const single = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      caller(db, ADMIN_ACTOR_A).list({ limit: 200 })
    );
    expect(single.items).toHaveLength(TOTAL_A);
    expect(single.nextCursor).toBeUndefined();
  });

  // 4. `where` carries no organizationId predicate by design, so this case has
  //    exactly one thing standing between the two tenants: row level security,
  //    enforced through the unprivileged role `beforeAll` insists on.
  it('keeps cross-tenant rows invisible, through RLS', async () => {
    const fromA = await walk(ORGANIZATION_A, ADMIN_ACTOR_A, { limit: PAGE });
    const fromB = await walk(ORGANIZATION_B, ADMIN_ACTOR_B, { limit: PAGE });

    expect(fromB.ids).toEqual(await oracle(ORGANIZATION_B));
    expect(fromB.ids).toHaveLength(TOTAL_B);

    expect(fromA.ids.some((entry) => entry.startsWith(id('audit_b')))).toBe(false);
    expect(fromB.ids.some((entry) => entry.startsWith(id('audit_a')))).toBe(false);
  });

  // 5. The returned shape and the filters are untouched by the cursor change:
  //    a filtered walk still equals the same filter applied to the oracle.
  it('leaves filters and the returned shape unchanged', async () => {
    const expected = await oracle(ORGANIZATION_A, { outcome: 'FAILURE' });
    const { ids } = await walk(ORGANIZATION_A, ADMIN_ACTOR_A, { limit: 2, outcome: 'FAILURE' });

    expect(expected.length).toBeGreaterThan(2); // more than one page of them
    expect(ids).toEqual(expected);

    const page = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      caller(db, ADMIN_ACTOR_A).list({ limit: PAGE })
    );
    expect(Object.keys(page).sort()).toEqual(['items', 'nextCursor']);
    expect(page.nextCursor).toBe(page.items[page.items.length - 1]?.id);
  });
});
