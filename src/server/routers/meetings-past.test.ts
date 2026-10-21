/**
 * PAST meeting retrieval, against a REAL PostgreSQL (#44).
 *
 * The sibling files establish WHOSE meetings each list procedure returns
 * (`meetings-list-policy.test.ts`) and HOW MANY (`meetings-bounds.test.ts`).
 * This one establishes that the PAST half is reachable at all.
 *
 * `getAll` is ordered furthest-future first, so in a tenant whose future
 * calendar exceeds one page every early page is future-only. The Past section
 * used to be a client-side filter over those pages, which meant "0 past of 50
 * meetings loaded" until the user had clicked through the whole future
 * calendar. The fixture here reproduces exactly that shape — 120 future
 * meetings against a 50-row page — because a fixture that fits in one page
 * cannot reproduce the defect and would pass against the broken code.
 *
 * A real database is what makes the rest of it evidence:
 *
 *  - ordering across TIED `startTime` values is decided by PostgreSQL's
 *    row-value comparison, not by application code, and a cursor over a
 *    non-unique ordering is precisely the way a paginated Past list loses or
 *    repeats rows;
 *  - the cross-organization case is decided purely by row level security,
 *    because `meetingListScope`'s ADMIN branch deliberately carries no
 *    `organizationId` filter. Faking the client would test the fake.
 *
 * Requires TEST_DATABASE_URL (a migrated, throwaway database — the same
 * variable `test:rls` uses, and never DATABASE_URL). Without it the suite
 * reports itself skipped rather than passing vacuously.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { assertRlsEnforcingRole } from '@/lib/testing/rls-role-guard';
import { legacyRecurrenceToRule } from '@/lib/meetings/recurrence';
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
const id = (name: string) => `${name}_past_${suffix}`;

const ORGANIZATION_A = id('org_a');
const ORGANIZATION_B = id('org_b');

const ADMIN_A = id('user_admin_a');
const MEMBER_A = id('user_member_a');
const TIE_A = id('user_tie_a');
const OTHER_A = id('user_other_a');
const ADMIN_B = id('user_admin_b');
const MEMBER_B = id('user_member_b');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** The page size `getPast` applies when the caller sends no input. */
const DEFAULT_PAGE_SIZE = 50;
/** The largest page a caller may ask for. */
const MAX_PAGE_SIZE = 200;

// Fixture sizes. The future set is deliberately larger than a page — that is
// the reported condition — and the past sets are deliberately larger than the
// default page, because a ceiling the fixture cannot reach proves nothing.
const FUTURE_COUNT = 120;
const PAST_MEMBER_COUNT = 60;
const TIE_COUNT = 14;
const ORGANIZATION_ONLY_COUNT = 6;
/** Every non-recurring past meeting in the tenant, which is what an ADMIN sees. */
const ADMIN_PAST_TOTAL = PAST_MEMBER_COUNT + TIE_COUNT + ORGANIZATION_ONLY_COUNT;

/** Ids sort lexically, so zero-padding makes the id tiebreaker predictable. */
const pad = (n: number) => String(n).padStart(3, '0');
const futureId = (n: number) => `${id('mtg_future')}_${pad(n)}`;
const pastId = (n: number) => `${id('mtg_past')}_${pad(n)}`;
const tieId = (n: number) => `${id('mtg_tie')}_${pad(n)}`;
const organizationOnlyId = (n: number) => `${id('mtg_orgonly')}_${pad(n)}`;
const RECURRING_PAST = id('mtg_recurring');
const PAST_B = id('mtg_b_past');

/**
 * Hours-ago for each meeting in the tie set. Indices 3/4/5 share one instant
 * and 9/10 share another, so a walk at TIE_PAGE_SIZE puts a page boundary
 * INSIDE a tie — the case a cursor over `startTime` alone gets wrong.
 */
const TIE_OFFSET_HOURS = [1, 2, 3, 4, 4, 4, 5, 6, 7, 8, 8, 9, 10, 11];
const TIE_PAGE_SIZE = 4;
/** (startTime desc, id desc) over TIE_OFFSET_HOURS, written out by hand. */
const TIE_ORDER = [0, 1, 2, 5, 4, 3, 6, 7, 8, 10, 9, 11, 12, 13].map(tieId);

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  meetingsRouter: (typeof import('./meetings'))['meetingsRouter'];
};

let deps: Deps;

type Actor = { id: string; role: 'ADMIN' | 'EMPLOYEE' };

const ADMIN = { id: ADMIN_A, role: 'ADMIN' } as const;
const MEMBER = { id: MEMBER_A, role: 'EMPLOYEE' } as const;

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

type ListRow = { id: string; startTime: Date; recurrenceRule: string | null };

/**
 * The predicate the Past section used to apply client-side, for comparison.
 *
 * WHA-235: reads `recurrenceRule` rather than the deprecated `recurrence`,
 * matching the column `getPast` now filters on. The PROPERTY is unchanged — a
 * recurring series is never "past", because its next occurrence belongs to
 * Upcoming — only the column that records the cadence has moved.
 */
const isPastRow = (m: ListRow) => m.startTime.getTime() < Date.now() && m.recurrenceRule === null;

/** The omitted-input schema path: `getPast` invoked with no input argument. */
const firstPastPage = (organizationId: string, actor: Actor) =>
  deps.withTenantDb(organizationId, (db) => caller(db, actor).getPast());

const firstListPage = (organizationId: string, actor: Actor) =>
  deps.withTenantDb(organizationId, (db) => caller(db, actor).getAll());

/** Walk every page of a cursor-paginated list procedure until it runs out. */
const walk = async (
  procedure: 'getPast' | 'getAll',
  organizationId: string,
  actor: Actor,
  limit?: number
) => {
  const ids: string[] = [];
  const startTimes: Date[] = [];
  let cursor: string | undefined;
  const ceiling = FUTURE_COUNT + ADMIN_PAST_TOTAL + 2;

  for (let page = 0; page <= ceiling; page++) {
    const input = { ...(limit === undefined ? {} : { limit }), ...(cursor ? { cursor } : {}) };
    const result: { items: ListRow[]; nextCursor?: string } = await deps.withTenantDb(
      organizationId,
      (db) => {
        const called = caller(db, actor);
        return procedure === 'getPast' ? called.getPast(input) : called.getAll(input);
      }
    );
    ids.push(...result.items.map((m) => m.id));
    startTimes.push(...result.items.map((m) => m.startTime));
    if (!result.nextCursor) return { ids, startTimes, pages: page + 1 };
    cursor = result.nextCursor;
  }

  throw new Error('pagination never reported a last page');
};

/**
 * How many `getAll` pages a caller must fetch before the first past meeting
 * appears in one — the cost the Past section used to pay, measured rather than
 * assumed. Returns `Infinity` if the list runs out without ever holding one.
 */
const listPagesUntilFirstPast = async (organizationId: string, actor: Actor) => {
  let cursor: string | undefined;

  for (let page = 1; page <= FUTURE_COUNT + ADMIN_PAST_TOTAL; page++) {
    const result = await deps.withTenantDb(organizationId, (db) =>
      caller(db, actor).getAll(cursor ? { cursor } : {})
    );
    if (result.items.some(isPastRow)) return page;
    if (!result.nextCursor) return Infinity;
    cursor = result.nextCursor;
  }

  throw new Error('pagination never reported a last page');
};

const getUpcomingIds = (organizationId: string, actor: Actor) =>
  deps.withTenantDb(organizationId, async (db) =>
    (await caller(db, actor).getUpcoming()).map((m) => m.id)
  );

/**
 * An oracle issued directly against the database rather than through the
 * router, so it cannot agree with the router by construction.
 */
const oraclePastIds = (organizationId: string, attendeeId?: string) =>
  deps.withTenantDb(organizationId, async (db) => {
    const rows = await db.meeting.findMany({
      where: {
        recurrenceRule: null,
        startTime: { lt: new Date() },
        ...(attendeeId ? { attendees: { some: { userId: attendeeId } } } : {}),
      },
      orderBy: [{ startTime: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    return rows.map((m) => m.id);
  });

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDatabase('past meeting retrieval, against PostgreSQL', () => {
  beforeAll(async () => {
    const scopedDb = await import('@/lib/tenancy/scoped-db');
    deps = {
      withTenantDb: scopedDb.withTenantDb,
      withPlatformDb: scopedDb.withPlatformDb,
      meetingsRouter: (await import('./meetings')).meetingsRouter,
    };

    // The cross-organization case is decided purely by row level security, so
    // a role that bypasses it would turn that case into a test that passes no
    // matter what.
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
            legalName: `Past ${label}`,
            displayName: `Past ${label}`,
            status: 'ACTIVE',
          },
        });
        await seedDepartments(db, [organizationId], ['ENGINEERING']);
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
      recurrenceRule?: string;
    }> = [];
    const attendees: Array<{ meetingId: string; userId: string }> = [];

    const add = (meetingId: string, attendeeId: string, startMs: number, recurrence?: string) => {
      meetings.push({
        id: meetingId,
        title: meetingId,
        startTime: new Date(startMs),
        endTime: new Date(startMs + HOUR),
        createdById: attendeeId,
        // WHA-235: this fixture writes rows directly rather than through the
        // router, so it has to write the SAME PAIR the router writes —
        // `recurrence` for backwards compatibility and `recurrenceRule` as the
        // cadence every occurrence-backed read expands. A fixture that set only
        // the deprecated column would describe a series no production write
        // path can now produce.
        ...(recurrence
          ? { recurrence, recurrenceRule: legacyRecurrenceToRule(recurrence) ?? undefined }
          : {}),
      });
      attendees.push({ meetingId, userId: attendeeId });
    };

    // The reported condition: a future calendar well over one page. With the
    // 50-row default, the first TWO pages of `getAll` are future-only.
    for (let i = 0; i < FUTURE_COUNT; i++) add(futureId(i), MEMBER_A, now + (i + 1) * HOUR);

    // The member's own past, larger than the default page so the bound on the
    // new path is provable rather than assumed.
    for (let i = 0; i < PAST_MEMBER_COUNT; i++) add(pastId(i), MEMBER_A, now - (i + 1) * HOUR);

    // A recurring series whose original occurrence is in the past. The Past
    // surface has always excluded these — its next occurrence belongs to
    // Upcoming — so it must not appear no matter how old the original is.
    add(RECURRING_PAST, MEMBER_A, now - 100 * HOUR, 'daily');

    // The tie set, on a half-hour grid so it cannot collide with the whole-hour
    // sets above. Ties are inside it, on purpose.
    for (let i = 0; i < TIE_COUNT; i++)
      add(tieId(i), TIE_A, now - 30 * MINUTE - TIE_OFFSET_HOURS[i] * HOUR);

    // Past meetings nobody above attends: visible to the ADMIN, invisible to
    // the member. This is the organization-wide half of the scope.
    for (let i = 0; i < ORGANIZATION_ONLY_COUNT; i++)
      add(organizationOnlyId(i), OTHER_A, now - (200 + i) * HOUR);

    await deps.withTenantDb(
      ORGANIZATION_A,
      async (db) => {
        for (const userId of [ADMIN_A, MEMBER_A, TIE_A, OTHER_A]) {
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
      await db.user.create({ data: user(MEMBER_B, ORGANIZATION_B, 'EMPLOYEE') });
      await db.meeting.create({
        data: {
          id: PAST_B,
          title: PAST_B,
          startTime: new Date(now - 3 * HOUR),
          endTime: new Date(now - 2 * HOUR),
          createdById: MEMBER_B,
          attendees: { create: [{ userId: MEMBER_B }] },
        },
      });
    });
  }, 180_000);

  afterAll(async () => {
    if (!deps) return;
    await deps.withPlatformDb(
      async (db) => {
        await db.meeting.deleteMany({
          where: { organizationId: { in: [ORGANIZATION_A, ORGANIZATION_B] } },
        });
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

  // 1. Issue #44 itself. The first Past request has to return past meetings —
  //    not after the caller has walked the future calendar, and not after any
  //    continuation click. This case FAILS against main, where the Past surface
  //    is a client-side filter over `getAll`'s future-ordered pages.
  it('returns past meetings on the FIRST request, with no future page fetched', async () => {
    for (const actor of [MEMBER, ADMIN]) {
      // The defect, made concrete: `getAll` is ordered furthest-future first,
      // so the page the Past section used to be filtered out of holds no past
      // meeting at all.
      const listPage = await firstListPage(ORGANIZATION_A, actor);
      expect(listPage.items).toHaveLength(DEFAULT_PAGE_SIZE);
      expect(listPage.items.filter(isPastRow)).toEqual([]);

      // And reaching the first one costs more pages still — measured, not
      // assumed: FUTURE_COUNT future meetings at DEFAULT_PAGE_SIZE a page means
      // two full future-only pages before any past meeting appears at all.
      const cost = await listPagesUntilFirstPast(ORGANIZATION_A, actor);
      expect(cost).toBe(Math.floor(FUTURE_COUNT / DEFAULT_PAGE_SIZE) + 1);
      expect(cost).toBeGreaterThan(1);

      // The fix. One request, no cursor, past meetings in it — and the most
      // recent past meeting first, rather than whatever the future pages left.
      const past = await firstPastPage(ORGANIZATION_A, actor);
      expect(past.items.length).toBeGreaterThan(0);
      expect(past.items.every(isPastRow)).toBe(true);
      expect(past.items[0]?.id).toBe(pastId(0));
    }
  });

  // 2. Most recent first, in a TOTAL order. `startTime` alone is not one: three
  //    meetings share one instant and two share another, and the walk below
  //    puts a page boundary inside the first of those blocks.
  it('orders past most-recent-first and deterministically across tied start times', async () => {
    const tie = { id: TIE_A, role: 'EMPLOYEE' as const };

    const first = await walk('getPast', ORGANIZATION_A, tie, TIE_PAGE_SIZE);
    const second = await walk('getPast', ORGANIZATION_A, tie, TIE_PAGE_SIZE);

    expect(first.ids).toEqual(TIE_ORDER);
    expect(second.ids).toEqual(TIE_ORDER);

    // Most recent first, over every row of the walk.
    const times = first.startTimes.map((t) => t.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));

    // The rows really are tied, not merely adjacent…
    const tied = [tieId(3), tieId(4), tieId(5)];
    const rows = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      db.meeting.findMany({ where: { id: { in: tied } }, select: { startTime: true } })
    );
    expect(new Set(rows.map((r) => r.startTime.getTime())).size).toBe(1);

    // …and a page boundary genuinely falls inside them, so the equality above
    // is not passing by accident.
    expect(first.ids.slice(0, TIE_PAGE_SIZE).filter((seen) => tied.includes(seen))).toEqual([
      tieId(5),
    ]);
    expect(first.ids.slice(TIE_PAGE_SIZE).filter((seen) => tied.includes(seen))).toEqual([
      tieId(4),
      tieId(3),
    ]);

    // The member's larger set is descending too, across its own boundaries.
    const member = await walk('getPast', ORGANIZATION_A, MEMBER);
    const memberTimes = member.startTimes.map((t) => t.getTime());
    expect(memberTimes).toEqual([...memberTimes].sort((a, b) => b - a));
  });

  // 3. Walking every past page yields every past meeting exactly once — no
  //    gaps, no repeats — and the walk terminates.
  it('paginates past completely and without duplicates', async () => {
    const { ids, pages } = await walk('getPast', ORGANIZATION_A, ADMIN);

    expect(ids).toHaveLength(ADMIN_PAST_TOTAL);
    expect(new Set(ids).size).toBe(ADMIN_PAST_TOTAL);
    expect(pages).toBe(Math.ceil(ADMIN_PAST_TOTAL / DEFAULT_PAGE_SIZE));
    expect(ids).toEqual(await oraclePastIds(ORGANIZATION_A));

    // Nothing that is not past leaks in: no future meeting, and no recurring
    // series however old its original occurrence is.
    expect(ids.some((seen) => seen.startsWith(id('mtg_future')))).toBe(false);
    expect(ids).not.toContain(RECURRING_PAST);

    // A smaller page walks to the same set — the cursor, not the page size,
    // decides what is reachable.
    const small = await walk('getPast', ORGANIZATION_A, ADMIN, 7);
    expect(small.ids).toEqual(ids);
  });

  // 4. Upcoming and Past paginate independently: separate procedures, separate
  //    cursors, so exhausting one cannot move the other.
  it('paginates Upcoming and Past independently', async () => {
    const upcomingBefore = await getUpcomingIds(ORGANIZATION_A, MEMBER);
    const pastBefore = (await firstPastPage(ORGANIZATION_A, MEMBER)).items.map((m) => m.id);
    expect(upcomingBefore.length).toBeGreaterThan(0);
    expect(pastBefore).toHaveLength(DEFAULT_PAGE_SIZE);

    // Exhaust Past…
    const past = await walk('getPast', ORGANIZATION_A, MEMBER);
    expect(past.ids).toHaveLength(PAST_MEMBER_COUNT);

    // …Upcoming is exactly where it was, and Past starts over from the top.
    expect(await getUpcomingIds(ORGANIZATION_A, MEMBER)).toEqual(upcomingBefore);
    expect((await firstPastPage(ORGANIZATION_A, MEMBER)).items.map((m) => m.id)).toEqual(
      pastBefore
    );

    // And the reverse: exhaust the organization list, which walks the whole
    // future calendar, and Past's first page has not moved either.
    const list = await walk('getAll', ORGANIZATION_A, MEMBER);
    expect(list.ids.length).toBeGreaterThan(FUTURE_COUNT);
    expect((await firstPastPage(ORGANIZATION_A, MEMBER)).items.map((m) => m.id)).toEqual(
      pastBefore
    );
    expect(await getUpcomingIds(ORGANIZATION_A, MEMBER)).toEqual(upcomingBefore);
  });

  // 5. The scope this path uses: `meetingListScope` — the getAll/#36 policy,
  //    organization-wide for an ADMIN. NOT `upcomingListScope`, whose #38
  //    narrowing covers the upcoming surfaces only. Asserted against an oracle
  //    issued directly against the database.
  it('gives an ADMIN the organization past and a non-admin only their own', async () => {
    const adminIds = (await walk('getPast', ORGANIZATION_A, ADMIN)).ids;
    const memberIds = (await walk('getPast', ORGANIZATION_A, MEMBER)).ids;

    expect(adminIds).toEqual(await oraclePastIds(ORGANIZATION_A));
    expect(memberIds).toEqual(await oraclePastIds(ORGANIZATION_A, MEMBER_A));

    // The two scopes genuinely differ: the admin attends nothing at all, yet
    // reaches past meetings whose only attendee is somebody else.
    expect(adminIds.length).toBeGreaterThan(memberIds.length);
    expect(adminIds).toContain(organizationOnlyId(0));
    expect(adminIds).toContain(tieId(0));
    expect(memberIds).not.toContain(organizationOnlyId(0));
    expect(memberIds).not.toContain(tieId(0));
  });

  // 6. `meetingListScope`'s ADMIN branch carries no organizationId filter by
  //    design, so this case has exactly one thing standing between organization
  //    B and organization A's history: row level security.
  it("keeps another organization's past meetings invisible, through RLS", async () => {
    const adminB = { id: ADMIN_B, role: 'ADMIN' as const };

    const pageB = await firstPastPage(ORGANIZATION_B, adminB);
    expect(pageB.items.map((m) => m.id)).toEqual([PAST_B]);
    expect(pageB.nextCursor).toBeUndefined();

    const adminIds = (await walk('getPast', ORGANIZATION_A, ADMIN)).ids;
    expect(adminIds).not.toContain(PAST_B);
    expect(adminIds).toHaveLength(ADMIN_PAST_TOTAL);
  });

  // 7. #38's guard, on the new path. The bound has to hold for the shape
  //    production sends, which is no input at all, and the caller cannot argue
  //    the ceiling away.
  it('bounds getPast when the caller supplies no input', async () => {
    expect(ADMIN_PAST_TOTAL).toBeGreaterThan(DEFAULT_PAGE_SIZE);

    const omitted = await firstPastPage(ORGANIZATION_A, ADMIN);
    expect(omitted.items).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(omitted.nextCursor).toBeTruthy();

    // Present but empty — the other no-limit shape — is bounded identically.
    const empty = await deps.withTenantDb(ORGANIZATION_A, (db) => caller(db, ADMIN).getPast({}));
    expect(empty.items).toHaveLength(DEFAULT_PAGE_SIZE);
    expect(empty.items.map((m) => m.id)).toEqual(omitted.items.map((m) => m.id));

    await expect(
      deps.withTenantDb(ORGANIZATION_A, (db) =>
        caller(db, ADMIN).getPast({ limit: MAX_PAGE_SIZE + 1 })
      )
    ).rejects.toThrow();
  });
});
