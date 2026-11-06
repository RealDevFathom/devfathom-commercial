/**
 * MEETINGS / schedule tools for the DevFathom assistant.
 *
 * Mirrors `src/server/routers/meetings.ts` (the source of truth) for input
 * validation, authorization and side effects, but speaks the assistant's
 * dialect: fuzzy resolution of a meeting by title (the model never invents an
 * id), `{ error }` / `{ needsClarification }` returns instead of throws, and
 * `needsApproval: true` on every write so the SDK pauses for the user.
 *
 * Authorization is the same keystone the rest of the app uses (`@/lib/authz`):
 *   - canAccessMeeting → creator / attendee / admin  (view + join)
 *   - canManageMeeting → creator / admin             (edit + delete)
 * so the assistant can never exceed the acting user's real permissions, even
 * under prompt injection.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { Prisma } from '@/generated/prisma/client';
import * as authz from '@/lib/authz';
import { appUrl, templates } from '@/lib/email';
import { computePunctuality } from '@/lib/meeting-occurrence';
import { legacyRecurrenceToRule } from '@/lib/meetings/recurrence';
import { materializeMeetingOccurrences } from '@/lib/meetings/materialize';
import { resolveRelevantOccurrence } from '@/lib/meetings/occurrences';
import {
  INVALID_MEETING_TIME_MESSAGE,
  isMeetingTimeConstraintError,
  isValidMeetingTimeRange,
} from '@/lib/meetings/time-range';
import type { AssistantHelpers, ToolSet } from '@/lib/ai/context';

const DAY_MS = 86_400_000;

function parseDate(value: string): Date | null {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Display-ready "when" for an invite, e.g. "Mon, Jun 23, 3:00 PM". */
function formatWhen(d: Date): string {
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Human duration between two instants, e.g. "30 min" / "1h 30m". */
function formatDuration(start: Date, end: Date): string {
  const min = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  const rem = min % 60;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
}

export function buildMeetingsTools(h: AssistantHelpers): ToolSet {
  const { db } = h;
  // Visibility scope, mirroring the reads in `meetings.ts`: admins see every
  // meeting; everyone else only meetings they created or were invited to. This
  // is also the pool a meeting title is resolved against, so a non-admin can
  // never even name (let alone touch) a meeting they cannot see.
  const meetingScope = (): Prisma.MeetingWhereInput =>
    h.isAdmin
      ? {}
      : {
          OR: [{ createdById: h.ctx.userId }, { attendees: { some: { userId: h.ctx.userId } } }],
        };

  /** Resolve a free-text meeting title to one visible meeting, or candidates. */
  const resolveMeeting = async (title: string) => {
    const rows = await db.meeting.findMany({
      where: meetingScope(),
      select: { id: true, title: true },
    });
    return h.resolveNamed(
      title,
      rows.map((m) => ({ id: m.id, name: m.title }))
    );
  };

  const tools: ToolSet = {
    // ─────────────────────────────────── READS ──────────────────────────────
    listMeetings: tool({
      description:
        'List upcoming meetings (title, time, location, recurrence, attendees). Use for "my meetings", "what meetings do I have", "the schedule", "any meetings this week". Employees see meetings they created or are invited to; admins see all.',
      inputSchema: z.object({
        withinDays: z.number().int().nullish().describe('Only meetings starting within N days'),
      }),
      execute: async ({ withinDays }) => {
        const upperBound =
          withinDays != null ? new Date(h.now().getTime() + withinDays * DAY_MS) : undefined;
        // Combine the visibility scope, the "still upcoming OR recurring" window,
        // and the optional upper bound with AND so the non-admin scope is always
        // enforced (a flat object would let later OR keys clobber the scope).
        const where: Prisma.MeetingWhereInput = {
          AND: [
            meetingScope(),
            // WHA-235: `recurrenceRule`, not the deprecated `recurrence`. Both
            // describe the same series, but the rule is what the materialiser
            // and every occurrence path expand, so selecting on it keeps this
            // query and the occurrence table describing one set.
            { OR: [{ endTime: { gte: h.now() } }, { recurrenceRule: { not: null } }] },
            ...(upperBound ? [{ startTime: { lte: upperBound } }] : []),
          ],
        };
        const meetings = await db.meeting.findMany({
          where,
          take: 30,
          orderBy: { startTime: 'asc' },
          select: {
            title: true,
            startTime: true,
            endTime: true,
            location: true,
            // Display label only — the cadence word the tool description
            // promises the model. Nothing branches on it; the predicate above
            // selects on `recurrenceRule`.
            recurrence: true,
            attendees: { select: { user: { select: { name: true } } } },
          },
        });
        return meetings.map((m) => ({
          title: m.title,
          startTime: m.startTime,
          endTime: m.endTime,
          location: m.location,
          recurrence: m.recurrence,
          attendees: m.attendees.map((a) => a.user.name),
        }));
      },
    }),

    getMeeting: tool({
      description:
        'Full details of ONE meeting: time, location, recurrence, organizer, the attendee list and who has joined (attendance + punctuality for the current occurrence). Use for "details of <meeting>", "who is coming to <meeting>", "did everyone join the standup". Give the meeting title.',
      inputSchema: z.object({
        meeting: z.string().describe('The meeting title (fuzzy match), e.g. "Daily Standup"'),
      }),
      execute: async ({ meeting }) => {
        const r = await resolveMeeting(meeting);
        if (r.kind === 'notfound')
          return {
            error: `No meeting matches "${meeting}"${h.isAdmin ? '' : ' that you can see'}.`,
          };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which meeting — ${r.candidates.join(', ')}?` };
        const meetingId = r.value.id;

        // Object-level authz first — belt + braces over the scoped resolution.
        if (!(await authz.canAccessMeeting(db, h.ctx.userId, h.ctx.role, meetingId))) {
          return { error: 'You do not have access to that meeting.' };
        }

        const m = await db.meeting.findUnique({
          where: { id: meetingId },
          select: {
            title: true,
            description: true,
            startTime: true,
            endTime: true,
            location: true,
            // `recurrence` is carried ONLY as the human-readable cadence label
            // the tool description promises the model ("daily", "weekly", …).
            // No decision is taken from it — `recurrenceRule` below is what the
            // branch reads.
            recurrence: true,
            recurrenceRule: true,
            createdById: true,
            attendees: {
              select: { userId: true, user: { select: { name: true, title: true } } },
            },
          },
        });
        if (!m) return { error: 'That meeting was not found.' };

        // Meeting has no `createdBy` relation (only the scalar id) — look it up.
        const organizer = await db.user.findUnique({
          where: { id: m.createdById },
          select: { name: true },
        });

        // Per-occurrence attendance for the occurrence the meeting is "at" now,
        // read from the materialised occurrence rows (WHA-235) so a rescheduled
        // or cancelled instance is reported as it actually stands. Falls back to
        // the meeting's own times for a series with no occurrence row.
        const resolved = await resolveRelevantOccurrence(db, meetingId, h.now());
        const occurrence = resolved
          ? { start: resolved.start, end: resolved.end }
          : { start: m.startTime, end: m.endTime };
        const logs = await db.meetingAttendanceLog.findMany({
          where: { meetingId, occurrenceStart: occurrence.start },
          select: { userId: true, joinedAt: true },
        });
        const joinedMap = new Map(logs.map((l) => [l.userId, l.joinedAt]));

        return {
          title: m.title,
          description: m.description,
          startTime: m.startTime,
          endTime: m.endTime,
          location: m.location,
          recurrence: m.recurrence,
          organizer: organizer?.name ?? null,
          // The specific instance attendance is measured against (recurring only).
          occurrence: m.recurrenceRule ? occurrence : undefined,
          attendees: m.attendees.map((a) => {
            const joinedAt = joinedMap.get(a.userId) ?? null;
            const punctuality = computePunctuality(
              { startTime: occurrence.start, recurrence: null },
              joinedAt
            );
            return {
              name: a.user.name,
              title: a.user.title,
              joined: !!joinedAt,
              joinedAt,
              punctuality: punctuality?.label ?? null,
            };
          }),
          scopeNote: r.interpreted ? `Interpreted "${meeting}" as ${r.value.name}.` : undefined,
        };
      },
    }),

    // ────────────────────────────────── WRITES ──────────────────────────────
    createMeeting: tool({
      description:
        'Schedule a NEW meeting and invite people. Give a title, ISO start and end datetimes, optionally a location and a recurrence, plus the attendees by name (you are added automatically). Each invitee gets a meeting invite (in-app + email). Use for "set up a meeting with <names>", "schedule a standup", "book a call".',
      inputSchema: z.object({
        title: z.string().min(1).describe('Meeting title'),
        startTime: z.string().describe('ISO datetime the meeting starts'),
        endTime: z.string().describe('ISO datetime the meeting ends'),
        description: z.string().nullish().describe('Agenda / notes'),
        location: z.string().nullish().describe('"Google Meet", an office, or a join URL'),
        recurrence: z
          .enum(['daily', 'weekly', 'biweekly', 'monthly'])
          .nullish()
          .describe('Leave unset for a one-time meeting'),
        attendees: z
          .array(z.string())
          .nullish()
          .describe('Names of people to invite (besides you)'),
      }),
      needsApproval: true,
      execute: async ({
        title,
        startTime,
        endTime,
        description,
        location,
        recurrence,
        attendees,
      }) => {
        // Stale-session guard, mirroring the router: a JWT pointing at a deleted
        // user would otherwise blow up on the FK instead of a useful message.
        const user = await db.user.findUnique({
          where: { id: h.ctx.userId },
          select: { id: true },
        });
        if (!user) {
          return {
            error: 'Your session has expired. Please log out and back in to create meetings.',
          };
        }

        const start = parseDate(startTime);
        if (!start)
          return { error: `Could not read the start time "${startTime}". Use an ISO datetime.` };
        const end = parseDate(endTime);
        if (!end)
          return { error: `Could not read the end time "${endTime}". Use an ISO datetime.` };
        if (!isValidMeetingTimeRange(start, end)) {
          return { error: 'The end time must be after the start time.' };
        }

        // Resolve every attendee name up front so we can ask for clarification
        // before creating anything.
        const resolvedIds: string[] = [];
        const resolvedNames: string[] = [];
        for (const name of attendees ?? []) {
          const pr = await h.resolvePerson(name);
          if (pr.kind === 'notfound') return { error: `No team member matches "${name}".` };
          if (pr.kind === 'ambiguous')
            return { needsClarification: `Which one — ${pr.candidates.join(', ')}?` };
          resolvedIds.push(pr.value.id);
          resolvedNames.push(pr.value.name);
        }

        const allAttendees = [...new Set([user.id, ...resolvedIds])];
        const meeting = await db.meeting.create({
          data: {
            title,
            description: description ?? null,
            startTime: start,
            endTime: end,
            location: location ?? null,
            recurrence: recurrence ?? null,
            // WHA-235: written together with the legacy value, exactly as
            // `meetings.create` does — the assistant must not produce series the
            // materialiser cannot see.
            recurrenceRule: legacyRecurrenceToRule(recurrence ?? null),
            createdById: user.id,
            attendees: { create: allAttendees.map((userId) => ({ userId })) },
          },
        });

        // Materialise so the new series has occurrence rows (and therefore a
        // join link) before the invite emails below go out.
        await materializeMeetingOccurrences(db, meeting.id);

        // Side effects: invite + notify everyone except the organizer (in-app +
        // a branded meetingInvite email, fire-and-forget).
        const inviteeIds = allAttendees.filter((id) => id !== user.id);
        const whenLabel = formatWhen(start);
        if (inviteeIds.length > 0) {
          h.notifyUsers(inviteeIds, {
            type: 'meeting_invite',
            title: `Meeting invite: ${title}`,
            message: `${h.ctx.name ?? 'A teammate'} invited you to "${title}" — ${whenLabel}.`,
            entityType: 'Meeting',
            entityId: meeting.id,
            email: (recipient) =>
              templates.meetingInvite({
                recipientName: recipient.name,
                title,
                organizerName: h.ctx.name ?? 'A teammate',
                whenLabel,
                durationLabel: formatDuration(start, end),
                location: location ?? undefined,
                agenda: description ?? undefined,
                url: `${appUrl()}/meetings`,
              }),
          });
        }

        h.audit({
          category: 'MEETING',
          action: 'meeting.create',
          operation: 'CREATE',
          description: `Created meeting "${title}"`,
          targetType: 'Meeting',
          targetId: meeting.id,
          targetLabel: title,
          metadata: { whenLabel, recurrence: recurrence ?? null, attendees: resolvedNames },
        });

        return {
          created: true,
          title,
          startTime: start,
          endTime: end,
          location: location ?? null,
          recurrence: recurrence ?? null,
          attendees: resolvedNames,
          invited: inviteeIds.length,
        };
      },
    }),

    updateMeeting: tool({
      description:
        'Update an existing meeting — change its title, times, location, recurrence, or replace the attendee list. Find the meeting by its current title. Only the meeting\'s creator or an admin may edit it. Use for "move <meeting> to 3pm", "rename <meeting>", "swap the attendees on <meeting>".',
      inputSchema: z.object({
        meeting: z.string().describe('The current title of the meeting to update'),
        title: z.string().min(1).nullish().describe('New title'),
        startTime: z.string().nullish().describe('New ISO start datetime'),
        endTime: z.string().nullish().describe('New ISO end datetime'),
        description: z.string().nullish().describe('New agenda / notes'),
        location: z.string().nullish().describe('New location or join URL'),
        recurrence: z.enum(['daily', 'weekly', 'biweekly', 'monthly']).nullish(),
        attendees: z
          .array(z.string())
          .nullish()
          .describe('Replace the whole attendee list with these people (by name)'),
      }),
      needsApproval: true,
      execute: async ({
        meeting,
        title,
        startTime,
        endTime,
        description,
        location,
        recurrence,
        attendees,
      }) => {
        const r = await resolveMeeting(meeting);
        if (r.kind === 'notfound')
          return {
            error: `No meeting matches "${meeting}"${h.isAdmin ? '' : ' that you can see'}.`,
          };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which meeting — ${r.candidates.join(', ')}?` };
        const meetingId = r.value.id;

        if (!(await authz.canManageMeeting(db, h.ctx.userId, h.ctx.role, meetingId))) {
          return { error: 'You can only edit meetings you created (admins can edit any meeting).' };
        }

        const start = startTime == null ? null : parseDate(startTime);
        if (startTime != null && !start) {
          return { error: `Could not read the start time "${startTime}". Use an ISO datetime.` };
        }
        const end = endTime == null ? null : parseDate(endTime);
        if (endTime != null && !end) {
          return { error: `Could not read the end time "${endTime}". Use an ISO datetime.` };
        }
        if (start || end) {
          const current = await db.meeting.findFirst({
            where: { id: meetingId, organizationId: h.ctx.organizationId },
            select: { startTime: true, endTime: true },
          });
          if (!current) return { error: 'Meeting not found.' };
          if (!isValidMeetingTimeRange(start ?? current.startTime, end ?? current.endTime)) {
            return { error: INVALID_MEETING_TIME_MESSAGE };
          }
        }

        const data: Prisma.MeetingUpdateInput = {};
        if (title != null) data.title = title;
        if (description != null) data.description = description;
        if (location != null) data.location = location;
        if (recurrence != null) {
          data.recurrence = recurrence;
          // Keep the pair in step, as `meetings.update` does.
          data.recurrenceRule = legacyRecurrenceToRule(recurrence);
        }
        if (start) data.startTime = start;
        if (end) data.endTime = end;

        // Replace the attendee list when provided (mirrors the router: the
        // acting user is always kept on the list).
        let attendeeNames: string[] | undefined;
        if (attendees != null) {
          const ids: string[] = [];
          const names: string[] = [];
          for (const name of attendees) {
            const pr = await h.resolvePerson(name);
            if (pr.kind === 'notfound') return { error: `No team member matches "${name}".` };
            if (pr.kind === 'ambiguous')
              return { needsClarification: `Which one — ${pr.candidates.join(', ')}?` };
            ids.push(pr.value.id);
            names.push(pr.value.name);
          }
          const allAttendees = [...new Set([h.ctx.userId, ...ids])];
          // Prisma makes the attendee replacement and time edit atomic, even
          // when the assistant uses a per-operation tenant DB facade.
          data.attendees = {
            deleteMany: {},
            create: allAttendees.map((userId) => ({ userId })),
          };
          attendeeNames = names;
        }

        const updated = await db.meeting
          .update({
            where: { id: meetingId },
            data,
            select: {
              title: true,
              startTime: true,
              endTime: true,
              location: true,
              recurrence: true,
            },
          })
          .catch((error: unknown) => {
            if (isMeetingTimeConstraintError(error)) return null;
            throw error;
          });
        if (!updated) return { error: INVALID_MEETING_TIME_MESSAGE };

        // Reconcile after the edit, as `meetings.update` does: add the slots the
        // new rule produces, cancel the FUTURE ones that left it, touch nothing
        // already in the past.
        await materializeMeetingOccurrences(db, meetingId);

        h.audit({
          category: 'MEETING',
          action: 'meeting.update',
          operation: 'UPDATE',
          description: `Updated meeting "${updated.title}"`,
          targetType: 'Meeting',
          targetId: meetingId,
          targetLabel: updated.title,
          metadata: {
            updatedFields: Object.keys(data),
            ...(attendeeNames ? { attendees: attendeeNames } : {}),
          },
        });

        return {
          updated: true,
          title: updated.title,
          startTime: updated.startTime,
          endTime: updated.endTime,
          location: updated.location,
          recurrence: updated.recurrence,
          attendees: attendeeNames,
        };
      },
    }),

    deleteMeeting: tool({
      description:
        'Cancel / delete a meeting. Find it by title. Only the meeting\'s creator or an admin may delete it. Use for "cancel <meeting>", "delete the <meeting>".',
      inputSchema: z.object({
        meeting: z.string().describe('The title of the meeting to cancel'),
      }),
      needsApproval: true,
      execute: async ({ meeting }) => {
        const r = await resolveMeeting(meeting);
        if (r.kind === 'notfound')
          return {
            error: `No meeting matches "${meeting}"${h.isAdmin ? '' : ' that you can see'}.`,
          };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which meeting — ${r.candidates.join(', ')}?` };
        const meetingId = r.value.id;

        if (!(await authz.canManageMeeting(db, h.ctx.userId, h.ctx.role, meetingId))) {
          return {
            error: 'You can only delete meetings you created (admins can delete any meeting).',
          };
        }

        const existing = await db.meeting.findUnique({
          where: { id: meetingId },
          select: { title: true },
        });
        await db.meeting.delete({ where: { id: meetingId } });

        const label = existing?.title ?? r.value.name;
        h.audit({
          category: 'MEETING',
          action: 'meeting.delete',
          operation: 'DELETE',
          description: `Deleted meeting "${label}"`,
          targetType: 'Meeting',
          targetId: meetingId,
          targetLabel: label,
        });

        return { deleted: true, title: label };
      },
    }),

    markJoined: tool({
      description:
        'Mark YOURSELF as having joined a meeting you are an attendee of — records attendance + punctuality for the current occurrence. Attendance only counts from 5 minutes before the start until it ends. Use for "I joined the standup", "mark me as attended <meeting>".',
      inputSchema: z.object({
        meeting: z.string().describe('The title of the meeting you are joining'),
      }),
      needsApproval: true,
      execute: async ({ meeting }) => {
        const r = await resolveMeeting(meeting);
        if (r.kind === 'notfound')
          return {
            error: `No meeting matches "${meeting}"${h.isAdmin ? '' : ' that you can see'}.`,
          };
        if (r.kind === 'ambiguous')
          return { needsClarification: `Which meeting — ${r.candidates.join(', ')}?` };
        const meetingId = r.value.id;

        if (!(await authz.canAccessMeeting(db, h.ctx.userId, h.ctx.role, meetingId))) {
          return { error: 'You do not have access to that meeting.' };
        }

        // Attendance is recorded per attendee — you must be on the list.
        const attendee = await db.meetingAttendee.findUnique({
          where: { meetingId_userId: { meetingId, userId: h.ctx.userId } },
          include: {
            meeting: { select: { id: true, title: true, startTime: true, endTime: true } },
          },
        });
        if (!attendee) return { error: 'You are not on the attendee list for this meeting.' };

        const now = h.now();
        // Same occurrence resolution the router's `markJoined` uses, so the
        // assistant and the UI write attendance under the same key.
        const resolvedOccurrence = await resolveRelevantOccurrence(db, meetingId, now);
        const occurrence = resolvedOccurrence
          ? { start: resolvedOccurrence.start, end: resolvedOccurrence.end }
          : { start: attendee.meeting.startTime, end: attendee.meeting.endTime };

        // Attendance window: only [start - 5min, end] counts, so attendance for
        // past or not-yet-started occurrences can't be back-filled.
        const windowStart = new Date(occurrence.start.getTime() - 5 * 60_000);
        const windowEnd = occurrence.end;
        if (now < windowStart) {
          return {
            skipped: 'too_early',
            message: `"${attendee.meeting.title}" hasn't started yet — you can mark attendance from 5 minutes before it begins.`,
            occurrence,
          };
        }
        if (now > windowEnd) {
          return {
            skipped: 'too_late',
            message: `"${attendee.meeting.title}" has already ended, so attendance can no longer be recorded.`,
            occurrence,
          };
        }

        // Idempotent per occurrence.
        const existing = await db.meetingAttendanceLog.findUnique({
          where: {
            meetingId_userId_occurrenceStart: {
              meetingId,
              userId: h.ctx.userId,
              occurrenceStart: occurrence.start,
            },
          },
        });
        if (existing) {
          return {
            alreadyJoined: true,
            meeting: attendee.meeting.title,
            joinedAt: existing.joinedAt,
            occurrence,
          };
        }

        const created = await db.meetingAttendanceLog.create({
          data: {
            meetingId,
            userId: h.ctx.userId,
            occurrenceStart: occurrence.start,
            joinedAt: now,
          },
        });
        // Keep the deprecated MeetingAttendee.joinedAt roughly in sync.
        await db.meetingAttendee.update({
          where: { meetingId_userId: { meetingId, userId: h.ctx.userId } },
          data: { joinedAt: now },
        });

        const punctuality = computePunctuality(
          { startTime: occurrence.start, recurrence: null },
          now
        );

        h.activity({
          type: 'meeting_joined',
          message: `joined meeting "${attendee.meeting.title}" (${punctuality?.label ?? 'on time'})`,
          entityType: 'Meeting',
          entityId: meetingId,
        });
        h.audit({
          category: 'MEETING',
          action: 'meeting.markJoined',
          operation: 'EXECUTE',
          description: `Marked attendance for "${attendee.meeting.title}"`,
          targetType: 'Meeting',
          targetId: meetingId,
          targetLabel: attendee.meeting.title,
          metadata: { punctuality: punctuality?.label ?? 'on time' },
        });

        return {
          joined: true,
          alreadyJoined: false,
          meeting: attendee.meeting.title,
          joinedAt: created.joinedAt,
          punctuality: punctuality?.label ?? 'on time',
          occurrence,
        };
      },
    }),
  };

  return tools;
}
