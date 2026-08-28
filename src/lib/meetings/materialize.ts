/**
 * Bounded, additive occurrence materialisation — WHA-235 (Lane 1).
 *
 * This is the writer the `MeetingOccurrence` model doc has been waiting for,
 * and the one `src/server/routers/meetings.ts` names in its `ponytail:` note:
 * until now `meeting_occurrences` had a one-shot backfill in the migration and
 * nothing in `src/` that kept it current, so every series created after MEET-01
 * had zero occurrence rows and no read path could safely consult the table.
 *
 * THREE INVARIANTS, taken directly from the model documentation. They are the
 * reason this is a reconciler and not a regenerator:
 *
 *  1. BOUNDED. Slots are only ever walked to `now + MEETING_MATERIALISATION_WINDOW_DAYS`.
 *     An infinite `FREQ=DAILY` therefore produces a rolling ~30 rows, not an
 *     unbounded table, and `Meeting.materializedThrough` records how far the
 *     walk got so the next call resumes instead of restarting.
 *  2. ADDITIVE. Rows are INSERTed and never DELETEd. This table is not "the set
 *     the current rule generates" — it is that set UNION every instant that
 *     already has evidence hanging off it. The MEET-01 backfill produced 215
 *     occurrences from 210 meetings precisely because five attendance rows
 *     named instants no rule generates. Changing a recurrence rule does not
 *     un-happen the meetings already held.
 *  3. FUTURE-ONLY WITHDRAWAL. A slot that leaves the rule is CANCELLED, and
 *     only when it is still in the future. A past occurrence that no longer
 *     matches the current rule is history, not drift.
 */
import type { Prisma } from '@/generated/prisma/client';

import { expandOccurrences, parseRecurrenceRule } from './recurrence';

/**
 * The rolling horizon, in days. Named in the `MeetingOccurrence` model doc as
 * "now() + MEETING_MATERIALISATION_WINDOW (30 days)" and kept in application
 * code, not the schema, exactly as that doc specifies: the schema enforces the
 * SHAPE (one row per series slot), the materialiser owns the HORIZON.
 */
export const MEETING_MATERIALISATION_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * Ceiling on slots produced in ONE call. A 30-day horizon over the coarsest
 * supported cadence needs 30 rows; this leaves an order of magnitude of head
 * room while still refusing to expand a pathological rule without limit.
 */
const MAX_SLOTS_PER_RUN = 400;

/**
 * PROVISIONAL — pending the `link TTL` owner decision (see WHA-254 evidence).
 *
 * The join window has to be data, because `MeetingOccurrence.joinOpensAt` /
 * `joinClosesAt` are NOT NULL and the join path is specified to enforce them.
 * These are NOT an invented product policy: the lead is the SAME 5 minutes the
 * shipped anti-backfill attendance window already uses in `meetings.markJoined`
 * / `logJoin` (RT-01), and the lag mirrors it on the other side so a call that
 * runs a little long is still joinable. They are declared here, once, so the
 * owner's answer is a one-line change and every occurrence written before that
 * answer can be re-derived from a single place.
 */
export const PROVISIONAL_JOIN_WINDOW = {
  /** How long before `scheduledStart` the room opens. */
  leadMs: 5 * MINUTE_MS,
  /** How long after `scheduledEnd` the room stays joinable. */
  lagMs: 5 * MINUTE_MS,
} as const;

/** Derive an occurrence's join window from its scheduled times. */
export function joinWindowFor(scheduledStart: Date, scheduledEnd: Date) {
  return {
    joinOpensAt: new Date(scheduledStart.getTime() - PROVISIONAL_JOIN_WINDOW.leadMs),
    joinClosesAt: new Date(scheduledEnd.getTime() + PROVISIONAL_JOIN_WINDOW.lagMs),
  };
}

/**
 * The subset of a Prisma client this module needs. Accepting a structural type
 * rather than `PrismaClient` is what lets callers pass a TENANT-SCOPED client
 * (`withTenantDb`'s transaction handle), which is the only kind that carries
 * the `app.current_organization_id` setting the RLS policies and the
 * `organizationId` column defaults both read.
 */
export type MaterialiserDb = {
  meeting: {
    findUnique(args: {
      where: { id: string };
      select: Record<string, boolean>;
    }): Promise<Record<string, unknown> | null>;
    update(args: { where: { id: string }; data: Prisma.MeetingUpdateInput }): Promise<unknown>;
  };
  meetingOccurrence: {
    findMany(args: {
      where: Record<string, unknown>;
      select: Record<string, boolean>;
    }): Promise<Array<Record<string, unknown>>>;
    createMany(args: {
      data: Prisma.MeetingOccurrenceCreateManyInput[];
      skipDuplicates?: boolean;
    }): Promise<{ count: number }>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
};

export type MaterialiseResult = {
  /** Occurrence rows inserted by this call. */
  created: number;
  /** Future rows withdrawn because their slot left the rule. */
  cancelled: number;
  /** The watermark after this call. */
  materializedThrough: Date;
};

type MeetingRow = {
  id: string;
  startTime: Date;
  endTime: Date;
  timezone: string;
  recurrenceRule: string | null;
  materializedThrough: Date | null;
};

/**
 * Reconcile one meeting's occurrence rows up to the rolling horizon.
 *
 * Idempotent: calling it twice in a row inserts nothing the second time, both
 * because the slot set is unchanged and because the insert is guarded by the
 * `(meetingId, seriesSlotStart)` unique constraint rather than by a read the
 * caller has to trust. Safe to call on every create, every update, and every
 * read path that needs the table to be current.
 *
 * @param db a TENANT-SCOPED client — see `MaterialiserDb`.
 */
export async function materializeMeetingOccurrences(
  db: MaterialiserDb,
  meetingId: string,
  options: { now?: Date; horizon?: Date } = {}
): Promise<MaterialiseResult> {
  const now = options.now ?? new Date();
  const horizon =
    options.horizon ?? new Date(now.getTime() + MEETING_MATERIALISATION_WINDOW_DAYS * DAY_MS);

  const meeting = (await db.meeting.findUnique({
    where: { id: meetingId },
    select: {
      id: true,
      startTime: true,
      endTime: true,
      timezone: true,
      recurrenceRule: true,
      materializedThrough: true,
    },
  })) as MeetingRow | null;

  // Not an error: RLS makes a meeting in another tenant indistinguishable from
  // one that does not exist, and that is the correct answer to give here.
  if (!meeting) {
    return { created: 0, cancelled: 0, materializedThrough: horizon };
  }

  const rule = meeting.recurrenceRule ? parseRecurrenceRule(meeting.recurrenceRule) : null;
  const durationMs = Math.max(0, meeting.endTime.getTime() - meeting.startTime.getTime());

  const slots = expandOccurrences({
    anchor: meeting.startTime,
    // The `meetings_timezone_from_organization` trigger guarantees a non-blank
    // IANA zone reaches storage, so this fallback is unreachable in practice —
    // it exists so a hand-written fixture cannot crash the materialiser.
    timeZone: meeting.timezone || 'UTC',
    rule,
    until: horizon,
    limit: MAX_SLOTS_PER_RUN,
  });

  const existing = (await db.meetingOccurrence.findMany({
    where: { meetingId },
    select: { id: true, seriesSlotStart: true, scheduledStart: true, status: true },
  })) as Array<{ id: string; seriesSlotStart: Date; scheduledStart: Date; status: string }>;

  const existingSlots = new Set(existing.map((row) => row.seriesSlotStart.getTime()));
  const ruleSlots = new Set(slots.map((slot) => slot.getTime()));

  const missing = slots.filter((slot) => !existingSlots.has(slot.getTime()));

  let created = 0;
  if (missing.length > 0) {
    const result = await db.meetingOccurrence.createMany({
      data: missing.map((slot) => {
        const scheduledEnd = new Date(slot.getTime() + durationMs);
        return {
          meetingId,
          seriesSlotStart: slot,
          // A freshly materialised slot has no exception yet, so it is held at
          // the instant the rule produced. A reschedule later moves these two
          // and leaves `seriesSlotStart` alone.
          scheduledStart: slot,
          scheduledEnd,
          ...joinWindowFor(slot, scheduledEnd),
          // `publicId` and `providerRoomName` are deliberately NOT supplied:
          // both are database-defaulted (`gen_random_uuid()`,
          // `meeting_provider_room_name()`) so a caller cannot forget them and
          // cannot choose them.
        };
      }),
      // The unique `(meetingId, seriesSlotStart)` index — not the read above —
      // is what makes two concurrent materialisations safe. The read only
      // avoids pointless write attempts.
      skipDuplicates: true,
    });
    created = result.count;
  }

  // INVARIANT 3. A slot the rule no longer produces is withdrawn, never
  // deleted, and only while it is still ahead of us. `updateMany` with the
  // explicit id list keeps this to the rows actually identified.
  const departed = existing.filter(
    (row) =>
      !ruleSlots.has(row.seriesSlotStart.getTime()) &&
      row.scheduledStart.getTime() > now.getTime() &&
      row.status !== 'CANCELLED' &&
      // Only withdraw slots inside the window we just reconciled. A row beyond
      // the horizon was materialised by an earlier, wider call and this call
      // has no opinion about it.
      row.seriesSlotStart.getTime() <= horizon.getTime() &&
      row.seriesSlotStart.getTime() >= meeting.startTime.getTime()
  );

  let cancelled = 0;
  if (departed.length > 0) {
    const result = await db.meetingOccurrence.updateMany({
      where: { id: { in: departed.map((row) => row.id) } },
      data: {
        status: 'CANCELLED',
        cancelledAt: now,
        cancellationReason: 'Occurrence no longer part of the meeting series.',
      },
    });
    cancelled = result.count;
  }

  // The watermark only ever moves FORWARD. A caller materialising a narrower
  // horizon than a previous call must not retract the claim that the wider
  // range is already expanded — that would make the watermark a lie in the one
  // direction that causes duplicate work rather than missing rows.
  const previous = meeting.materializedThrough;
  const watermark = previous && previous.getTime() > horizon.getTime() ? previous : horizon;
  if (!previous || previous.getTime() !== watermark.getTime()) {
    await db.meeting.update({
      where: { id: meetingId },
      data: { materializedThrough: watermark },
    });
  }

  return { created, cancelled, materializedThrough: watermark };
}
