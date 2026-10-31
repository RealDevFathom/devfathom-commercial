/**
 * Meetings list policy, against a REAL PostgreSQL (#35).
 *
 * A mock cannot establish what this file is for. Two of the cases are
 * decided by PostgreSQL, not by application code:
 *
 *  - the ADMIN branch deliberately carries NO `organizationId` filter, so the
 *    cross-organization case is decided purely by row level security. Faking
 *    the client would test the fake.
 *  - the past-meeting case depends on rows actually being stored and returned
 *    with their real timestamps, which is what the Past surface filters on.
 *
 * Fixtures live in two organizations created by this file and removed again in
 * `afterAll`. Nothing here touches staging, and nothing here reads the seeded
 * organization, so the expected counts are exact.
 *
 * Requires TEST_DATABASE_URL (a migrated, throwaway database — the same
 * variable `test:rls` uses, and never DATABASE_URL). Without it the suite
 * reports itself skipped rather than passing vacuously.
 *
 * The connection role must be NEITHER a superuser NOR BYPASSRLS: both bypass
 * row level security outright, FORCE included, which would leave the
 * cross-organization case testing nothing it claims to test.
 * `assertRlsEnforcingRole` refuses to run rather than let that happen quietly.
 * `test:rls` solves the same problem with `SET LOCAL ROLE`; Prisma has no
 * equivalent, so the URL itself has to name an unprivileged role.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { assertRlsEnforcingRole } from '@/lib/testing/rls-role-guard';
import { seedDepartments } from '@/lib/test-support/departments';
import { isMeetingTimeConstraintError } from '@/lib/meetings/time-range';

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
const id = (name: string) => `${name}_list_policy_${suffix}`;

const ORGANIZATION_A = id('org_a');
const ORGANIZATION_B = id('org_b');

const ADMIN_A = id('user_admin_a');
const MEMBER_A = id('user_member_a');
const OUTSIDER_A = id('user_outsider_a');
const STRANGER_A = id('user_stranger_a');
const ADMIN_B = id('user_admin_b');

const FUTURE_MEMBER = id('meeting_future_member');
const PAST_MEMBER = id('meeting_past_member');
const FUTURE_STRANGER = id('meeting_future_stranger');

const DAY = 24 * 60 * 60 * 1000;

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  meetingsRouter: (typeof import('./meetings'))['meetingsRouter'];
};

let deps: Deps;

type Actor = { id: string; role: 'ADMIN' | 'EMPLOYEE' };

/**
 * The list procedures use `db`, `session.user` and `entitlements` only. The
 * session shape mirrors what `requireActiveUser` and `requireLicensedModule`
 * demand of a live session.
 */
const caller = (db: unknown, actor: Actor) =>
  deps.meetingsRouter.createCaller({
    db,
    session: { user: { id: actor.id, role: actor.role, status: 'ACTIVE' } },
    entitlements: { enabledModules: ['meetings'] },
  } as never);

const sorted = (ids: string[]) => [...ids].sort();

const getAllIds = (organizationId: string, actor: Actor) =>
  deps.withTenantDb(organizationId, async (db) =>
    sorted((await caller(db, actor).getAll()).items.map((m) => m.id))
  );

const getUpcomingIds = (organizationId: string, actor: Actor) =>
  deps.withTenantDb(organizationId, async (db) =>
    sorted((await caller(db, actor).getUpcoming()).map((m) => m.id))
  );

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

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDatabase('meetings list policy, against PostgreSQL', () => {
  beforeAll(async () => {
    const scopedDb = await import('@/lib/tenancy/scoped-db');
    deps = {
      withTenantDb: scopedDb.withTenantDb,
      withPlatformDb: scopedDb.withPlatformDb,
      meetingsRouter: (await import('./meetings')).meetingsRouter,
    };

    // The cross-organization case below is decided purely by row level
    // security, so a role that bypasses it would leave that case proving
    // nothing.
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
            legalName: `List Policy ${label}`,
            displayName: `List Policy ${label}`,
            status: 'ACTIVE',
          },
        });
        await seedDepartments(db, [organizationId], ['ENGINEERING']);
      }
    });

    const now = Date.now();

    await deps.withTenantDb(ORGANIZATION_A, async (db) => {
      await db.user.create({ data: user(ADMIN_A, ORGANIZATION_A, 'ADMIN') });
      await db.user.create({ data: user(MEMBER_A, ORGANIZATION_A, 'EMPLOYEE') });
      await db.user.create({ data: user(OUTSIDER_A, ORGANIZATION_A, 'EMPLOYEE') });
      await db.user.create({ data: user(STRANGER_A, ORGANIZATION_A, 'EMPLOYEE') });

      await db.meeting.create({
        data: {
          id: FUTURE_MEMBER,
          title: 'Future, member attends',
          startTime: new Date(now + 2 * DAY),
          endTime: new Date(now + 2 * DAY + 3_600_000),
          createdById: MEMBER_A,
          attendees: { create: [{ userId: MEMBER_A }] },
        },
      });
      await db.meeting.create({
        data: {
          id: PAST_MEMBER,
          title: 'Past, member attended',
          startTime: new Date(now - 2 * DAY),
          endTime: new Date(now - 2 * DAY + 3_600_000),
          createdById: MEMBER_A,
          attendees: { create: [{ userId: MEMBER_A }] },
        },
      });
      await db.meeting.create({
        data: {
          id: FUTURE_STRANGER,
          title: 'Future, nobody else attends',
          startTime: new Date(now + 3 * DAY),
          endTime: new Date(now + 3 * DAY + 3_600_000),
          createdById: STRANGER_A,
          attendees: { create: [{ userId: STRANGER_A }] },
        },
      });
    });

    await deps.withTenantDb(ORGANIZATION_B, async (db) => {
      await db.user.create({ data: user(ADMIN_B, ORGANIZATION_B, 'ADMIN') });
    });
  }, 60_000);

  afterAll(async () => {
    if (!deps) return;
    await deps.withPlatformDb(async (db) => {
      await db.meeting.deleteMany({
        where: { id: { in: [FUTURE_MEMBER, PAST_MEMBER, FUTURE_STRANGER] } },
      });
      await db.user.deleteMany({
        where: { id: { in: [ADMIN_A, MEMBER_A, OUTSIDER_A, STRANGER_A, ADMIN_B] } },
      });
      await db.organization.deleteMany({
        where: { id: { in: [ORGANIZATION_A, ORGANIZATION_B] } },
      });
    });
  }, 60_000);

  it('shows an ADMIN who attends nothing every meeting in the organization', async () => {
    expect(await getAllIds(ORGANIZATION_A, { id: ADMIN_A, role: 'ADMIN' })).toEqual(
      sorted([FUTURE_MEMBER, PAST_MEMBER, FUTURE_STRANGER])
    );
  });

  // CHANGED BY #38, deliberately. This file asserted organization-wide
  // `getUpcoming` for an ADMIN because that is what #35 specified and PR #36
  // delivered. #38 narrows the upcoming surfaces back to user-relevant for
  // every role: they feed the dashboard widget and the Upcoming section, and
  // organization-wide they made every admin dashboard load fetch the tenant's
  // entire future calendar. Organization-wide DISCOVERY is unchanged and still
  // lives on `getAll`, asserted above. See `upcomingListScope`.
  it('keeps the upcoming surfaces user-relevant, including for an ADMIN (#38)', async () => {
    expect(await getUpcomingIds(ORGANIZATION_A, { id: ADMIN_A, role: 'ADMIN' })).toEqual([]);
    expect(await getUpcomingIds(ORGANIZATION_A, { id: MEMBER_A, role: 'EMPLOYEE' })).toEqual([
      FUTURE_MEMBER,
    ]);
  });

  it('shows an ordinary non-attendee nothing', async () => {
    expect(await getAllIds(ORGANIZATION_A, { id: OUTSIDER_A, role: 'EMPLOYEE' })).toEqual([]);
    expect(await getUpcomingIds(ORGANIZATION_A, { id: OUTSIDER_A, role: 'EMPLOYEE' })).toEqual([]);
  });

  it('shows an attendee and creator exactly their own meetings', async () => {
    expect(await getAllIds(ORGANIZATION_A, { id: MEMBER_A, role: 'EMPLOYEE' })).toEqual(
      sorted([FUTURE_MEMBER, PAST_MEMBER])
    );
    expect(await getUpcomingIds(ORGANIZATION_A, { id: MEMBER_A, role: 'EMPLOYEE' })).toEqual([
      FUTURE_MEMBER,
    ]);
  });

  // The ADMIN branch carries no organizationId filter by design, so this case
  // has exactly one thing standing between organization B and organization A's
  // meetings: row level security. If RLS regressed, this test fails — which is
  // the point of leaving the filter out.
  it("keeps another organization's ADMIN out, through RLS", async () => {
    expect(await getAllIds(ORGANIZATION_B, { id: ADMIN_B, role: 'ADMIN' })).toEqual([]);
    expect(await getUpcomingIds(ORGANIZATION_B, { id: ADMIN_B, role: 'ADMIN' })).toEqual([]);
  });

  it('returns past meetings through getAll, in the shape the Past surface filters on', async () => {
    const meetings = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      caller(db, { id: ADMIN_A, role: 'ADMIN' }).getAll()
    );

    const past = meetings.items.find((m) => m.id === PAST_MEMBER);
    // `meetings-content.tsx` builds its Past section from getAll with
    // `isPast(startTime) && !recurrence`.
    expect(past?.startTime.getTime()).toBeLessThan(Date.now());
    expect(past?.recurrence).toBeNull();
    expect(await getUpcomingIds(ORGANIZATION_A, { id: ADMIN_A, role: 'ADMIN' })).not.toContain(
      PAST_MEMBER
    );
  });

  it('replaces attendees atomically with a time edit, preserving them when the edit fails', async () => {
    const attendeeIds = () => deps.withTenantDb(ORGANIZATION_A, async (db) => {
      const meeting = await db.meeting.findUniqueOrThrow({
        where: { id: FUTURE_MEMBER },
        select: { attendees: { select: { userId: true } } },
      });
      return sorted(meeting.attendees.map((attendee) => attendee.userId));
    });
    const original = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      db.meeting.findUniqueOrThrow({
        where: { id: FUTURE_MEMBER },
        select: { startTime: true, endTime: true },
      })
    );

    try {
      await deps.withTenantDb(ORGANIZATION_A, (db) => db.meeting.update({
        where: { id: FUTURE_MEMBER },
        data: {
          ...original,
          attendees: { deleteMany: {}, create: [{ userId: MEMBER_A }, { userId: OUTSIDER_A }] },
        },
      }));
      expect(await attendeeIds()).toEqual(sorted([MEMBER_A, OUTSIDER_A]));

      await expect(deps.withTenantDb(ORGANIZATION_A, (db) => db.meeting.update({
        where: { id: FUTURE_MEMBER },
        data: {
          endTime: original.startTime,
          attendees: { deleteMany: {}, create: [{ userId: STRANGER_A }] },
        },
      }))).rejects.toSatisfy(isMeetingTimeConstraintError);
      expect(await attendeeIds()).toEqual(sorted([MEMBER_A, OUTSIDER_A]));
    } finally {
      await deps.withTenantDb(ORGANIZATION_A, (db) => db.meeting.update({
        where: { id: FUTURE_MEMBER },
        data: { attendees: { deleteMany: {}, create: [{ userId: MEMBER_A }] } },
      }));
    }
  });

  it('atomically rejects complementary partial updates that would create an invalid range', async () => {
    const original = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      db.meeting.findUniqueOrThrow({
        where: { id: FUTURE_MEMBER },
        select: { startTime: true, endTime: true },
      })
    );
    const laterStart = new Date(original.endTime.getTime() - 30 * 60 * 1000);
    const earlierEnd = new Date(original.startTime.getTime() + 30 * 60 * 1000);

    const results = await Promise.allSettled([
      deps.withTenantDb(ORGANIZATION_A, (db) =>
        db.meeting.update({ where: { id: FUTURE_MEMBER }, data: { startTime: laterStart } })
      ),
      deps.withTenantDb(ORGANIZATION_A, (db) =>
        db.meeting.update({ where: { id: FUTURE_MEMBER }, data: { endTime: earlierEnd } })
      ),
    ]);

    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const stored = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      db.meeting.findUniqueOrThrow({
        where: { id: FUTURE_MEMBER },
        select: { startTime: true, endTime: true },
      })
    );
    expect(stored.endTime.getTime()).toBeGreaterThan(stored.startTime.getTime());

    await deps.withTenantDb(ORGANIZATION_A, (db) =>
      db.meeting.update({ where: { id: FUTURE_MEMBER }, data: original })
    );
  });
});
