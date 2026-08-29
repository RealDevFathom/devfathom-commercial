/**
 * Reading and mutating materialised occurrences — WHA-235 (Lane 1).
 *
 * This module is what replaces the recurrence-string walkers in
 * `@/lib/meeting-occurrence` on every production read path. The difference is
 * not a refactor, it is a change of source of truth:
 *
 *   - the walkers RECOMPUTED the series from `Meeting.recurrence` on every
 *     call, in the SERVER's timezone, and therefore could not see a
 *     reschedule, a cancellation, or a one-off retitle at all — those live on
 *     the occurrence row and there was no occurrence row being read;
 *   - these functions READ the materialised row, so an exception recorded
 *     against an instance is what every surface reports.
 *
 * SELF-HEALING READS. Every resolver here materialises first. A series created
 * before this lane shipped has no occurrence rows, and a read that returned
 * "no occurrence" for it would be a regression against the walkers it replaces.
 * Materialising on read costs one bounded reconcile and makes the table
 * authoritative for rows nobody has written since MEET-01.
 */
import type { Prisma, PrismaClient } from '@/generated/prisma/client';

import {
  materializeMeetingOccurrences,
  joinWindowFor,
  MEETING_MATERIALISATION_WINDOW_DAYS,
  type MaterialiserDb,
} from './materialize';
import { parseRecurrenceRule, relevantSlot, slotsInRange } from './recurrence';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The occurrence shape every read path here returns.
 *
 * `start`/`end` are the SCHEDULED times — the times the meeting is actually
 * held at, exceptions included — not `seriesSlotStart`. Callers that need the
 * immutable series identity read `seriesSlotStart` explicitly.
 */
export type ResolvedOccurrence = {
  id: string;
  publicId: string;
  seriesSlotStart: Date;
  start: Date;
  end: Date;
  status: string;
  titleOverride: string | null;
  cancelledAt: Date | null;
};

const OCCURRENCE_SELECT = {
  id: true,
  publicId: true,
  seriesSlotStart: true,
  scheduledStart: true,
  scheduledEnd: true,
  status: true,
  titleOverride: true,
  cancelledAt: true,
} satisfies Prisma.MeetingOccurrenceSelect;

type OccurrenceRow = {
  id: string;
  publicId: string;
  seriesSlotStart: Date;
  scheduledStart: Date;
  scheduledEnd: Date;
  status: string;
  titleOverride: string | null;
  cancelledAt: Date | null;
};

function toResolved(row: OccurrenceRow): ResolvedOccurrence {
  return {
    id: row.id,
    publicId: row.publicId,
    seriesSlotStart: row.seriesSlotStart,
    start: row.scheduledStart,
    end: row.scheduledEnd,
    status: row.status,
    titleOverride: row.titleOverride,
    cancelledAt: row.cancelledAt,
  };
}

/** A tenant-scoped Prisma client, which is the only kind these helpers accept. */
type Db = PrismaClient;

/**
 * The occurrence a user clicking "join" right now means.
 *
 * Preserves the semantics the walker documented as RT-10, because the Meetings
 * list depends on them: while an occurrence is LIVE return it, and in the gap
 * between two occurrences keep returning the most recent PAST one until the
 * next actually begins. Jumping to the next (empty) occurrence halfway through
 * the gap makes the just-finished occurrence's attendance disappear early.
 *
 * CANCELLED occurrences are skipped: a cancelled instance is not the one
 * somebody is joining.
 *
 * Returns `null` only when a meeting genuinely has no occurrence — which after
 * the materialise above means a meeting whose entire series is in the past
 * beyond the retained rows, or one in another tenant.
 */
export async function resolveRelevantOccurrence(
  db: Db,
  meetingId: string,
  now: Date = new Date()
): Promise<ResolvedOccurrence | null> {
  await materializeMeetingOccurrences(db as unknown as MaterialiserDb, meetingId, { now });

  // Live right now: started, not yet ended.
  const live = (await db.meetingOccurrence.findFirst({
    where: {
      meetingId,
      status: { not: 'CANCELLED' },
      scheduledStart: { lte: now },
      scheduledEnd: { gt: now },
    },
    select: OCCURRENCE_SELECT,
    orderBy: [{ scheduledStart: 'desc' }, { id: 'desc' }],
  })) as OccurrenceRow | null;
  if (live) return toResolved(live);

  // Otherwise the most recent one that has already started (RT-10's "keep
  // showing the finished occurrence through the gap").
  const previous = (await db.meetingOccurrence.findFirst({
    where: { meetingId, status: { not: 'CANCELLED' }, scheduledStart: { lte: now } },
    select: OCCURRENCE_SELECT,
    orderBy: [{ scheduledStart: 'desc' }, { id: 'desc' }],
  })) as OccurrenceRow | null;
  if (previous) return toResolved(previous);

  // Nothing has started yet — the series is entirely ahead of us, so the
  // relevant occurrence is its first.
  const next = (await db.meetingOccurrence.findFirst({
    where: { meetingId, status: { not: 'CANCELLED' } },
    select: OCCURRENCE_SELECT,
    orderBy: [{ scheduledStart: 'asc' }, { id: 'asc' }],
  })) as OccurrenceRow | null;
  return next ? toResolved(next) : null;
}

/**
 * The same resolution for many meetings at once, as one query per phase rather
 * than per meeting.
 *
 * The list surfaces resolve an occurrence for every row on the page, and doing
 * that one meeting at a time is the N+1 the batched
 * `attachPerOccurrenceJoinedAt` helper already exists to avoid.
 *
 * DELIBERATELY DOES NOT MATERIALISE. Materialising a whole page would turn one
 * list render into up to `limit` reconcile passes with their writes. List rows
 * fall back to the meeting's own stored times when no occurrence row exists,
 * which is exactly what those rows displayed before this lane; the detail and
 * join paths, which are the ones that must be exact, do materialise.
 *
 * BOUNDED AT TWO ROWS PER MEETING, not "every occurrence of every meeting on
 * the page". The naive form of this query — every non-cancelled occurrence for
 * up to 200 series — is thousands of rows on a list render, which is the shape
 * of the unbounded query #38 exists to have removed. Both queries below are
 * `distinct` on `meetingId` (DISTINCT ON in PostgreSQL, which is why
 * `meetingId` leads the ORDER BY) and capped by `take`, so the row count is at
 * most twice the page size regardless of how long the series are.
 */
export async function resolveOccurrencesForMeetings(
  db: Db,
  meetingIds: string[],
  now: Date = new Date()
): Promise<Map<string, ResolvedOccurrence>> {
  const resolved = new Map<string, ResolvedOccurrence>();
  if (meetingIds.length === 0) return resolved;

  const [started, upcoming] = await Promise.all([
    // The latest occurrence that has already begun. This covers both the LIVE
    // case and RT-10's "keep showing the finished occurrence through the gap",
    // because the live occurrence is the latest started one whenever there is
    // one. (Two occurrences of one series can only overlap if a reschedule put
    // them there by hand; the materialiser produces strictly increasing slots
    // of uniform length. In that hand-made case this prefers the later start,
    // where `resolveRelevantOccurrence` prefers the live one — a divergence
    // confined to a list row's displayed time.)
    db.meetingOccurrence.findMany({
      where: {
        meetingId: { in: meetingIds },
        status: { not: 'CANCELLED' },
        scheduledStart: { lte: now },
      },
      select: { ...OCCURRENCE_SELECT, meetingId: true },
      distinct: ['meetingId'],
      orderBy: [{ meetingId: 'asc' }, { scheduledStart: 'desc' }, { id: 'desc' }],
      take: meetingIds.length,
    }),
    // The earliest occurrence still ahead of us, used only for a series that
    // has not started at all.
    db.meetingOccurrence.findMany({
      where: {
        meetingId: { in: meetingIds },
        status: { not: 'CANCELLED' },
        scheduledStart: { gt: now },
      },
      select: { ...OCCURRENCE_SELECT, meetingId: true },
      distinct: ['meetingId'],
      orderBy: [{ meetingId: 'asc' }, { scheduledStart: 'asc' }, { id: 'asc' }],
      take: meetingIds.length,
    }),
  ]);

  // `upcoming` first, then `started` overwrites it — an occurrence that has
  // begun always wins over one that has not.
  for (const row of upcoming as Array<OccurrenceRow & { meetingId: string }>) {
    resolved.set(row.meetingId, toResolved(row));
  }
  for (const row of started as Array<OccurrenceRow & { meetingId: string }>) {
    resolved.set(row.meetingId, toResolved(row));
  }

  return resolved;
}

/**
 * The series fields the display resolvers need off a `Meeting` row.
 *
 * `recurrenceRule` and `timezone`, NOT the deprecated `recurrence` column: the
 * rule is what the materialiser expands and what the migration backfilled, so
 * consulting it here keeps the display path and the stored path expanding the
 * same series.
 */
export type SeriesRow = {
  id: string;
  startTime: Date;
  endTime: Date;
  timezone: string;
  recurrenceRule: string | null;
};

export type DisplayTimes = { start: Date; end: Date; occurrence: ResolvedOccurrence | null };

/** Parse a stored rule, treating an unexpandable one as a one-time meeting. */
function safeRule(recurrenceRule: string | null) {
  if (!recurrenceRule) return null;
  try {
    return parseRecurrenceRule(recurrenceRule);
  } catch {
    // A rule this expander does not implement must not take a list page down.
    // Degrading to the meeting's own stored times shows the series' original
    // occurrence, which is what the row displayed before occurrences existed.
    return null;
  }
}

/**
 * Resolve the occurrence to DISPLAY for each meeting on a page.
 *
 * Two sources, in priority order, and the order is the point:
 *
 *  1. a materialised `MeetingOccurrence` row, so a reschedule, a cancellation
 *     or a retitle recorded against an instance is what the list shows;
 *  2. failing that, the slot computed from `recurrenceRule` in the series'
 *     own timezone.
 *
 * The fallback is what makes this safe to deploy ahead of a full backfill: a
 * series with no materialised rows yet still displays a correct occurrence
 * rather than vanishing, and it does so WITHOUT writing — see the note on
 * `resolveOccurrencesForMeetings` about not turning a page render into a
 * write storm.
 */
export async function resolveDisplayTimes(
  db: Db,
  meetings: SeriesRow[],
  now: Date = new Date()
): Promise<Map<string, DisplayTimes>> {
  const resolved = await resolveOccurrencesForMeetings(
    db,
    meetings.map((meeting) => meeting.id),
    now
  );

  const out = new Map<string, DisplayTimes>();
  for (const meeting of meetings) {
    const occurrence = resolved.get(meeting.id);
    if (occurrence) {
      out.set(meeting.id, { start: occurrence.start, end: occurrence.end, occurrence });
      continue;
    }

    const durationMs = Math.max(0, meeting.endTime.getTime() - meeting.startTime.getTime());
    const slot = relevantSlot({
      anchor: meeting.startTime,
      timeZone: meeting.timezone || 'UTC',
      rule: safeRule(meeting.recurrenceRule),
      now,
    });
    const start = slot ?? meeting.startTime;
    out.set(meeting.id, {
      start,
      end: new Date(start.getTime() + durationMs),
      occurrence: null,
    });
  }
  return out;
}

/**
 * The NEXT occurrence of each series — the first whose END is still ahead of
 * `now`, so a currently-running occurrence counts as "next" rather than being
 * skipped past.
 *
 * Feeds the Upcoming surfaces. Same two-source priority as
 * `resolveDisplayTimes`, and `null` for a series that has no occurrence left.
 */
export async function resolveNextTimes(
  db: Db,
  meetings: SeriesRow[],
  now: Date = new Date()
): Promise<Map<string, { start: Date; end: Date }>> {
  const out = new Map<string, { start: Date; end: Date }>();
  if (meetings.length === 0) return out;

  // BOUNDED, because this feeds the dashboard. Without the bounds below, 200
  // daily series would return ~6000 rows here on every load, when what is
  // wanted is at most one row per series.
  //
  //  - `distinct` collapses the result to one row per meeting. On PostgreSQL
  //    Prisma pushes this down to DISTINCT ON, whose required leading ORDER BY
  //    is why `meetingId` sorts first; if it ever fell back to deduplicating
  //    after the fetch the ANSWER would still be identical, only slower.
  //  - the horizon caps how far ahead a row may sit. Nothing beyond the
  //    materialisation window exists to be found, so this discards no row the
  //    query could otherwise have returned — a series whose next occurrence is
  //    past the horizon falls through to the rule fallback below, which is
  //    where it would have landed anyway.
  const horizon = new Date(now.getTime() + MEETING_MATERIALISATION_WINDOW_DAYS * DAY_MS);
  const rows = (await db.meetingOccurrence.findMany({
    where: {
      meetingId: { in: meetings.map((meeting) => meeting.id) },
      status: { not: 'CANCELLED' },
      scheduledEnd: { gt: now },
      scheduledStart: { lte: horizon },
    },
    select: { meetingId: true, scheduledStart: true, scheduledEnd: true },
    distinct: ['meetingId'],
    orderBy: [{ meetingId: 'asc' }, { scheduledStart: 'asc' }, { id: 'asc' }],
    take: meetings.length,
  })) as Array<{ meetingId: string; scheduledStart: Date; scheduledEnd: Date }>;

  // One row per meeting after `distinct`, and it is the earliest — but the
  // guard stays, so a fallback to post-fetch deduplication still yields the
  // first (earliest) row rather than the last.
  for (const row of rows) {
    if (out.has(row.meetingId)) continue;
    out.set(row.meetingId, { start: row.scheduledStart, end: row.scheduledEnd });
  }

  for (const meeting of meetings) {
    if (out.has(meeting.id)) continue;

    const durationMs = Math.max(0, meeting.endTime.getTime() - meeting.startTime.getTime());
    const rule = safeRule(meeting.recurrenceRule);
    if (!rule) {
      // One-time meeting: its own slot is "next" only while it has not ended.
      if (meeting.endTime.getTime() > now.getTime()) {
        out.set(meeting.id, { start: meeting.startTime, end: meeting.endTime });
      }
      continue;
    }

    // Start the search one duration back from `now` so an occurrence that is
    // currently RUNNING is found rather than stepped over.
    const slots = slotsInRange({
      anchor: meeting.startTime,
      timeZone: meeting.timezone || 'UTC',
      rule,
      from: new Date(now.getTime() - durationMs),
      // A bounded look-ahead: every supported cadence recurs at least monthly,
      // so a series with any occurrence left has one inside ~13 months.
      until: new Date(now.getTime() + 400 * 24 * 60 * 60 * 1000),
      limit: 1,
    });
    const start = slots[0];
    if (start) out.set(meeting.id, { start, end: new Date(start.getTime() + durationMs) });
  }

  return out;
}

/**
 * Move ONE occurrence without touching the series.
 *
 * `seriesSlotStart` is untouched by construction — it is the instance's
 * identity and the key the materialiser reconciles against. Moving it would
 * make the materialiser re-create the original slot on its next pass and leave
 * the series with two rows for one instance.
 */
export async function rescheduleOccurrence(
  db: Db,
  occurrenceId: string,
  input: { scheduledStart: Date; scheduledEnd: Date }
): Promise<ResolvedOccurrence> {
  const row = (await db.meetingOccurrence.update({
    where: { id: occurrenceId },
    data: {
      scheduledStart: input.scheduledStart,
      scheduledEnd: input.scheduledEnd,
      // The join window follows the times it is derived from. Leaving it at the
      // old slot's window would make a rescheduled occurrence unjoinable at the
      // time it is now held.
      ...joinWindowFor(input.scheduledStart, input.scheduledEnd),
    },
    select: OCCURRENCE_SELECT,
  })) as OccurrenceRow;
  return toResolved(row);
}

/**
 * Withdraw ONE occurrence. Never deletes: the row stays as the record that this
 * instance existed and was called off, and any evidence already hanging off it
 * stays reachable.
 */
export async function cancelOccurrence(
  db: Db,
  occurrenceId: string,
  input: { cancelledById: string; reason?: string | null; now?: Date }
): Promise<ResolvedOccurrence> {
  const row = (await db.meetingOccurrence.update({
    where: { id: occurrenceId },
    data: {
      status: 'CANCELLED',
      // The `meeting_occurrences_cancellation_check` CHECK requires this
      // alongside the status, so the two can never disagree.
      cancelledAt: input.now ?? new Date(),
      cancelledById: input.cancelledById,
      cancellationReason: input.reason ?? null,
    },
    select: OCCURRENCE_SELECT,
  })) as OccurrenceRow;
  return toResolved(row);
}

/**
 * The path a guest is sent to. `publicId` ONLY.
 *
 * Nothing secret is ever appended here, and the function returns a PATH rather
 * than accepting a query object so there is no parameter for a caller to hang a
 * credential off. See `./guest-access` for why a URL is not a place a live
 * meeting credential may sit.
 */
export function occurrenceJoinPath(publicId: string): string {
  return `/join/${encodeURIComponent(publicId)}`;
}

/** The absolute form, for emails. Same guarantee: locator only. */
export function occurrenceJoinUrl(publicId: string, appBaseUrl: string): string {
  return `${appBaseUrl.replace(/\/+$/, '')}${occurrenceJoinPath(publicId)}`;
}
