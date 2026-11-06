import { describe, expect, it, vi } from 'vitest';

import {
  formatPrescriptionDate,
  prescriptionCalendarDate,
  prescriptionIsValidForOrganization,
  prescriptionIsValidOn,
} from './prescription-validity';

describe('prescription business-calendar validity', () => {
  it('captures a Pakistan calendar value as a date-only UTC sentinel', () => {
    expect(prescriptionCalendarDate('2026-10-22').toISOString()).toBe('2026-10-22T00:00:00.000Z');
    expect(() => prescriptionCalendarDate('2026-02-30')).toThrow('Invalid prescription date');
  });

  it.each(['America/Los_Angeles', 'Asia/Karachi', 'Pacific/Auckland'])(
    'renders and checks the entered date unchanged for a browser in %s',
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
      // The browser zone must not leak into the sale gate: validity follows the
      // organization calendar even on devices west and east of UTC.
      expect(
        prescriptionIsValidOn(
          prescriptionCalendarDate('2026-10-22'),
          prescriptionCalendarDate('2026-10-22'),
          new Date('2026-10-22T18:59:59.999Z'),
          'Asia/Karachi'
        )
      ).toBe(true);
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

  it('includes valid-from and leap-day boundaries', () => {
    const from = prescriptionCalendarDate('2028-02-29');
    const through = prescriptionCalendarDate('2028-03-01');

    expect(
      prescriptionIsValidOn(from, through, new Date('2028-02-28T19:00:00.000Z'), 'Asia/Karachi')
    ).toBe(true);
    expect(
      prescriptionIsValidOn(from, through, new Date('2028-02-28T18:59:59.999Z'), 'Asia/Karachi')
    ).toBe(false);
  });

  it.each([null, 'Not/A_Timezone'])(
    'falls back to UTC for a missing or invalid zone (%s)',
    (zone) => {
      const day = prescriptionCalendarDate('2026-10-22');
      expect(prescriptionIsValidOn(day, day, new Date('2026-10-22T23:59:59.999Z'), zone)).toBe(
        true
      );
      expect(prescriptionIsValidOn(day, day, new Date('2026-10-23T00:00:00.000Z'), zone)).toBe(
        false
      );
    }
  );

  it('loads the organization timezone for the shared production sale gate', async () => {
    const findUnique = vi.fn(async () => ({ timezone: 'Asia/Karachi' }));
    const db = { organization: { findUnique } };
    const day = prescriptionCalendarDate('2026-10-22');

    await expect(
      prescriptionIsValidForOrganization(
        db as never,
        'org-1',
        day,
        day,
        new Date('2026-10-22T18:59:59.999Z')
      )
    ).resolves.toBe(true);
    await expect(
      prescriptionIsValidForOrganization(
        db as never,
        'org-1',
        day,
        day,
        new Date('2026-10-22T19:00:00.000Z')
      )
    ).resolves.toBe(false);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      select: { timezone: true },
    });
  });
});
