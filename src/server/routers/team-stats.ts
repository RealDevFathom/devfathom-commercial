import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { countPastOccurrences, ON_TIME_THRESHOLD_MINUTES } from '@/lib/meeting-occurrence';

/**
 * Per-member analytics powering the /team/stats dashboard and the personal
 * stats block on /team/[id]. Built as a few batched queries (rather than N
 * queries per user) so a team of 8 runs in well under 100ms.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export interface MemberStats {
  userId: string;
  name: string;
  avatar: string | null;
  title: string | null;
  // Workload
  openTasks: number;
  completedThisWeek: number;
  completedLastWeek: number;
  overdueTasks: number;
  avgCycleTimeDays: number | null;
  // Meetings
  meetingsInvited: number;
  meetingsAttended: number;
  avgMinutesLate: number | null;
  onTimePercent: number | null;
  // Collaboration
  notesAuthored: number;
  projectsActive: number;
  commentsThisWeek: number;
  // Pulse
  lastActiveAt: Date | null;
  tasksDoneSparkline: number[]; // length 7: tasks completed per day, last 7 days
}

export interface TeamAlert {
  userId: string;
  name: string;
  severity: 'high' | 'medium' | 'low';
  kind: string;
  message: string;
}

function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function diffDays(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / DAY_MS);
}

export const teamStatsRouter = router({
  /**
   * All members' stats plus team-wide aggregates.
   * Admin-only — full team view.
   */
  getAll: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.session.user.role !== 'ADMIN') {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Team stats overview is admin-only. See your personal stats on your profile.',
      });
    }

    const now = new Date();
    const weekAgo = new Date(now.getTime() - WEEK_MS);
    const twoWeeksAgo = new Date(now.getTime() - 2 * WEEK_MS);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS);

    // Fetch everything in parallel — this is the hot path.
    const [
      users,
      openTasksRows,
      completedThisWeekRows,
      completedLastWeekRows,
      overdueRows,
      cycleTimeRows,
      meetingInvitedRows,
      meetingJoinedRows,
      notesRows,
      projectsRows,
      commentsRows,
      velocityByDayRows,
      overdueSample,
    ] = await Promise.all([
      ctx.db.user.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, name: true, avatar: true, title: true, lastActiveAt: true },
        orderBy: { name: 'asc' },
      }),

      // Open tasks = assigned to user, in a column NOT named 'Done'
      ctx.db.task.findMany({
        where: {
          assignees: { some: {} },
          column: { name: { not: 'Done' } },
        },
        select: { id: true, assignees: { select: { userId: true } } },
      }),

      // Completed this week = task in Done column that ENTERED Done in the last 7
      // days (#410: completedAt, never the mutable updatedAt an edit moves).
      ctx.db.task.findMany({
        where: {
          column: { name: 'Done' },
          completedAt: { gte: weekAgo },
          assignees: { some: {} },
        },
        select: {
          id: true,
          createdAt: true,
          completedAt: true,
          assignees: { select: { userId: true } },
        },
      }),

      // Completed last week = Done, entered Done 7–14 days ago (week-over-week delta)
      ctx.db.task.findMany({
        where: {
          column: { name: 'Done' },
          completedAt: { gte: twoWeeksAgo, lt: weekAgo },
          assignees: { some: {} },
        },
        select: { id: true, assignees: { select: { userId: true } } },
      }),

      // Overdue = dueDate < now, not in Done
      ctx.db.task.findMany({
        where: {
          dueDate: { lt: now },
          column: { name: { not: 'Done' } },
          assignees: { some: {} },
        },
        select: { id: true, assignees: { select: { userId: true } } },
      }),

      // Cycle time = Done tasks with a known completion time (any age) - used for avg
      ctx.db.task.findMany({
        where: {
          column: { name: 'Done' },
          completedAt: { not: null },
          assignees: { some: {} },
        },
        select: {
          createdAt: true,
          completedAt: true,
          assignees: { select: { userId: true } },
        },
        take: 500,
        orderBy: { completedAt: 'desc' },
      }),

      // Meetings invited — fetch the (meeting, attendee) pairs so we can count
      // past occurrences per user. Recurring meetings get multiplied below.
      ctx.db.meetingAttendee.findMany({
        select: {
          userId: true,
          meeting: {
            select: { id: true, startTime: true, endTime: true, recurrence: true },
          },
        },
      }),

      // Meetings attended — read from the per-occurrence attendance log.
      // Each row = one user, one specific occurrence they joined.
      ctx.db.meetingAttendanceLog.findMany({
        where: { occurrenceStart: { lt: now } },
        select: { userId: true, joinedAt: true, occurrenceStart: true },
      }),

      // Notes authored — include all visibilities (counted for the author)
      ctx.db.note.groupBy({
        by: ['authorId'],
        _count: { _all: true },
      }),

      // Active project memberships — project must be ACTIVE or IN_DEVELOPMENT
      ctx.db.projectMember.findMany({
        where: { project: { status: { in: ['ACTIVE', 'IN_DEVELOPMENT'] } } },
        select: { userId: true },
      }),

      // Task comments in last 7 days — a rough "collaboration pulse"
      ctx.db.taskComment.groupBy({
        by: ['userId'],
        where: { createdAt: { gte: weekAgo } },
        _count: { _all: true },
      }),

      // Team velocity — tasks completed per day across all users, last 30 days
      ctx.db.task.findMany({
        where: {
          column: { name: 'Done' },
          completedAt: { gte: thirtyDaysAgo },
        },
        select: { completedAt: true },
      }),

      // Sample of overdue tasks for the alerts section (titles for context)
      ctx.db.task.findMany({
        where: {
          dueDate: { lt: now },
          column: { name: { not: 'Done' } },
          assignees: { some: {} },
        },
        select: {
          id: true,
          title: true,
          dueDate: true,
          assignees: { select: { userId: true } },
        },
        take: 100,
      }),
    ]);

    // (no longer needed — meetingJoinedRows is a real query now)

    // ---------- Group per user ----------

    const byUser = new Map<string, MemberStats>();
    for (const u of users) {
      byUser.set(u.id, {
        userId: u.id,
        name: u.name,
        avatar: u.avatar,
        title: u.title,
        openTasks: 0,
        completedThisWeek: 0,
        completedLastWeek: 0,
        overdueTasks: 0,
        avgCycleTimeDays: null,
        meetingsInvited: 0,
        meetingsAttended: 0,
        avgMinutesLate: null,
        onTimePercent: null,
        notesAuthored: 0,
        projectsActive: 0,
        commentsThisWeek: 0,
        lastActiveAt: u.lastActiveAt,
        tasksDoneSparkline: [0, 0, 0, 0, 0, 0, 0],
      });
    }

    // Open tasks
    for (const t of openTasksRows) {
      for (const a of t.assignees) {
        const s = byUser.get(a.userId);
        if (s) s.openTasks++;
      }
    }

    // Completed this week + build sparkline
    const today = startOfDay(now);
    for (const t of completedThisWeekRows) {
      if (!t.completedAt) continue;
      for (const a of t.assignees) {
        const s = byUser.get(a.userId);
        if (!s) continue;
        s.completedThisWeek++;
        const daysAgo = diffDays(today, startOfDay(t.completedAt));
        if (daysAgo >= 0 && daysAgo < 7) {
          // index 0 = oldest (6 days ago), index 6 = today
          s.tasksDoneSparkline[6 - daysAgo]++;
        }
      }
    }

    // Completed last week
    for (const t of completedLastWeekRows) {
      for (const a of t.assignees) {
        const s = byUser.get(a.userId);
        if (s) s.completedLastWeek++;
      }
    }

    // Overdue
    for (const t of overdueRows) {
      for (const a of t.assignees) {
        const s = byUser.get(a.userId);
        if (s) s.overdueTasks++;
      }
    }

    // Cycle time (avg days from createdAt → entering Done, for Done tasks)
    const cycleSumByUser = new Map<string, { sum: number; count: number }>();
    for (const t of cycleTimeRows) {
      if (!t.completedAt) continue;
      const days = (t.completedAt.getTime() - t.createdAt.getTime()) / DAY_MS;
      if (days < 0 || days > 365) continue; // sanity filter
      for (const a of t.assignees) {
        const bucket = cycleSumByUser.get(a.userId) ?? { sum: 0, count: 0 };
        bucket.sum += days;
        bucket.count++;
        cycleSumByUser.set(a.userId, bucket);
      }
    }
    for (const [userId, bucket] of cycleSumByUser) {
      const s = byUser.get(userId);
      if (s && bucket.count > 0) {
        s.avgCycleTimeDays = Math.round((bucket.sum / bucket.count) * 10) / 10;
      }
    }

    // Meetings INVITED — for each (meeting, user) pair, count how many
    // occurrences have already ended. A recurring daily standup with 30 past
    // days contributes 30 to that user's invited count, not 1.
    for (const row of meetingInvitedRows) {
      const s = byUser.get(row.userId);
      if (!s) continue;
      s.meetingsInvited += countPastOccurrences(
        row.meeting.startTime,
        row.meeting.endTime,
        row.meeting.recurrence,
        now
      );
    }

    // Meetings ATTENDED + punctuality — read from the per-occurrence log.
    // Each row = one confirmed attendance. Punctuality is computed directly
    // from the log's own occurrenceStart → no need to re-derive the
    // occurrence, which is where the recurring-meeting bug lived.
    const lateByUser = new Map<string, { sum: number; count: number; onTime: number }>();
    for (const l of meetingJoinedRows) {
      const s = byUser.get(l.userId);
      if (!s) continue;
      s.meetingsAttended++;
      const diffMin = (l.joinedAt.getTime() - l.occurrenceStart.getTime()) / 60000;
      const bucket = lateByUser.get(l.userId) ?? { sum: 0, count: 0, onTime: 0 };
      bucket.sum += Math.max(0, diffMin);
      bucket.count++;
      if (diffMin <= ON_TIME_THRESHOLD_MINUTES) bucket.onTime++;
      lateByUser.set(l.userId, bucket);
    }
    for (const [userId, bucket] of lateByUser) {
      const s = byUser.get(userId);
      if (!s || bucket.count === 0) continue;
      s.avgMinutesLate = Math.round((bucket.sum / bucket.count) * 10) / 10;
      s.onTimePercent = Math.round((bucket.onTime / bucket.count) * 100);
    }

    // Notes
    for (const row of notesRows) {
      const s = byUser.get(row.authorId);
      if (s) s.notesAuthored = row._count._all;
    }

    // Active projects
    for (const pm of projectsRows) {
      const s = byUser.get(pm.userId);
      if (s) s.projectsActive++;
    }

    // Comments this week
    for (const row of commentsRows) {
      const s = byUser.get(row.userId);
      if (s) s.commentsThisWeek = row._count._all;
    }

    const members = Array.from(byUser.values());

    // ---------- Team-wide aggregates ----------

    // Team velocity — 30 day array, each entry = tasks completed that day
    const velocity: { date: string; count: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getTime() - i * DAY_MS);
      const key = d.toISOString().slice(0, 10);
      velocity.push({ date: key, count: 0 });
    }
    const velocityIndex = new Map(velocity.map((v, i) => [v.date, i]));
    for (const t of velocityByDayRows) {
      if (!t.completedAt) continue;
      const key = t.completedAt.toISOString().slice(0, 10);
      const i = velocityIndex.get(key);
      if (i !== undefined) velocity[i].count++;
    }

    // ---------- Alerts ----------

    const alerts: TeamAlert[] = [];
    for (const s of members) {
      if (s.openTasks === 0) {
        alerts.push({
          userId: s.userId,
          name: s.name,
          severity: 'high',
          kind: 'no_tasks',
          message: `has no active tasks assigned`,
        });
      }
      if (s.completedThisWeek === 0 && s.openTasks > 0) {
        alerts.push({
          userId: s.userId,
          name: s.name,
          severity: 'medium',
          kind: 'no_progress',
          message: `hasn't moved anything to Done in the last 7 days`,
        });
      }
      if (s.overdueTasks >= 3) {
        alerts.push({
          userId: s.userId,
          name: s.name,
          severity: 'medium',
          kind: 'overdue',
          message: `has ${s.overdueTasks} overdue tasks`,
        });
      } else if (s.overdueTasks > 0) {
        alerts.push({
          userId: s.userId,
          name: s.name,
          severity: 'low',
          kind: 'overdue',
          message: `has ${s.overdueTasks} overdue task${s.overdueTasks === 1 ? '' : 's'}`,
        });
      }
      if (s.meetingsInvited >= 5 && s.meetingsAttended / s.meetingsInvited < 0.6) {
        alerts.push({
          userId: s.userId,
          name: s.name,
          severity: 'medium',
          kind: 'absenteeism',
          message: `missed ${s.meetingsInvited - s.meetingsAttended} of last ${s.meetingsInvited} meetings`,
        });
      }
    }
    // Sort by severity: high → medium → low
    const sevOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    alerts.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);

    // ---------- Leaderboards ----------

    const leaderboards = {
      topCompleter: [...members]
        .filter((m) => m.completedThisWeek > 0)
        .sort((a, b) => b.completedThisWeek - a.completedThisWeek)
        .slice(0, 3),
      bestPunctuality: [...members]
        .filter((m) => m.onTimePercent !== null && m.meetingsAttended >= 2)
        .sort((a, b) => (b.onTimePercent ?? 0) - (a.onTimePercent ?? 0))
        .slice(0, 3),
      mostCollaborative: [...members]
        .filter((m) => m.commentsThisWeek + m.notesAuthored > 0)
        .sort(
          (a, b) => b.commentsThisWeek + b.notesAuthored - (a.commentsThisWeek + a.notesAuthored)
        )
        .slice(0, 3),
      fastestCycle: [...members]
        .filter((m) => m.avgCycleTimeDays !== null)
        .sort((a, b) => (a.avgCycleTimeDays ?? 99) - (b.avgCycleTimeDays ?? 99))
        .slice(0, 3),
    };

    // ---------- Team totals ----------

    const totals = {
      teamCompletedThisWeek: members.reduce((s, m) => s + m.completedThisWeek, 0),
      teamCompletedLastWeek: members.reduce((s, m) => s + m.completedLastWeek, 0),
      teamOpenTasks: members.reduce((s, m) => s + m.openTasks, 0),
      teamOverdue: members.reduce((s, m) => s + m.overdueTasks, 0),
      teamMembers: members.length,
      membersWithNoTasks: members.filter((m) => m.openTasks === 0).length,
    };

    return {
      members,
      alerts,
      velocity,
      leaderboards,
      totals,
      overdueSample: overdueSample.slice(0, 10),
    };
  }),

  /**
   * Personal stats for a single user. Viewable by the user themselves or by admin.
   * Returns the same MemberStats shape as one row of getAll.
   */
  getForUser: protectedProcedure
    .input(z.object({ userId: z.string() }))
    .query(async ({ ctx, input }) => {
      const isSelf = ctx.session.user.id === input.userId;
      const isAdmin = ctx.session.user.role === 'ADMIN';
      if (!isSelf && !isAdmin) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You can only view your own stats.',
        });
      }

      const now = new Date();
      const weekAgo = new Date(now.getTime() - WEEK_MS);
      const twoWeeksAgo = new Date(now.getTime() - 2 * WEEK_MS);

      const [
        user,
        openTasks,
        completedThisWeek,
        completedLastWeek,
        overdueTasks,
        cycleTasks,
        meetingAttendees,
        attendanceLog,
        notesCount,
        projectsCount,
        commentsCount,
      ] = await Promise.all([
        ctx.db.user.findUnique({
          where: { id: input.userId },
          select: { id: true, name: true, avatar: true, title: true, lastActiveAt: true },
        }),
        ctx.db.task.count({
          where: {
            assignees: { some: { userId: input.userId } },
            column: { name: { not: 'Done' } },
          },
        }),
        // #410: completion windows read completedAt (entering Done), not updatedAt.
        ctx.db.task.findMany({
          where: {
            column: { name: 'Done' },
            completedAt: { gte: weekAgo },
            assignees: { some: { userId: input.userId } },
          },
          select: { completedAt: true },
        }),
        ctx.db.task.count({
          where: {
            column: { name: 'Done' },
            completedAt: { gte: twoWeeksAgo, lt: weekAgo },
            assignees: { some: { userId: input.userId } },
          },
        }),
        ctx.db.task.count({
          where: {
            dueDate: { lt: now },
            column: { name: { not: 'Done' } },
            assignees: { some: { userId: input.userId } },
          },
        }),
        ctx.db.task.findMany({
          where: {
            column: { name: 'Done' },
            completedAt: { not: null },
            assignees: { some: { userId: input.userId } },
          },
          select: { createdAt: true, completedAt: true },
          orderBy: { completedAt: 'desc' },
          take: 200,
        }),
        // All meetings this user is invited to — used to count past occurrences
        ctx.db.meetingAttendee.findMany({
          where: { userId: input.userId },
          select: {
            meeting: {
              select: { id: true, startTime: true, endTime: true, recurrence: true },
            },
          },
        }),
        // Per-occurrence attendance log for this user
        ctx.db.meetingAttendanceLog.findMany({
          where: { userId: input.userId, occurrenceStart: { lt: now } },
          select: { joinedAt: true, occurrenceStart: true },
        }),
        ctx.db.note.count({ where: { authorId: input.userId } }),
        ctx.db.projectMember.count({
          where: {
            userId: input.userId,
            project: { status: { in: ['ACTIVE', 'IN_DEVELOPMENT'] } },
          },
        }),
        ctx.db.taskComment.count({
          where: { userId: input.userId, createdAt: { gte: weekAgo } },
        }),
      ]);

      if (!user) throw new TRPCError({ code: 'NOT_FOUND' });

      // Sparkline
      const today = startOfDay(now);
      const sparkline = [0, 0, 0, 0, 0, 0, 0];
      for (const t of completedThisWeek) {
        if (!t.completedAt) continue;
        const daysAgo = diffDays(today, startOfDay(t.completedAt));
        if (daysAgo >= 0 && daysAgo < 7) sparkline[6 - daysAgo]++;
      }

      // Cycle time (createdAt → entering Done)
      let avgCycleTimeDays: number | null = null;
      const cycleDays = cycleTasks.flatMap((t) =>
        t.completedAt ? [(t.completedAt.getTime() - t.createdAt.getTime()) / DAY_MS] : []
      );
      if (cycleDays.length > 0) {
        const total = cycleDays.reduce((sum, days) => sum + days, 0);
        avgCycleTimeDays = Math.round((total / cycleDays.length) * 10) / 10;
      }

      // Meetings invited = sum of past occurrences across all meetings I'm on
      let meetingsInvited = 0;
      for (const a of meetingAttendees) {
        meetingsInvited += countPastOccurrences(
          a.meeting.startTime,
          a.meeting.endTime,
          a.meeting.recurrence,
          now
        );
      }

      // Meetings attended + punctuality comes from the per-occurrence log
      let avgMinutesLate: number | null = null;
      let onTimePercent: number | null = null;
      if (attendanceLog.length > 0) {
        const diffs = attendanceLog.map(
          (l) => (l.joinedAt.getTime() - l.occurrenceStart.getTime()) / 60000
        );
        const lates = diffs.map((d) => Math.max(0, d));
        avgMinutesLate = Math.round((lates.reduce((a, b) => a + b, 0) / lates.length) * 10) / 10;
        onTimePercent = Math.round(
          (diffs.filter((d) => d <= ON_TIME_THRESHOLD_MINUTES).length / attendanceLog.length) * 100
        );
      }

      const stats: MemberStats = {
        userId: user.id,
        name: user.name,
        avatar: user.avatar,
        title: user.title,
        openTasks,
        completedThisWeek: completedThisWeek.length,
        completedLastWeek,
        overdueTasks,
        avgCycleTimeDays,
        meetingsInvited,
        meetingsAttended: attendanceLog.length,
        avgMinutesLate,
        onTimePercent,
        notesAuthored: notesCount,
        projectsActive: projectsCount,
        commentsThisWeek: commentsCount,
        lastActiveAt: user.lastActiveAt,
        tasksDoneSparkline: sparkline,
      };

      return stats;
    }),
});
