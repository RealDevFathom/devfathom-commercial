/**
 * RRULE parsing and wall-clock expansion (WHA-235).
 *
 * No database: every property here is decided by the expander alone, and the
 * DST cases are decided by the platform's IANA data, which a mock would replace
 * with whatever the mock asserted.
 *
 * The DST cases are the reason this file exists. The legacy walkers in
 * `@/lib/meeting-occurrence` stepped with `Date.prototype.setDate`, which runs
 * in the SERVER's zone — so a 09:00 New York standup expanded on a UTC server
 * drifted an hour twice a year, and expanded to different instants depending on
 * where the process ran. These assertions are written against LOCAL WALL CLOCK,
 * because that is the property that has to hold.
 */
import { describe, expect, it } from 'vitest';

import {
  expandOccurrences,
  legacyRecurrenceToRule,
  parseRecurrenceRule,
  relevantSlot,
  slotsInRange,
  wallClockToInstant,
} from './recurrence';

/** Wall clock an instant shows in a zone, as `YYYY-MM-DD HH:mm`. */
function localLabel(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

const NEW_YORK = 'America/New_York';

describe('legacyRecurrenceToRule', () => {
  it('maps every legacy cadence exactly as the MEET-01 migration did', () => {
    expect(legacyRecurrenceToRule('daily')).toBe('FREQ=DAILY');
    expect(legacyRecurrenceToRule('weekly')).toBe('FREQ=WEEKLY');
    expect(legacyRecurrenceToRule('biweekly')).toBe('FREQ=WEEKLY;INTERVAL=2');
    expect(legacyRecurrenceToRule('monthly')).toBe('FREQ=MONTHLY');
  });

  it('treats absent, null and blank as a one-time meeting', () => {
    expect(legacyRecurrenceToRule(null)).toBeNull();
    expect(legacyRecurrenceToRule(undefined)).toBeNull();
    expect(legacyRecurrenceToRule('   ')).toBeNull();
  });

  it('REFUSES an unmappable cadence rather than degrading it to one-time', () => {
    // The failure this guards is silent: a series that quietly became a single
    // meeting would lose every occurrence after the first, and nothing would
    // report it. The backfill script refuses to guess here for the same reason.
    expect(() => legacyRecurrenceToRule('fortnightly')).toThrow(/Unmappable/);
    expect(() => legacyRecurrenceToRule('yearly')).toThrow(/Unmappable/);
  });
});

describe('parseRecurrenceRule', () => {
  it('reads FREQ, INTERVAL, COUNT and UNTIL', () => {
    expect(parseRecurrenceRule('FREQ=WEEKLY;INTERVAL=2')).toEqual({
      freq: 'WEEKLY',
      interval: 2,
      count: null,
      until: null,
    });
    expect(parseRecurrenceRule('FREQ=DAILY;COUNT=5')).toMatchObject({ freq: 'DAILY', count: 5 });
    expect(parseRecurrenceRule('FREQ=DAILY;UNTIL=20260901T090000Z').until).toEqual(
      new Date(Date.UTC(2026, 8, 1, 9, 0, 0))
    );
  });

  it('REJECTS rules whose shape is legal but whose meaning is not implemented', () => {
    // The database CHECK admits any `FREQ=…(;KEY=VALUE)*`. Parsing one of these
    // leniently would drop the clause that made the rule specific and expand a
    // DIFFERENT series than the operator wrote — silently, and forever.
    expect(() => parseRecurrenceRule('FREQ=YEARLY')).toThrow(/Unsupported RRULE frequency/);
    expect(() => parseRecurrenceRule('FREQ=WEEKLY;BYDAY=MO,WE')).toThrow(/Unsupported RRULE part/);
    expect(() => parseRecurrenceRule('FREQ=MONTHLY;BYSETPOS=-1')).toThrow(/Unsupported RRULE part/);
    expect(() => parseRecurrenceRule('FREQ=DAILY;INTERVAL=0')).toThrow(/Invalid RRULE INTERVAL/);
    expect(() => parseRecurrenceRule('FREQ=DAILY;COUNT=-3')).toThrow(/Invalid RRULE COUNT/);
    expect(() => parseRecurrenceRule('FREQ=DAILY;UNTIL=soon')).toThrow(/Invalid RRULE UNTIL/);
  });
});

describe('wall-clock expansion across DST', () => {
  it('holds a 09:00 New York standup at 09:00 on BOTH sides of spring forward', () => {
    // 2026-03-08 is the US spring-forward. A 24h-elapsed step would put every
    // occurrence after it at 08:00 local — which is the legacy walker's bug.
    const anchor = wallClockToInstant(
      { year: 2026, month: 3, day: 5, hour: 9, minute: 0, second: 0, millisecond: 0 },
      NEW_YORK
    );

    const slots = expandOccurrences({
      anchor,
      timeZone: NEW_YORK,
      rule: parseRecurrenceRule('FREQ=DAILY'),
      until: new Date(anchor.getTime() + 6 * 24 * 60 * 60 * 1000),
      limit: 10,
    });

    expect(slots.map((slot) => localLabel(slot, NEW_YORK))).toEqual([
      '2026-03-05 09:00',
      '2026-03-06 09:00',
      '2026-03-07 09:00',
      '2026-03-08 09:00', // transition day
      '2026-03-09 09:00',
      '2026-03-10 09:00',
      '2026-03-11 09:00',
    ]);

    // And the UTC instants really do shift, which is what proves the local
    // times above were preserved ACROSS a change rather than by there being no
    // change to survive.
    expect(slots[0].toISOString()).toBe('2026-03-05T14:00:00.000Z'); // EST, UTC-5
    expect(slots[6].toISOString()).toBe('2026-03-11T13:00:00.000Z'); // EDT, UTC-4
  });

  it('holds a 09:00 standup at 09:00 across autumn fall-back', () => {
    const anchor = wallClockToInstant(
      { year: 2026, month: 10, day: 30, hour: 9, minute: 0, second: 0, millisecond: 0 },
      NEW_YORK
    );

    const slots = expandOccurrences({
      anchor,
      timeZone: NEW_YORK,
      rule: parseRecurrenceRule('FREQ=DAILY'),
      until: new Date(anchor.getTime() + 4 * 24 * 60 * 60 * 1000),
      limit: 10,
    });

    // FOUR, not five. `until` is an INSTANT — anchor + 4×24h of elapsed time —
    // and fall-back repeats an hour, so the fifth wall-clock 09:00 lands one
    // hour PAST that instant. This is the horizon behaving correctly: elapsed
    // time and calendar days are not the same quantity across a transition,
    // which is the entire reason the series is anchored to a zone.
    expect(slots.map((slot) => localLabel(slot, NEW_YORK))).toEqual([
      '2026-10-30 09:00',
      '2026-10-31 09:00',
      '2026-11-01 09:00', // transition day
      '2026-11-02 09:00',
    ]);

    // The UTC instants shifting the other way is what proves the local times
    // above survived a real change.
    expect(slots[0].toISOString()).toBe('2026-10-30T13:00:00.000Z'); // EDT, UTC-4
    expect(slots[3].toISOString()).toBe('2026-11-02T14:00:00.000Z'); // EST, UTC-5
  });

  it('shifts an occurrence FORWARD out of the spring-forward gap, never drops it', () => {
    // 02:30 does not exist on 2026-03-08 in New York. Dropping the slot would
    // silently delete an occurrence from the series; the calendar-standard
    // answer is to shift it by the length of the gap, to 03:30.
    const gap = wallClockToInstant(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0, millisecond: 0 },
      NEW_YORK
    );
    expect(localLabel(gap, NEW_YORK)).toBe('2026-03-08 03:30');
    expect(gap.toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('resolves the autumn-back overlap to the FIRST of the two instants', () => {
    // 01:30 happens twice on 2026-11-01 in New York: 05:30Z (EDT) and 06:30Z
    // (EST). RFC 5545 and every calendar client take the earlier one.
    const overlap = wallClockToInstant(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0, millisecond: 0 },
      NEW_YORK
    );
    expect(overlap.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(localLabel(overlap, NEW_YORK)).toBe('2026-11-01 01:30');
  });
});

describe('expandOccurrences bounds', () => {
  const anchor = new Date('2026-01-01T09:00:00.000Z');

  it('is bounded by `until` and independently by `limit`', () => {
    const rule = parseRecurrenceRule('FREQ=DAILY');

    // An infinite rule with a distant horizon is still bounded by `limit` —
    // this is what makes the materialiser's 30-day window a bound rather than
    // an intention.
    expect(
      expandOccurrences({
        anchor,
        timeZone: 'UTC',
        rule,
        until: new Date('2099-01-01T00:00:00.000Z'),
        limit: 7,
      })
    ).toHaveLength(7);

    expect(
      expandOccurrences({
        anchor,
        timeZone: 'UTC',
        rule,
        until: new Date('2026-01-05T09:00:00.000Z'),
        limit: 1000,
      })
    ).toHaveLength(5);
  });

  it('treats a one-time meeting as a series of exactly one', () => {
    expect(
      expandOccurrences({
        anchor,
        timeZone: 'UTC',
        rule: null,
        until: new Date('2026-06-01T00:00:00.000Z'),
        limit: 50,
      })
    ).toEqual([anchor]);

    // ...and yields nothing when it falls outside the horizon.
    expect(
      expandOccurrences({
        anchor,
        timeZone: 'UTC',
        rule: null,
        until: new Date('2025-06-01T00:00:00.000Z'),
        limit: 50,
      })
    ).toEqual([]);
  });

  it('honours COUNT and UNTIL', () => {
    expect(
      expandOccurrences({
        anchor,
        timeZone: 'UTC',
        rule: parseRecurrenceRule('FREQ=DAILY;COUNT=3'),
        until: new Date('2099-01-01T00:00:00.000Z'),
        limit: 100,
      })
    ).toHaveLength(3);

    expect(
      expandOccurrences({
        anchor,
        timeZone: 'UTC',
        rule: parseRecurrenceRule('FREQ=DAILY;UNTIL=20260104T090000Z'),
        until: new Date('2099-01-01T00:00:00.000Z'),
        limit: 100,
      })
    ).toHaveLength(4);
  });

  it('SKIPS a monthly slot in a month that lacks the day, keeping the day-of-month', () => {
    // RFC 5545 §3.3.10 skips invalid instances. Clamping to the 28th instead
    // would permanently move a "31st of the month" series onto the 28th, which
    // is a different series from the one the operator wrote.
    const endOfMonth = new Date('2026-01-31T09:00:00.000Z');
    const slots = expandOccurrences({
      anchor: endOfMonth,
      timeZone: 'UTC',
      rule: parseRecurrenceRule('FREQ=MONTHLY'),
      until: new Date('2026-06-01T00:00:00.000Z'),
      limit: 12,
    });

    expect(slots.map((slot) => slot.toISOString().slice(0, 10))).toEqual([
      '2026-01-31',
      // no February — 2026 is not a leap year and February has no 31st
      '2026-03-31',
      // no April, June, ... — 30-day months have no 31st
      '2026-05-31',
    ]);
  });

  it('interprets INTERVAL=2 on a weekly rule as fortnightly', () => {
    const slots = expandOccurrences({
      anchor,
      timeZone: 'UTC',
      rule: parseRecurrenceRule('FREQ=WEEKLY;INTERVAL=2'),
      until: new Date('2026-03-01T00:00:00.000Z'),
      limit: 20,
    });
    expect(slots.map((slot) => slot.toISOString().slice(0, 10))).toEqual([
      '2026-01-01',
      '2026-01-15',
      '2026-01-29',
      '2026-02-12',
      '2026-02-26',
    ]);
  });
});

describe('slotsInRange', () => {
  it('agrees with a full expansion, without walking the series from its anchor', () => {
    // The skip-ahead is an optimisation, so the only assertion worth making is
    // that it produces exactly what the naive walk would. The anchor here is
    // three years back — ~1100 steps for the naive walk.
    const anchor = new Date('2023-01-01T09:00:00.000Z');
    const from = new Date('2026-02-01T00:00:00.000Z');
    const until = new Date('2026-02-10T00:00:00.000Z');

    const windowed = slotsInRange({
      anchor,
      timeZone: NEW_YORK,
      rule: parseRecurrenceRule('FREQ=DAILY'),
      from,
      until,
      limit: 50,
    });

    const naive = expandOccurrences({
      anchor,
      timeZone: NEW_YORK,
      rule: parseRecurrenceRule('FREQ=DAILY'),
      until,
      limit: 5000,
    }).filter((slot) => slot.getTime() >= from.getTime());

    expect(windowed.map((s) => s.toISOString())).toEqual(naive.map((s) => s.toISOString()));
    expect(windowed.length).toBe(9);
  });

  it('applies COUNT to the SERIES, not to the window', () => {
    // A 5-occurrence series is over before the window opens, so the window is
    // empty — not "the next 5 from here".
    const anchor = new Date('2026-01-01T09:00:00.000Z');
    expect(
      slotsInRange({
        anchor,
        timeZone: 'UTC',
        rule: parseRecurrenceRule('FREQ=DAILY;COUNT=5'),
        from: new Date('2026-02-01T00:00:00.000Z'),
        until: new Date('2026-03-01T00:00:00.000Z'),
        limit: 50,
      })
    ).toEqual([]);
  });
});

describe('relevantSlot', () => {
  const anchor = new Date('2026-01-01T09:00:00.000Z');
  const rule = parseRecurrenceRule('FREQ=DAILY');

  it('returns the occurrence in progress while one is running', () => {
    const now = new Date('2026-03-05T09:30:00.000Z');
    expect(relevantSlot({ anchor, timeZone: 'UTC', rule, now })?.toISOString()).toBe(
      '2026-03-05T09:00:00.000Z'
    );
  });

  it('KEEPS the most recent past occurrence through the gap before the next one', () => {
    // RT-10. Jumping to the next (empty) occurrence halfway through the gap
    // makes the just-finished occurrence's attendance disappear early.
    const lateInTheGap = new Date('2026-03-05T23:30:00.000Z');
    expect(relevantSlot({ anchor, timeZone: 'UTC', rule, now: lateInTheGap })?.toISOString()).toBe(
      '2026-03-05T09:00:00.000Z'
    );
  });

  it('returns the anchor for a series that has not started', () => {
    const before = new Date('2025-12-01T00:00:00.000Z');
    expect(relevantSlot({ anchor, timeZone: 'UTC', rule, now: before })?.toISOString()).toBe(
      anchor.toISOString()
    );
  });

  it('returns the LAST slot of a series that has already finished', () => {
    // Walking forward and taking the first match would return the series'
    // FIRST slot — the wrong end of a finished series.
    const finished = parseRecurrenceRule('FREQ=DAILY;COUNT=3');
    const now = new Date('2026-06-01T00:00:00.000Z');
    expect(relevantSlot({ anchor, timeZone: 'UTC', rule: finished, now })?.toISOString()).toBe(
      '2026-01-03T09:00:00.000Z'
    );
  });
});
