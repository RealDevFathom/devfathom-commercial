/**
 * Meeting time order through the tRPC router, against a REAL PostgreSQL
 * (DEV-249 / #451).
 *
 * `meetings.create` and `meetings.update` used to accept an end at or before
 * the start. These cases pin the fix on both procedures, and the partial-update
 * cases are the reason a database is needed: a patch that carries only
 * `startTime` (or only `endTime`) has to be judged against the value that is
 * actually stored, which a mocked client would answer with whatever the mock
 * was told to say.
 *
 * The last cases hit the `meetings_time_order_check` CHECK directly, below the
 * router, to prove the floor exists for any writer that skips the shared
 * validator.
 *
 * No row level security guard: nothing here depends on tenant isolation, and
 * the assertions are equally true for a role that bypasses it.
 *
 * Requires TEST_DATABASE_URL (a migrated, throwaway database, never
 * DATABASE_URL). Without it the suite reports itself skipped rather than
 * passing vacuously.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MEETING_TIME_ORDER_MESSAGE } from '@/lib/meetings/time-order';
import { seedDepartments } from '@/lib/test-support/departments';

// The router reaches `@/server/trpc`, which reaches Auth.js, which cannot load
// outside a Next server runtime. The context below is built by hand; the
// database, the router and the scoped transactions are all real.
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// `@/lib/db` reads DATABASE_URL when its module is evaluated, so this has to
// happen before the dynamic imports in `beforeAll`.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const suffix = randomBytes(6).toString('hex');
const id = (name: string) => `${name}_order_${suffix}`;

const ORGANIZATION = id('org');
const OWNER = id('user_owner');
const GUEST = id('user_guest');

const HOUR = 60 * 60 * 1000;
// A whole hour well in the future, so nothing here is "past" and every slot
// the materialiser writes is SCHEDULED.
const BASE = Math.ceil((Date.now() + 7 * 24 * HOUR) / HOUR) * HOUR;
const at = (hours: number) => new Date(BASE + hours * HOUR);

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  meetingsRouter: (typeof import('./meetings'))['meetingsRouter'];
};

let deps: Deps;

const caller = (db: unknown) =>
  deps.meetingsRouter.createCaller({
    db,
    session: {
      user: { id: OWNER, organizationId: ORGANIZATION, role: 'EMPLOYEE', status: 'ACTIVE' },
    },
    entitlements: { enabledModules: ['meetings'] },
  } as never);

const asOwner = <T>(run: (called: ReturnType<typeof caller>, db: unknown) => Promise<T>) =>
  deps.withTenantDb(ORGANIZATION, (db) => run(caller(db), db));

const stored = (meetingId: string) =>
  deps.withTenantDb(ORGANIZATION, (db) =>
    db.meeting.findUniqueOrThrow({
      where: { id: meetingId },
      select: { startTime: true, endTime: true, title: true },
    })
  );

const refusal = { code: 'BAD_REQUEST', message: MEETING_TIME_ORDER_MESSAGE };

/** A fresh 10:00–11:00 (relative to BASE) meeting owned by OWNER. */
const createSeries = (title: string) =>
  asOwner((called) =>
    called.create({ title, startTime: at(10), endTime: at(11), attendeeIds: [] })
  );

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDatabase('meeting time order, against PostgreSQL', () => {
  beforeAll(async () => {
    const scopedDb = await import('@/lib/tenancy/scoped-db');
    deps = {
      withTenantDb: scopedDb.withTenantDb,
      withPlatformDb: scopedDb.withPlatformDb,
      meetingsRouter: (await import('./meetings')).meetingsRouter,
    };

    await deps.withPlatformDb(async (db) => {
      await db.organization.create({
        data: {
          id: ORGANIZATION,
          slug: ORGANIZATION.replaceAll('_', '-'),
          legalName: 'Time Order',
          displayName: 'Time Order',
          status: 'ACTIVE',
        },
      });
      await seedDepartments(db, [ORGANIZATION], ['ENGINEERING']);
    });

    await deps.withTenantDb(ORGANIZATION, async (db) => {
      for (const userId of [OWNER, GUEST]) {
        await db.user.create({
          data: {
            id: userId,
            organizationId: ORGANIZATION,
            email: `${userId}@example.test`,
            name: userId,
            title: 'Engineer',
            department: 'ENGINEERING',
            role: 'EMPLOYEE',
            status: 'ACTIVE',
          },
        });
      }
    });
  }, 60_000);

  afterAll(async () => {
    if (!deps) return;
    await deps.withPlatformDb(async (db) => {
      await db.meeting.deleteMany({ where: { organizationId: ORGANIZATION } });
      await db.user.deleteMany({ where: { organizationId: ORGANIZATION } });
      await db.organization.deleteMany({ where: { id: ORGANIZATION } });
    });
  }, 60_000);

  describe('create', () => {
    it.each([
      ['equal to', 10],
      ['before', 9],
    ])('refuses an end %s the start and writes nothing', async (_label, endHour) => {
      const title = id(`create_bad_${endHour}`);

      await expect(
        asOwner((called) =>
          called.create({ title, startTime: at(10), endTime: at(endHour), attendeeIds: [] })
        )
      ).rejects.toMatchObject(refusal);

      const rows = await deps.withTenantDb(ORGANIZATION, (db) =>
        db.meeting.count({ where: { title } })
      );
      expect(rows).toBe(0);
    });

    it('accepts an end after the start', async () => {
      const meeting = await createSeries(id('create_ok'));
      expect(meeting.endTime.getTime()).toBeGreaterThan(meeting.startTime.getTime());
    });
  });

  describe('update', () => {
    it('refuses a start-only edit that would reach the STORED end', async () => {
      const meeting = await createSeries(id('start_only'));

      for (const startHour of [11, 12]) {
        await expect(
          asOwner((called) => called.update({ id: meeting.id, startTime: at(startHour) }))
        ).rejects.toMatchObject(refusal);
      }

      expect(await stored(meeting.id)).toMatchObject({ startTime: at(10), endTime: at(11) });
    });

    it('refuses an end-only edit that would reach the STORED start', async () => {
      const meeting = await createSeries(id('end_only'));

      for (const endHour of [10, 9]) {
        await expect(
          asOwner((called) => called.update({ id: meeting.id, endTime: at(endHour) }))
        ).rejects.toMatchObject(refusal);
      }

      expect(await stored(meeting.id)).toMatchObject({ startTime: at(10), endTime: at(11) });
    });

    it('refuses an edit that supplies both times out of order', async () => {
      const meeting = await createSeries(id('both_bad'));

      await expect(
        asOwner((called) => called.update({ id: meeting.id, startTime: at(14), endTime: at(13) }))
      ).rejects.toMatchObject(refusal);
    });

    it('refuses BEFORE replacing attendees, so a rejected edit changes nothing', async () => {
      const meeting = await createSeries(id('attendees'));

      // Run the refused edit and the read in ONE transaction. If the attendee
      // replacement ran before the check, the read would see GUEST added (or
      // the transaction would already be aborted); a rollback cannot hide it.
      const attendeeIds = await deps.withTenantDb(ORGANIZATION, async (db) => {
        await expect(
          caller(db).update({
            id: meeting.id,
            title: 'renamed',
            startTime: at(12),
            attendeeIds: [GUEST],
          })
        ).rejects.toMatchObject(refusal);
        const rows = await db.meetingAttendee.findMany({
          where: { meetingId: meeting.id },
          select: { userId: true },
        });
        return rows.map((row) => row.userId);
      });

      expect(attendeeIds).toEqual([OWNER]);
      expect((await stored(meeting.id)).title).toBe(id('attendees'));
    });

    it('accepts a partial edit that keeps the range in order', async () => {
      const meeting = await createSeries(id('partial_ok'));

      await asOwner((called) => called.update({ id: meeting.id, startTime: at(9) }));
      expect(await stored(meeting.id)).toMatchObject({ startTime: at(9), endTime: at(11) });

      await asOwner((called) => called.update({ id: meeting.id, endTime: at(9.5) }));
      expect(await stored(meeting.id)).toMatchObject({ startTime: at(9), endTime: at(9.5) });

      // An edit that leaves both times alone never consults them.
      await asOwner((called) => called.update({ id: meeting.id, title: id('renamed') }));
      expect((await stored(meeting.id)).title).toBe(id('renamed'));
    });
  });

  describe('rescheduleOccurrence', () => {
    it('refuses moving one occurrence to a zero-length or backwards slot', async () => {
      const meeting = await createSeries(id('occurrence'));
      const [occurrence] = await asOwner((called) =>
        called.getOccurrences({ meetingId: meeting.id })
      );
      expect(occurrence).toBeDefined();

      for (const endHour of [20, 19]) {
        await expect(
          asOwner((called) =>
            called.rescheduleOccurrence({
              occurrenceId: occurrence!.id,
              scheduledStart: at(20),
              scheduledEnd: at(endHour),
            })
          )
        ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      }

      const moved = await asOwner((called) =>
        called.rescheduleOccurrence({
          occurrenceId: occurrence!.id,
          scheduledStart: at(20),
          scheduledEnd: at(21),
        })
      );
      expect(moved.end.getTime()).toBeGreaterThan(moved.start.getTime());
    });
  });

  describe('the meetings_time_order_check constraint', () => {
    it('rejects a writer that bypasses the router, on insert and on update', async () => {
      await expect(
        deps.withTenantDb(ORGANIZATION, (db) =>
          db.meeting.create({
            data: {
              title: id('raw_insert'),
              startTime: at(30),
              endTime: at(30),
              createdById: OWNER,
            },
          })
        )
      ).rejects.toThrow(/meetings_time_order_check/);

      const meeting = await createSeries(id('raw_update'));
      await expect(
        deps.withTenantDb(ORGANIZATION, (db) =>
          db.meeting.update({ where: { id: meeting.id }, data: { endTime: at(9) } })
        )
      ).rejects.toThrow(/meetings_time_order_check/);

      expect(await stored(meeting.id)).toMatchObject({ startTime: at(10), endTime: at(11) });
    });
  });
});
