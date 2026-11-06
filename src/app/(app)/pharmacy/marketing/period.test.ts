import { describe, expect, it } from 'vitest';
import {
  dayRangeToPeriod,
  defaultDayRange,
  defaultSendTime,
  instantToLocalDateTime,
  localDateTimeToInstant,
  localTime,
  zoneLabel,
} from './period';

// 17:00 in Karachi on 2 November 2026.
const now = new Date('2026-11-02T12:00:00Z');

describe('marketing periods in the workspace zone (DEV-591)', () => {
  it('defaults to the last 30 days that have ended in Karachi', () => {
    expect(defaultDayRange('Asia/Karachi', now)).toEqual({
      firstDay: '2026-10-03',
      lastDay: '2026-11-01',
    });
    // 21:00Z on 1 November is already 2 November in Karachi but not in UTC.
    const lateEvening = new Date('2026-11-01T21:00:00Z');
    expect(defaultDayRange('Asia/Karachi', lateEvening).lastDay).toBe('2026-11-01');
    expect(defaultDayRange('UTC', lateEvening).lastDay).toBe('2026-10-31');
  });

  it('turns whole Karachi days into the UTC from and exclusive cutoff', () => {
    expect(dayRangeToPeriod('2026-10-01', '2026-10-30', 'Asia/Karachi', now)).toEqual({
      ok: true,
      from: new Date('2026-09-30T19:00:00.000Z'),
      cutoff: new Date('2026-10-30T19:00:00.000Z'),
    });
    // A single day is one whole day.
    expect(dayRangeToPeriod('2026-11-01', '2026-11-01', 'Asia/Karachi', now)).toEqual({
      ok: true,
      from: new Date('2026-10-31T19:00:00.000Z'),
      cutoff: new Date('2026-11-01T19:00:00.000Z'),
    });
  });

  it('follows a daylight-saving zone across its change', () => {
    // London leaves summer time on 25 October 2026.
    expect(dayRangeToPeriod('2026-10-24', '2026-10-25', 'Europe/London', now)).toEqual({
      ok: true,
      from: new Date('2026-10-23T23:00:00.000Z'),
      cutoff: new Date('2026-10-26T00:00:00.000Z'),
    });
  });

  it.each([
    ['', '2026-10-01', 'Choose a first day and a last day.'],
    ['2026-02-30', '2026-03-01', 'calendar date'],
    ['2026-10-05', '2026-10-01', 'on or after the first day'],
    ['2026-07-01', '2026-10-01', '90 days or fewer'],
    ['2026-11-01', '2026-11-02', 'must already be over'],
  ])('explains %s to %s', (first, last, message) => {
    const result = dayRangeToPeriod(first, last, 'Asia/Karachi', now);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain(message);
  });

  it('reads send times as Karachi wall time and back', () => {
    expect(localDateTimeToInstant('2026-11-05T10:00', 'Asia/Karachi')).toEqual(
      new Date('2026-11-05T05:00:00.000Z')
    );
    expect(localDateTimeToInstant('2026-11-05T25:00', 'Asia/Karachi')).toBeNull();
    expect(localDateTimeToInstant('2026-11-05T05:00:00Z', 'Asia/Karachi')).toBeNull();
    expect(instantToLocalDateTime(new Date('2026-11-05T05:00:00Z'), 'Asia/Karachi')).toBe(
      '2026-11-05T10:00'
    );
    expect(defaultSendTime('Asia/Karachi', now)).toBe('2026-11-03T10:00');
    expect(localTime('2026-10-07T07:00:00Z', 'Asia/Karachi')).toBe('2026-10-07 12:00');
    expect(localTime('not a date', 'Asia/Karachi')).toBe('not a date');
  });

  it('names the zone in words, and falls back to UTC for a zone Intl refuses', () => {
    expect(zoneLabel('Asia/Karachi', now)).toBe('Pakistan Standard Time');
    expect(zoneLabel('PKT', now)).toBe('UTC');
  });
});
