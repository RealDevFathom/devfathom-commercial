import { describe, expect, it } from 'vitest';

import { formatReceiptIssuedAt } from './counter-receipt';
import {
  PHARMACY_DEFAULT_DAY_END_HOUR,
  isPharmacyCurrentBusinessDate,
  pharmacyBusinessDate,
  pharmacyBusinessDay,
  pharmacyBusinessDayOffset,
  pharmacyBusinessDayRange,
  pharmacyCalendarDay,
  pharmacyDayEndHour,
  pharmacyDayEndLabel,
  pharmacyDayEndField,
  pharmacyDayEndHourOn,
  pharmacyDayEndSchedule,
  PharmacyDayEndHistoryError,
  withClientPharmacyDayEnd,
  sharedPharmacyDayEnd,
  shiftPharmacyDay,
} from './business-day';
import { workspaceDateOffset, workspaceDateRange, workspaceToday } from '@/lib/timezone';

// Karachi is UTC+5 all year. Local times on the night of 1 to 2 Nov 2026.
const KARACHI = 'Asia/Karachi';
const AT_2330 = new Date('2026-11-01T18:30:00.000Z'); // 23:30 on 1 Nov
const AT_0030 = new Date('2026-11-01T19:30:00.000Z'); // 00:30 on 2 Nov
const AT_0530 = new Date('2026-11-02T00:30:00.000Z'); // 05:30 on 2 Nov
const LATE = { timeZone: KARACHI, dayEnd: 5 };
const DEFAULT = { timeZone: KARACHI };

describe('DEV-958A the business day of an instant on a branch clock', () => {
  it.each([
    ['23:30', AT_2330, '2026-11-01', '2026-11-01'],
    // The late shift: past midnight but before 05:00 it is still the day before.
    ['00:30', AT_0030, '2026-11-02', '2026-11-01'],
    ['05:30', AT_0530, '2026-11-02', '2026-11-02'],
  ])('at %s local: midnight branch %s, 05:00 branch %s', (_, at, midnight, late) => {
    expect(pharmacyBusinessDay(DEFAULT, at)).toBe(midnight);
    expect(pharmacyBusinessDay({ ...DEFAULT, dayEnd: 0 }, at)).toBe(midnight);
    expect(pharmacyBusinessDay(LATE, at)).toBe(late);
  });

  it('starts the next day exactly at the day-end hour', () => {
    expect(pharmacyBusinessDay(LATE, new Date('2026-11-01T23:59:59.999Z'))).toBe('2026-11-01');
    expect(pharmacyBusinessDay(LATE, new Date('2026-11-02T00:00:00.000Z'))).toBe('2026-11-02');
  });

  it('stores the day as the UTC-midnight date a business date column holds', () => {
    expect(pharmacyBusinessDate(LATE, AT_0030).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(isPharmacyCurrentBusinessDate(new Date('2026-11-01T00:00:00.000Z'), LATE, AT_0030)).toBe(
      true
    );
    expect(isPharmacyCurrentBusinessDate(new Date('2026-11-02T00:00:00.000Z'), LATE, AT_0030)).toBe(
      false
    );
  });

  it('bounds a 05:00 branch day from 05:00 to 05:00 on the shop clock', () => {
    expect(pharmacyBusinessDayRange('2026-11-01', '2026-11-01', LATE)).toEqual({
      from: new Date('2026-11-01T00:00:00.000Z'),
      to: new Date('2026-11-02T00:00:00.000Z'),
    });
    const week = pharmacyBusinessDayRange('2026-11-01', '2026-11-07', LATE);
    expect(week.to.getTime() - week.from.getTime()).toBe(7 * 86_400_000);
    // Every instant inside the window is on one of its days, and the bounds are exact.
    for (const at of [AT_2330, AT_0030]) {
      const range = pharmacyBusinessDayRange('2026-11-01', '2026-11-01', LATE);
      expect(at >= range.from && at < range.to).toBe(true);
    }
    expect(AT_0530 >= pharmacyBusinessDayRange('2026-11-01', '2026-11-01', LATE).to).toBe(true);
  });

  it('follows a daylight-saving change on the wall clock', () => {
    // London leaves summer time at 02:00 BST on 25 Oct 2026.
    const london = { timeZone: 'Europe/London', dayEnd: 5 };
    expect(pharmacyBusinessDayRange('2026-10-24', '2026-10-24', london)).toEqual({
      from: new Date('2026-10-24T04:00:00.000Z'), // 05:00 BST
      to: new Date('2026-10-25T05:00:00.000Z'), // 05:00 GMT
    });
    expect(pharmacyBusinessDay(london, new Date('2026-10-25T04:30:00.000Z'))).toBe('2026-10-24');
  });

  it('reports default offsets from the business day', () => {
    expect(pharmacyBusinessDayOffset(LATE, -30, AT_0030)).toBe('2026-10-02');
    expect(pharmacyBusinessDayOffset(LATE, 1, AT_0030)).toBe('2026-11-02');
    expect(pharmacyBusinessDayOffset(DEFAULT, 1, AT_0030)).toBe('2026-11-03');
  });
});

describe('DEV-958A the default (midnight) is the organisation day used before', () => {
  const instants = [AT_2330, AT_0030, AT_0530, new Date('2026-03-29T00:59:59.000Z')];
  const zones = [KARACHI, 'UTC', 'Europe/London', 'America/New_York', null, undefined, 'PKT'];

  it.each(zones)('equals workspaceToday, workspaceDateRange and the offsets in %s', (zone) => {
    for (const hour of [undefined, null, 0, 7, -1, 2.5]) {
      const clock = { timeZone: zone, dayEnd: hour };
      // 7, -1 and 2.5 are not hours a branch can store; they read as midnight.
      for (const at of instants) {
        expect(pharmacyBusinessDay(clock, at)).toBe(workspaceToday(zone, at));
        expect(pharmacyBusinessDayOffset(clock, -30, at)).toBe(workspaceDateOffset(zone, -30, at));
      }
      expect(pharmacyBusinessDayRange('2026-10-25', '2026-11-02', clock)).toEqual(
        workspaceDateRange('2026-10-25', '2026-11-02', zone)
      );
    }
  });

  it('reads a missing or refused hour as midnight', () => {
    expect(PHARMACY_DEFAULT_DAY_END_HOUR).toBe(0);
    expect([undefined, null, 0, 7, -1, 2.5, Number.NaN].map(pharmacyDayEndHour)).toEqual([
      0, 0, 0, 0, 0, 0, 0,
    ]);
    expect([1, 5, 6].map(pharmacyDayEndHour)).toEqual([1, 5, 6]);
    expect(pharmacyDayEndLabel(0)).toBe('Midnight');
    expect(pharmacyDayEndLabel(5)).toBe('5:00 AM');
  });
});

describe('DEV-958A windows over several branches', () => {
  const later = [{ from: '2026-11-20', hour: 5 }];
  it('uses the shared hours, and midnight when the branches differ', () => {
    expect(sharedPharmacyDayEnd([])).toEqual({ dayEnd: [], mixed: false });
    expect(sharedPharmacyDayEnd([later, later])).toEqual({ dayEnd: later, mixed: false });
    expect(
      sharedPharmacyDayEnd([0, null, undefined, [], [{ from: '2026-11-20', hour: 0 }]])
    ).toEqual({ dayEnd: [], mixed: false });
    expect(sharedPharmacyDayEnd([later, []])).toEqual({ dayEnd: [], mixed: true });
    expect(sharedPharmacyDayEnd([later, [{ from: '2026-11-21', hour: 5 }]])).toEqual({
      dayEnd: [],
      mixed: true,
    });
  });

  it('passes no field at midnight, so the default filters are unchanged', () => {
    expect(pharmacyDayEndField([])).toEqual({});
    expect(pharmacyDayEndField(undefined)).toEqual({});
    expect(pharmacyDayEndField([{ from: '2026-11-20', hour: 0 }])).toEqual({});
    expect(pharmacyDayEndField(later)).toEqual({ dayEnd: later });
  });
});

describe('DEV-958A a change of the hour keeps every earlier day as it was', () => {
  // Days closed at midnight up to 19 Nov; from the business day of 20 Nov the day ends at 05:00.
  const raised = { timeZone: KARACHI, dayEnd: [{ from: '2026-11-20', hour: 5 }] };
  // And back: from 23 Nov it ends at midnight again.
  const loweredAgain = {
    timeZone: KARACHI,
    dayEnd: [
      { from: '2026-11-20', hour: 5 },
      { from: '2026-11-23', hour: 0 },
    ],
  };
  const midnight = { timeZone: KARACHI };
  const days = (from: string, count: number) =>
    Array.from({ length: count }, (_, index) => shiftPharmacyDay(from, index));

  it('reads every day before the change exactly as before it', () => {
    for (const day of days('2026-10-01', 49)) {
      expect(pharmacyBusinessDayRange(day, day, raised)).toEqual(
        workspaceDateRange(day, day, KARACHI)
      );
    }
    // A month of past days read in one window is the same window too.
    expect(pharmacyBusinessDayRange('2026-10-19', '2026-11-18', raised)).toEqual(
      pharmacyBusinessDayRange('2026-10-19', '2026-11-18', midnight)
    );
  });

  it('makes the last day before the change the one longer day, and tiles every day', () => {
    // 19 Nov starts at midnight as usual and ends at 05:00 on 20 Nov: 29 hours.
    expect(pharmacyBusinessDayRange('2026-11-19', '2026-11-19', raised)).toEqual({
      from: new Date('2026-11-18T19:00:00.000Z'),
      to: new Date('2026-11-20T00:00:00.000Z'),
    });
    // 20 Nov onwards run from 05:00 to 05:00.
    expect(pharmacyBusinessDayRange('2026-11-20', '2026-11-20', raised)).toEqual({
      from: new Date('2026-11-20T00:00:00.000Z'),
      to: new Date('2026-11-21T00:00:00.000Z'),
    });
    // Back to midnight: 22 Nov runs from 05:00 to midnight, 19 hours.
    expect(pharmacyBusinessDayRange('2026-11-22', '2026-11-22', loweredAgain)).toEqual({
      from: new Date('2026-11-22T00:00:00.000Z'),
      to: new Date('2026-11-22T19:00:00.000Z'),
    });
    for (const clock of [raised, loweredAgain]) {
      const span = days('2026-11-10', 21);
      for (const [index, day] of span.entries()) {
        if (index === 0) continue;
        // No gap and no overlap: each day starts where the day before ends.
        expect(pharmacyBusinessDayRange(day, day, clock).from).toEqual(
          pharmacyBusinessDayRange(span[index - 1]!, span[index - 1]!, clock).to
        );
      }
      // A range across the change is exactly its days laid end to end.
      expect(pharmacyBusinessDayRange('2026-11-10', '2026-11-30', clock)).toEqual({
        from: pharmacyBusinessDayRange('2026-11-10', '2026-11-10', clock).from,
        to: pharmacyBusinessDayRange('2026-11-30', '2026-11-30', clock).to,
      });
    }
  });

  it('books each instant on the day whose window holds it', () => {
    const at = (iso: string) => new Date(iso);
    // 00:30 on 19 Nov (still midnight): 19 Nov. 00:30 on 20 Nov (the long day): 19 Nov.
    expect(pharmacyBusinessDay(raised, at('2026-11-18T19:30:00.000Z'))).toBe('2026-11-19');
    expect(pharmacyBusinessDay(raised, at('2026-11-19T19:30:00.000Z'))).toBe('2026-11-19');
    // 05:30 on 20 Nov: 20 Nov. 00:30 on 21 Nov: still 20 Nov.
    expect(pharmacyBusinessDay(raised, at('2026-11-20T00:30:00.000Z'))).toBe('2026-11-20');
    expect(pharmacyBusinessDay(raised, at('2026-11-20T19:30:00.000Z'))).toBe('2026-11-20');
    for (const clock of [raised, loweredAgain])
      for (let hour = 0; hour < 24 * 20; hour += 5) {
        const instant = new Date(Date.parse('2026-11-12T00:15:00.000Z') + hour * 3_600_000);
        const day = pharmacyBusinessDay(clock, instant);
        const range = pharmacyBusinessDayRange(day, day, clock);
        expect(instant >= range.from && instant < range.to).toBe(true);
      }
    expect(pharmacyDayEndHourOn(raised, '2026-11-19')).toBe(0);
    expect(pharmacyDayEndHourOn(raised, '2026-11-20')).toBe(5);
  });

  it('lets a later change for the same day win, and keeps only the day and the hour', () => {
    const schedule = pharmacyDayEndSchedule([
      { from: '2026-11-20', hour: 5, actorId: 'owner_1' },
      { from: '2026-11-20', hour: 4, at: '2026-11-18T18:00:00.000Z' },
    ]);
    expect(schedule).toEqual([
      { from: '2026-11-20', hour: 5 },
      { from: '2026-11-20', hour: 4 },
    ]);
    expect(pharmacyDayEndHourOn({ dayEnd: schedule }, '2026-11-20')).toBe(4);
    expect(pharmacyDayEndSchedule(undefined)).toEqual([]);
    expect(pharmacyDayEndSchedule([])).toEqual([]);
  });

  it('fails closed on a stored history it cannot read, instead of reading midnight', () => {
    for (const history of [
      { from: '2026-11-20', hour: 5 },
      'nonsense',
      ['nonsense'],
      [{ from: 'soon', hour: 3 }],
      [{ from: '2026-02-30', hour: 3 }],
      [{ from: '2026-11-20', hour: 9 }],
      [{ from: '2026-11-20', hour: '5' }],
      [{ from: '2026-11-20', hour: 2.5 }],
      [{ hour: 5 }],
      [
        { from: '2026-11-22', hour: 5 },
        { from: '2026-11-20', hour: 3 },
      ],
    ]) {
      expect(() => pharmacyDayEndSchedule(history)).toThrow(PharmacyDayEndHistoryError);
      expect(() => pharmacyBusinessDay({ timeZone: KARACHI, dayEnd: history }, AT_0030)).toThrow(
        PharmacyDayEndHistoryError
      );
      expect(() =>
        pharmacyBusinessDayRange('2026-11-01', '2026-11-01', {
          timeZone: KARACHI,
          dayEnd: history,
        })
      ).toThrow(PharmacyDayEndHistoryError);
    }
  });
});

describe('DEV-958A a branch as a screen gets it', () => {
  it('sends the day and hour of each change, never who made it or when', () => {
    expect(
      withClientPharmacyDayEnd({
        id: 'branch_a',
        name: 'Main',
        businessDayEndsAtHistory: [
          { from: '2026-11-20', hour: 5, actorId: 'user_owner_1', at: '2026-11-18T18:30:00.000Z' },
        ],
      })
    ).toEqual({
      id: 'branch_a',
      name: 'Main',
      businessDayEndsAtHistory: [{ from: '2026-11-20', hour: 5 }],
    });
    expect(withClientPharmacyDayEnd({ id: 'branch_b', businessDayEndsAtHistory: [] })).toEqual({
      id: 'branch_b',
      businessDayEndsAtHistory: [],
    });
  });
});

describe('DEV-958A receipts print the real clock, never the business day', () => {
  it('prints a 00:30 sale at a 05:00 branch with its own date and time', () => {
    const completedAt = AT_0030.toISOString();
    // The sale books on 1 Nov ...
    expect(pharmacyBusinessDay(LATE, AT_0030)).toBe('2026-11-01');
    // ... but the paper says when it happened: 2 Nov, 00:30 in Karachi.
    expect(formatReceiptIssuedAt(completedAt)).toBe('2026-11-02 00:30 PKT');
    expect(pharmacyCalendarDay(KARACHI, AT_0030)).toBe('2026-11-02');
  });
});
