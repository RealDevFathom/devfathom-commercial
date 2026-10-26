import { describe, expect, it } from 'vitest';

import {
  formatPrescriptionDate,
  prescriptionCalendarDate,
  prescriptionIsValidOn,
} from './prescription-validity';

describe('prescription business-calendar validity', () => {
  it('captures a Pakistan calendar value as a date-only UTC sentinel', () => {
    expect(prescriptionCalendarDate('2026-10-22').toISOString()).toBe('2026-10-22T00:00:00.000Z');
    expect(() => prescriptionCalendarDate('2026-02-30')).toThrow('Invalid prescription date');
  });

  it.each(['America/Los_Angeles', 'Asia/Karachi', 'Pacific/Auckland'])(
    'renders the entered date unchanged for a browser in %s',
    (browserTimeZone) => {
      // Demonstrate that the instant has a different local date west of UTC,
      // while the product formatter deliberately treats it as a calendar date.
      const date = prescriptionCalendarDate('2026-10-22');
      if (browserTimeZone === 'America/Los_Angeles') {
        expect(new Intl.DateTimeFormat('en-CA', { timeZone: browserTimeZone }).format(date)).toBe(
          '2026-10-21'
        );
      }
      expect(formatPrescriptionDate(date)).toBe('22/10/2026');
    }
  );

  it('includes the valid-through day in Pakistan and rejects the next local day', () => {
    const from = prescriptionCalendarDate('2026-10-01');
    const through = prescriptionCalendarDate('2026-10-22');

    expect(
      prescriptionIsValidOn(from, through, new Date('2026-10-22T18:59:59.999Z'), 'Asia/Karachi')
    ).toBe(true);
    expect(
      prescriptionIsValidOn(from, through, new Date('2026-10-22T19:00:00.000Z'), 'Asia/Karachi')
    ).toBe(false);
  });
});
