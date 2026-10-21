/**
 * Occurrence materialisation, exceptions and guest admission, against a REAL
 * PostgreSQL (WHA-235).
 *
 * Everything asserted here is decided by the database, not by application code,
 * which is why a mock would prove nothing:
 *
 *  - the ADDITIVE invariant is enforced by a UNIQUE `(meetingId, seriesSlotStart)`
 *    index, and "materialising twice inserts nothing the second time" is a
 *    statement about that index;
 *  - `publicId`, `providerRoomName` and the guest-token CHECK are DATABASE
 *    defaults and constraints (`gen_random_uuid()`,
 *    `meeting_provider_room_name()`,
 *    `meeting_occurrence_participants_guest_token_check`). A fake client would
 *    be asserting its own fixture;
 *  - the CROSS-TENANT case is decided purely by row level security. Both new
 *    tables carry FORCE ROW LEVEL SECURITY and a `tenant_isolation` policy, and
 *    nothing in the queries below filters on `organizationId` — so if RLS were
 *    off, the cross-tenant assertions would fail rather than pass silently.
 *
 * Requires a migrated, throwaway database. Reads
 * `M8_TEST_RUNTIME_DATABASE_URL` (the variable named by this lane's gate) and
 * falls back to `TEST_DATABASE_URL`, which is what the sibling meetings suites
 * use. Without one the suite reports itself SKIPPED rather than passing
 * vacuously.
 *
 * The connection role must be NEITHER a superuser NOR BYPASSRLS: both read
 * straight through every policy, FORCE included, which would leave the
 * cross-tenant cases testing nothing. `assertRlsEnforcingRole` aborts rather
 * than let that happen quietly.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { assertRlsEnforcingRole } from '@/lib/testing/rls-role-guard';
import { seedDepartments } from '@/lib/test-support/departments';

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;

// `@/lib/db` reads DATABASE_URL when its module is evaluated, so this must
// happen before the dynamic imports in `beforeAll`.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const suffix = randomBytes(6).toString('hex');
const id = (name: string) => `${name}_occ_${suffix}`;

const ORGANIZATION_A = id('org_a');
const ORGANIZATION_B = id('org_b');

const HOST_A = id('user_host_a');
const MEMBER_A = id('user_member_a');
const OUTSIDER_A = id('user_outsider_a');
const HOST_B = id('user_host_b');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The window the materialiser reconciles, mirrored from the module. */
const WINDOW_DAYS = 30;

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  meetingsRouter: (typeof import('@/server/routers/meetings'))['meetingsRouter'];
  materialize: typeof import('./materialize');
  occurrences: typeof import('./occurrences');
  guestSession: typeof import('./guest-session');
};

let deps: Deps;

type Actor = { id: string; role: 'ADMIN' | 'EMPLOYEE' };

const caller = (db: unknown, actor: Actor, organizationId: string) =>
  deps.meetingsRouter.createCaller({
    db,
    session: { user: { id: actor.id, role: actor.role, status: 'ACTIVE', organizationId } },
    organization: { id: organizationId },
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

/** Create a meeting through the ROUTER, so the production write path is used. */
const createMeeting = (
  organizationId: string,
  actor: Actor,
  input: {
    title: string;
    startTime: Date;
    endTime: Date;
    recurrence?: 'daily' | 'weekly' | 'biweekly' | 'monthly' | null;
    attendeeIds?: string[];
  }
) =>
  deps.withTenantDb(organizationId, (db) =>
    caller(db, actor, organizationId).create({
      title: input.title,
      startTime: input.startTime,
      endTime: input.endTime,
      recurrence: input.recurrence ?? null,
      attendeeIds: input.attendeeIds ?? [],
    })
  );

const occurrenceRows = (organizationId: string, meetingId: string) =>
  deps.withTenantDb(organizationId, (db) =>
    db.meetingOccurrence.findMany({
      where: { meetingId },
      orderBy: [{ seriesSlotStart: 'asc' }],
    })
  );

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDatabase('meeting occurrences, against PostgreSQL', () => {
  beforeAll(async () => {
    const scopedDb = await import('@/lib/tenancy/scoped-db');
    deps = {
      withTenantDb: scopedDb.withTenantDb,
      withPlatformDb: scopedDb.withPlatformDb,
      meetingsRouter: (await import('@/server/routers/meetings')).meetingsRouter,
      materialize: await import('./materialize'),
      occurrences: await import('./occurrences'),
      guestSession: await import('./guest-session'),
    };

    // The cross-tenant cases are decided purely by row level security, so a
    // role that bypasses it would leave them proving nothing.
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
            legalName: `Occurrences ${label}`,
            displayName: `Occurrences ${label}`,
            status: 'ACTIVE',
          },
        });
        await seedDepartments(db, [organizationId], ['ENGINEERING']);
      }
    });

    await deps.withTenantDb(ORGANIZATION_A, async (db) => {
      await db.user.create({ data: user(HOST_A, ORGANIZATION_A, 'EMPLOYEE') });
      await db.user.create({ data: user(MEMBER_A, ORGANIZATION_A, 'EMPLOYEE') });
      await db.user.create({ data: user(OUTSIDER_A, ORGANIZATION_A, 'EMPLOYEE') });
    });
    await deps.withTenantDb(ORGANIZATION_B, async (db) => {
      await db.user.create({ data: user(HOST_B, ORGANIZATION_B, 'EMPLOYEE') });
    });
  }, 120_000);

  afterAll(async () => {
    if (!deps?.withPlatformDb) return;
    await deps.withPlatformDb(
      async (db) => {
        // Order matters: meetings and users hold foreign keys into the
        // organization, and occurrences cascade from the meeting.
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
  }, 120_000);

  // ─────────────────────────── materialisation ───────────────────────────

  it('materialises a BOUNDED 30-day window for an infinite daily series', async () => {
    const start = new Date(Date.now() + HOUR);
    const meeting = await createMeeting(
      ORGANIZATION_A,
      { id: HOST_A, role: 'EMPLOYEE' },
      {
        title: id('daily'),
        startTime: start,
        endTime: new Date(start.getTime() + 30 * MINUTE),
        recurrence: 'daily',
      }
    );

    const rows = await occurrenceRows(ORGANIZATION_A, meeting.id);

    // An infinite FREQ=DAILY produces a ROLLING set, not an unbounded table.
    // 30 or 31 rows depending on where `now` falls relative to the anchor.
    expect(rows.length).toBeGreaterThanOrEqual(WINDOW_DAYS);
    expect(rows.length).toBeLessThanOrEqual(WINDOW_DAYS + 2);

    const horizon = Date.now() + WINDOW_DAYS * DAY;
    for (const row of rows) {
      expect(row.seriesSlotStart.getTime()).toBeLessThanOrEqual(horizon + MINUTE);
      // Every row gets database-generated identities the caller cannot choose.
      expect(row.publicId).toMatch(/^[0-9a-f-]{36}$/);
      expect(row.providerRoomName).toMatch(/^mtg_[A-Z2-7]{26}$/);
      // The room name must NOT be derivable from the join link, or a
      // link-holder could address the media room and bypass the lobby.
      expect(row.providerRoomName).not.toContain(row.publicId);
    }
  }, 60_000);

  it('advances materializedThrough to the horizon', async () => {
    const start = new Date(Date.now() + HOUR);
    const meeting = await createMeeting(
      ORGANIZATION_A,
      { id: HOST_A, role: 'EMPLOYEE' },
      {
        title: id('watermark'),
        startTime: start,
        endTime: new Date(start.getTime() + 30 * MINUTE),
        recurrence: 'weekly',
      }
    );

    const row = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      db.meeting.findUniqueOrThrow({
        where: { id: meeting.id },
        select: { materializedThrough: true, recurrenceRule: true },
      })
    );

    // `create` persists the RRULE alongside the deprecated legacy value.
    expect(row.recurrenceRule).toBe('FREQ=WEEKLY');
    expect(row.materializedThrough).not.toBeNull();
    expect(row.materializedThrough!.getTime()).toBeGreaterThan(
      Date.now() + (WINDOW_DAYS - 1) * DAY
    );
  }, 60_000);

  it('is IDEMPOTENT — a second pass inserts nothing and never deletes', async () => {
    const start = new Date(Date.now() + HOUR);
    const meeting = await createMeeting(
      ORGANIZATION_A,
      { id: HOST_A, role: 'EMPLOYEE' },
      {
        title: id('idempotent'),
        startTime: start,
        endTime: new Date(start.getTime() + 30 * MINUTE),
        recurrence: 'daily',
      }
    );

    const before = await occurrenceRows(ORGANIZATION_A, meeting.id);

    const second = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      deps.materialize.materializeMeetingOccurrences(db, meeting.id)
    );
    expect(second.created).toBe(0);
    expect(second.cancelled).toBe(0);

    const after = await occurrenceRows(ORGANIZATION_A, meeting.id);
    // Same rows, same ids, same publicIds — a re-materialise must not churn
    // identities that join links already point at.
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.map((r) => r.publicId)).toEqual(before.map((r) => r.publicId));
  }, 60_000);

  it('NEVER DELETES a historical occurrence when the series rule changes', async () => {
    // The series started well in the past, so it has occurrences that already
    // happened. Changing its cadence must not collect them.
    const start = new Date(Date.now() - 10 * DAY);
    const meeting = await createMeeting(
      ORGANIZATION_A,
      { id: HOST_A, role: 'EMPLOYEE' },
      {
        title: id('history'),
        startTime: start,
        endTime: new Date(start.getTime() + 30 * MINUTE),
        recurrence: 'daily',
      }
    );

    const before = await occurrenceRows(ORGANIZATION_A, meeting.id);
    const past = before.filter((r) => r.scheduledStart.getTime() < Date.now());
    expect(past.length).toBeGreaterThan(5);

    // Attendance evidence against one of those past instants, which is exactly
    // what the model doc says must never be reconciled away.
    await deps.withTenantDb(ORGANIZATION_A, (db) =>
      db.meetingAttendanceLog.create({
        data: {
          meetingId: meeting.id,
          userId: HOST_A,
          occurrenceStart: past[0].scheduledStart,
          joinedAt: past[0].scheduledStart,
        },
      })
    );

    // Daily → monthly. Most future daily slots leave the rule.
    await deps.withTenantDb(ORGANIZATION_A, (db) =>
      caller(db, { id: HOST_A, role: 'EMPLOYEE' }, ORGANIZATION_A).update({
        id: meeting.id,
        recurrence: 'monthly',
      })
    );

    const after = await occurrenceRows(ORGANIZATION_A, meeting.id);

    // INVARIANT 2: every row that existed still exists.
    const beforeIds = new Set(before.map((r) => r.id));
    const afterIds = new Set(after.map((r) => r.id));
    for (const rowId of beforeIds) expect(afterIds.has(rowId)).toBe(true);

    // INVARIANT 3: past slots are untouched; departed FUTURE slots are
    // withdrawn, not removed.
    for (const row of after) {
      if (row.scheduledStart.getTime() < past[past.length - 1].scheduledStart.getTime() + MINUTE) {
        expect(row.status).not.toBe('CANCELLED');
      }
    }
    const cancelledFuture = after.filter(
      (r) => r.status === 'CANCELLED' && r.scheduledStart.getTime() > Date.now()
    );
    expect(cancelledFuture.length).toBeGreaterThan(0);
    for (const row of cancelledFuture) expect(row.cancelledAt).not.toBeNull();

    // The attendance evidence still resolves to a live occurrence row.
    const evidence = after.find((r) => r.id === past[0].id);
    expect(evidence).toBeDefined();
    expect(evidence!.status).not.toBe('CANCELLED');
  }, 120_000);

  // ────────────────────── reschedule and cancel ──────────────────────

  it('reschedules ONE occurrence, leaving its series slot and siblings alone', async () => {
    const start = new Date(Date.now() + HOUR);
    const meeting = await createMeeting(
      ORGANIZATION_A,
      { id: HOST_A, role: 'EMPLOYEE' },
      {
        title: id('reschedule'),
        startTime: start,
        endTime: new Date(start.getTime() + 30 * MINUTE),
        recurrence: 'daily',
      }
    );

    const rows = await occurrenceRows(ORGANIZATION_A, meeting.id);
    const target = rows[2];
    const movedStart = new Date(target.scheduledStart.getTime() + 3 * HOUR);
    const movedEnd = new Date(movedStart.getTime() + 45 * MINUTE);

    const moved = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      caller(db, { id: HOST_A, role: 'EMPLOYEE' }, ORGANIZATION_A).rescheduleOccurrence({
        occurrenceId: target.id,
        scheduledStart: movedStart,
        scheduledEnd: movedEnd,
      })
    );

    expect(moved.start.toISOString()).toBe(movedStart.toISOString());
    // The IMMUTABLE identity is untouched — this is what stops the materialiser
    // re-creating the original slot as a duplicate on its next pass.
    expect(moved.seriesSlotStart.toISOString()).toBe(target.seriesSlotStart.toISOString());

    const reloaded = await occurrenceRows(ORGANIZATION_A, meeting.id);
    const after = reloaded.find((r) => r.id === target.id)!;
    // The join window followed the times it is derived from, or the occurrence
    // would be unjoinable at the hour it is now held.
    expect(after.joinOpensAt.getTime()).toBeLessThan(movedStart.getTime());
    expect(after.joinClosesAt.getTime()).toBeGreaterThan(movedEnd.getTime());

    // Siblings are untouched.
    for (const row of reloaded) {
      if (row.id === target.id) continue;
      expect(row.scheduledStart.toISOString()).toBe(row.seriesSlotStart.toISOString());
    }

    // And a re-materialise does not resurrect the original slot as a duplicate.
    const again = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      deps.materialize.materializeMeetingOccurrences(db, meeting.id)
    );
    expect(again.created).toBe(0);
  }, 60_000);

  it('cancels ONE occurrence without deleting it, and is idempotent', async () => {
    const start = new Date(Date.now() + HOUR);
    const meeting = await createMeeting(
      ORGANIZATION_A,
      { id: HOST_A, role: 'EMPLOYEE' },
      {
        title: id('cancel'),
        startTime: start,
        endTime: new Date(start.getTime() + 30 * MINUTE),
        recurrence: 'daily',
      }
    );

    const rows = await occurrenceRows(ORGANIZATION_A, meeting.id);
    const target = rows[1];

    const cancelled = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      caller(db, { id: HOST_A, role: 'EMPLOYEE' }, ORGANIZATION_A).cancelOccurrence({
        occurrenceId: target.id,
        reason: 'Host away',
      })
    );
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancelledAt).not.toBeNull();

    const after = await occurrenceRows(ORGANIZATION_A, meeting.id);
    // Not deleted — the row is the record that the instance existed and was
    // called off, and keeps any evidence hanging off it reachable.
    expect(after.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    const row = after.find((r) => r.id === target.id)!;
    expect(row.cancellationReason).toBe('Host away');
    expect(row.cancelledById).toBe(HOST_A);

    // A second cancel is a race, not a conflict.
    const twice = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      caller(db, { id: HOST_A, role: 'EMPLOYEE' }, ORGANIZATION_A).cancelOccurrence({
        occurrenceId: target.id,
        reason: null,
      })
    );
    expect(twice.status).toBe('CANCELLED');
    // The original reason survives — the second call did not overwrite it.
    const stillThere = await occurrenceRows(ORGANIZATION_A, meeting.id);
    expect(stillThere.find((r) => r.id === target.id)!.cancellationReason).toBe('Host away');
  }, 60_000);

  it('skips a CANCELLED occurrence when resolving the one being joined', async () => {
    const start = new Date(Date.now() - 30 * MINUTE);
    const meeting = await createMeeting(
      ORGANIZATION_A,
      { id: HOST_A, role: 'EMPLOYEE' },
      {
        title: id('skip-cancelled'),
        startTime: start,
        endTime: new Date(start.getTime() + 2 * HOUR),
        recurrence: 'daily',
      }
    );

    const rows = await occurrenceRows(ORGANIZATION_A, meeting.id);
    const live = rows[0];

    const before = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      deps.occurrences.resolveRelevantOccurrence(db, meeting.id)
    );
    expect(before?.id).toBe(live.id);

    await deps.withTenantDb(ORGANIZATION_A, (db) =>
      caller(db, { id: HOST_A, role: 'EMPLOYEE' }, ORGANIZATION_A).cancelOccurrence({
        occurrenceId: live.id,
        reason: null,
      })
    );

    const after = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      deps.occurrences.resolveRelevantOccurrence(db, meeting.id)
    );
    // A cancelled instance is not the one somebody is joining.
    expect(after?.id).not.toBe(live.id);
  }, 60_000);

  // ───────────────────────── authorization ─────────────────────────

  it('lets a MEMBER of the meeting read its occurrences and refuses an outsider', async () => {
    const start = new Date(Date.now() + HOUR);
    const meeting = await createMeeting(
      ORGANIZATION_A,
      { id: HOST_A, role: 'EMPLOYEE' },
      {
        title: id('member-authz'),
        startTime: start,
        endTime: new Date(start.getTime() + 30 * MINUTE),
        recurrence: null,
        attendeeIds: [MEMBER_A],
      }
    );

    const asMember = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      caller(db, { id: MEMBER_A, role: 'EMPLOYEE' }, ORGANIZATION_A).getOccurrences({
        meetingId: meeting.id,
      })
    );
    expect(asMember).toHaveLength(1);
    // A join PATH, carrying the locator and nothing else.
    expect(asMember[0].joinPath).toBe(`/join/${asMember[0].publicId}`);
    expect(asMember[0].joinPath).not.toContain('secret');
    // The media room address is never in a list payload.
    expect(asMember[0]).not.toHaveProperty('providerRoomName');

    // Same tenant, not on the meeting, not an admin.
    await expect(
      deps.withTenantDb(ORGANIZATION_A, (db) =>
        caller(db, { id: OUTSIDER_A, role: 'EMPLOYEE' }, ORGANIZATION_A).getOccurrences({
          meetingId: meeting.id,
        })
      )
    ).rejects.toThrow();

    // ...and an outsider cannot mutate an instance either.
    await expect(
      deps.withTenantDb(ORGANIZATION_A, (db) =>
        caller(db, { id: OUTSIDER_A, role: 'EMPLOYEE' }, ORGANIZATION_A).cancelOccurrence({
          occurrenceId: asMember[0].id,
          reason: null,
        })
      )
    ).rejects.toThrow();
  }, 60_000);

  it('keeps another tenant out of an occurrence entirely, through RLS', async () => {
    const start = new Date(Date.now() + HOUR);
    const meeting = await createMeeting(
      ORGANIZATION_A,
      { id: HOST_A, role: 'EMPLOYEE' },
      {
        title: id('cross-tenant'),
        startTime: start,
        endTime: new Date(start.getTime() + 30 * MINUTE),
        recurrence: null,
      }
    );
    const [occurrence] = await occurrenceRows(ORGANIZATION_A, meeting.id);

    // Organization B's host holds a real occurrence id. Nothing in these
    // queries filters on organizationId — row level security is the only thing
    // between B and A's row.
    const seen = await deps.withTenantDb(ORGANIZATION_B, (db) =>
      db.meetingOccurrence.findUnique({ where: { id: occurrence.id } })
    );
    expect(seen).toBeNull();

    // An ADMIN of B holding A's meeting id gets an EMPTY list, not an error and
    // not A's occurrences. That distinction is the point: `canAccessMeeting`
    // grants any ADMIN an organization-wide decision WITHOUT looking the
    // meeting up, so object-level authorization does not refuse this call —
    // row level security is the only thing that stops it returning data. An
    // empty result is therefore evidence the boundary held; a populated one
    // would mean RLS was off.
    const leaked = await deps.withTenantDb(ORGANIZATION_B, (db) =>
      caller(db, { id: HOST_B, role: 'ADMIN' }, ORGANIZATION_B).getOccurrences({
        meetingId: meeting.id,
      })
    );
    expect(leaked).toEqual([]);

    // Where the code DOES look the row up first, the same boundary surfaces as
    // a NOT_FOUND — RLS makes another tenant's row indistinguishable from a
    // missing one.
    await expect(
      deps.withTenantDb(ORGANIZATION_B, (db) =>
        caller(db, { id: HOST_B, role: 'ADMIN' }, ORGANIZATION_B).cancelOccurrence({
          occurrenceId: occurrence.id,
          reason: null,
        })
      )
    ).rejects.toThrow();

    // A's row is untouched by any of that.
    const stillLive = await occurrenceRows(ORGANIZATION_A, meeting.id);
    expect(stillLive[0].status).not.toBe('CANCELLED');
  }, 60_000);

  // ─────────────────────── guest credentials ───────────────────────

  it('emits a guest secret ONCE, stores only its hash, and admits the holder', async () => {
    // Live right now, so the occurrence is inside its join window.
    const start = new Date(Date.now() - 5 * MINUTE);
    const meeting = await createMeeting(
      ORGANIZATION_A,
      { id: HOST_A, role: 'EMPLOYEE' },
      {
        title: id('guest-ok'),
        startTime: start,
        endTime: new Date(start.getTime() + 2 * HOUR),
        recurrence: null,
      }
    );
    const [occurrence] = await occurrenceRows(ORGANIZATION_A, meeting.id);

    const invite = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      caller(db, { id: HOST_A, role: 'EMPLOYEE' }, ORGANIZATION_A).createGuestInvitation({
        occurrenceId: occurrence.id,
        displayName: 'Outside Counsel',
      })
    );

    expect(invite.secret).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
    // The locator is the ONLY thing in the link.
    expect(invite.joinPath).toBe(`/join/${occurrence.publicId}`);
    expect(invite.joinPath).not.toContain(invite.secret);
    expect(invite.joinPath.toLowerCase()).not.toContain(invite.secret.toLowerCase());

    // The RAW secret is nowhere in the database — only a SHA-256 digest is.
    const stored = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      db.meetingOccurrenceParticipant.findUniqueOrThrow({
        where: { id: invite.occurrenceParticipantId },
      })
    );
    const normalized = invite.secret.replace(/-/g, '');
    expect(stored.guestTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.guestTokenHash).not.toBe(invite.secret);
    expect(stored.guestTokenHash).not.toContain(normalized);
    // The CHECK constraint refuses a hash without an expiry; assert the pair.
    expect(stored.guestTokenExpiresAt).not.toBeNull();
    expect(stored.guestTokenExpiresAt!.getTime()).toBeLessThanOrEqual(
      occurrence.joinClosesAt.getTime()
    );
    // No column anywhere on the row holds the raw value.
    expect(JSON.stringify(stored)).not.toContain(normalized);

    // The credential admits its holder.
    const grant = await deps.guestSession.verifyGuestAccess({
      publicId: occurrence.publicId,
      secret: invite.secret,
    });
    expect(grant.ok).toBe(true);
    if (grant.ok) {
      expect(grant.organizationId).toBe(ORGANIZATION_A);
      expect(grant.occurrenceId).toBe(occurrence.id);
      expect(grant.displayName).toBe('Outside Counsel');
    }

    // Retyped with the grouping stripped and the case changed — same credential.
    const retyped = await deps.guestSession.verifyGuestAccess({
      publicId: occurrence.publicId,
      secret: normalized.toLowerCase(),
    });
    expect(retyped.ok).toBe(true);
  }, 60_000);

  it('refuses a link WITHOUT the secret, and a secret against the WRONG occurrence', async () => {
    const start = new Date(Date.now() - 5 * MINUTE);
    const meeting = await createMeeting(
      ORGANIZATION_A,
      { id: HOST_A, role: 'EMPLOYEE' },
      {
        title: id('guest-locator'),
        startTime: start,
        endTime: new Date(start.getTime() + 2 * HOUR),
        recurrence: 'daily',
      }
    );
    const rows = await occurrenceRows(ORGANIZATION_A, meeting.id);
    const [first, second] = rows;

    const invite = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      caller(db, { id: HOST_A, role: 'EMPLOYEE' }, ORGANIZATION_A).createGuestInvitation({
        occurrenceId: first.id,
        displayName: 'Guest',
      })
    );

    // publicId is a LOCATOR, not authorization: holding it proves nothing.
    const noSecret = await deps.guestSession.verifyGuestAccess({
      publicId: first.publicId,
      secret: '',
    });
    expect(noSecret.ok).toBe(false);

    const wrongSecret = await deps.guestSession.verifyGuestAccess({
      publicId: first.publicId,
      secret: 'AAAA-BBBB-CCCC-DDDD-EEEE',
    });
    expect(wrongSecret.ok).toBe(false);

    // A valid secret for occurrence 1 must not admit its holder to occurrence 2
    // — the credential is occurrence-scoped, never series-scoped.
    const replayed = await deps.guestSession.verifyGuestAccess({
      publicId: second.publicId,
      secret: invite.secret,
    });
    expect(replayed.ok).toBe(false);
  }, 60_000);

  it('refuses a REVOKED credential, and revokes every guest when the occurrence is cancelled', async () => {
    const start = new Date(Date.now() - 5 * MINUTE);
    const meeting = await createMeeting(
      ORGANIZATION_A,
      { id: HOST_A, role: 'EMPLOYEE' },
      {
        title: id('guest-revoke'),
        startTime: start,
        endTime: new Date(start.getTime() + 2 * HOUR),
        recurrence: null,
      }
    );
    const [occurrence] = await occurrenceRows(ORGANIZATION_A, meeting.id);

    const invite = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      caller(db, { id: HOST_A, role: 'EMPLOYEE' }, ORGANIZATION_A).createGuestInvitation({
        occurrenceId: occurrence.id,
        displayName: 'Revoked Guest',
      })
    );
    expect(
      (
        await deps.guestSession.verifyGuestAccess({
          publicId: occurrence.publicId,
          secret: invite.secret,
        })
      ).ok
    ).toBe(true);

    await deps.withTenantDb(ORGANIZATION_A, (db) =>
      caller(db, { id: HOST_A, role: 'EMPLOYEE' }, ORGANIZATION_A).revokeGuestInvitation({
        occurrenceParticipantId: invite.occurrenceParticipantId,
      })
    );

    expect(
      (
        await deps.guestSession.verifyGuestAccess({
          publicId: occurrence.publicId,
          secret: invite.secret,
        })
      ).ok
    ).toBe(false);

    // Cancelling an occurrence withdraws every credential still outstanding
    // against it — a working credential must not point at a meeting that is
    // not happening.
    const second = await createMeeting(
      ORGANIZATION_A,
      { id: HOST_A, role: 'EMPLOYEE' },
      {
        title: id('guest-cancel'),
        startTime: start,
        endTime: new Date(start.getTime() + 2 * HOUR),
        recurrence: null,
      }
    );
    const [secondOccurrence] = await occurrenceRows(ORGANIZATION_A, second.id);
    const secondInvite = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      caller(db, { id: HOST_A, role: 'EMPLOYEE' }, ORGANIZATION_A).createGuestInvitation({
        occurrenceId: secondOccurrence.id,
        displayName: 'Cancelled Guest',
      })
    );
    expect(
      (
        await deps.guestSession.verifyGuestAccess({
          publicId: secondOccurrence.publicId,
          secret: secondInvite.secret,
        })
      ).ok
    ).toBe(true);

    await deps.withTenantDb(ORGANIZATION_A, (db) =>
      caller(db, { id: HOST_A, role: 'EMPLOYEE' }, ORGANIZATION_A).cancelOccurrence({
        occurrenceId: secondOccurrence.id,
        reason: null,
      })
    );

    expect(
      (
        await deps.guestSession.verifyGuestAccess({
          publicId: secondOccurrence.publicId,
          secret: secondInvite.secret,
        })
      ).ok
    ).toBe(false);
  }, 60_000);

  it('EXPIRES a guest credential, and caps its life to the occurrence', async () => {
    const start = new Date(Date.now() - 5 * MINUTE);
    const meeting = await createMeeting(
      ORGANIZATION_A,
      { id: HOST_A, role: 'EMPLOYEE' },
      {
        title: id('guest-expiry'),
        startTime: start,
        endTime: new Date(start.getTime() + 2 * HOUR),
        recurrence: null,
      }
    );
    const [occurrence] = await occurrenceRows(ORGANIZATION_A, meeting.id);

    // An explicit cap SHORTER than the occurrence is honoured.
    const short = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      caller(db, { id: HOST_A, role: 'EMPLOYEE' }, ORGANIZATION_A).createGuestInvitation({
        occurrenceId: occurrence.id,
        displayName: 'Short Lived',
        maxTtlMinutes: 5,
      })
    );
    expect(short.expiresAt.getTime()).toBeLessThan(occurrence.joinClosesAt.getTime());

    // A cap LONGER than the occurrence is NOT honoured: nothing on this row may
    // outlive the occurrence it belongs to.
    const long = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      caller(db, { id: HOST_A, role: 'EMPLOYEE' }, ORGANIZATION_A).createGuestInvitation({
        occurrenceId: occurrence.id,
        displayName: 'Would Outlive',
        maxTtlMinutes: 60 * 24 * 20,
      })
    );
    expect(long.expiresAt.getTime()).toBeLessThanOrEqual(occurrence.joinClosesAt.getTime());

    // A credential past its expiry is refused, evaluated against a later clock.
    const afterExpiry = new Date(short.expiresAt.getTime() + MINUTE);
    const verdict = await deps.guestSession.verifyGuestAccess({
      publicId: occurrence.publicId,
      secret: short.secret,
      now: afterExpiry,
    });
    expect(verdict.ok).toBe(false);
  }, 60_000);

  it('refuses a guest OUTSIDE the occurrence join window', async () => {
    // Starts well in the future, so the room is not open yet.
    const start = new Date(Date.now() + 5 * DAY);
    const meeting = await createMeeting(
      ORGANIZATION_A,
      { id: HOST_A, role: 'EMPLOYEE' },
      {
        title: id('guest-window'),
        startTime: start,
        endTime: new Date(start.getTime() + HOUR),
        recurrence: null,
      }
    );
    const [occurrence] = await occurrenceRows(ORGANIZATION_A, meeting.id);

    const invite = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      caller(db, { id: HOST_A, role: 'EMPLOYEE' }, ORGANIZATION_A).createGuestInvitation({
        occurrenceId: occurrence.id,
        displayName: 'Too Early',
      })
    );

    // Credential is valid; the WINDOW is not open. Both have to hold.
    const early = await deps.guestSession.verifyGuestAccess({
      publicId: occurrence.publicId,
      secret: invite.secret,
    });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toBe('outside_join_window');

    // Inside the window, the same credential is admitted.
    const inside = await deps.guestSession.verifyGuestAccess({
      publicId: occurrence.publicId,
      secret: invite.secret,
      now: new Date(occurrence.scheduledStart.getTime() + MINUTE),
    });
    expect(inside.ok).toBe(true);
  }, 60_000);

  it('does not let a guest credential resolve into ANOTHER tenant', async () => {
    const start = new Date(Date.now() - 5 * MINUTE);
    const meetingA = await createMeeting(
      ORGANIZATION_A,
      { id: HOST_A, role: 'EMPLOYEE' },
      {
        title: id('guest-tenant-a'),
        startTime: start,
        endTime: new Date(start.getTime() + 2 * HOUR),
        recurrence: null,
      }
    );
    const [occurrenceA] = await occurrenceRows(ORGANIZATION_A, meetingA.id);

    const meetingB = await createMeeting(
      ORGANIZATION_B,
      { id: HOST_B, role: 'EMPLOYEE' },
      {
        title: id('guest-tenant-b'),
        startTime: start,
        endTime: new Date(start.getTime() + 2 * HOUR),
        recurrence: null,
      }
    );
    const [occurrenceB] = await occurrenceRows(ORGANIZATION_B, meetingB.id);

    const inviteA = await deps.withTenantDb(ORGANIZATION_A, (db) =>
      caller(db, { id: HOST_A, role: 'EMPLOYEE' }, ORGANIZATION_A).createGuestInvitation({
        occurrenceId: occurrenceA.id,
        displayName: 'A Guest',
      })
    );

    // A's secret against B's public link. The tenant is resolved from the
    // SECRET, so this must not cross over — and the second-factor publicId
    // check is what refuses it.
    const crossed = await deps.guestSession.verifyGuestAccess({
      publicId: occurrenceB.publicId,
      secret: inviteA.secret,
    });
    expect(crossed.ok).toBe(false);

    // And it still resolves correctly against its OWN occurrence, so the
    // refusal above was the cross-tenant check and not a broken credential.
    const own = await deps.guestSession.verifyGuestAccess({
      publicId: occurrenceA.publicId,
      secret: inviteA.secret,
    });
    expect(own.ok).toBe(true);
    if (own.ok) expect(own.organizationId).toBe(ORGANIZATION_A);
  }, 60_000);
});
