import { describe, expect, it } from 'vitest';

import {
  BusinessDateError,
  DEFAULT_BUSINESS_DAY_CUTOFF,
  businessDateToUtcDate,
  parseCutoffMinutes,
  resolveBusinessDate,
} from './business-date';

describe('parseCutoffMinutes', () => {
  it('parses HH:MM into minutes-of-day', () => {
    expect(parseCutoffMinutes('00:00')).toBe(0);
    expect(parseCutoffMinutes('06:00')).toBe(360);
    expect(parseCutoffMinutes('02:30')).toBe(150);
    expect(parseCutoffMinutes('23:59')).toBe(1439);
  });

  it('rejects malformed or out-of-range cutoffs', () => {
    for (const bad of ['24:00', '6:00', '06:60', '0600', '', 'noon', '25:15']) {
      expect(() => parseCutoffMinutes(bad)).toThrow(BusinessDateError);
    }
  });

  it('the default cutoff is midnight', () => {
    expect(DEFAULT_BUSINESS_DAY_CUTOFF).toBe('00:00');
    expect(parseCutoffMinutes(DEFAULT_BUSINESS_DAY_CUTOFF)).toBe(0);
  });
});

describe('resolveBusinessDate — midnight cutoff equals branch-local calendar date', () => {
  it('projects a UTC instant onto the branch-local date (crossing midnight)', () => {
    // 04:30Z is 23:30 the previous day in New York (EST, UTC-5).
    expect(resolveBusinessDate(new Date('2026-01-15T04:30:00Z'), 'America/New_York')).toBe(
      '2026-01-14'
    );
    // Same instant is already the 15th in UTC.
    expect(resolveBusinessDate(new Date('2026-01-15T04:30:00Z'), 'UTC')).toBe('2026-01-15');
  });

  it('handles a half-hour-offset timezone crossing midnight (Asia/Kolkata +5:30)', () => {
    // 19:00Z -> 00:30 next local day in Kolkata.
    expect(resolveBusinessDate(new Date('2026-06-01T19:00:00Z'), 'Asia/Kolkata')).toBe(
      '2026-06-02'
    );
  });
});

describe('resolveBusinessDate — cutoff rolls the early morning back a day', () => {
  it('attributes pre-cutoff local time to the previous business date', () => {
    // 10:30Z -> 05:30 local (New York, EST). With a 06:00 cutoff this belongs to
    // the day that has not yet closed.
    const instant = new Date('2026-01-15T10:30:00Z');
    expect(resolveBusinessDate(instant, 'America/New_York', '06:00')).toBe('2026-01-14');
    expect(resolveBusinessDate(instant, 'America/New_York', '00:00')).toBe('2026-01-15');
  });

  it('attributes at-or-after-cutoff local time to the current business date', () => {
    // 12:00Z -> 07:00 local (New York, EST) >= 06:00 cutoff.
    expect(resolveBusinessDate(new Date('2026-01-15T12:00:00Z'), 'America/New_York', '06:00')).toBe(
      '2026-01-15'
    );
  });

  it('supports a cross-midnight (after-midnight) cutoff like 02:00', () => {
    // 00:30 local -> before 02:00 cutoff -> previous business day.
    expect(resolveBusinessDate(new Date('2026-06-01T19:00:00Z'), 'Asia/Kolkata', '02:00')).toBe(
      '2026-06-01'
    );
    // 02:30 local -> at/after 02:00 cutoff -> that day.
    expect(resolveBusinessDate(new Date('2026-06-01T21:00:00Z'), 'Asia/Kolkata', '02:00')).toBe(
      '2026-06-02'
    );
  });
});

describe('resolveBusinessDate — DST correctness (Intl-based)', () => {
  it('spring-forward: the skipped 02:00-03:00 hour does not shift the date', () => {
    // New York springs forward 2026-03-08 at 02:00 -> 03:00. 07:30Z is 03:30 EDT.
    expect(resolveBusinessDate(new Date('2026-03-08T07:30:00Z'), 'America/New_York', '06:00')).toBe(
      '2026-03-07'
    );
    // 06:30Z is 01:30 EST (still before the jump), same business date.
    expect(resolveBusinessDate(new Date('2026-03-08T06:30:00Z'), 'America/New_York', '06:00')).toBe(
      '2026-03-07'
    );
  });

  it('fall-back: both occurrences of the repeated 01:30 hour resolve identically', () => {
    // New York falls back 2026-11-01 at 02:00 EDT -> 01:00 EST.
    // 05:30Z = 01:30 EDT (first pass); 06:30Z = 01:30 EST (second pass).
    const first = resolveBusinessDate(
      new Date('2026-11-01T05:30:00Z'),
      'America/New_York',
      '06:00'
    );
    const second = resolveBusinessDate(
      new Date('2026-11-01T06:30:00Z'),
      'America/New_York',
      '06:00'
    );
    expect(first).toBe('2026-10-31');
    expect(second).toBe('2026-10-31');
  });

  it('a same-day midday instant during EDT resolves to the current date', () => {
    // 16:00Z on 2026-07-01 is 12:00 EDT.
    expect(resolveBusinessDate(new Date('2026-07-01T16:00:00Z'), 'America/New_York', '04:00')).toBe(
      '2026-07-01'
    );
  });
});

describe('resolveBusinessDate — input validation', () => {
  it('rejects an invalid instant', () => {
    expect(() => resolveBusinessDate(new Date('nope'), 'UTC')).toThrow(BusinessDateError);
  });

  it('rejects an invalid timezone', () => {
    expect(() => resolveBusinessDate(new Date('2026-01-01T00:00:00Z'), 'Mars/Olympus')).toThrow(
      BusinessDateError
    );
  });

  it('rejects an invalid cutoff', () => {
    expect(() => resolveBusinessDate(new Date('2026-01-01T00:00:00Z'), 'UTC', '99:99')).toThrow(
      BusinessDateError
    );
  });
});

describe('businessDateToUtcDate', () => {
  it('produces the UTC-midnight Date for a YYYY-MM-DD string', () => {
    const date = businessDateToUtcDate('2026-08-19');
    expect(date.toISOString()).toBe('2026-08-19T00:00:00.000Z');
  });

  it('round-trips with resolveBusinessDate', () => {
    const businessDate = resolveBusinessDate(
      new Date('2026-03-08T07:30:00Z'),
      'America/New_York',
      '06:00'
    );
    const utc = businessDateToUtcDate(businessDate);
    expect(utc.toISOString().slice(0, 10)).toBe(businessDate);
  });

  it('rejects malformed and impossible calendar dates', () => {
    for (const bad of ['2026-13-01', '2026-02-30', '20260819', '2026-8-9', 'today']) {
      expect(() => businessDateToUtcDate(bad)).toThrow(BusinessDateError);
    }
  });
});
