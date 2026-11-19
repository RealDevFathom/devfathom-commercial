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
  sharedPharmacyDayEndHour,
} from './business-day';
import { workspaceDateOffset, workspaceDateRange, workspaceToday } from '@/lib/timezone';

// Karachi is UTC+5 all year. Local times on the night of 1 to 2 Nov 2026.
const KARACHI = 'Asia/Karachi';
const AT_2330 = new Date('2026-11-01T18:30:00.000Z'); // 23:30 on 1 Nov
const AT_0030 = new Date('2026-11-01T19:30:00.000Z'); // 00:30 on 2 Nov
const AT_0530 = new Date('2026-11-02T00:30:00.000Z'); // 05:30 on 2 Nov
const LATE = { timeZone: KARACHI, dayEndsAtHour: 5 };
const DEFAULT = { timeZone: KARACHI };

describe('DEV-958A the business day of an instant on a branch clock', () => {
  it.each([
    ['23:30', AT_2330, '2026-11-01', '2026-11-01'],
    // The late shift: past midnight but before 05:00 it is still the day before.
    ['00:30', AT_0030, '2026-11-02', '2026-11-01'],
    ['05:30', AT_0530, '2026-11-02', '2026-11-02'],
  ])('at %s local: midnight branch %s, 05:00 branch %s', (_, at, midnight, late) => {
    expect(pharmacyBusinessDay(DEFAULT, at)).toBe(midnight);
    expect(pharmacyBusinessDay({ ...DEFAULT, dayEndsAtHour: 0 }, at)).toBe(midnight);
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
    const london = { timeZone: 'Europe/London', dayEndsAtHour: 5 };
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
      const clock = { timeZone: zone, dayEndsAtHour: hour };
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
  it('uses the shared hour, and midnight when the branches differ', () => {
    expect(sharedPharmacyDayEndHour([])).toEqual({ dayEndsAtHour: 0, mixed: false });
    expect(sharedPharmacyDayEndHour([5, 5])).toEqual({ dayEndsAtHour: 5, mixed: false });
    expect(sharedPharmacyDayEndHour([0, null, undefined])).toEqual({
      dayEndsAtHour: 0,
      mixed: false,
    });
    expect(sharedPharmacyDayEndHour([5, 0])).toEqual({ dayEndsAtHour: 0, mixed: true });
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
