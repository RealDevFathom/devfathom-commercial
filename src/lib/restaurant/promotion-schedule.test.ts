/**
 * WHA-288 / promotions Lane A — §3.2 schedule semantics.
 *
 * Named acceptance test (§13):
 *   - promotion_schedule_handles_day_mask_overnight_dst_and_exclusive_end
 *
 * Every instant below is written as an explicit UTC literal and its local
 * rendering was confirmed against `Intl` before being asserted, so a failure
 * here means the ENGINE moved, not that the fixture drifted.
 */

import { describe, expect, it } from 'vitest';

import { PROMOTION_REASON } from '@/lib/restaurant/promotion-contracts';
import {
  PromotionScheduleError,
  resolvePromotionSchedule,
  type PromotionSchedule,
} from '@/lib/restaurant/promotion-schedule';

/** dayMask bit 0 = Monday .. bit 6 = Sunday (§3.1). */
const MONDAY = 1 << 0;
const FRIDAY = 1 << 4;
const SATURDAY = 1 << 5;
const SUNDAY = 1 << 6;
const EVERY_DAY = 127;

function schedule(overrides: Partial<PromotionSchedule> = {}): PromotionSchedule {
  return {
    effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
    effectiveTo: null,
    timezone: 'UTC',
    dayMask: EVERY_DAY,
    startMinute: null,
    endMinute: null,
    ...overrides,
  };
}

describe('promotion schedule — §3.2 effective range', () => {
  it('is half-open: the start instant is in and the end instant is out', () => {
    const window = schedule({
      effectiveFrom: new Date('2026-03-04T10:00:00.000Z'),
      effectiveTo: new Date('2026-03-04T12:00:00.000Z'),
    });
    expect(resolvePromotionSchedule(new Date('2026-03-04T09:59:59.999Z'), window).eligible).toBe(
      false
    );
    expect(resolvePromotionSchedule(new Date('2026-03-04T10:00:00.000Z'), window).eligible).toBe(
      true
    );
    expect(resolvePromotionSchedule(new Date('2026-03-04T11:59:59.999Z'), window).eligible).toBe(
      true
    );
    // Exclusive end — the boundary instant belongs to the NEXT version.
    const atEnd = resolvePromotionSchedule(new Date('2026-03-04T12:00:00.000Z'), window);
    expect(atEnd.eligible).toBe(false);
    expect(atEnd.reasonCode).toBe(PROMOTION_REASON.OUTSIDE_EFFECTIVE_RANGE);
  });

  it('an absent end never expires', () => {
    const verdict = resolvePromotionSchedule(
      new Date('2099-12-31T23:59:00.000Z'),
      schedule({ effectiveTo: null })
    );
    expect(verdict.eligible).toBe(true);
  });
});

describe('promotion schedule — §3.2 day mask', () => {
  // 2026-03-04 is a Wednesday; 2026-03-06 a Friday; 2026-03-07 a Saturday.
  it('admits only the selected local weekdays', () => {
    const fridayOnly = schedule({ dayMask: FRIDAY });
    expect(
      resolvePromotionSchedule(new Date('2026-03-06T12:00:00.000Z'), fridayOnly).eligible
    ).toBe(true);
    const wednesday = resolvePromotionSchedule(new Date('2026-03-04T12:00:00.000Z'), fridayOnly);
    expect(wednesday.eligible).toBe(false);
    expect(wednesday.reasonCode).toBe(PROMOTION_REASON.DAY_MASK_EXCLUDED);
  });

  it('maps bit 0 to Monday and bit 6 to Sunday', () => {
    // 2026-03-02 is a Monday, 2026-03-08 a Sunday.
    expect(
      resolvePromotionSchedule(new Date('2026-03-02T12:00:00.000Z'), schedule({ dayMask: MONDAY }))
        .eligible
    ).toBe(true);
    expect(
      resolvePromotionSchedule(new Date('2026-03-08T12:00:00.000Z'), schedule({ dayMask: SUNDAY }))
        .eligible
    ).toBe(true);
    // A Monday rule must not fire on Sunday — the classic off-by-one.
    expect(
      resolvePromotionSchedule(new Date('2026-03-08T12:00:00.000Z'), schedule({ dayMask: MONDAY }))
        .eligible
    ).toBe(false);
  });

  it('uses the RULE timezone, not UTC, to pick the weekday', () => {
    // 2026-03-07T02:00Z is still Friday 21:00 in New York.
    const instant = new Date('2026-03-07T02:00:00.000Z');
    expect(
      resolvePromotionSchedule(instant, schedule({ dayMask: FRIDAY, timezone: 'America/New_York' }))
        .eligible
    ).toBe(true);
    expect(
      resolvePromotionSchedule(instant, schedule({ dayMask: SATURDAY, timezone: 'UTC' })).eligible
    ).toBe(true);
  });
});

describe('promotion schedule — §3.2 minute windows', () => {
  it('no window means the whole selected local day', () => {
    const allDay = schedule({ dayMask: FRIDAY });
    expect(resolvePromotionSchedule(new Date('2026-03-06T00:00:00.000Z'), allDay).eligible).toBe(
      true
    );
    expect(resolvePromotionSchedule(new Date('2026-03-06T23:59:00.000Z'), allDay).eligible).toBe(
      true
    );
  });

  it('EQUAL endpoints mean a full selected day, not an empty interval', () => {
    const equal = schedule({ dayMask: FRIDAY, startMinute: 1320, endMinute: 1320 });
    expect(resolvePromotionSchedule(new Date('2026-03-06T03:00:00.000Z'), equal).eligible).toBe(
      true
    );
    expect(resolvePromotionSchedule(new Date('2026-03-06T22:00:00.000Z'), equal).eligible).toBe(
      true
    );
  });

  it('a same-day window is half-open: start is in, end is out', () => {
    // 12:00-14:00 UTC on any day.
    const midday = schedule({ startMinute: 720, endMinute: 840 });
    expect(resolvePromotionSchedule(new Date('2026-03-04T11:59:00.000Z'), midday).eligible).toBe(
      false
    );
    expect(resolvePromotionSchedule(new Date('2026-03-04T12:00:00.000Z'), midday).eligible).toBe(
      true
    );
    expect(resolvePromotionSchedule(new Date('2026-03-04T13:59:00.000Z'), midday).eligible).toBe(
      true
    );
    const atEnd = resolvePromotionSchedule(new Date('2026-03-04T14:00:00.000Z'), midday);
    expect(atEnd.eligible).toBe(false);
    expect(atEnd.reasonCode).toBe(PROMOTION_REASON.TIME_WINDOW_EXCLUDED);
  });

  it('§12.14 an overnight window is anchored on the day whose bit is set', () => {
    // Friday bit only, 22:00-02:00 in Asia/Karachi (UTC+5, no DST).
    const overnight = schedule({
      dayMask: FRIDAY,
      startMinute: 22 * 60,
      endMinute: 2 * 60,
      timezone: 'Asia/Karachi',
    });

    // Friday 23:30 local — inside, under Friday's own bit.
    const fridayNight = resolvePromotionSchedule(new Date('2026-03-06T18:30:00.000Z'), overnight);
    expect(fridayNight.eligible).toBe(true);
    expect(fridayNight.localDate).toBe('2026-03-06');
    expect(fridayNight.localMinute).toBe(23 * 60 + 30);

    // Saturday 01:30 local — inside, still under FRIDAY's bit even though
    // Saturday is not selected. This is the case a naive "is today selected?"
    // implementation gets wrong.
    const saturdayMorning = resolvePromotionSchedule(
      new Date('2026-03-06T20:30:00.000Z'),
      overnight
    );
    expect(saturdayMorning.eligible).toBe(true);
    expect(saturdayMorning.localDate).toBe('2026-03-07');

    // Saturday 02:00 local — the exclusive end.
    const atEnd = resolvePromotionSchedule(new Date('2026-03-06T21:00:00.000Z'), overnight);
    expect(atEnd.eligible).toBe(false);
    expect(atEnd.reasonCode).toBe(PROMOTION_REASON.TIME_WINDOW_EXCLUDED);

    // Saturday 23:30 local — Saturday's bit is NOT set, so an overnight window
    // does not start on it.
    expect(resolvePromotionSchedule(new Date('2026-03-07T18:30:00.000Z'), overnight).eligible).toBe(
      false
    );
  });
});

describe('promotion schedule — §3.2 daylight saving', () => {
  it('an ambiguous fall-back local time is eligible in BOTH offsets', () => {
    // America/New_York, 2026-11-01: 01:30 local happens twice, at 05:30Z
    // (EDT, -240) and again at 06:30Z (EST, -300).
    const sundayNight = schedule({
      dayMask: SUNDAY,
      startMinute: 60,
      endMinute: 120,
      timezone: 'America/New_York',
    });
    const first = resolvePromotionSchedule(new Date('2026-11-01T05:30:00.000Z'), sundayNight);
    const second = resolvePromotionSchedule(new Date('2026-11-01T06:30:00.000Z'), sundayNight);

    expect(first.eligible).toBe(true);
    expect(second.eligible).toBe(true);
    expect(first.localMinute).toBe(90);
    expect(second.localMinute).toBe(90);
    // Same local time, different recorded offsets — which is exactly why the
    // snapshot stores the offset rather than re-deriving it later.
    expect(first.utcOffsetMinutes).toBe(-240);
    expect(second.utcOffsetMinutes).toBe(-300);
  });

  it('a nonexistent spring-forward local time simply never occurs', () => {
    // America/New_York, 2026-03-08: the clock jumps 02:00 EST -> 03:00 EDT, so
    // no instant renders as 02:30 local. A 02:00-03:00 window therefore matches
    // nothing that day rather than throwing or matching a neighbouring hour.
    const gap = schedule({
      dayMask: SUNDAY,
      startMinute: 120,
      endMinute: 180,
      timezone: 'America/New_York',
    });
    const before = resolvePromotionSchedule(new Date('2026-03-08T06:30:00.000Z'), gap); // 01:30 EST
    const after = resolvePromotionSchedule(new Date('2026-03-08T07:30:00.000Z'), gap); // 03:30 EDT
    expect(before.eligible).toBe(false);
    expect(after.eligible).toBe(false);
    expect(before.localMinute).toBe(90);
    expect(after.localMinute).toBe(210);
  });
});

describe('promotion schedule — malformed input fails loudly', () => {
  it('rejects an unknown timezone rather than silently never matching', () => {
    expect(() =>
      resolvePromotionSchedule(new Date(), schedule({ timezone: 'Mars/Olympus_Mons' }))
    ).toThrow(PromotionScheduleError);
  });

  it('rejects a half-specified minute window and an out-of-range mask', () => {
    expect(() =>
      resolvePromotionSchedule(new Date(), schedule({ startMinute: 60, endMinute: null }))
    ).toThrow(PromotionScheduleError);
    expect(() => resolvePromotionSchedule(new Date(), schedule({ dayMask: 128 }))).toThrow(
      PromotionScheduleError
    );
    expect(() =>
      resolvePromotionSchedule(new Date(), schedule({ startMinute: 0, endMinute: 1440 }))
    ).toThrow(PromotionScheduleError);
  });
});
