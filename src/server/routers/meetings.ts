import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import type { Prisma, PrismaClient } from '@/generated/prisma/client';
import { entitlementIndependentHistoryProcedure, protectedProcedure, router } from '../trpc';
import { assertMeetingManage, assertMeetingAccess } from '../authz';
import { isAdmin } from '@/lib/authz';
import { logActivity } from '../activity';
import { computePunctuality } from '@/lib/meeting-occurrence';
import { legacyRecurrenceToRule } from '@/lib/meetings/recurrence';
import { materializeMeetingOccurrences } from '@/lib/meetings/materialize';
import {
  cancelOccurrence,
  occurrenceJoinPath,
  rescheduleOccurrence,
  resolveDisplayTimes,
  resolveNextTimes,
  resolveRelevantOccurrence,
  type SeriesRow,
} from '@/lib/meetings/occurrences';
import { guestSecretExpiryFor, mintGuestSecret } from '@/lib/meetings/guest-access';
import { assertInOrganization, workspaceId } from '../org-refs';

/** Page size `getAll` falls back to when the caller sends no `limit` (#38). */
const MEETINGS_PAGE_SIZE = 50;
/** Ceiling a caller may raise `getAll`'s page size to. */
const MEETINGS_PAGE_SIZE_MAX = 200;
/** Live occurrences `getUpcoming` reads directly. */
const UPCOMING_LIMIT = 50;
/** Recurring series `getUpcoming` evaluates per call — see the query below. */
const UPCOMING_SERIES_LIMIT = 200;
/** Occurrences one `getOccurrences` page may return. */
const OCCURRENCE_PAGE_SIZE_MAX = 200;

/**
 * The `Meeting` columns the occurrence resolvers need. Selected explicitly so
 * that adding a column to the model does not silently widen these payloads.
 */
const SERIES_FIELDS = {
  id: true,
  startTime: true,
  endTime: true,
  timezone: true,
  recurrenceRule: true,
} as const;

/**
 * The attendee columns the list surfaces return.
 *
 * A `select`, not an `include`, for one reason: an `include` returns EVERY
 * scalar on `MeetingAttendee`, and that set contains `joinedAt`, which the
 * schema marks DEPRECATED in favour of the per-occurrence
 * `MeetingAttendanceLog`. Reading it was always pointless here —
 * `attachPerOccurrenceJoinedAt` overwrites it on the way out — but "pointless"
 * is how a deprecated column keeps a live reader and never gets dropped. The
 * `joinedAt` on the returned payload is now sourced ONLY from the attendance
 * log, and this select is what proves it.
 */
const ATTENDEE_SELECT = {
  id: true,
  meetingId: true,
  userId: true,
  user: { select: { id: true, name: true, avatar: true } },
} satisfies Prisma.MeetingAttendeeSelect;

export const meetingsRouter = router({
  getUpcoming: protectedProcedure.query(async ({ ctx }) => {
    const scope = upcomingListScope(ctx.session.user);
    const now = new Date();

    // Include currently-running meetings (endTime still in the future),
    // not just strictly-future ones. A meeting that started 1 min ago and runs
    // for 30 minutes is still the "current" meeting until it ends.
    const [futureMeetings, recurringMeetings] = await Promise.all([
      ctx.db.meeting.findMany({
        where: {
          ...scope,
          endTime: { gte: now },
        },
        include: {
          attendees: { select: ATTENDEE_SELECT },
        },
        // `startTime` alone leaves ties in an arbitrary order, so which rows
        // survive `take` is arbitrary too. `id` is unique — (startTime, id) is
        // a total order, so the same fixture always yields the same page.
        orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
        take: UPCOMING_LIMIT,
      }),
      // Recurring series whose ORIGINAL occurrence has already ended: the query
      // above cannot see them (it filters on endTime), yet their NEXT
      // occurrence may still be ahead of us, so it is computed below.
      //
      // BOUNDED (#38). This query used to carry no take, no orderBy and no time
      // bound at all, which for an admin meant every recurring meeting in the
      // tenant plus its full attendee graph on every dashboard load.
      //
      // `endTime: { lt: now }` avoids duplicate work while the first query still
      // has capacity: for a series whose original occurrence has NOT ended,
      // getNextOccurrence returns that original occurrence unchanged (its first
      // iteration already satisfies `end > now`), which is byte-for-byte the row
      // the query above already returned and the merge below already dedupes.
      // Excluding those rows spends this bound only on series the other query
      // can otherwise never reach.
      //
      // It is NOT fully lossless once the first query reaches UPCOMING_LIMIT.
      // A recurring series with `endTime >= now` is excluded here, so if at
      // least UPCOMING_LIMIT (50) attendee-scoped rows sort ahead of it by
      // (startTime, id), the first query's take drops it and this query never
      // looks at it — the series is omitted from the merged result entirely.
      // That bounded tail limitation is accepted: it is the price of replacing
      // the unbounded tenant-wide query fixed by issue #38.
      //
      // The take is a real ceiling, not a lossless bound, because which series
      // matter is decided AFTER the fetch: every live series recurs at most
      // monthly, so every one of them has a next occurrence within ~31 days and
      // no column on this row orders them by it. Combined with the attendee
      // scope above, the ceiling means "the 200 most recently started recurring
      // series you personally attend", which no real calendar reaches.
      //
      // WHA-235: the predicate is `recurrenceRule`, not the deprecated
      // `recurrence` column. Both describe the same series — the MEET-01
      // migration backfilled the rule from the legacy value and `create`/
      // `update` below now write the two together — but the rule is what the
      // materialiser and every occurrence path expand, so selecting on it keeps
      // this query and the occurrence table describing the same set.
      ctx.db.meeting.findMany({
        where: {
          ...scope,
          recurrenceRule: { not: null },
          endTime: { lt: now },
        },
        include: {
          attendees: { select: ATTENDEE_SELECT },
        },
        orderBy: [{ startTime: 'desc' }, { id: 'desc' }],
        take: UPCOMING_SERIES_LIMIT,
      }),
    ]);

    // Next occurrence per series, preferring a materialised MeetingOccurrence
    // row so a rescheduled or cancelled instance is reflected here, and falling
    // back to expanding the rule for a series not yet materialised. Batched:
    // one query for the whole page, not one per series.
    const nextTimes = await resolveNextTimes(ctx.db, recurringMeetings, now);
    const computed = recurringMeetings
      .map((m) => {
        const next = nextTimes.get(m.id);
        if (!next) return null;
        return { ...m, startTime: next.start, endTime: next.end };
      })
      .filter(Boolean) as typeof futureMeetings;

    // Merge, dedupe by id, sort by startTime
    const allMap = new Map<string, (typeof futureMeetings)[number]>();
    for (const m of [...futureMeetings, ...computed]) {
      const existing = allMap.get(m.id);
      if (!existing || new Date(m.startTime) < new Date(existing.startTime)) {
        allMap.set(m.id, m);
      }
    }

    const merged = Array.from(allMap.values()).sort(
      (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
    );

    return attachPerOccurrenceJoinedAt(ctx.db, merged);
  }),

  /**
   * The organization-wide meeting list — one page of it (#38).
   *
   * `limit` carries a schema-level default and the whole input object defaults
   * to `{}`, so the bound holds for the production call shape, which sends no
   * input at all. A page size that depended on the caller remembering to ask
   * for one is the defect this replaces: for an admin, `meetingListScope`
   * drops the attendee filter, so an unbounded take here is "every meeting in
   * the tenant, with its full attendee graph".
   *
   * Nothing is hidden by the bound — `nextCursor` walks the rest.
   */
  getAll: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(MEETINGS_PAGE_SIZE_MAX).default(MEETINGS_PAGE_SIZE),
          cursor: z.string().optional(),
        })
        // `prefault`, not `default`: an absent input is PARSED as `{}`, so
        // `limit`'s own default applies to it. The production call site sends
        // no input at all, and that is the shape the bound has to survive.
        .prefault({})
    )
    .query(async ({ ctx, input }) => {
      const now = new Date();

      const meetings = await ctx.db.meeting.findMany({
        where: meetingListScope(ctx.session.user),
        include: {
          attendees: { select: ATTENDEE_SELECT },
        },
        // `startTime` alone is NOT a total order: two meetings can start at the
        // same instant, and a cursor over a non-unique ordering skips or
        // repeats rows across the page boundary. `id` is unique, so
        // (startTime, id) is total and the cursor below is consistent with it.
        orderBy: [{ startTime: 'desc' }, { id: 'desc' }],
        // One row past the page tells us whether another page exists without a
        // second count query, and that extra row IS the next page's cursor.
        take: input.limit + 1,
        // Prisma's cursor is INCLUSIVE — the cursor row is the first row of
        // the page. Pairing it with `skip: 1` (as the pre-#38 plumbing did)
        // while pointing it at the row after the page silently drops exactly
        // one meeting per page boundary.
        ...(input.cursor ? { cursor: { id: input.cursor } } : {}),
      });

      let nextCursor: string | undefined;
      if (meetings.length > input.limit) nextCursor = meetings.pop()?.id;

      // For each meeting, resolve the "relevant" occurrence for display so the
      // per-occurrence attendance lookup targets the right one. Non-recurring:
      // the meeting's own start/end. Recurring: the occurrence closest to now.
      // Note this rewrites the DISPLAY times only; the cursor above walks the
      // stored `startTime`, which is what keeps paging stable.
      //
      // WHA-235: resolved from materialised occurrence rows where they exist,
      // so an instance that was rescheduled shows the time it was moved TO
      // rather than the time the rule would have produced. One batched query
      // for the page.
      const displayTimes = await resolveDisplayTimes(ctx.db, meetings, now);
      const withResolvedStart = meetings.map((m) => {
        const times = displayTimes.get(m.id);
        return times ? { ...m, startTime: times.start, endTime: times.end } : m;
      });

      return {
        items: await attachPerOccurrenceJoinedAt(ctx.db, withResolvedStart),
        nextCursor,
      };
    }),

  /**
   * The PAST half of the meeting list, retrieved server-side (#44).
   *
   * `getAll` is ordered furthest-future first, so in a tenant whose future
   * calendar exceeds one page, every early page is future-only. The Past
   * section used to be derived client-side from whatever `getAll` happened to
   * have loaded, which meant "0 past of 50 meetings loaded" until the user had
   * paged through the entire future calendar. No client-side filter over a
   * future-ordered list can fix that, so the predicate moves here.
   *
   * SCOPE: `meetingListScope` — the getAll/#36 policy, organization-wide for an
   * ADMIN and attendee-scoped for everyone else. Deliberately NOT
   * `upcomingListScope`: #38 narrowed the UPCOMING surfaces to attendee scope
   * for every role because they answer "what am I doing next" on every
   * dashboard load. Past is the other half of organization-wide DISCOVERY,
   * which #36 put on `getAll` and #38 explicitly left there. Moving Past off
   * `getAll` must not silently take an admin's organization-wide history with
   * it, and #38's narrowing is not extended here.
   *
   * Tenant scope stays RLS's job, exactly as in `meetingListScope`: no
   * `organizationId` predicate, so the cross-organization test has row level
   * security and nothing else between it and another tenant's history.
   *
   * Bounded in the shape #38/#40 established — schema default, schema ceiling,
   * `prefault({})` for the no-input call shape — and paginated by a cursor of
   * its own, so exhausting Past cannot disturb the upcoming surfaces or
   * `getAll`.
   */
  getPast: entitlementIndependentHistoryProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(MEETINGS_PAGE_SIZE_MAX).default(MEETINGS_PAGE_SIZE),
          cursor: z.string().optional(),
        })
        // As on `getAll`: an absent input is PARSED as `{}` so `limit`'s own
        // default applies to it, and the bound survives the no-input shape.
        .prefault({})
    )
    .query(async ({ ctx, input }) => {
      const now = new Date();

      const meetings = await ctx.db.meeting.findMany({
        where: {
          ...meetingListScope(ctx.session.user),
          // The predicate the Past section applied client-side, moved to the
          // database unchanged: `isPast(startTime) && !recurrence`. A recurring
          // series is never past — its next occurrence belongs to Upcoming.
          //
          // WHA-235: expressed against `recurrenceRule` for the same reason
          // `getUpcoming` is. The two columns describe one series, and the rule
          // is the one the occurrence table is built from.
          recurrenceRule: null,
          startTime: { lt: now },
        },
        include: {
          attendees: { select: ATTENDEE_SELECT },
        },
        // Most recent past first. `startTime` alone is NOT a total order — two
        // meetings can start at the same instant — and a cursor over a
        // non-unique ordering skips or repeats rows across the page boundary.
        // `id` is unique, so (startTime, id) is total and the cursor below is
        // consistent with it.
        orderBy: [{ startTime: 'desc' }, { id: 'desc' }],
        // One row past the page reports whether another page exists without a
        // second count query, and that extra row IS the next page's cursor.
        take: input.limit + 1,
        // Prisma's cursor is INCLUSIVE — the cursor row is the first row of the
        // next page, which is why it is the popped row and carries no `skip`.
        ...(input.cursor ? { cursor: { id: input.cursor } } : {}),
      });

      let nextCursor: string | undefined;
      if (meetings.length > input.limit) nextCursor = meetings.pop()?.id;

      // No `findRelevantOccurrence` pass: every row here is non-recurring by
      // the predicate above, so its stored start/end IS the occurrence, and
      // that is the key the attendance log is written under.
      return {
        items: await attachPerOccurrenceJoinedAt(ctx.db, meetings),
        nextCursor,
      };
    }),

  create: protectedProcedure
    .input(
      z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        startTime: z.date(),
        endTime: z.date(),
        location: z.string().optional(),
        recurrence: z.enum(['daily', 'weekly', 'biweekly', 'monthly']).nullable().default(null),
        attendeeIds: z.array(z.string()),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Guard against stale sessions: if the session JWT references a user that
      // no longer exists (e.g. after a DB reset), fail fast with a useful message
      // instead of a cryptic FK violation.
      const user = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
        select: { id: true },
      });
      if (!user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Session expired. Please log out and log back in.',
        });
      }

      const { attendeeIds, ...meetingData } = input;
      const allAttendees = [...new Set([user.id, ...attendeeIds])];
      await assertInOrganization(ctx.db.user, workspaceId(ctx), allAttendees);

      const meeting = await ctx.db.meeting.create({
        data: {
          ...meetingData,
          // WHA-235: the legacy value and its RRULE are written TOGETHER, and
          // this is the cutover seam. `recurrence` stays populated so a
          // rollback to pre-MEET-01 application code keeps working (the column
          // doc's stated reason for keeping it), while `recurrenceRule` is what
          // every read path added by this lane expands. Deriving one from the
          // other at the single point of write is what stops them drifting.
          recurrenceRule: legacyRecurrenceToRule(meetingData.recurrence),
          createdById: user.id,
          attendees: { create: allAttendees.map((userId) => ({ userId })) },
        },
      });

      // Materialise immediately rather than lazily on first read, so the join
      // link and its `publicId` exist the moment the meeting does — an invite
      // sent before the first read would otherwise have nothing to point at.
      await materializeMeetingOccurrences(ctx.db, meeting.id);

      return meeting;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        title: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        startTime: z.date().optional(),
        endTime: z.date().optional(),
        location: z.string().nullable().optional(),
        recurrence: z.enum(['daily', 'weekly', 'biweekly', 'monthly']).nullable().optional(),
        attendeeIds: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertMeetingManage(ctx, input.id);
      const { id, attendeeIds, ...data } = input;

      if (attendeeIds) {
        const allAttendees = [...new Set([ctx.session.user.id, ...attendeeIds])];
        await assertInOrganization(ctx.db.user, workspaceId(ctx), allAttendees);
        await ctx.db.meetingAttendee.deleteMany({ where: { meetingId: id } });
        await ctx.db.meetingAttendee.createMany({
          data: allAttendees.map((userId) => ({ meetingId: id, userId })),
        });
      }

      const updated = await ctx.db.meeting.update({
        where: { id },
        data: {
          ...data,
          // Keep the pair in step on every edit, exactly as `create` does. The
          // guard matters: `recurrence` is OPTIONAL on this input, and an
          // absent key means "leave the cadence alone", which must not be
          // confused with an explicit `null` meaning "make it one-time".
          ...(data.recurrence !== undefined
            ? { recurrenceRule: legacyRecurrenceToRule(data.recurrence) }
            : {}),
        },
      });

      // Reconcile after the edit. Moving the series or changing its cadence
      // adds the slots the new rule produces and CANCELS the future slots that
      // left it — past occurrences are untouched, because changing a rule does
      // not un-happen the meetings already held.
      await materializeMeetingOccurrences(ctx.db, id);

      return updated;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertMeetingManage(ctx, input.id);
      return ctx.db.meeting.delete({ where: { id: input.id } });
    }),

  /**
   * Meeting detail with all attendees + their join status.
   * Returns null if the user is not an attendee and not an admin.
   */
  getById: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;
    const isAdmin = ctx.session.user.role === 'ADMIN';

    const meeting = await ctx.db.meeting.findUnique({
      where: { id: input.id },
      include: {
        attendees: {
          // `select`, not `include`, for the reason given on ATTENDEE_SELECT:
          // an include drags the deprecated `joinedAt` along. Detail-page
          // attendance comes from `getAttendanceReport`, which reads the
          // per-occurrence log.
          select: {
            id: true,
            meetingId: true,
            userId: true,
            user: { select: { id: true, name: true, avatar: true, title: true } },
          },
        },
      },
    });

    if (!meeting) throw new TRPCError({ code: 'NOT_FOUND' });

    await assertMeetingAccess(ctx, input.id);

    const isAttendee = meeting.attendees.some((a) => a.userId === userId);
    if (!isAdmin && !isAttendee) {
      throw new TRPCError({ code: 'FORBIDDEN' });
    }

    return meeting;
  }),

  /**
   * Mark the current user as having joined a meeting.
   *
   * Attendance is recorded per-occurrence in MeetingAttendanceLog. Each call
   * upserts a row keyed on (meetingId, userId, occurrenceStart) — idempotent
   * per occurrence, so double-clicks are safe, and joining today's standup
   * creates a separate row from yesterday's.
   *
   * ATTENDANCE WINDOW: to prevent users from back-filling attendance for past
   * meetings they didn't actually attend, we only stamp the log if the click
   * falls within [start - 5min, end] of a live or imminent occurrence.
   * Outside that window, we return `{ skipped: '<reason>' }` — the frontend
   * still opens the meeting link, but no attendance record is created.
   */
  markJoined: protectedProcedure
    .input(z.object({ meetingId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      const attendee = await ctx.db.meetingAttendee.findUnique({
        where: { meetingId_userId: { meetingId: input.meetingId, userId } },
        include: {
          meeting: {
            select: { ...SERIES_FIELDS, title: true },
          },
        },
      });

      if (!attendee) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You are not an attendee of this meeting.',
        });
      }

      const now = new Date();
      const occurrence = await occurrenceWindow(ctx.db, attendee.meeting, now);

      // Attendance window: attendance counts only if you clicked Join while
      // the meeting is actually live (or about to start within 5 minutes).
      // This prevents retroactive attendance lies.
      const windowStart = new Date(occurrence.start.getTime() - 5 * 60_000);
      const windowEnd = occurrence.end;
      if (now < windowStart) {
        return { skipped: 'too_early' as const, occurrence };
      }
      if (now > windowEnd) {
        return { skipped: 'too_late' as const, occurrence };
      }

      // RT-06: atomic insert for this occurrence. createMany + skipDuplicates is
      // race-safe; the old findUnique→create threw P2002 (500) on a genuine
      // concurrent double-join. count === 0 means the row already existed.
      const result = await ctx.db.meetingAttendanceLog.createMany({
        data: [
          { meetingId: input.meetingId, userId, occurrenceStart: occurrence.start, joinedAt: now },
        ],
        skipDuplicates: true,
      });

      if (result.count === 0) {
        const existing = await ctx.db.meetingAttendanceLog.findUnique({
          where: {
            meetingId_userId_occurrenceStart: {
              meetingId: input.meetingId,
              userId,
              occurrenceStart: occurrence.start,
            },
          },
        });
        return {
          joinedAt: existing?.joinedAt ?? now,
          alreadyJoined: true as const,
          occurrence,
        };
      }

      // Also stamp MeetingAttendee.joinedAt with the latest join time so the
      // deprecated field still looks reasonable for any stale code that reads
      // it. updateMany so a non-formal attendee is a no-op, not a missing-row error.
      await ctx.db.meetingAttendee.updateMany({
        where: { meetingId: input.meetingId, userId },
        data: { joinedAt: now },
      });

      const punctuality = computePunctuality(
        { startTime: occurrence.start, recurrence: null }, // pass fixed start — punctuality already points at the right occurrence
        now
      );

      logActivity(ctx.db, userId, {
        type: 'meeting_joined',
        message: `joined meeting "${attendee.meeting.title}" (${punctuality?.label ?? 'on time'})`,
        entityType: 'Meeting',
        entityId: input.meetingId,
      });

      return {
        joinedAt: now,
        alreadyJoined: false as const,
        occurrence,
      };
    }),

  /**
   * Record that the current user joined the embedded video call. Upserts the
   * per-occurrence MeetingAttendanceLog row (idempotent per occurrence). Gated
   * identically to the rest of this router via assertMeetingAccess.
   */
  logJoin: protectedProcedure
    .input(z.object({ meetingId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertMeetingAccess(ctx, input.meetingId);
      const userId = ctx.session.user.id;

      const meeting = await ctx.db.meeting.findUnique({
        where: { id: input.meetingId },
        select: { ...SERIES_FIELDS, title: true },
      });
      if (!meeting) throw new TRPCError({ code: 'NOT_FOUND' });

      const now = new Date();
      const occurrence = await occurrenceWindow(ctx.db, meeting, now);

      // RT-01: logJoin is the PRIMARY, auto-fired attendance signal, so it MUST
      // honour the same anti-backfill window markJoined enforces — otherwise a
      // user who opens /meetings/<id>/call off-hours is stamped "present" for the
      // resolved occurrence. Attendance counts only within [start-5min, end].
      const windowStart = new Date(occurrence.start.getTime() - 5 * 60_000);
      if (now < windowStart)
        return { skipped: 'too_early' as const, alreadyJoined: false as const };
      if (now > occurrence.end)
        return { skipped: 'too_late' as const, alreadyJoined: false as const };

      // RT-06: atomic insert. createMany + skipDuplicates can't race the way the
      // old findUnique→create did (a genuine concurrent double-join threw P2002 →
      // 500). count === 0 means the row already existed.
      const result = await ctx.db.meetingAttendanceLog.createMany({
        data: [
          { meetingId: input.meetingId, userId, occurrenceStart: occurrence.start, joinedAt: now },
        ],
        skipDuplicates: true,
      });
      if (result.count === 0) {
        const existing = await ctx.db.meetingAttendanceLog.findUnique({
          where: {
            meetingId_userId_occurrenceStart: {
              meetingId: input.meetingId,
              userId,
              occurrenceStart: occurrence.start,
            },
          },
        });
        return { joinedAt: existing?.joinedAt ?? now, alreadyJoined: true as const };
      }

      // Keep the deprecated MeetingAttendee.joinedAt reasonable. updateMany (not
      // update) so an admin who joins without being a formal attendee is a no-op
      // rather than a missing-row error.
      await ctx.db.meetingAttendee.updateMany({
        where: { meetingId: input.meetingId, userId },
        data: { joinedAt: now },
      });

      const punctuality = computePunctuality(
        { startTime: occurrence.start, recurrence: null },
        now
      );

      logActivity(ctx.db, userId, {
        type: 'meeting_joined',
        message: `joined meeting "${meeting.title}" (${punctuality?.label ?? 'on time'})`,
        entityType: 'Meeting',
        entityId: input.meetingId,
      });

      return { joinedAt: now, alreadyJoined: false as const };
    }),

  /**
   * Stamp leftAt on the user's open attendance record for the current
   * occurrence when they leave the call. updateMany so leaving without a
   * recorded join (or after it's already stamped) is a harmless no-op. Gated
   * identically to the rest of this router via assertMeetingAccess.
   */
  logLeave: protectedProcedure
    .input(z.object({ meetingId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await assertMeetingAccess(ctx, input.meetingId);
      const userId = ctx.session.user.id;

      const meeting = await ctx.db.meeting.findUnique({
        where: { id: input.meetingId },
        select: SERIES_FIELDS,
      });
      if (!meeting) throw new TRPCError({ code: 'NOT_FOUND' });

      const now = new Date();
      const occurrence = await occurrenceWindow(ctx.db, meeting, now);

      const res = await ctx.db.meetingAttendanceLog.updateMany({
        where: {
          meetingId: input.meetingId,
          userId,
          occurrenceStart: occurrence.start,
          leftAt: null,
        },
        data: { leftAt: now },
      });

      return { left: res.count > 0 };
    }),

  /**
   * One page of a series' materialised occurrences, newest slot first.
   *
   * Materialises before reading, so a series created before this lane shipped
   * answers with its window rather than with an empty list. Bounded in the
   * shape #38/#40 established: schema default, schema ceiling, `prefault({})`.
   */
  getOccurrences: protectedProcedure
    .input(
      z
        .object({
          meetingId: z.string(),
          limit: z
            .number()
            .int()
            .min(1)
            .max(OCCURRENCE_PAGE_SIZE_MAX)
            .default(OCCURRENCE_PAGE_SIZE_MAX),
          includeCancelled: z.boolean().default(true),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      await assertMeetingAccess(ctx, input.meetingId);
      await materializeMeetingOccurrences(ctx.db, input.meetingId);

      const occurrences = await ctx.db.meetingOccurrence.findMany({
        where: {
          meetingId: input.meetingId,
          ...(input.includeCancelled ? {} : { status: { not: 'CANCELLED' } }),
        },
        select: {
          id: true,
          publicId: true,
          seriesSlotStart: true,
          scheduledStart: true,
          scheduledEnd: true,
          joinOpensAt: true,
          joinClosesAt: true,
          status: true,
          titleOverride: true,
          cancelledAt: true,
          cancelledById: true,
          cancellationReason: true,
          // `providerRoomName` is deliberately NOT selected. It is the media
          // room address, held apart from `publicId` precisely so a link-holder
          // cannot address the room directly and bypass the lobby; putting it
          // in a list payload would hand it to every attendee's browser.
        },
        // `scheduledStart` is not a total order across a rescheduled series,
        // so `id` makes the page deterministic — the same reason the list
        // procedures above carry an id tiebreaker.
        orderBy: [{ scheduledStart: 'desc' }, { id: 'desc' }],
        take: input.limit,
      });

      return occurrences.map((occurrence) => ({
        ...occurrence,
        joinPath: occurrenceJoinPath(occurrence.publicId),
      }));
    }),

  /**
   * Move ONE occurrence, leaving the series and every other instance alone.
   *
   * The exception is recorded on the occurrence — `seriesSlotStart` keeps the
   * instant the rule produced, so the materialiser still recognises this row as
   * that slot and does not re-create it on its next pass.
   */
  rescheduleOccurrence: protectedProcedure
    .input(
      z
        .object({
          occurrenceId: z.string(),
          scheduledStart: z.date(),
          scheduledEnd: z.date(),
        })
        .strict()
        // The `meeting_occurrences_time_order_check` CHECK enforces this in the
        // database; rejecting it here turns a 500 into a 400 with a reason.
        .refine((input) => input.scheduledEnd.getTime() >= input.scheduledStart.getTime(), {
          message: 'scheduledEnd must not precede scheduledStart.',
          path: ['scheduledEnd'],
        })
    )
    .mutation(async ({ ctx, input }) => {
      const occurrence = await ctx.db.meetingOccurrence.findUnique({
        where: { id: input.occurrenceId },
        select: { id: true, meetingId: true, status: true },
      });
      // RLS makes another tenant's occurrence indistinguishable from a missing
      // one, so this single branch covers both.
      if (!occurrence) throw new TRPCError({ code: 'NOT_FOUND' });

      // Authorization is the SERIES' — rescheduling an instance is a manage
      // action on the meeting it belongs to, not a separate permission.
      await assertMeetingManage(ctx, occurrence.meetingId);

      if (occurrence.status === 'CANCELLED') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This occurrence is cancelled and cannot be rescheduled.',
        });
      }

      const moved = await rescheduleOccurrence(ctx.db, input.occurrenceId, {
        scheduledStart: input.scheduledStart,
        scheduledEnd: input.scheduledEnd,
      });

      // NO ACTIVITY ENTRY. `ActivityType` in `src/server/activity.ts` has no
      // member for an occurrence-level change, and that file is outside this
      // lane. Recorded as a follow-up rather than widened here.
      return moved;
    }),

  /**
   * Call off ONE occurrence. Never deletes the row: it stays as the record that
   * this instance existed and was cancelled, and keeps any evidence already
   * hanging off it reachable.
   */
  cancelOccurrence: protectedProcedure
    .input(
      z
        .object({
          occurrenceId: z.string(),
          reason: z.string().max(500).nullable().default(null),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const occurrence = await ctx.db.meetingOccurrence.findUnique({
        where: { id: input.occurrenceId },
        select: { id: true, meetingId: true, status: true },
      });
      if (!occurrence) throw new TRPCError({ code: 'NOT_FOUND' });

      await assertMeetingManage(ctx, occurrence.meetingId);

      // Idempotent rather than an error: two operators cancelling the same
      // occurrence is a race, not a conflict, and the second must not see a
      // failure for an outcome that already holds.
      if (occurrence.status === 'CANCELLED') {
        const existing = await ctx.db.meetingOccurrence.findUniqueOrThrow({
          where: { id: input.occurrenceId },
          select: {
            id: true,
            publicId: true,
            seriesSlotStart: true,
            scheduledStart: true,
            scheduledEnd: true,
            status: true,
            titleOverride: true,
            cancelledAt: true,
          },
        });
        return {
          id: existing.id,
          publicId: existing.publicId,
          seriesSlotStart: existing.seriesSlotStart,
          start: existing.scheduledStart,
          end: existing.scheduledEnd,
          status: existing.status,
          titleOverride: existing.titleOverride,
          cancelledAt: existing.cancelledAt,
        };
      }

      const cancelled = await cancelOccurrence(ctx.db, input.occurrenceId, {
        cancelledById: ctx.session.user.id,
        reason: input.reason,
      });

      // Every outstanding guest credential for a cancelled occurrence is
      // withdrawn in the same breath. Leaving them live would keep a working
      // credential pointing at a meeting that is not happening.
      await ctx.db.meetingOccurrenceParticipant.updateMany({
        where: {
          occurrenceId: input.occurrenceId,
          guestTokenHash: { not: null },
          guestTokenRevokedAt: null,
        },
        data: { guestTokenRevokedAt: new Date() },
      });

      // No activity entry — see the note on `rescheduleOccurrence`.
      return cancelled;
    }),

  /**
   * Mint a guest credential for ONE occurrence.
   *
   * THE ONLY TIME THE SECRET EXISTS OUTSIDE THE CALLER'S RESPONSE. It is
   * returned once, stored only as a SHA-256 hash, and never logged — the
   * activity entry below deliberately records that a guest was invited and not
   * what they were given. The join link carries `publicId` only; the secret is
   * delivered out of band and typed. See `@/lib/meetings/guest-access`.
   *
   * Re-inviting the same guest MINTS A NEW SECRET and overwrites the old hash,
   * which is what makes a lost credential recoverable without a delete path and
   * invalidates the previous one in the same statement.
   */
  createGuestInvitation: protectedProcedure
    .input(
      z
        .object({
          occurrenceId: z.string(),
          displayName: z.string().min(1).max(200),
          /**
           * Optional cap on the credential's life. Absent means "expires with
           * the occurrence", which is the `MeetingOccurrenceParticipant`
           * contract — everything on that row expires with the occurrence it
           * belongs to. A shorter cap is honoured; a longer one is not, because
           * a credential outliving its occurrence is the thing that must not
           * exist.
           */
          maxTtlMinutes: z
            .number()
            .int()
            .min(1)
            .max(60 * 24 * 30)
            .optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const occurrence = await ctx.db.meetingOccurrence.findUnique({
        where: { id: input.occurrenceId },
        select: { id: true, meetingId: true, publicId: true, status: true, joinClosesAt: true },
      });
      if (!occurrence) throw new TRPCError({ code: 'NOT_FOUND' });

      await assertMeetingManage(ctx, occurrence.meetingId);

      if (occurrence.status === 'CANCELLED') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This occurrence is cancelled.',
        });
      }

      const now = new Date();
      const expiresAt = guestSecretExpiryFor(occurrence, {
        now,
        maxTtlMs: input.maxTtlMinutes === undefined ? undefined : input.maxTtlMinutes * 60_000,
      });

      if (expiresAt.getTime() <= now.getTime()) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'This occurrence is no longer joinable, so a guest link would already be expired.',
        });
      }

      const { secret, secretHash } = mintGuestSecret();

      const participant = await ctx.db.meetingOccurrenceParticipant.create({
        data: {
          occurrenceId: input.occurrenceId,
          displayName: input.displayName,
          // A guest waits in the lobby. The credential proves who sent them,
          // not that a host is expecting them right now.
          lobbyStatus: 'WAITING',
          guestTokenHash: secretHash,
          // The CHECK constraint refuses a hash without an expiry, so these two
          // are written together or not at all.
          guestTokenExpiresAt: expiresAt,
        },
        select: { id: true },
      });

      // No activity entry — see the note on `rescheduleOccurrence`. When one is
      // added it must name the GUEST and never the credential.
      return {
        occurrenceParticipantId: participant.id,
        displayName: input.displayName,
        joinPath: occurrenceJoinPath(occurrence.publicId),
        expiresAt,
        /**
         * SHOW ONCE. Not persisted in this form and not retrievable again —
         * a second call mints a different secret.
         */
        secret,
      };
    }),

  /**
   * Withdraw a guest credential immediately.
   *
   * Sets `guestTokenRevokedAt` rather than clearing the hash: the row remains
   * the record that this person was invited and cut off, and
   * `evaluateGuestCredential` checks revocation before expiry so the reason
   * stays visible in the server's own logs after the clock passes the expiry.
   */
  revokeGuestInvitation: protectedProcedure
    .input(z.object({ occurrenceParticipantId: z.string() }).strict())
    .mutation(async ({ ctx, input }) => {
      const participant = await ctx.db.meetingOccurrenceParticipant.findUnique({
        where: { id: input.occurrenceParticipantId },
        select: { id: true, occurrence: { select: { meetingId: true } } },
      });
      if (!participant) throw new TRPCError({ code: 'NOT_FOUND' });

      await assertMeetingManage(ctx, participant.occurrence.meetingId);

      const result = await ctx.db.meetingOccurrenceParticipant.updateMany({
        where: { id: input.occurrenceParticipantId, guestTokenRevokedAt: null },
        data: { guestTokenRevokedAt: new Date() },
      });

      return { revoked: result.count > 0 };
    }),

  // IMP-RT-01: attendance reporting — per-person attendance across all recorded
  // occurrences of a meeting (count + rate + last join), so the logged data is
  // actionable. Gated identically to the meeting itself.
  getAttendanceReport: protectedProcedure
    .input(z.object({ meetingId: z.string() }))
    .query(async ({ ctx, input }) => {
      await assertMeetingAccess(ctx, input.meetingId);
      const logs = await ctx.db.meetingAttendanceLog.findMany({
        where: { meetingId: input.meetingId },
        include: { user: { select: { id: true, name: true, avatar: true } } },
      });
      const heldOccurrences = new Set(logs.map((l) => l.occurrenceStart.getTime())).size || 1;
      const byUser = new Map<
        string,
        {
          user: { id: string; name: string; avatar: string | null };
          attended: number;
          lastJoinedAt: Date | null;
        }
      >();
      for (const l of logs) {
        const e = byUser.get(l.userId) ?? { user: l.user, attended: 0, lastJoinedAt: null };
        e.attended += 1;
        if (!e.lastJoinedAt || l.joinedAt > e.lastJoinedAt) e.lastJoinedAt = l.joinedAt;
        byUser.set(l.userId, e);
      }
      return {
        heldOccurrences,
        attendees: Array.from(byUser.values())
          .map((e) => ({
            user: e.user,
            attended: e.attended,
            rate: Math.round((e.attended / heldOccurrences) * 100),
            lastJoinedAt: e.lastJoinedAt,
          }))
          .sort((a, b) => b.attended - a.attended),
      };
    }),
});

/**
 * Whose meetings the list procedures return (#35).
 *
 * ADMIN comes from `isAdmin` — the SAME predicate `canAccessMeeting` /
 * `assertMeetingAccess` already use to grant an admin organization-wide access
 * and manage rights. Writing a second `role === 'ADMIN'` literal here is
 * precisely how list policy and access policy came to disagree: an admin could
 * open and manage a meeting whose id they held, but could not discover one.
 *
 * The admin branch drops the attendee filter and NOTHING else. Tenant scope is
 * RLS's job on the scoped client, so adding `organizationId` here would make a
 * cross-organization test pass even with RLS broken — a guard that guards
 * nothing.
 */
function meetingListScope(user: { id: string; role?: string | null }): Prisma.MeetingWhereInput {
  return isAdmin(user.role) ? {} : { attendees: { some: { userId: user.id } } };
}

/**
 * Whose meetings the UPCOMING surfaces return (#38).
 *
 * DELIBERATELY NOT `meetingListScope`, and this is why the two now differ.
 *
 * Issue #35 (closed, delivered by PR #36) specified "ADMIN — organization-wide
 * list AND upcoming visibility", and `getUpcoming` shared `meetingListScope`
 * accordingly. #38 narrows the upcoming half back to user-relevant for every
 * role, admins included. That is an intentional PARTIAL REVERSAL of shipped,
 * accepted behaviour, not a bug fix landing on top of it:
 *
 *  - `getUpcoming` feeds the dashboard widget and the Meetings page's Upcoming
 *    section. Both answer "what am I doing next", not "what is the
 *    organization doing next". Organization-wide, it made every admin
 *    dashboard load fetch every future meeting in the tenant plus every
 *    recurring series plus their full attendee graphs.
 *  - Organization-wide DISCOVERY is unaffected: it lives on `getAll`, which is
 *    bounded and paginated, and an admin still reaches every organization
 *    meeting there.
 *
 * An organization-wide upcoming view remains a legitimate feature — it is just
 * a separately authorized one. Until it is explicitly requested, this
 * procedure stays attendee-scoped, which is byte-for-byte what a non-admin
 * already saw.
 */
function upcomingListScope(user: { id: string }): Prisma.MeetingWhereInput {
  return { attendees: { some: { userId: user.id } } };
}

/**
 * Given a list of meetings whose `startTime` has already been resolved to the
 * "relevant" occurrence for display, look up per-occurrence attendance log
 * rows for each attendee and return the meetings with `joinedAt` on each
 * attendee set to the log's timestamp for that specific occurrence.
 *
 * Uses a single batched query (OR clause) for all (meetingId, occurrenceStart)
 * pairs, so this is O(1) queries regardless of meeting count.
 */
type MeetingWithAttendees = {
  id: string;
  startTime: Date;
  attendees: Array<{
    user: { id: string; name: string; avatar: string | null };
  }>;
  [key: string]: unknown;
};

async function attachPerOccurrenceJoinedAt<M extends MeetingWithAttendees>(
  db: PrismaClient,
  meetings: M[]
): Promise<M[]> {
  if (meetings.length === 0) return meetings;

  // Batch: one query for all (meetingId, occurrenceStart) pairs
  const logs = await db.meetingAttendanceLog.findMany({
    where: {
      OR: meetings.map((m) => ({
        meetingId: m.id,
        occurrenceStart: m.startTime,
      })),
    },
  });

  // Index by meetingId + occurrenceStartISO + userId
  const keyFor = (meetingId: string, occStart: Date, userId: string) =>
    `${meetingId}::${new Date(occStart).toISOString()}::${userId}`;

  const joinedIndex = new Map<string, Date>();
  for (const l of logs) {
    joinedIndex.set(keyFor(l.meetingId, l.occurrenceStart, l.userId), l.joinedAt);
  }

  // Attach per-occurrence joinedAt on each attendee, overriding the
  // deprecated MeetingAttendee.joinedAt field.
  return meetings.map((m) => ({
    ...m,
    attendees: m.attendees.map((a) => ({
      ...a,
      joinedAt: joinedIndex.get(keyFor(m.id, m.startTime, a.user.id)) ?? null,
    })),
  }));
}

/**
 * The occurrence an attendance write belongs to, as a `{ start, end }` window.
 *
 * The single replacement for `findRelevantOccurrence` on the write paths. It
 * MATERIALISES first (unlike the batched list resolvers, which must not turn a
 * page render into a write storm) because these three procedures are the ones
 * that must be exact: `occurrenceStart` is part of the attendance log's unique
 * key, so resolving it differently from one call to the next would split one
 * occurrence's attendance across two rows.
 *
 * Falls back to the meeting's own stored times when a series has no occurrence
 * row at all — byte-for-byte what the non-recurring branch of the old walker
 * returned, and the only case that can reach it.
 */
async function occurrenceWindow(
  db: PrismaClient,
  meeting: SeriesRow,
  now: Date
): Promise<{ start: Date; end: Date }> {
  const resolved = await resolveRelevantOccurrence(db, meeting.id, now);
  if (resolved) return { start: resolved.start, end: resolved.end };
  return { start: meeting.startTime, end: meeting.endTime };
}
