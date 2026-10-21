/**
 * M7-L3 — SOP recurrence unit tests.
 *
 * Two things are proven here with EXACT UTC instants (never a system-local
 * assumption): (1) structured DAILY/WEEKLY/MONTHLY/ONCE selection with interval,
 * end date, and month-day clamping; (2) DST handling in BOTH directions across
 * two zones (America/New_York and Europe/Berlin) — spring-forward gaps resolve to
 * the next valid instant, fall-back ambiguity resolves to the first/earlier one.
 */
import { describe, expect, it } from 'vitest';

import {
  RecurrenceError,
  type RecurrenceRule,
  computeOccurrence,
  enumerateOccurrences,
  occursOn,
  zonedWallTimeToUtc,
} from './sop-recurrence';

function rule(partial: Partial<RecurrenceRule>): RecurrenceRule {
  return {
    frequency: 'DAILY',
    interval: 1,
    daysOfWeek: [],
    monthDay: null,
    startDate: '2026-01-01',
    endDate: null,
    dueTimeMinutes: 9 * 60, // 09:00 local
    intervalEndTimeMinutes: null,
    windowMinutes: 120,
    ...partial,
  };
}

const iso = (d: Date) => d.toISOString();

describe('zonedWallTimeToUtc — DST-free days', () => {
  it('projects a plain wall clock through the zone offset (New York, EDT)', () => {
    const { instant, adjustment } = zonedWallTimeToUtc('2026-06-15', 9 * 60, 'America/New_York');
    expect(iso(instant)).toBe('2026-06-15T13:00:00.000Z'); // EDT = UTC-4
    expect(adjustment).toBe('none');
  });

  it('is driven by the timezone argument, not the process local zone (Berlin)', () => {
    const { instant } = zonedWallTimeToUtc('2026-06-15', 9 * 60, 'Europe/Berlin');
    expect(iso(instant)).toBe('2026-06-15T07:00:00.000Z'); // CEST = UTC+2 → different UTC than NY
  });

  it('handles a midnight wall clock', () => {
    const { instant } = zonedWallTimeToUtc('2026-06-15', 0, 'America/New_York');
    expect(iso(instant)).toBe('2026-06-15T04:00:00.000Z');
  });
});

describe('zonedWallTimeToUtc — America/New_York DST', () => {
  // Spring forward: 2026-03-08, 02:00 EST → 03:00 EDT (transition at 07:00Z).
  it('spring-forward gap → next valid instant (transition boundary)', () => {
    const { instant, adjustment } = zonedWallTimeToUtc(
      '2026-03-08',
      2 * 60 + 30,
      'America/New_York'
    );
    expect(iso(instant)).toBe('2026-03-08T07:00:00.000Z');
    expect(adjustment).toBe('spring-forward');
  });

  it('the wall clock just before the gap is unaffected (EST)', () => {
    const { instant, adjustment } = zonedWallTimeToUtc(
      '2026-03-08',
      1 * 60 + 30,
      'America/New_York'
    );
    expect(iso(instant)).toBe('2026-03-08T06:30:00.000Z'); // 01:30 EST = UTC-5
    expect(adjustment).toBe('none');
  });

  it('the wall clock just after the gap is unaffected (EDT)', () => {
    const { instant, adjustment } = zonedWallTimeToUtc(
      '2026-03-08',
      3 * 60 + 30,
      'America/New_York'
    );
    expect(iso(instant)).toBe('2026-03-08T07:30:00.000Z'); // 03:30 EDT = UTC-4
    expect(adjustment).toBe('none');
  });

  // Fall back: 2026-11-01, 02:00 EDT → 01:00 EST (transition at 06:00Z).
  it('fall-back ambiguity → first (earlier) instant (EDT)', () => {
    const { instant, adjustment } = zonedWallTimeToUtc(
      '2026-11-01',
      1 * 60 + 30,
      'America/New_York'
    );
    expect(iso(instant)).toBe('2026-11-01T05:30:00.000Z'); // 01:30 EDT (UTC-4), the earlier of the two
    expect(adjustment).toBe('fall-back');
  });

  it('a wall clock after the fold is unaffected (EST)', () => {
    const { instant, adjustment } = zonedWallTimeToUtc(
      '2026-11-01',
      2 * 60 + 30,
      'America/New_York'
    );
    expect(iso(instant)).toBe('2026-11-01T07:30:00.000Z'); // 02:30 EST = UTC-5
    expect(adjustment).toBe('none');
  });
});

describe('zonedWallTimeToUtc — Europe/Berlin DST', () => {
  // Spring forward: 2026-03-29, 02:00 CET → 03:00 CEST (transition at 01:00Z).
  it('spring-forward gap → next valid instant (transition boundary)', () => {
    const { instant, adjustment } = zonedWallTimeToUtc('2026-03-29', 2 * 60 + 30, 'Europe/Berlin');
    expect(iso(instant)).toBe('2026-03-29T01:00:00.000Z');
    expect(adjustment).toBe('spring-forward');
  });

  it('the wall clock just before the gap is unaffected (CET)', () => {
    const { instant } = zonedWallTimeToUtc('2026-03-29', 1 * 60 + 30, 'Europe/Berlin');
    expect(iso(instant)).toBe('2026-03-29T00:30:00.000Z'); // 01:30 CET = UTC+1
  });

  it('the wall clock just after the gap is unaffected (CEST)', () => {
    const { instant } = zonedWallTimeToUtc('2026-03-29', 3 * 60 + 30, 'Europe/Berlin');
    expect(iso(instant)).toBe('2026-03-29T01:30:00.000Z'); // 03:30 CEST = UTC+2
  });

  // Fall back: 2026-10-25, 03:00 CEST → 02:00 CET (transition at 01:00Z).
  it('fall-back ambiguity → first (earlier) instant (CEST)', () => {
    const { instant, adjustment } = zonedWallTimeToUtc('2026-10-25', 2 * 60 + 30, 'Europe/Berlin');
    expect(iso(instant)).toBe('2026-10-25T00:30:00.000Z'); // 02:30 CEST (UTC+2), the earlier of the two
    expect(adjustment).toBe('fall-back');
  });

  it('a wall clock before the fold is unaffected (CEST, crossing UTC midnight)', () => {
    const { instant } = zonedWallTimeToUtc('2026-10-25', 1 * 60 + 30, 'Europe/Berlin');
    expect(iso(instant)).toBe('2026-10-24T23:30:00.000Z'); // 01:30 CEST = UTC+2 → previous UTC day
  });
});

describe('occursOn — structured selection', () => {
  it('INTERVAL is effective on every date inside its inclusive date window', () => {
    const r = rule({
      frequency: 'INTERVAL',
      interval: 30,
      startDate: '2026-02-10',
      endDate: '2026-02-11',
      intervalEndTimeMinutes: 10 * 60,
      daysOfWeek: [2, 3],
    });
    expect(occursOn(r, '2026-02-09')).toBe(false);
    expect(occursOn(r, '2026-02-10')).toBe(true);
    expect(occursOn(r, '2026-02-11')).toBe(true);
    expect(occursOn(r, '2026-02-12')).toBe(false);
  });

  it('DAILY every day from the start', () => {
    const r = rule({ frequency: 'DAILY', interval: 1, startDate: '2026-02-10' });
    expect(occursOn(r, '2026-02-10')).toBe(true);
    expect(occursOn(r, '2026-02-11')).toBe(true);
    expect(occursOn(r, '2026-02-09')).toBe(false); // before start
  });

  it('DAILY every 3rd day is interval-aligned on the start', () => {
    const r = rule({ frequency: 'DAILY', interval: 3, startDate: '2026-02-10' });
    expect(occursOn(r, '2026-02-10')).toBe(true);
    expect(occursOn(r, '2026-02-11')).toBe(false);
    expect(occursOn(r, '2026-02-13')).toBe(true);
  });

  it('WEEKLY selects weekdays and honours the interval (every 2 weeks, Mon+Wed)', () => {
    // 2026-03-02 is a Monday. Mon=1, Wed=3.
    const r = rule({
      frequency: 'WEEKLY',
      interval: 2,
      daysOfWeek: [1, 3],
      startDate: '2026-03-02',
    });
    expect(occursOn(r, '2026-03-02')).toBe(true); // Mon, week 0
    expect(occursOn(r, '2026-03-04')).toBe(true); // Wed, week 0
    expect(occursOn(r, '2026-03-03')).toBe(false); // Tue
    expect(occursOn(r, '2026-03-09')).toBe(false); // Mon, week 1 (skipped by interval 2)
    expect(occursOn(r, '2026-03-16')).toBe(true); // Mon, week 2
  });

  it('WEEKLY with no daysOfWeek defaults to the start weekday', () => {
    const r = rule({ frequency: 'WEEKLY', interval: 1, daysOfWeek: [], startDate: '2026-03-02' });
    expect(occursOn(r, '2026-03-02')).toBe(true); // Mon
    expect(occursOn(r, '2026-03-09')).toBe(true); // next Mon
    expect(occursOn(r, '2026-03-10')).toBe(false); // Tue
  });

  it('MONTHLY fires on the month-day and clamps to the last day of short months', () => {
    const r = rule({ frequency: 'MONTHLY', interval: 1, monthDay: 31, startDate: '2026-01-31' });
    expect(occursOn(r, '2026-01-31')).toBe(true);
    expect(occursOn(r, '2026-02-28')).toBe(true); // clamped (Feb has 28 days in 2026)
    expect(occursOn(r, '2026-02-27')).toBe(false);
    expect(occursOn(r, '2026-03-31')).toBe(true);
  });

  it('MONTHLY honours the month interval (every 2 months)', () => {
    const r = rule({ frequency: 'MONTHLY', interval: 2, monthDay: 15, startDate: '2026-01-15' });
    expect(occursOn(r, '2026-01-15')).toBe(true);
    expect(occursOn(r, '2026-02-15')).toBe(false);
    expect(occursOn(r, '2026-03-15')).toBe(true);
  });

  it('ONCE fires only on the start date', () => {
    const r = rule({ frequency: 'ONCE', startDate: '2026-04-01' });
    expect(occursOn(r, '2026-04-01')).toBe(true);
    expect(occursOn(r, '2026-04-02')).toBe(false);
  });

  it('respects an inclusive end date', () => {
    const r = rule({ frequency: 'DAILY', startDate: '2026-05-01', endDate: '2026-05-03' });
    expect(occursOn(r, '2026-05-03')).toBe(true);
    expect(occursOn(r, '2026-05-04')).toBe(false);
  });
});

describe('INTERVAL intraday expansion', () => {
  it('emits exactly 14 hourly slots from 10:00 through 23:00 in Asia/Karachi', () => {
    const occurrences = enumerateOccurrences(
      rule({
        frequency: 'INTERVAL',
        interval: 60,
        daysOfWeek: [4],
        dueTimeMinutes: 10 * 60,
        intervalEndTimeMinutes: 23 * 60,
      }),
      'Asia/Karachi',
      '2026-01-01',
      '2026-01-01'
    );
    expect(occurrences).toHaveLength(14);
    expect(occurrences[0]!.dueAt.toISOString()).toBe('2026-01-01T05:00:00.000Z');
    expect(occurrences[13]!.dueAt.toISOString()).toBe('2026-01-01T18:00:00.000Z');
  });

  it.each([
    [10 * 60, 23 * 60, 15],
    [10 * 60, 23 * 60, 45],
    [7 * 60 + 10, 19 * 60 + 5, 125],
  ])('obeys floor((end-start)/interval)+1 for %i..%i every %i minutes', (start, end, interval) => {
    const occurrences = enumerateOccurrences(
      rule({
        frequency: 'INTERVAL',
        interval,
        daysOfWeek: [4],
        dueTimeMinutes: start,
        intervalEndTimeMinutes: end,
      }),
      'Asia/Karachi',
      '2026-01-01',
      '2026-01-01'
    );
    expect(occurrences).toHaveLength(Math.floor((end - start) / interval) + 1);
  });

  it('emits every N minutes between inclusive branch-local bounds', () => {
    const occurrences = enumerateOccurrences(
      rule({
        frequency: 'INTERVAL',
        interval: 30,
        daysOfWeek: [4],
        dueTimeMinutes: 9 * 60,
        intervalEndTimeMinutes: 10 * 60,
      }),
      'Asia/Karachi',
      '2026-01-01',
      '2026-01-01'
    );
    expect(occurrences.map((item) => item.dueAt.toISOString())).toEqual([
      '2026-01-01T04:00:00.000Z',
      '2026-01-01T04:30:00.000Z',
      '2026-01-01T05:00:00.000Z',
    ]);
  });

  it('rejects missing or reversed interval-hour bounds', () => {
    expect(() =>
      enumerateOccurrences(
        rule({ frequency: 'INTERVAL', interval: 30, daysOfWeek: [4] }),
        'UTC',
        '2026-01-01',
        '2026-01-01'
      )
    ).toThrow(/requires intervalEndTimeMinutes/);
    expect(() =>
      enumerateOccurrences(
        rule({
          frequency: 'INTERVAL',
          interval: 30,
          daysOfWeek: [4],
          dueTimeMinutes: 600,
          intervalEndTimeMinutes: 540,
        }),
        'UTC',
        '2026-01-01',
        '2026-01-01'
      )
    ).toThrow(/end time must be later/);
  });

  it('requires selected weekdays, honours them, enforces 15 minutes, and never crosses midnight', () => {
    expect(() =>
      enumerateOccurrences(
        rule({ frequency: 'INTERVAL', interval: 14, daysOfWeek: [4], intervalEndTimeMinutes: 600 }),
        'Asia/Karachi',
        '2026-01-01',
        '2026-01-01'
      )
    ).toThrow(/at least 15 minutes/);
    expect(() =>
      enumerateOccurrences(
        rule({ frequency: 'INTERVAL', interval: 15, daysOfWeek: [], intervalEndTimeMinutes: 600 }),
        'Asia/Karachi',
        '2026-01-01',
        '2026-01-01'
      )
    ).toThrow(/selected weekday/);
    expect(
      enumerateOccurrences(
        rule({ frequency: 'INTERVAL', interval: 60, daysOfWeek: [5], intervalEndTimeMinutes: 600 }),
        'Asia/Karachi',
        '2026-01-01',
        '2026-01-01'
      )
    ).toEqual([]);
    expect(() =>
      enumerateOccurrences(
        rule({
          frequency: 'INTERVAL',
          interval: 60,
          daysOfWeek: [4],
          intervalEndTimeMinutes: 1440,
        }),
        'Asia/Karachi',
        '2026-01-01',
        '2026-01-01'
      )
    ).toThrow(/0..1439/);
  });
});

describe('computeOccurrence + enumerateOccurrences', () => {
  it('computes dueAt and windowEndsAt from the local due time', () => {
    const r = rule({ startDate: '2026-06-01', dueTimeMinutes: 6 * 60, windowMinutes: 90 });
    const occ = computeOccurrence(r, '2026-06-15', 'America/New_York');
    expect(iso(occ.dueAt)).toBe('2026-06-15T10:00:00.000Z'); // 06:00 EDT
    expect(iso(occ.windowEndsAt)).toBe('2026-06-15T11:30:00.000Z'); // +90m
    expect(occ.businessDate).toBe('2026-06-15');
  });

  it('enumerates a daily window inclusively and pins each instant', () => {
    const r = rule({ frequency: 'DAILY', startDate: '2026-06-01', dueTimeMinutes: 8 * 60 });
    const occs = enumerateOccurrences(r, 'Europe/Berlin', '2026-06-10', '2026-06-12');
    expect(occs.map((o) => o.businessDate)).toEqual(['2026-06-10', '2026-06-11', '2026-06-12']);
    expect(iso(occs[0]!.dueAt)).toBe('2026-06-10T06:00:00.000Z'); // 08:00 CEST
  });

  it('spans a spring-forward day inside enumeration with the adjusted instant', () => {
    const r = rule({ frequency: 'DAILY', startDate: '2026-03-07', dueTimeMinutes: 2 * 60 + 30 });
    const occs = enumerateOccurrences(r, 'America/New_York', '2026-03-07', '2026-03-09');
    const march8 = occs.find((o) => o.businessDate === '2026-03-08')!;
    expect(iso(march8.dueAt)).toBe('2026-03-08T07:00:00.000Z');
    expect(march8.adjustment).toBe('spring-forward');
  });

  it('clamps the enumeration window to the rule start/end', () => {
    const r = rule({ frequency: 'DAILY', startDate: '2026-06-05', endDate: '2026-06-06' });
    const occs = enumerateOccurrences(r, 'UTC', '2026-06-01', '2026-06-30');
    expect(occs.map((o) => o.businessDate)).toEqual(['2026-06-05', '2026-06-06']);
  });

  it('rejects an over-wide enumeration window', () => {
    const r = rule({ frequency: 'DAILY', startDate: '2000-01-01' });
    expect(() => enumerateOccurrences(r, 'UTC', '2000-01-01', '2026-01-01')).toThrow(
      RecurrenceError
    );
  });

  it('rejects an invalid interval', () => {
    expect(() =>
      enumerateOccurrences(rule({ interval: 0 }), 'UTC', '2026-01-01', '2026-01-02')
    ).toThrow(RecurrenceError);
  });
});
