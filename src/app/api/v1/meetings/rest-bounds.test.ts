// @vitest-environment node
/**
 * REST `GET /api/v1/meetings` BOUNDS, against a REAL PostgreSQL (#45).
 *
 * `src/server/routers/meetings-bounds.test.ts` bounds the tRPC surface (#38).
 * This file bounds the REST one, which is a genuinely separate code path: the
 * route handler calls `ctx.db.meeting.findMany` directly and never consults the
 * meetings router, so the server-side default #38 established does not reach
 * it. Before this change, omitting `?limit` produced `take: undefined` — every
 * meeting the token's user attends, attendee graph included, in one response.
 *
 * A real database is required for the same reasons the tRPC file gives:
 *
 *  - a ceiling is only evidence of a bound if the fixture is bigger than the
 *    ceiling, so the fixture here is 130 meetings, not five;
 *  - ordering across TIED `startTime` values is decided by PostgreSQL, not by
 *    application code. `startTime` alone is not a total order; with only
 *    `ORDER BY "startTime"` the server may return a tied block in any order it
 *    likes, and a mock would simply agree with whatever it was written to say;
 *  - attendee scoping and RLS are enforced by the database, and the route
 *    deliberately carries no `organizationId` predicate.
 *
 * Requires TEST_DATABASE_URL (a migrated, throwaway database — never
 * DATABASE_URL). Without it the suite reports itself skipped rather than
 * passing vacuously.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { assertRlsEnforcingRole } from '@/lib/testing/rls-role-guard';
import { seedDepartments } from '@/lib/test-support/departments';

// REST audit writes are fire-and-forget: `recordRestAudit` starts a detached
// transaction that would outlive the assertion it belongs to and race teardown.
// Nothing here tests auditing; PR #41 covers that surface.
vi.mock('@/server/audit', () => ({ recordRestAudit: vi.fn() }));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// The client in `@/lib/db` reads DATABASE_URL when its module is evaluated, so
// this must happen before the dynamic imports below.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const suffix = randomBytes(6).toString('hex');
const id = (name: string) => `${name}_rest_${suffix}`;

const ORGANIZATION_A = id('org_a');
const OWNER_A = id('user_owner_a');
const OTHER_A = id('user_other_a');

const HOUR = 60 * 60 * 1000;

/** The page size the route applies when `?limit` is absent. */
const DEFAULT_LIMIT = 50;
/** The largest page a caller may ask for. */
const MAX_LIMIT = 100;

// Fixture sizes, both deliberately larger than the ceiling they exercise: a
// bound the fixture cannot reach proves nothing.
const OWNER_COUNT = 130; // > MAX_LIMIT
const OTHER_COUNT = 40;

/** Ids sort lexically, so zero-padding makes the id tiebreaker predictable. */
const pad = (n: number) => String(n).padStart(3, '0');
const ownerMeetingId = (n: number) => `${id('mtg_owner')}_${pad(n)}`;
const otherMeetingId = (n: number) => `${id('mtg_other')}_${pad(n)}`;

/**
 * Ranks 45..59 of the owner's set share ONE instant on purpose, so the default
 * 50-row page boundary falls inside the tied block.
 */
const TIE_FIRST = 45;
const TIE_LAST = 59;
const tiedIds = Array.from({ length: TIE_LAST - TIE_FIRST + 1 }, (_, i) =>
  ownerMeetingId(TIE_FIRST + i)
);

type Deps = {
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  GET: (typeof import('./route'))['GET'];
};

let deps: Deps;

/** Plaintext bearer tokens, minted in `beforeAll`. */
const tokens = { owner: '', other: '', noScope: '' };

const callGet = async (token: string, query = '') => {
  const response = await deps.GET(
    new Request(`https://acme.example.test/api/v1/meetings${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  );
  return {
    status: response.status,
    body: (await response.json()) as { data?: Array<{ id: string }> },
  };
};

const idsFrom = (body: { data?: Array<{ id: string }> }) => (body.data ?? []).map((m) => m.id);

/** What the route must return, computed by the database, not by this file. */
const oracleIds = (userId: string) =>
  deps.withTenantDb(ORGANIZATION_A, async (db) =>
    (
      await db.meeting.findMany({
        where: { attendees: { some: { userId } } },
        orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
        select: { id: true },
      })
    ).map((m) => m.id)
  );

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDatabase('GET /api/v1/meetings bounds, against PostgreSQL', () => {
  beforeAll(async () => {
    const scopedDb = await import('@/lib/tenancy/scoped-db');
    deps = {
      withPlatformDb: scopedDb.withPlatformDb,
      withTenantDb: scopedDb.withTenantDb,
      GET: (await import('./route')).GET,
    };

    // The attendee and tenant scoping cases below are decided by row level
    // security, so a role that bypasses it would turn them into tests that
    // pass no matter what the route does.
    await assertRlsEnforcingRole(deps.withPlatformDb);

    const { generateApiToken } = await import('@/lib/api-auth');
    const minted = {
      owner: await generateApiToken(),
      other: await generateApiToken(),
      noScope: await generateApiToken(),
    };
    tokens.owner = minted.owner.token;
    tokens.other = minted.other.token;
    tokens.noScope = minted.noScope.token;

    await deps.withPlatformDb(async (db) => {
      await db.organization.create({
        data: {
          id: ORGANIZATION_A,
          slug: ORGANIZATION_A.replaceAll('_', '-'),
          legalName: 'REST Bounds A',
          displayName: 'REST Bounds A',
          status: 'ACTIVE',
        },
      });
      await seedDepartments(db, [ORGANIZATION_A], ['ENGINEERING']);

      // The route is gated on the `api` and `meetings` modules. Catalog rows
      // are control-plane-only and may already exist in a migrated database,
      // so upsert by key rather than create.
      for (const [key, name] of [
        ['api', 'API'],
        ['meetings', 'Meetings'],
      ] as const) {
        const platformModule = await db.platformModule.upsert({
          where: { key },
          create: { key, name, category: 'core', band: 'PLATFORM', active: true },
          update: { active: true },
        });
        await db.organizationModule.create({
          data: {
            organizationId: ORGANIZATION_A,
            moduleId: platformModule.id,
            status: 'ENABLED',
          },
        });
      }
    });

    const now = Date.now();
    const base = now + HOUR;
    const meetings: Array<{
      id: string;
      title: string;
      startTime: Date;
      endTime: Date;
      createdById: string;
    }> = [];
    const attendees: Array<{ meetingId: string; userId: string }> = [];

    const add = (meetingId: string, attendeeId: string, startMs: number) => {
      meetings.push({
        id: meetingId,
        title: meetingId,
        startTime: new Date(startMs),
        endTime: new Date(startMs + HOUR),
        createdById: attendeeId,
      });
      attendees.push({ meetingId, userId: attendeeId });
    };

    // Owner's set: one meeting per hour, ASCENDING, except ranks
    // TIE_FIRST..TIE_LAST which all share rank TIE_FIRST's instant. Ids are
    // zero-padded and allocated in rank order, so the composite
    // (startTime asc, id asc) order is exactly index order 0..OWNER_COUNT-1 —
    // and the tied block straddles the default 50-row boundary.
    for (let i = 0; i < OWNER_COUNT; i++) {
      const rank = i >= TIE_FIRST && i <= TIE_LAST ? TIE_FIRST : i;
      add(ownerMeetingId(i), OWNER_A, base + rank * HOUR);
    }

    // A second user in the SAME tenant, so "sees only its own user's meetings"
    // is decided by the attendee predicate rather than by RLS.
    for (let i = 0; i < OTHER_COUNT; i++) add(otherMeetingId(i), OTHER_A, base + i * HOUR);

    await deps.withTenantDb(
      ORGANIZATION_A,
      async (db) => {
        for (const [userId, role] of [
          [OWNER_A, 'EMPLOYEE'],
          [OTHER_A, 'EMPLOYEE'],
        ] as const) {
          await db.user.create({
            data: {
              id: userId,
              organizationId: ORGANIZATION_A,
              email: `${userId}@example.test`,
              name: userId,
              title: 'Engineer',
              department: 'ENGINEERING',
              role,
              status: 'ACTIVE',
            },
          });
        }
        await db.meeting.createMany({ data: meetings });
        await db.meetingAttendee.createMany({ data: attendees });

        for (const [key, userId, scopes] of [
          ['owner', OWNER_A, ['meetings:read']],
          ['other', OTHER_A, ['meetings:read']],
          // Deliberately NOT meetings:read, and not a scope that implies it.
          ['noScope', OWNER_A, ['tasks:read']],
        ] as const) {
          await db.apiToken.create({
            data: {
              organizationId: ORGANIZATION_A,
              name: `${key} token`,
              prefix: minted[key].prefix,
              tokenHash: minted[key].hash,
              scopes: [...scopes],
              userId,
            },
          });
        }
      },
      { timeout: 120_000, maxWait: 30_000 }
    );
  }, 180_000);

  afterAll(async () => {
    if (!deps) return;
    await deps.withPlatformDb(
      async (db) => {
        await db.meeting.deleteMany({ where: { organizationId: ORGANIZATION_A } });
        await db.apiToken.deleteMany({ where: { organizationId: ORGANIZATION_A } });
        await db.user.deleteMany({ where: { organizationId: ORGANIZATION_A } });
        await db.organizationModule.deleteMany({ where: { organizationId: ORGANIZATION_A } });
        await db.organization.deleteMany({ where: { id: ORGANIZATION_A } });
      },
      { timeout: 120_000, maxWait: 30_000 }
    );
  }, 180_000);

  // 1. THE DEFECT. Against the pre-#45 route this returns all OWNER_COUNT
  //    meetings, attendee graph included, because `take` was `undefined`.
  it('bounds the response to the default when ?limit is omitted', async () => {
    const { status, body } = await callGet(tokens.owner);

    expect(status).toBe(200);
    expect(OWNER_COUNT).toBeGreaterThan(DEFAULT_LIMIT);
    expect(body.data).toHaveLength(DEFAULT_LIMIT);
  });

  // 2. A limit the caller is allowed to ask for is passed through untouched.
  it('honours an explicit valid limit', async () => {
    for (const limit of [1, 7, MAX_LIMIT]) {
      const { status, body } = await callGet(tokens.owner, `?limit=${limit}`);
      expect(status).toBe(200);
      expect(body.data).toHaveLength(limit);
    }
  });

  // 3. The ceiling cannot be argued away by the caller.
  it('clamps an excessive limit to the maximum', async () => {
    for (const limit of [101, 1000, 100000]) {
      const { status, body } = await callGet(tokens.owner, `?limit=${limit}`);
      expect(status).toBe(200);
      expect(body.data).toHaveLength(MAX_LIMIT);
    }
  });

  // 4. Malformed input resolves by a stated rule and never reaches Prisma as
  //    `take: NaN`, which is a 500. The rule, matching /tasks and
  //    /transactions exactly:
  //      parseInt(raw ?? '50', 10) || 50, then clamped into [1, MAX_LIMIT].
  //    So anything that parses to NaN or 0 falls back to the default, and
  //    anything that parses below 1 floors at 1.
  it('resolves malformed limits predictably, never 500', async () => {
    const cases: Array<[string, number]> = [
      ['?limit=abc', DEFAULT_LIMIT], // NaN     → default
      ['?limit=0', DEFAULT_LIMIT], // 0 falsy → default
      ['?limit=', DEFAULT_LIMIT], // NaN     → default
      ['?limit=null', DEFAULT_LIMIT], // NaN     → default
      ['?limit=-5', 1], // parses, floors at 1
      ['?limit=-9999', 1], // parses, floors at 1
      ['?limit=7.9', 7], // parseInt truncates
      ['?limit=1e9', 1], // parseInt stops at 'e' → 1
    ];

    for (const [query, expected] of cases) {
      const { status, body } = await callGet(tokens.owner, query);
      expect(status, `${query} must not 500`).toBe(200);
      expect(body.data, `${query} must resolve to ${expected}`).toHaveLength(expected);
    }
  });

  // 5. `startTime` alone is not a total order. Fifteen meetings share one
  //    instant and the default page boundary lands inside them, so without a
  //    unique tiebreaker PostgreSQL is free to return that block differently
  //    between two identical calls, silently dropping and repeating rows.
  it('orders deterministically across tied startTimes', async () => {
    const first = await callGet(tokens.owner);
    const second = await callGet(tokens.owner);

    // Same answer twice.
    expect(idsFrom(first.body)).toEqual(idsFrom(second.body));

    // …and that answer is the composite order the database computes, not
    // whatever the plan happened to produce.
    const expected = await oracleIds(OWNER_A);
    expect(expected).toHaveLength(OWNER_COUNT);
    expect(idsFrom(first.body)).toEqual(expected.slice(0, DEFAULT_LIMIT));

    // The tied block genuinely straddles the boundary, so the assertions above
    // are not passing by accident.
    const page = idsFrom(first.body);
    expect(tiedIds.some((meetingId) => page.includes(meetingId))).toBe(true);
    expect(tiedIds.some((meetingId) => !page.includes(meetingId))).toBe(true);

    // Within the tie, the order is `id` ascending exactly — the only thing that
    // can guarantee it is the unique tiebreaker.
    const seenTied = page.filter((meetingId) => tiedIds.includes(meetingId));
    expect(seenTied).toEqual(tiedIds.slice(0, seenTied.length));

    // A larger page keeps the same prefix rather than reshuffling the tie.
    const wide = await callGet(tokens.owner, `?limit=${MAX_LIMIT}`);
    expect(idsFrom(wide.body)).toEqual(expected.slice(0, MAX_LIMIT));
  });

  // 6. Authorization is unchanged by the bound.
  it('still refuses a token without meetings:read', async () => {
    const { status, body } = await callGet(tokens.noScope);

    expect(status).toBe(403);
    expect(body.data).toBeUndefined();
  });

  it('still shows a token only its own user’s meetings', async () => {
    const { status, body } = await callGet(tokens.other, `?limit=${MAX_LIMIT}`);
    expect(status).toBe(200);

    const seen = idsFrom(body);
    // OTHER_COUNT is under the ceiling, so this is the user's whole set.
    expect(seen).toEqual(await oracleIds(OTHER_A));
    expect(seen).toHaveLength(OTHER_COUNT);
    expect(seen.every((meetingId) => meetingId.startsWith(id('mtg_other')))).toBe(true);
    expect(seen.some((meetingId) => meetingId.startsWith(id('mtg_owner')))).toBe(false);
  });
});
