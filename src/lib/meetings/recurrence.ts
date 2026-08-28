/**
 * RRULE expansion for meeting series — WHA-235 (Lane 1).
 *
 * WHY THIS EXISTS AND NOT A LIBRARY. `package.json` carries no RRULE or
 * timezone dependency, and the lane forbids adding one. What it has to expand
 * is not general RFC 5545: it is the closed set of rules this product writes,
 * which `prisma/migrations/20260803120000_meeting_occurrences` fixes at four
 * shapes (`FREQ=DAILY`, `FREQ=WEEKLY`, `FREQ=WEEKLY;INTERVAL=2`,
 * `FREQ=MONTHLY`) plus the `COUNT`/`UNTIL` terminators a caller may add later.
 * Anything outside that set is REJECTED rather than approximated — a series
 * silently expanded under the wrong rule materialises wrong occurrences, and a
 * wrong occurrence is what people join.
 *
 * WALL CLOCK, NOT ELAPSED TIME. `Meeting.timezone` exists because a series is
 * anchored to wall-clock time: a 09:00 standup is 09:00 on both sides of a DST
 * transition, which is 23 or 25 elapsed hours, never a fixed 24. The legacy
 * walkers in `@/lib/meeting-occurrence` used `Date.prototype.setDate`, which
 * operates in the SERVER's zone — so the same series expanded to different
 * instants depending on which region the process ran in. Every step here is
 * taken on the calendar fields in the series' own zone and converted back to an
 * instant afterwards.
 *
 * BOUNDED BY CONSTRUCTION. `expandOccurrences` takes a hard `until` and a hard
 * `limit` and returns whichever comes first. An infinite `FREQ=DAILY` is
 * therefore finite here, which is what makes the 30-day materialisation window
 * in `./materialize` a bound rather than an intention.
 */

/** Frequencies this expander accepts. Anything else is an unsupported rule. */
const SUPPORTED_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;

type Frequency = (typeof SUPPORTED_FREQUENCIES)[number];

export type RecurrenceRule = {
  freq: Frequency;
  /** Positive integer; `INTERVAL=2` on a WEEKLY rule is a fortnightly series. */
  interval: number;
  /** Total occurrence cap for the series, counting from the anchor. */
  count: number | null;
  /** Inclusive final instant the series may produce. */
  until: Date | null;
};

/**
 * The legacy `Meeting.recurrence` vocabulary, mapped to the RRULE the MEET-01
 * migration wrote for the same value.
 *
 * This map is the ONLY place the deprecated column is interpreted, and it is a
 * WRITE-side translation: callers use it to persist `recurrenceRule` when a
 * legacy-shaped input arrives, so that every read path downstream can consult
 * `recurrenceRule` alone. It is byte-for-byte the mapping in
 * `scripts/backfill-meeting-occurrences.ts` and in the migration's `UPDATE`,
 * because a third disagreeing copy is how a series changes cadence during a
 * deploy.
 */
export const LEGACY_RECURRENCE_TO_RRULE: ReadonlyMap<string, string> = new Map([
  ['daily', 'FREQ=DAILY'],
  ['weekly', 'FREQ=WEEKLY'],
  ['biweekly', 'FREQ=WEEKLY;INTERVAL=2'],
  ['monthly', 'FREQ=MONTHLY'],
]);

/**
 * Translate a legacy `recurrence` value into the RRULE to store alongside it.
 *
 * Returns `null` for a one-time meeting and THROWS for a value with no
 * mapping: an unmappable cadence must not become a silent one-time meeting,
 * which is precisely the failure the backfill script refuses to guess at.
 */
export function legacyRecurrenceToRule(recurrence: string | null | undefined): string | null {
  const normalized = recurrence?.trim().toLowerCase() ?? '';
  if (normalized === '') return null;
  const rule = LEGACY_RECURRENCE_TO_RRULE.get(normalized);
  if (!rule) {
    throw new Error(`Unmappable meeting recurrence: ${JSON.stringify(recurrence)}`);
  }
  return rule;
}

/**
 * Parse a stored `recurrenceRule`.
 *
 * The database CHECK (`meetings_recurrenceRule_shape_check`) already guarantees
 * the `FREQ=…(;KEY=VALUE)*` SHAPE, so this is not re-validating syntax for its
 * own sake — it rejects rules whose shape is legal but whose MEANING this
 * expander does not implement (`FREQ=YEARLY`, `BYDAY`, `BYSETPOS`, …). Parsing
 * one of those leniently would drop the part it did not understand and expand a
 * different series than the one the operator wrote.
 */
export function parseRecurrenceRule(rule: string): RecurrenceRule {
  const parts = rule.split(';').filter((part) => part.length > 0);
  const fields = new Map<string, string>();

  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator === -1) throw new Error(`Malformed RRULE segment: ${JSON.stringify(part)}`);
    fields.set(part.slice(0, separator).toUpperCase(), part.slice(separator + 1));
  }

  const freq = fields.get('FREQ')?.toUpperCase();
  if (!freq || !(SUPPORTED_FREQUENCIES as readonly string[]).includes(freq)) {
    throw new Error(`Unsupported RRULE frequency: ${JSON.stringify(freq ?? null)}`);
  }
  fields.delete('FREQ');

  let interval = 1;
  const rawInterval = fields.get('INTERVAL');
  if (rawInterval !== undefined) {
    interval = Number(rawInterval);
    if (!Number.isInteger(interval) || interval < 1) {
      throw new Error(`Invalid RRULE INTERVAL: ${JSON.stringify(rawInterval)}`);
    }
    fields.delete('INTERVAL');
  }

  let count: number | null = null;
  const rawCount = fields.get('COUNT');
  if (rawCount !== undefined) {
    count = Number(rawCount);
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`Invalid RRULE COUNT: ${JSON.stringify(rawCount)}`);
    }
    fields.delete('COUNT');
  }

  let until: Date | null = null;
  const rawUntil = fields.get('UNTIL');
  if (rawUntil !== undefined) {
    until = parseUntil(rawUntil);
    if (!until) throw new Error(`Invalid RRULE UNTIL: ${JSON.stringify(rawUntil)}`);
    fields.delete('UNTIL');
  }

  // Fail loudly on anything left over rather than expanding a rule minus the
  // clause that made it specific.
  if (fields.size > 0) {
    const unsupported = Array.from(fields.keys()).sort().join(', ');
    throw new Error(`Unsupported RRULE part(s): ${unsupported}`);
  }

  return { freq: freq as Frequency, interval, count, until };
}

/** RFC 5545 UTC form (`20260901T090000Z`), plus the bare date form. */
function parseUntil(value: string): Date | null {
  const utc = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (utc) {
    const [, y, mo, d, h, mi, s] = utc;
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  }
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (date) {
    const [, y, mo, d] = date;
    return new Date(Date.UTC(+y, +mo - 1, +d, 23, 59, 59, 999));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Timezone arithmetic
// ---------------------------------------------------------------------------

/** Calendar fields as they read on a wall clock in some zone. */
type WallClock = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = partsCache.get(timeZone);
  if (cached) return cached;
  // `hourCycle: 'h23'` matters: the default for some locales renders midnight
  // as hour 24, which would push the converted instant a full day forward.
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  partsCache.set(timeZone, formatter);
  return formatter;
}

/** Read the wall clock a given instant shows in `timeZone`. */
export function instantToWallClock(instant: Date, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes) => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) throw new Error(`Intl did not return a ${type} part for zone ${timeZone}`);
    return Number(part.value);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
    millisecond: instant.getTime() - Math.floor(instant.getTime() / 1000) * 1000,
  };
}

/** The zone's UTC offset, in milliseconds, at a given instant. */
function offsetAt(epochMs: number, timeZone: string): number {
  const wall = instantToWallClock(new Date(epochMs), timeZone);
  const asIfUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
    0
  );
  return asIfUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * Convert a wall clock in `timeZone` back to the instant it names.
 *
 * DST makes this not a function in two places, and both are resolved
 * explicitly rather than left to whichever offset the first guess happened to
 * pick up:
 *
 *  - the SPRING-FORWARD GAP names a wall clock that never occurs. The meeting
 *    is SHIFTED FORWARD by the length of the gap — an 02:30 daily standup is
 *    held at 03:30 on the day 02:30 does not exist. This is the `compatible`
 *    disambiguation every calendar client and `Temporal` use. Skipping the
 *    occurrence instead would silently delete a slot from the series.
 *  - the AUTUMN-BACK OVERLAP names a wall clock that occurs twice. We take the
 *    FIRST (still-DST) instant, which the loop below reaches naturally: the
 *    pre-transition offset is self-consistent, so it returns on the first pass.
 */
export function wallClockToInstant(wall: WallClock, timeZone: string): Date {
  const asIfUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
    wall.millisecond
  );

  const firstOffset = offsetAt(asIfUtc, timeZone);
  const firstGuess = asIfUtc - firstOffset;
  const secondOffset = offsetAt(firstGuess, timeZone);
  if (secondOffset === firstOffset) return new Date(firstGuess);

  const secondGuess = asIfUtc - secondOffset;
  const thirdOffset = offsetAt(secondGuess, timeZone);
  if (thirdOffset === secondOffset) return new Date(secondGuess);

  // Neither candidate is self-consistent: the wall clock falls in a gap. The
  // LATER candidate is the one produced by the pre-transition offset, which is
  // the forward shift described above.
  return new Date(Math.max(firstGuess, secondGuess));
}

/** Days in a Gregorian month, 1-indexed month. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Advance a wall clock by `steps` periods of the rule's frequency.
 *
 * Arithmetic is on the CALENDAR FIELDS, so the time-of-day is carried through
 * a DST transition unchanged — which is the whole point of storing a zone.
 * Returns `null` for a MONTHLY step that lands on a day the target month does
 * not have (the 31st of February). RFC 5545 §3.3.10 SKIPS such instances, and
 * skipping is what this returning `null` means to the caller: no occurrence in
 * that month, and the series continues at the next one with its day-of-month
 * intact. Clamping to the 28th instead would permanently move a
 * "31st of the month" series onto the 28th.
 */
function addSteps(anchor: WallClock, rule: RecurrenceRule, steps: number): WallClock | null {
  if (steps === 0) return anchor;

  if (rule.freq === 'DAILY' || rule.freq === 'WEEKLY') {
    const days = (rule.freq === 'WEEKLY' ? 7 : 1) * rule.interval * steps;
    // Day-of-month arithmetic via UTC is safe here precisely BECAUSE these are
    // detached calendar fields, not an instant: no zone is involved until
    // `wallClockToInstant` converts the result back.
    const shifted = new Date(Date.UTC(anchor.year, anchor.month - 1, anchor.day));
    shifted.setUTCDate(shifted.getUTCDate() + days);
    return {
      ...anchor,
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
    };
  }

  const totalMonths = anchor.month - 1 + rule.interval * steps;
  const year = anchor.year + Math.floor(totalMonths / 12);
  const month = (((totalMonths % 12) + 12) % 12) + 1;
  if (anchor.day > daysInMonth(year, month)) return null;
  return { ...anchor, year, month, day: anchor.day };
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

export type ExpandOptions = {
  /** The series anchor — `Meeting.startTime`, the first occurrence. */
  anchor: Date;
  /** IANA zone the series recurs in (`Meeting.timezone`). */
  timeZone: string;
  /** Parsed `Meeting.recurrenceRule`; `null` for a one-time meeting. */
  rule: RecurrenceRule | null;
  /** Inclusive horizon. No returned slot starts after this instant. */
  until: Date;
  /**
   * Hard ceiling on returned slots, so a caller cannot ask for an unbounded
   * expansion even by passing a distant `until`.
   */
  limit: number;
};

/**
 * Every series slot in `[anchor, until]`, in ascending order.
 *
 * A one-time meeting (`rule: null`) yields exactly its anchor, and only when
 * the anchor is within the horizon — a one-time meeting is a series of one, not
 * a special case the callers have to branch on.
 *
 * The returned instants are `seriesSlotStart` values: the instants the RULE
 * produces. They are the immutable identity of each instance and deliberately
 * NOT the times a meeting is held at — a rescheduled occurrence keeps its slot
 * and moves `scheduledStart`. See the `MeetingOccurrence` model docs.
 */
export function expandOccurrences(options: ExpandOptions): Date[] {
  const { anchor, timeZone, rule, until, limit } = options;
  if (limit <= 0) return [];

  if (!rule) {
    return anchor.getTime() <= until.getTime() ? [new Date(anchor)] : [];
  }

  const horizon = rule.until && rule.until.getTime() < until.getTime() ? rule.until : until;
  const anchorWall = instantToWallClock(anchor, timeZone);
  const slots: Date[] = [];

  // `emitted` counts slots the rule PRODUCED, which is what RFC 5545 COUNT
  // limits. `steps` counts periods walked, and the two diverge whenever a
  // MONTHLY step is skipped for want of a 31st — so COUNT stays correct
  // without the skip logic having to know about it.
  let emitted = 0;

  // A safety stop independent of both bounds above. `limit` bounds the OUTPUT;
  // this bounds the WORK, so a MONTHLY rule that skips many months in a row
  // still terminates. Twelve periods per emitted slot is far past any real
  // skip run (at most 7 of 12 months lack a 31st).
  const maxSteps = limit * 12 + 24;

  for (let steps = 0; steps <= maxSteps; steps++) {
    if (slots.length >= limit) break;
    if (rule.count !== null && emitted >= rule.count) break;

    const wall = addSteps(anchorWall, rule, steps);
    if (!wall) continue; // skipped month — costs a step, not an occurrence

    const instant = wallClockToInstant(wall, timeZone);
    emitted++;
    if (instant.getTime() > horizon.getTime()) break;
    slots.push(instant);
  }

  return slots;
}

// ---------------------------------------------------------------------------
// Windowed lookup, for display paths that must not walk a whole series
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Nominal period of one step, used only to SKIP AHEAD — never to emit a slot. */
function nominalPeriodMs(rule: RecurrenceRule): number {
  switch (rule.freq) {
    case 'DAILY':
      return rule.interval * DAY_MS;
    case 'WEEKLY':
      return rule.interval * 7 * DAY_MS;
    case 'MONTHLY':
      // The mean Gregorian month. Only ever an estimate of WHICH step to start
      // from; the correction loop below fixes the small drift it accumulates.
      return rule.interval * 30.436875 * DAY_MS;
  }
}

/**
 * Slots of a series that fall in `[from, until]`, without walking the series
 * from its anchor.
 *
 * The list surfaces need "the occurrence around now" for a standup that has
 * been running daily for three years. Walking from the anchor is ~1000 steps
 * per meeting per page — the legacy walkers did exactly that, with a hard stop
 * at 5000 iterations that silently truncated older series. This jumps to the
 * arithmetically-estimated step first and then corrects, so the cost is
 * independent of how old the series is.
 *
 * The estimate is only ever used to pick a STARTING INDEX. Every emitted slot
 * still comes from `addSteps` + `wallClockToInstant`, so DST correctness is
 * unaffected by the approximation.
 */
export function slotsInRange(options: {
  anchor: Date;
  timeZone: string;
  rule: RecurrenceRule | null;
  from: Date;
  until: Date;
  limit: number;
}): Date[] {
  const { anchor, timeZone, rule, from, until, limit } = options;
  if (limit <= 0 || from.getTime() > until.getTime()) return [];

  if (!rule) {
    const time = anchor.getTime();
    return time >= from.getTime() && time <= until.getTime() ? [new Date(anchor)] : [];
  }

  const horizon = rule.until && rule.until.getTime() < until.getTime() ? rule.until : until;
  if (from.getTime() > horizon.getTime()) return [];

  const anchorWall = instantToWallClock(anchor, timeZone);
  const slotAt = (step: number): Date | null => {
    const wall = addSteps(anchorWall, rule, step);
    return wall ? wallClockToInstant(wall, timeZone) : null;
  };

  const CORRECTION_BUDGET = 64;
  let step = 0;

  // A COUNT-limited series is bounded by definition, so it is walked from step
  // zero. That is not an optimisation give-up: COUNT limits slots the rule
  // PRODUCED, and a MONTHLY rule can skip a step without producing one, so the
  // only way to apply COUNT exactly is to have counted from the start.
  if (rule.count === null) {
    // Estimate the first step at or after `from`, then correct. The estimate is
    // exact for DAILY and WEEKLY (fixed periods) and off by the accumulated
    // month-length drift for MONTHLY, which stays well inside this budget.
    const elapsed = from.getTime() - anchor.getTime();
    step = elapsed <= 0 ? 0 : Math.floor(elapsed / nominalPeriodMs(rule));

    // Walk back to a step genuinely before `from`, so an over-estimate cannot
    // skip a slot that belongs in the window.
    for (let guard = 0; guard < CORRECTION_BUDGET && step > 0; guard++) {
      const candidate = slotAt(step);
      if (candidate && candidate.getTime() < from.getTime()) break;
      step--;
    }
    if (step < 0) step = 0;
  }

  const slots: Date[] = [];
  let emitted = 0;
  const maxSteps = step + limit * 12 + CORRECTION_BUDGET + 24;

  for (; step <= maxSteps; step++) {
    if (slots.length >= limit) break;
    if (rule.count !== null && emitted >= rule.count) break;

    const instant = slotAt(step);
    if (!instant) continue; // skipped month — costs a step, not an occurrence
    emitted++;

    if (instant.getTime() > horizon.getTime()) break;
    if (instant.getTime() >= from.getTime()) slots.push(instant);
  }

  return slots;
}

/**
 * The slot a `from`-relative viewer is "on" — the latest slot at or before
 * `now`, or the first slot of the series when none has started yet.
 *
 * Mirrors the RT-10 semantics the legacy `findRelevantOccurrence` documented,
 * so the list surfaces keep showing a just-finished occurrence through the gap
 * before the next one begins instead of jumping forward early.
 */
export function relevantSlot(options: {
  anchor: Date;
  timeZone: string;
  rule: RecurrenceRule | null;
  now: Date;
}): Date | null {
  const { anchor, timeZone, rule, now } = options;
  if (!rule) return new Date(anchor);
  if (now.getTime() <= anchor.getTime()) return new Date(anchor);

  // Two nominal periods back from `now` is more than enough to contain the
  // latest started slot, and bounds the search independently of series age.
  const window = nominalPeriodMs(rule) * 2;
  const found = slotsInRange({
    anchor,
    timeZone,
    rule,
    from: new Date(Math.max(anchor.getTime(), now.getTime() - window)),
    until: now,
    limit: 8,
  });
  if (found.length > 0) return found[found.length - 1];

  // Nothing in that window: the series TERMINATED before it (COUNT or UNTIL),
  // so the relevant slot is the series' last one. Search back from the
  // termination instant rather than forward from the anchor — walking forward
  // and taking the first match would return the series' FIRST slot, which for
  // a long finished series is the wrong end of it.
  const endedAt = rule.until && rule.until.getTime() < now.getTime() ? rule.until : now;
  const tail = slotsInRange({
    anchor,
    timeZone,
    rule,
    from: new Date(Math.max(anchor.getTime(), endedAt.getTime() - window)),
    until: endedAt,
    limit: 8,
  });
  if (tail.length > 0) return tail[tail.length - 1];

  // A COUNT-limited series whose tail is older than the window above. It is
  // bounded by COUNT, so expanding it in full is safe.
  if (rule.count !== null) {
    const all = expandOccurrences({ anchor, timeZone, rule, until: now, limit: rule.count });
    if (all.length > 0) return all[all.length - 1];
  }

  return new Date(anchor);
}
