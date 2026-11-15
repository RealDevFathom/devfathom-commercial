import { expect, it } from 'vitest';
import {
  localDateTime,
  localDateTimeLabel,
  localDayAfter,
  localDayStart,
  localInputValue,
  recentCompletedDays,
  shiftDay,
  timeZoneLabel,
} from './marketing-dates';

it('reads calendar days as Pakistan-time midnights and the last day as an exclusive cutoff', () => {
  expect(localDayStart('2026-10-01', 'Asia/Karachi').toISOString()).toBe(
    '2026-09-30T19:00:00.000Z'
  );
  expect(localDayAfter('2026-10-30', 'Asia/Karachi').toISOString()).toBe(
    '2026-10-30T19:00:00.000Z'
  );
  expect(localDayAfter('2026-12-31', 'UTC').toISOString()).toBe('2027-01-01T00:00:00.000Z');
});

it('reads datetime-local values as workspace wall-clock time and keeps explicit offsets', () => {
  expect(localDateTime('2026-10-10T12:00', 'Asia/Karachi').toISOString()).toBe(
    '2026-10-10T07:00:00.000Z'
  );
  expect(localDateTime('2026-10-10T12:00:00Z', 'Asia/Karachi').toISOString()).toBe(
    '2026-10-10T12:00:00.000Z'
  );
});

it('rejects impossible or malformed values instead of rolling them over', () => {
  expect(localDayStart('2026-02-31', 'Asia/Karachi').getTime()).toBeNaN();
  expect(localDayAfter('2026-13-01', 'Asia/Karachi').getTime()).toBeNaN();
  expect(localDayAfter('', 'Asia/Karachi').getTime()).toBeNaN();
  expect(localDateTime('2026-10-10T25:00', 'Asia/Karachi').getTime()).toBeNaN();
  expect(localDateTime('', 'Asia/Karachi').getTime()).toBeNaN();
});

it('defaults to completed local days ending yesterday', () => {
  // 20:00 UTC on 2 Nov is already 3 Nov in Pakistan.
  const now = new Date('2026-11-02T20:00:00Z');
  expect(recentCompletedDays('Asia/Karachi', 30, now)).toEqual({
    firstDay: '2026-10-04',
    lastDay: '2026-11-02',
  });
  expect(recentCompletedDays('UTC', 7, now)).toEqual({
    firstDay: '2026-10-26',
    lastDay: '2026-11-01',
  });
  expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
});

it('formats saved instants for local inputs and labels', () => {
  const instant = new Date('2026-10-07T07:00:00Z');
  expect(localInputValue(instant, 'Asia/Karachi')).toBe('2026-10-07T12:00');
  expect(localInputValue('2026-10-07T07:00:00.000Z', 'UTC')).toBe('2026-10-07T07:00');
  expect(localInputValue(undefined, 'UTC')).toBe('');
  expect(localDateTimeLabel(instant, 'Asia/Karachi')).toBe('7 Oct 2026, 12:00');
  expect(timeZoneLabel('Asia/Karachi')).toBe('Pakistan time (PKT)');
  expect(timeZoneLabel('not/a-zone')).toBe('UTC');
});
