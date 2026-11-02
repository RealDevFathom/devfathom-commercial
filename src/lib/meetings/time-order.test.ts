/**
 * The meeting time-order rule (DEV-249 / #451). No database: the rule is pure,
 * and the partial-update helper's only I/O is the injected loader, whose calls
 * are part of what is asserted.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  followStartDate,
  isMeetingTimeOrderValid,
  MEETING_TIME_ORDER_MESSAGE,
  meetingFormInstants,
  meetingFormTimeOrderError,
  meetingTimeOrderError,
  meetingTimeOrderErrorForPatch,
} from './time-order';

const at = (iso: string) => new Date(iso);
const NINE = at('2026-11-02T09:00:00.000Z');
const TEN = at('2026-11-02T10:00:00.000Z');
const ELEVEN = at('2026-11-02T11:00:00.000Z');

describe('isMeetingTimeOrderValid / meetingTimeOrderError', () => {
  it('accepts an end strictly after the start', () => {
    expect(isMeetingTimeOrderValid(TEN, ELEVEN)).toBe(true);
    expect(meetingTimeOrderError(TEN, ELEVEN)).toBeNull();
    // One millisecond is enough: the rule is order, not a minimum duration.
    expect(isMeetingTimeOrderValid(TEN, new Date(TEN.getTime() + 1))).toBe(true);
  });

  it('rejects an end equal to the start', () => {
    expect(isMeetingTimeOrderValid(TEN, new Date(TEN))).toBe(false);
    expect(meetingTimeOrderError(TEN, new Date(TEN))).toBe(MEETING_TIME_ORDER_MESSAGE);
  });

  it('rejects an end before the start', () => {
    expect(isMeetingTimeOrderValid(TEN, NINE)).toBe(false);
    expect(meetingTimeOrderError(TEN, NINE)).toBe(MEETING_TIME_ORDER_MESSAGE);
  });

  it('never treats an unparseable date as in order', () => {
    const invalid = new Date('not a date');
    expect(isMeetingTimeOrderValid(invalid, ELEVEN)).toBe(false);
    expect(isMeetingTimeOrderValid(TEN, invalid)).toBe(false);
  });

  it('says what to fix in words a person can act on', () => {
    expect(MEETING_TIME_ORDER_MESSAGE).toBe('End time must be after the start time.');
  });
});

describe('meetingFormTimeOrderError', () => {
  const form = (startDate: string, startTime: string, endTime: string, endDate = startDate) =>
    meetingFormTimeOrderError({ startDate, startTime, endDate, endTime });

  it('stays silent until both times are chosen', () => {
    expect(form('2026-11-02', '', '')).toBeNull();
    expect(form('2026-11-02', '10:00', '')).toBeNull();
    expect(form('2026-11-02', '', '09:00')).toBeNull();
  });

  it('judges the same instants the form submits', () => {
    expect(form('2026-11-02', '10:00', '11:00')).toBeNull();
    expect(form('2026-11-02', '10:00', '10:00')).toBe(MEETING_TIME_ORDER_MESSAGE);
    expect(form('2026-11-02', '10:00', '09:45')).toBe(MEETING_TIME_ORDER_MESSAGE);
  });

  it('flags a bad range before a date is picked', () => {
    expect(form('', '14:00', '13:00', '')).toBe(MEETING_TIME_ORDER_MESSAGE);
    expect(form('', '13:00', '14:00', '')).toBeNull();
  });

  it('allows a meeting that runs past midnight into the next day', () => {
    // 23:30 to 00:30 the next day is one hour, not an end 23 hours early.
    expect(form('2026-11-09', '23:30', '00:30', '2026-11-10')).toBeNull();
    // The review's case: a stored 04:00-05:00 UTC range read back in New York.
    expect(form('2026-11-09', '23:00', '00:00', '2026-11-10')).toBeNull();
  });

  it('still refuses an end at or before the start', () => {
    // The same wall-clock times on one day run backwards.
    expect(form('2026-11-09', '23:30', '00:30')).toBe(MEETING_TIME_ORDER_MESSAGE);
    // An end date before the start date, whatever the times say.
    expect(form('2026-11-10', '09:00', '10:00', '2026-11-09')).toBe(MEETING_TIME_ORDER_MESSAGE);
    expect(form('2026-11-09', '00:00', '00:00')).toBe(MEETING_TIME_ORDER_MESSAGE);
    // The same time on the next day is a full day later, so it is in order.
    expect(form('2026-11-09', '10:00', '10:00', '2026-11-10')).toBeNull();
  });

  it('reads an empty end date as the start date', () => {
    expect(form('2026-11-02', '10:00', '11:00', '')).toBeNull();
    expect(form('2026-11-02', '10:00', '09:00', '')).toBe(MEETING_TIME_ORDER_MESSAGE);
  });
});

describe('meetingFormInstants', () => {
  it('reads each side on its own date in the viewer’s zone', () => {
    expect(
      meetingFormInstants({
        startDate: '2026-11-09',
        startTime: '23:30',
        endDate: '2026-11-10',
        endTime: '00:30',
      })
    ).toEqual({
      startTime: new Date(2026, 10, 9, 23, 30),
      endTime: new Date(2026, 10, 10, 0, 30),
    });
  });

  it('ends on the start date when no end date is set', () => {
    const { endTime } = meetingFormInstants({
      startDate: '2026-11-09',
      startTime: '10:00',
      endDate: '',
      endTime: '11:00',
    });
    expect(endTime).toEqual(new Date(2026, 10, 9, 11, 0));
  });
});

describe('followStartDate', () => {
  it('moves the end date by as many days as the start date moved', () => {
    expect(followStartDate('2026-11-09', '2026-11-12', '2026-11-10')).toBe('2026-11-13');
    expect(followStartDate('2026-11-09', '2026-11-02', '2026-11-09')).toBe('2026-11-02');
    // Across a month and a year end.
    expect(followStartDate('2026-12-31', '2027-01-31', '2027-01-01')).toBe('2027-02-01');
  });

  it('follows the start date when the end date was never set', () => {
    expect(followStartDate('', '2026-11-09', '')).toBe('2026-11-09');
    expect(followStartDate('2026-11-08', '2026-11-09', '')).toBe('2026-11-09');
  });

  it('follows the start date when it is cleared or unreadable', () => {
    expect(followStartDate('2026-11-09', '', '2026-11-10')).toBe('');
    expect(followStartDate('not-a-date', '2026-11-09', '2026-11-10')).toBe('2026-11-09');
  });
});

describe('meetingTimeOrderErrorForPatch', () => {
  const stored = { startTime: TEN, endTime: ELEVEN };

  it('checks nothing and reads nothing when neither time changes', async () => {
    const load = vi.fn(async () => stored);
    await expect(meetingTimeOrderErrorForPatch({}, load)).resolves.toBeNull();
    await expect(
      meetingTimeOrderErrorForPatch({ startTime: null, endTime: undefined }, load)
    ).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('judges a patch carrying both times on its own, without a read', async () => {
    const load = vi.fn(async () => stored);
    await expect(
      meetingTimeOrderErrorForPatch({ startTime: ELEVEN, endTime: TEN }, load)
    ).resolves.toBe(MEETING_TIME_ORDER_MESSAGE);
    await expect(
      meetingTimeOrderErrorForPatch({ startTime: NINE, endTime: TEN }, load)
    ).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('compares a start-only patch against the STORED end', async () => {
    const load = vi.fn(async () => stored);
    // 10:00–11:00 moved to start at 11:00 → zero length.
    await expect(meetingTimeOrderErrorForPatch({ startTime: ELEVEN }, load)).resolves.toBe(
      MEETING_TIME_ORDER_MESSAGE
    );
    // …and to start at 09:00 → still ends at 11:00, which is fine.
    await expect(meetingTimeOrderErrorForPatch({ startTime: NINE }, load)).resolves.toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('compares an end-only patch against the STORED start', async () => {
    const load = vi.fn(async () => stored);
    await expect(meetingTimeOrderErrorForPatch({ endTime: NINE }, load)).resolves.toBe(
      MEETING_TIME_ORDER_MESSAGE
    );
    await expect(meetingTimeOrderErrorForPatch({ endTime: TEN }, load)).resolves.toBe(
      MEETING_TIME_ORDER_MESSAGE
    );
    await expect(
      meetingTimeOrderErrorForPatch({ endTime: at('2026-11-02T12:00:00.000Z') }, load)
    ).resolves.toBeNull();
  });

  it('leaves a missing meeting to the caller’s own not-found handling', async () => {
    await expect(
      meetingTimeOrderErrorForPatch({ startTime: ELEVEN }, async () => null)
    ).resolves.toBeNull();
  });
});
