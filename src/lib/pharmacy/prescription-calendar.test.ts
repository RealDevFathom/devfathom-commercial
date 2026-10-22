import { describe, expect, it } from 'vitest';

import {
  formatPrescriptionCalendarDate,
  parsePrescriptionCalendarDate,
  prescriptionIsValidOn,
} from './prescription-calendar';

describe('prescription calendar dates', () => {
  it('captures and renders the entered date without inheriting the device timezone', () => {
    const captured = parsePrescriptionCalendarDate('2026-10-22');

    expect(captured.toISOString()).toBe('2026-10-22T00:00:00.000Z');
    expect(formatPrescriptionCalendarDate(captured)).toBe('22-Oct-2026');
    expect(
      captured.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
    ).toBe('2026-10-21');
    expect(captured.toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })).toBe('2026-10-22');
  });

  it('keeps the valid-until day open through the end of the Pakistan calendar day', () => {
    const from = parsePrescriptionCalendarDate('2026-10-01');
    const until = parsePrescriptionCalendarDate('2026-10-22');

    expect(prescriptionIsValidOn(from, until, 'Asia/Karachi', new Date('2026-10-22T18:59:59Z'))).toBe(
      true
    );
    expect(prescriptionIsValidOn(from, until, 'Asia/Karachi', new Date('2026-10-22T19:00:00Z'))).toBe(
      false
    );
  });

  it('rejects impossible dates rather than allowing Date rollover', () => {
    expect(() => parsePrescriptionCalendarDate('2026-02-30')).toThrow(RangeError);
  });
});
