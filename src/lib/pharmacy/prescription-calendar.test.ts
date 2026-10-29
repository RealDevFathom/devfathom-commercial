import { afterEach, describe, expect, it } from 'vitest';

import {
  formatPrescriptionDate,
  prescriptionCalendarDate,
  prescriptionIsCurrent,
} from './prescription-calendar';

const originalTimezone = process.env.TZ;
afterEach(() => {
  process.env.TZ = originalTimezone;
});

describe('prescription calendar dates', () => {
  it.each(['America/Los_Angeles', 'Pacific/Kiritimati'])(
    'captures and renders the entered Pakistan date unchanged under %s',
    (deviceTimezone) => {
      process.env.TZ = deviceTimezone;
      const date = prescriptionCalendarDate('2026-10-22');
      expect(date.toISOString()).toBe('2026-10-22T00:00:00.000Z');
      expect(formatPrescriptionDate(date)).toBe('22/10/2026');
    }
  );

  it('keeps the end date valid through the whole pharmacy-local day', () => {
    const from = prescriptionCalendarDate('2026-10-01');
    const until = prescriptionCalendarDate('2026-10-22');
    expect(
      prescriptionIsCurrent(from, until, new Date('2026-10-22T18:59:59.999Z'), 'Asia/Karachi')
    ).toBe(true);
    expect(
      prescriptionIsCurrent(from, until, new Date('2026-10-22T19:00:00.000Z'), 'Asia/Karachi')
    ).toBe(false);
  });

  it('uses the configured pharmacy day east and west of UTC', () => {
    const date = prescriptionCalendarDate('2026-10-22');
    const instant = new Date('2026-10-22T04:00:00.000Z');
    expect(prescriptionIsCurrent(date, date, instant, 'Asia/Karachi')).toBe(true);
    expect(prescriptionIsCurrent(date, date, instant, 'America/Los_Angeles')).toBe(false);
  });

  it.each(['2026-02-30', '22-10-2026', ''])('rejects invalid calendar value %j', (value) => {
    expect(() => prescriptionCalendarDate(value)).toThrow('Choose a valid prescription date.');
  });
});
