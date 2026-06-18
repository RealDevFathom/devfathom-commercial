import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import type { PrismaClient } from '@/generated/prisma/client';
import { router, protectedProcedure } from '../trpc';
import { assertMeetingManage, assertMeetingAccess } from '../authz';
import { logActivity } from '../activity';
import { computePunctuality, findRelevantOccurrence } from '@/lib/meeting-occurrence';

export const meetingsRouter = router({
  getUpcoming: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    const now = new Date();

    // Include currently-running meetings (endTime still in the future),
    // not just strictly-future ones. A meeting that started 1 min ago and runs
    // for 30 minutes is still the "current" meeting until it ends.
    const [futureMeetings, recurringMeetings] = await Promise.all([
      ctx.db.meeting.findMany({
        where: {
          attendees: { some: { userId } },
          endTime: { gte: now },
        },
        include: {
          attendees: { include: { user: { select: { id: true, name: true, avatar: true } } } },
        },
        orderBy: { startTime: 'asc' },
        take: 50,
      }),
      // Get recurring meetings (even if startTime is in the past — we compute next occurrence)
      ctx.db.meeting.findMany({
        where: {
          attendees: { some: { userId } },
          recurrence: { not: null },
        },
        include: {
          attendees: { include: { user: { select: { id: true, name: true, avatar: true } } } },
        },
      }),
    ]);

    // Compute next occurrences for recurring meetings
    const computed = recurringMeetings
      .map((m) => {
        const next = getNextOccurrence(
          new Date(m.startTime),
          new Date(m.endTime),
          m.recurrence!,
          now
        );
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

  getAll: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(1000).optional(),
          cursor: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const now = new Date();
      const limit = input?.limit ? Math.min(input.limit, 1000) : undefined;

      const meetings = await ctx.db.meeting.findMany({
        where: { attendees: { some: { userId } } },
        include: {
          attendees: { include: { user: { select: { id: true, name: true, avatar: true } } } },
        },
        orderBy: { startTime: 'desc' },
        take: limit,
        ...(input?.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });

      // For each meeting, resolve the "relevant" occurrence for display so the
      // per-occurrence attendance lookup targets the right one. Non-recurring:
      // the meeting's own start/end. Recurring: the occurrence closest to now.
      const withResolvedStart = meetings.map((m) => {
        const occ = findRelevantOccurrence(m.startTime, m.endTime, m.recurrence, now);
        return { ...m, startTime: occ.start, endTime: occ.end };
      });

      return attachPerOccurrenceJoinedAt(ctx.db, withResolvedStart);
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

      return ctx.db.meeting.create({
        data: {
          ...meetingData,
          createdById: user.id,
          attendees: { create: allAttendees.map((userId) => ({ userId })) },
        },
      });
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
        await ctx.db.meetingAttendee.deleteMany({ where: { meetingId: id } });
        const allAttendees = [...new Set([ctx.session.user.id, ...attendeeIds])];
        await ctx.db.meetingAttendee.createMany({
          data: allAttendees.map((userId) => ({ meetingId: id, userId })),
        });
      }

      return ctx.db.meeting.update({ where: { id }, data });
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
          include: {
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
            select: {
              id: true,
              title: true,
              startTime: true,
              endTime: true,
              recurrence: true,
            },
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
      const occurrence = findRelevantOccurrence(
        attendee.meeting.startTime,
        attendee.meeting.endTime,
        attendee.meeting.recurrence,
        now
      );

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

      // Upsert the log row for this specific occurrence. Double-clicks hit
      // the unique constraint and become a no-op.
      const existing = await ctx.db.meetingAttendanceLog.findUnique({
        where: {
          meetingId_userId_occurrenceStart: {
            meetingId: input.meetingId,
            userId,
            occurrenceStart: occurrence.start,
          },
        },
      });

      if (existing) {
        return {
          joinedAt: existing.joinedAt,
          alreadyJoined: true as const,
          occurrence,
        };
      }

      const created = await ctx.db.meetingAttendanceLog.create({
        data: {
          meetingId: input.meetingId,
          userId,
          occurrenceStart: occurrence.start,
          joinedAt: now,
        },
      });

      // Also stamp MeetingAttendee.joinedAt with the latest join time so the
      // deprecated field still looks reasonable for any stale code that reads
      // it. New reads should go through the log.
      await ctx.db.meetingAttendee.update({
        where: { meetingId_userId: { meetingId: input.meetingId, userId } },
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
        joinedAt: created.joinedAt,
        alreadyJoined: false as const,
        occurrence,
      };
    }),
});

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
    joinedAt: Date | null;
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

function getNextOccurrence(
  originalStart: Date,
  originalEnd: Date,
  recurrence: string,
  after: Date
): { start: Date; end: Date } | null {
  const duration = originalEnd.getTime() - originalStart.getTime();
  const current = new Date(originalStart);

  // Return the first occurrence whose END is still in the future.
  // This means if an occurrence is currently running (start ≤ now < end),
  // we return that one — it's the "current" meeting, not the next one.
  for (let i = 0; i < 365; i++) {
    const currentEnd = new Date(current.getTime() + duration);
    if (currentEnd > after) {
      return { start: new Date(current), end: currentEnd };
    }

    switch (recurrence) {
      case 'daily':
        current.setDate(current.getDate() + 1);
        break;
      case 'weekly':
        current.setDate(current.getDate() + 7);
        break;
      case 'biweekly':
        current.setDate(current.getDate() + 14);
        break;
      case 'monthly':
        current.setMonth(current.getMonth() + 1);
        break;
      default:
        return null;
    }
  }

  return null;
}
