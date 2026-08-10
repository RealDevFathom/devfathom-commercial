/**
 * Meeting list BOUNDS, against a REAL PostgreSQL (#38).
 *
 * The sibling file `meetings-list-policy.test.ts` establishes WHOSE meetings
 * each procedure returns. This one establishes HOW MANY, and that nothing is
 * lost on the way to that answer. Both properties need a real database:
 *
 *  - a ceiling is only evidence of a bound if the fixture is bigger than the
 *    ceiling, so the fixture here is hundreds of meetings, not five;
 *  - cursor pagination over TIED `startTime` values is decided by PostgreSQL's
 *    row-value comparison, not by application code. A mock would agree with
 *    whatever the mock was written to agree with — and a cursor over a
 *    non-unique ordering is exactly the defect this file exists to catch;
 *  - the cross-organization case is decided purely by row level security,
 *    because the ADMIN branch deliberately carries no `organizationId` filter.
 *
 * Requires TEST_DATABASE_URL (a migrated, throwaway database — the same
 * variable `test:rls` uses, and never DATABASE_URL). Without it the suite
 * reports itself skipped rather than passing vacuously.
 *
 * The connection role must NOT be a superuser: PostgreSQL lets a superuser
 * bypass row level security outright, FORCE included, which would turn the
 * cross-organization case into a test that passes no matter what. `beforeAll`
 * refuses to run rather than let that happen quietly.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
const id = (name: string) => `${name}_bounds_${suffix}`;

const ORGANIZATION_A = id('org_a');
const ORGANIZATION_B = id('org_b');

const ADMIN_A = id('user_admin_a');
const MEMBER_A = id('user_member_a');
const SERIES_A = id('user_series_a');
const TIE_A = id('user_tie_a');
const BULK_A = id('user_bulk_a');
const ADMIN_B = id('user_admin_b');

const USERS_A = [ADMIN_A, MEMBER_A, SERIES_A, TIE_A, BULK_A];

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const DAY = 24 * HOUR;

/** The page size `getAll` applies when the caller sends no input (#38). */
const DEFAULT_PAGE_SIZE = 50;
/** The largest page a caller may ask for. */
const MAX_PAGE_SIZE = 200;
/** The recurring series `getUpcoming` evaluates per call. */
const SERIES_CEILING = 200;

// Fixture sizes. Every one of these is deliberately larger than the bound it
// exercises: a ceiling that the fixture cannot reach proves nothing.
const BULK_COUNT = 240;
const MEMBER_COUNT = 120;
const SERIES_COUNT = 260; // > SERIES_CEILING
const TIE_COUNT = 12;
const TOTAL_COUNT = BULK_COUNT + MEMBER_COUNT + SERIES_COUNT + TIE_COUNT;

/** Ids sort lexically, so zero-padding makes the id tiebreaker predictable. */
const pad = (n: number) => String(n).padStart(3, '0');
const bulkId = (n: number) => `${id('mtg_bulk')}_${pad(n)}`;
const memberId = (n: number) => `${id('mtg_member')}_${pad(n)}`;
const seriesId = (n: number) => `${id('mtg_series')}_${pad(n)}`;
const tieId = (n: number) => `${id('mtg_tie')}_${pad(n)}`;

/**
 * The tied block inside the bulk set: ranks 46..55 of that set share one
 * instant, so a 50-row page boundary lands in the middle of them.
 */
const TIE_BLOCK_FIRST = 46;
const TIE_BLOCK_LAST = 55;

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  meetingsRouter: (typeof import('./meetings'))['meetingsRouter'];
};

let deps: Deps;

type Actor = { id: string; role: 'ADMIN' | 'EMPLOYEE' };

const caller = (db: unknown, actor: Actor) =>
  deps.meetingsRouter.createCaller({
    db,
    session: { user: { id: actor.id, role: actor.role, status: 'ACTIVE' } },
    entitlements: { enabledModules: ['meetings'] },
  } as never);

const user = (userId: string, organizationId: string, role: 'ADMIN' | 'EMPLOYEE') => ({
  id: userId,
  organizationId,
  email: `${userId}@example.test`,
  name: userId,
  title: 'Engineer',
  department: 'ENGINEERING' as const,
  role,
  status: 'ACTIVE' as const,
});

/** The exact production call shape: `getAll` invoked with no input at all. */
const firstPageWithNoInput = (organizationId: string, actor: Actor) =>
  deps.withTenantDb(organizationId, (db) => caller(db, actor).getAll());

/** Walk every page, following `nextCursor` until it runs out. */
const walk = async (organizationId: string, actor: Actor, limit?: number) => {
  const ids: string[] = [];
  let cursor: string | undefined;

  for (let page = 0; page <= TOTAL_COUNT + 1; page++) {
    const input = { ...(limit === undefined ? {} : { limit }), ...(cursor ? { cursor } : {}) };
    const result = await deps.withTenantDb(organizationId, (db) => caller(db, actor).getAll(input));
    ids.push(...result.items.map((m) => m.id));
    if (!result.nextCursor) return { ids, pages: page + 1 };
    cursor = result.nextCursor;
  }

  throw new Error('pagination never reported a last page');
};

const getUpcomingIds = (organizationId: string, actor: Actor) =>
  deps.withTenantDb(organizationId, async (db) =>
    (await caller(db, actor).getUpcoming()).map((m) => m.id)
  );

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDatabase('meeting list bounds, against PostgreSQL', () => {
  beforeAll(async () => {
    const scopedDb = await import('@/lib/tenancy/scoped-db');
    deps = {
      withTenantDb: scopedDb.withTenantDb,
      withPlatformDb: scopedDb.withPlatformDb,
      meetingsRouter: (await import('./meetings')).meetingsRouter,
    };

    const [{ is_superuser: isSuperuser }] = await deps.withPlatformDb((db) =>
      db.$queryRawUnsafe<Array<{ is_superuser: string }>>(
        `SELECT current_setting('is_superuser') AS is_superuser`
      )
    );
    if (isSuperuser === 'on') {
      throw new Error(
        'TEST_DATABASE_URL connects as a superuser, which bypasses row level security; ' +
          'the cross-organization case would pass vacuously. Use an unprivileged role.'
      );
    }

    await deps.withPlatformDb(async (db) => {
      for (const [organizationId, label] of [
        [ORGANIZATION_A, 'A'],
        [ORGANIZATION_B, 'B'],
      ] as const) {
        await db.organization.create({
          data: {
            id: organizationId,
            slug: organizationId.replaceAll('_', '-'),
            legalName: `Bounds ${label}`,
            displayName: `Bounds ${label}`,
            status: 'ACTIVE',
          },
        });
      }
    });

    const now = Date.now();
    const meetings: Array<{
      id: string;
      title: string;
      startTime: Date;
      endTime: Date;
      createdById: string;
      recurrence?: string;
    }> = [];
    const attendees: Array<{ meetingId: string; userId: string }> = [];

    const add = (meetingId: string, attendeeId: string, startMs: number, recurrence?: string) => {
      meetings.push({
        id: meetingId,
        title: meetingId,
        startTime: new Date(startMs),
        endTime: new Date(startMs + HOUR),
        createdById: attendeeId,
        ...(recurrence ? { recurrence } : {}),
      });
      attendees.push({ meetingId, userId: attendeeId });
    };

    // Bulk set: one meeting per hour walking backwards from now + 5 days, so
    // it straddles now and feeds both the Upcoming and the Past surfaces.
    // Ranks TIE_BLOCK_FIRST..TIE_BLOCK_LAST share ONE instant on purpose: with
    // the default 50-row page, the page boundary falls inside that block.
    const bulkBase = now + 5 * DAY;
    for (let i = 0; i < BULK_COUNT; i++) {
      const rank = i >= TIE_BLOCK_FIRST && i <= TIE_BLOCK_LAST ? TIE_BLOCK_FIRST : i;
      add(bulkId(i), BULK_A, bulkBase - rank * HOUR);
    }

    // Member set: a non-admin's own meetings. Distinct instants throughout, so
    // the pre-#38 ordering (`startTime` desc, no tiebreaker) is well defined
    // and can be compared against byte for byte.
    const memberBase = now + 2 * DAY - 10 * MINUTE;
    for (let i = 0; i < MEMBER_COUNT; i++) add(memberId(i), MEMBER_A, memberBase - i * HOUR);

    // Recurring series whose ORIGINAL occurrence has already ended — the set
    // the old unbounded recurring query fetched in full on every load.
    const seriesBase = now - 3 * DAY - 20 * MINUTE;
    for (let i = 0; i < SERIES_COUNT; i++)
      add(seriesId(i), SERIES_A, seriesBase - i * HOUR, 'daily');

    // A small set with a dense tie block, walked at a page size of 3 so every
    // page boundary provably lands inside the tie.
    const tieBase = now + DAY + 30 * MINUTE;
    for (let i = 0; i < TIE_COUNT; i++) {
      const offsetHours = i === 0 ? 0 : i === 1 ? 1 : i <= 9 ? 2 : i - 7;
      add(tieId(i), TIE_A, tieBase - offsetHours * HOUR);
    }

    await deps.withTenantDb(
      ORGANIZATION_A,
      async (db) => {
        for (const userId of USERS_A) {
          await db.user.create({
            data: user(userId, ORGANIZATION_A, userId === ADMIN_A ? 'ADMIN' : 'EMPLOYEE'),
          });
        }
        await db.meeting.createMany({ data: meetings });
        await db.meetingAttendee.createMany({ data: attendees });
      },
      { timeout: 120_000, maxWait: 30_000 }
    );

    await deps.withTenantDb(ORGANIZATION_B, async (db) => {
      await db.user.create({ data: user(ADMIN_B, ORGANIZATION_B, 'ADMIN') });
    });
  }, 180_000);

  afterAll(async () => {
    if (!deps) return;
    await deps.withPlatformDb(
      async (db) => {
        await db.meeting.deleteMany({ where: { organizationId: ORGANIZATION_A } });
        await db.user.deleteMany({
          where: { organizationId: { in: [ORGANIZATION_A, ORGANIZATION_B] } },
        });
        await db.organization.deleteMany({
          where: { id: { in: [ORGANIZATION_A, ORGANIZATION_B] } },
        });
      },
      { timeout: 120_000, maxWait: 30_000 }
    );
  }, 180_000);

  // 1. The bound must hold for the shape production actually sends, which is
  //    no input at all — `trpc.meetings.getAll.useQuery()`.
  it('bounds getAll when the input is omitted entirely', async () => {
    const page = await firstPageWithNoInput(ORGANIZATION_A, { id: ADMIN_A, role: 'ADMIN' });

    expect(page.items).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(page.nextCursor).toBeTruthy();
  });

  // 2. No unbounded organization-wide query remains. Both list queries are
  //    asserted against a fixture larger than their ceiling, and the schema
  //    refuses to hand out an unbounded page.
  it('leaves no unbounded organization-wide query', async () => {
    const admin = { id: ADMIN_A, role: 'ADMIN' as const };

    // getAll: the tenant holds TOTAL_COUNT meetings; one call returns a page.
    const page = await firstPageWithNoInput(ORGANIZATION_A, admin);
    expect(TOTAL_COUNT).toBeGreaterThan(MAX_PAGE_SIZE);
    expect(page.items.length).toBeLessThanOrEqual(DEFAULT_PAGE_SIZE);

    // …and the ceiling cannot be argued away by the caller.
    await expect(
      deps.withTenantDb(ORGANIZATION_A, (db) =>
        caller(db, admin).getAll({ limit: MAX_PAGE_SIZE + 1 })
      )
    ).rejects.toThrow();

    // getUpcoming's recurring-series query: SERIES_A attends SERIES_COUNT
    // series whose original occurrence has ended, which is what the pre-#38
    // query fetched in full, attendee graph included.
    const upcoming = await getUpcomingIds(ORGANIZATION_A, { id: SERIES_A, role: 'EMPLOYEE' });
    expect(SERIES_COUNT).toBeGreaterThan(SERIES_CEILING);
    expect(upcoming).toHaveLength(SERIES_CEILING);
    expect(new Set(upcoming).size).toBe(SERIES_CEILING);
  });

  // 3. Walking every page yields every meeting exactly once — no gaps, no
  //    repeats — and the walk terminates.
  it('paginates completely and without duplicates', async () => {
    const { ids, pages } = await walk(ORGANIZATION_A, { id: ADMIN_A, role: 'ADMIN' });

    expect(ids).toHaveLength(TOTAL_COUNT);
    expect(new Set(ids).size).toBe(TOTAL_COUNT);
    expect(pages).toBe(Math.ceil(TOTAL_COUNT / DEFAULT_PAGE_SIZE));

    const expected = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      db.meeting.findMany({ select: { id: true } })
    );
    expect([...ids].sort()).toEqual(expected.map((m) => m.id).sort());
  });

  // 4. The case a naive cursor gets wrong. `startTime` alone is not a total
  //    order; ten bulk meetings share one instant and eight tie meetings share
  //    another, and every page boundary below lands inside a tie.
  it('keeps ordering deterministic across tied timestamps', async () => {
    const tied = Array.from({ length: TIE_BLOCK_LAST - TIE_BLOCK_FIRST + 1 }, (_, i) =>
      bulkId(TIE_BLOCK_FIRST + i)
    );

    const first = await walk(ORGANIZATION_A, { id: ADMIN_A, role: 'ADMIN' });
    const second = await walk(ORGANIZATION_A, { id: ADMIN_A, role: 'ADMIN' });

    // Same total order every time, and each tied row surfaces exactly once.
    expect(first.ids).toEqual(second.ids);
    for (const meetingId of tied) {
      expect(first.ids.filter((seen) => seen === meetingId)).toEqual([meetingId]);
    }

    // A page boundary genuinely falls inside the tied block, so the assertion
    // above is not passing by accident.
    const firstPage = first.ids.slice(0, DEFAULT_PAGE_SIZE);
    const restOfWalk = first.ids.slice(DEFAULT_PAGE_SIZE);
    expect(tied.some((meetingId) => firstPage.includes(meetingId))).toBe(true);
    expect(tied.some((meetingId) => restOfWalk.includes(meetingId))).toBe(true);

    // A dense tie walked three at a time: every boundary is inside the tie,
    // and the order is the composite (startTime desc, id desc) exactly.
    const tie = await walk(ORGANIZATION_A, { id: TIE_A, role: 'EMPLOYEE' }, 3);
    expect(tie.ids).toEqual([
      tieId(0),
      tieId(1),
      tieId(9),
      tieId(8),
      tieId(7),
      tieId(6),
      tieId(5),
      tieId(4),
      tieId(3),
      tieId(2),
      tieId(10),
      tieId(11),
    ]);
  });

  // 5. Organization-wide discovery survives the bound: an admin who attends
  //    nothing still reaches every meeting in the tenant by paginating.
  it('lets an admin who attends nothing reach every organization meeting', async () => {
    const { ids } = await walk(ORGANIZATION_A, { id: ADMIN_A, role: 'ADMIN' }, MAX_PAGE_SIZE);

    expect(new Set(ids).size).toBe(TOTAL_COUNT);
    // Including meetings whose only attendee is somebody else entirely.
    expect(ids).toContain(bulkId(0));
    expect(ids).toContain(memberId(0));
    expect(ids).toContain(seriesId(0));
  });

  // 6. Non-admin visibility is unchanged: the same rows, in the same order, in
  //    the same number. The oracle is the pre-#38 query — attendee scope,
  //    `startTime` desc, no take — issued directly against the database rather
  //    than through the router, so it cannot agree with the router by
  //    construction. The bound changes the delivery, never the contents.
  it('returns a non-admin exactly what it returned before, across pages', async () => {
    const member = { id: MEMBER_A, role: 'EMPLOYEE' as const };

    const before = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      db.meeting.findMany({
        where: { attendees: { some: { userId: MEMBER_A } } },
        orderBy: { startTime: 'desc' },
        select: { id: true },
      })
    );
    const expected = before.map((m) => m.id);
    expect(expected).toHaveLength(MEMBER_COUNT);

    const page = await firstPageWithNoInput(ORGANIZATION_A, member);
    expect(page.items.map((m) => m.id)).toEqual(expected.slice(0, DEFAULT_PAGE_SIZE));

    const { ids } = await walk(ORGANIZATION_A, member);
    expect(ids).toEqual(expected);
  });

  // 7. The ADMIN branch carries no organizationId filter by design, so this
  //    case has exactly one thing standing between organization B and
  //    organization A's meetings: row level security, enforced through the
  //    unprivileged role `beforeAll` insists on.
  it("keeps another organization's ADMIN out, through RLS", async () => {
    const adminB = { id: ADMIN_B, role: 'ADMIN' as const };

    const page = await firstPageWithNoInput(ORGANIZATION_B, adminB);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
    expect(await getUpcomingIds(ORGANIZATION_B, adminB)).toEqual([]);
  });

  // 8. Decision 2 of #38, and the reason this file's expectation differs from
  //    what PR #36 shipped: the dashboard/upcoming surfaces answer "what am I
  //    doing next", so they stay attendee-scoped for every role. This case
  //    FAILS against main, deliberately — there, an admin's upcoming list is
  //    the whole tenant's future calendar.
  it('keeps the upcoming surfaces user-relevant, admins included', async () => {
    expect(await getUpcomingIds(ORGANIZATION_A, { id: ADMIN_A, role: 'ADMIN' })).toEqual([]);

    const mine = await getUpcomingIds(ORGANIZATION_A, { id: MEMBER_A, role: 'EMPLOYEE' });
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((meetingId) => meetingId.startsWith(id('mtg_member')))).toBe(true);

    // Organization-wide discovery is unaffected — it lives on getAll.
    const page = await firstPageWithNoInput(ORGANIZATION_A, { id: ADMIN_A, role: 'ADMIN' });
    expect(page.items.some((m) => m.id.startsWith(id('mtg_bulk')))).toBe(true);
  });
});
